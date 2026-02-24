require("dotenv").config();
const http = require("http");
const { server: WebSocketServer } = require("websocket");
const { sql, pool, poolConnect } = require("./db");
//const { sql, pool } = require("./db");

// const server = http.createServer(() => {});
// server.listen(8000);

const server = http.createServer((req, res) => {
  res.end("Server running");
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
server.on("error", (err) => {
  console.error("Server error:", err.message);
});

const webSocket = new WebSocketServer({ httpServer: server });

const connections = {};
const waitingQueue = [];

const findAvailableAgent = async () => {
  const result = await pool.request().query(`
    SELECT TOP 1 * FROM USER_Master
    WHERE IsOnline = 1 AND IsAvailable = 1
  `);
  return result.recordset[0];
};

webSocket.on("request", (req) => {
  const connection = req.accept();

  connection.on("message", async (message) => {
    const data = JSON.parse(message.utf8Data);

    switch (data.type) {

      // ==============================
      // STORE USER / AGENT
      // ==============================
      case "store_user":
        connections[data.name] = connection;

        if (data.role === "agent") {
          await pool.request()
            .input("Username", sql.NVarChar, data.name)
            .query(`
              UPDATE USER_Master
              SET IsOnline = 1, IsAvailable = 1
              WHERE UserId = @Username
            `);
        }
       console.log("store_user ",data.name)
        break;

      // ==============================
      // REQUEST KYC CALL
      // ==============================
      case "request_kyc_call":
        const agent = await findAvailableAgent();

        if (!agent) {
          waitingQueue.push(data.userId);
          connection.send(JSON.stringify({
            type: "waiting"
          }));
          return;
        }

        await pool.request()
          .input("Username", sql.NVarChar, agent.Username)
          .query(`
            UPDATE USER_Master
            SET IsAvailable = 0
            WHERE UserId = @Username
          `);

        // notify agent
        connections[agent.Username].send(JSON.stringify({
          type: "incoming_call",
          userId: data.userId
        }));

        // notify user
        connection.send(JSON.stringify({
          type: "agent_assigned",
          agentName: agent.Username
        }));

        break;

      // ==============================
      // OFFER / ANSWER / ICE
      // ==============================
      case "create_offer":
      case "create_answer":
      case "ice_candidate":
        if (connections[data.target]) {
          connections[data.target].send(JSON.stringify(data));
        }
        break;

      // ==============================
      // UPDATE KYC STATUS
      // ==============================
      case "kyc_status_update":

        await pool.request()
          .input("Status", sql.NVarChar, data.status)
          .input("MemberId", sql.Int, data.memberId)
          .input("AgentId", sql.Int, data.agentId)
          .query(`
            UPDATE tbl_member
            SET videoKyc = @Status,
                UserId = @AgentId,
                Remarks = GETDATE()
            WHERE MemberNo = @MemberId
          `);

        if (connections[data.userName]) {
          connections[data.userName].send(JSON.stringify({
            type: "kyc_result",
            status: data.status
          }));
        }

        break;

      // ==============================
      // CALL ENDED
      // ==============================
      case "call_ended":

        await pool.request()
          .input("Username", sql.NVarChar, data.agentName)
          .query(`
            UPDATE USER_Master
            SET IsAvailable = 1
            WHERE UserId = @Username
          `);

        break;
    }
  });

  connection.on("close", async () => {
    for (let key in connections) {
      if (connections[key] === connection) {
        delete connections[key];

        await pool.request()
          .input("Username", sql.NVarChar, key)
          .query(`
            UPDATE USER_Master
            SET IsOnline = 0, IsAvailable = 0
            WHERE UserId = @Username
          `);
      }
    }
  });
});
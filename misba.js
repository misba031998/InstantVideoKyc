require("dotenv").config();
const http = require("http");
const { server: WebSocketServer } = require("websocket");
const { sql, pool } = require("./db");

const server = http.createServer((req, res) => {
  res.end("Server running");
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const webSocket = new WebSocketServer({ httpServer: server });

/* ==============================
   IN-MEMORY STORAGE
============================== */

const connections = {};      // { userId: socket }
const waitingQueue = [];

/* ==============================
   FIND AVAILABLE AGENT
============================== */

const findAvailableAgent = async () => {
  const result = await pool.request().query(`
    SELECT TOP 1 UserId
    FROM USER_Master
    WHERE IsOnline = 1 AND IsAvailable = 1
  `);

  return result.recordset[0]; // returns { UserId: 'admin' }
};

/* ==============================
   SOCKET SERVER
============================== */

webSocket.on("request", (req) => {

  const connection = req.accept();

  connection.on("message", async (message) => {

    const data = JSON.parse(message.utf8Data);

    try {

      switch (data.type) {

        /* ==============================
           STORE USER / AGENT
        =============================== */
        case "store_user":

          connections[data.name] = connection;

          console.log("store_user:", data.name);

          if (data.role === "agent") {

            await pool.request()
              .input("UserId", sql.NVarChar, data.name)
              .query(`
                UPDATE USER_Master
                SET IsOnline = 1,
                    IsAvailable = 1
                WHERE UserId = @UserId
              `);

            console.log("Agent marked online:", data.name);
          }

          break;


        /* ==============================
           REQUEST KYC CALL (FROM MEMBER)
        =============================== */
        case "request_kyc_call":

          const agent = await findAvailableAgent();

          if (!agent) {
            waitingQueue.push(data.userId);

            connection.send(JSON.stringify({
              type: "waiting"
            }));

            console.log("No agent available");
            return;
          }

          const agentId = agent.UserId;

          console.log("Agent found:", agentId);

          // mark agent busy
          await pool.request()
            .input("UserId", sql.NVarChar, agentId)
            .query(`
              UPDATE USER_Master
              SET IsAvailable = 0
              WHERE UserId = @UserId
            `);

          // notify agent
          if (connections[agentId]) {

            connections[agentId].send(JSON.stringify({
              type: "incoming_call",
              userId: data.userId
            }));

          } else {

            console.log("Agent socket not found:", agentId);

            connection.send(JSON.stringify({
              type: "waiting"
            }));

            return;
          }

          // notify member
          connection.send(JSON.stringify({
            type: "agent_assigned",
            agentName: agentId
          }));

          break;


        /* ==============================
           WEBRTC SIGNALING
        =============================== */
        case "create_offer":
        case "create_answer":
        case "ice_candidate":

          if (connections[data.target]) {
            connections[data.target].send(JSON.stringify(data));
          }

          break;


        /* ==============================
           UPDATE KYC STATUS (ADMIN)
        =============================== */
        case "kyc_status_update":

          await pool.request()
            .input("Status", sql.NVarChar, data.status)
            .input("MemberId", sql.Int, data.memberId)
            .input("AgentId", sql.NVarChar, data.agentId)
            .query(`
              UPDATE tbl_member
              SET videoKyc = @Status,
                  UserId = @AgentId,
                  Remarks = GETDATE()
              WHERE MemberNo = @MemberId
            `);

          // notify member
          if (connections[data.userName]) {
            connections[data.userName].send(JSON.stringify({
              type: "kyc_result",
              status: data.status
            }));
          }

          break;


        /* ==============================
           CALL ENDED (ADMIN ONLY)
        =============================== */
        case "call_ended":

          const endedByAgent = data.name;
          const memberId = data.target;

          console.log("Call ended by:", endedByAgent);

          // make agent available again
          await pool.request()
            .input("UserId", sql.NVarChar, endedByAgent)
            .query(`
              UPDATE USER_Master
              SET IsAvailable = 1
              WHERE UserId = @UserId
            `);

          // notify member
          if (connections[memberId]) {
            connections[memberId].send(JSON.stringify({
              type: "call_ended"
            }));
          }

          break;

      }

    } catch (error) {
      console.error("Socket Error:", error.message);
    }

  });


  /* ==============================
     HANDLE DISCONNECT
  =============================== */

  connection.on("close", async () => {

    for (let key in connections) {

      if (connections[key] === connection) {

        delete connections[key];

        console.log("Disconnected:", key);

        await pool.request()
          .input("UserId", sql.NVarChar, key)
          .query(`
            UPDATE USER_Master
            SET IsOnline = 0,
                IsAvailable = 0
            WHERE UserId = @UserId
          `);

        break;
      }
    }

  });

});
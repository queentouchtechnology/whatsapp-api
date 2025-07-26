// server.js
require('dotenv').config();

const express = require("express");
const { Server } = require("socket.io");
const http = require("http");
const path = require("path");
const crypto = require("crypto");

const { default: makeWASocket, DisconnectReason, BufferJSON, initAuthCreds } = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode");

const { Pool } = require("pg");
const pool = new Pool(); // takes from .env automatically

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

/* ------------------------------------------------------------------ */
/* PG-backed auth state for Baileys                                    */
/* ------------------------------------------------------------------ */
async function usePgAuthState(sessionId) {
    // load creds from TEXT column
    const credsRow = await pool.query(
      'SELECT creds FROM wa_sessions WHERE session_id = $1',
      [sessionId]
    );
  
    const creds = credsRow.rows.length
      ? JSON.parse(credsRow.rows[0].creds, BufferJSON.reviver)
      : initAuthCreds();
  
    const keys = {
      get: async (type, ids) => {
        if (!ids.length) return {};
        const q = `
          SELECT id, value
          FROM wa_keys
          WHERE session_id = $1 AND type = $2 AND id = ANY($3)
        `;
        const { rows } = await pool.query(q, [sessionId, type, ids]);
        const res = {};
        for (const id of ids) {
          const row = rows.find(r => r.id === id);
          res[id] = row ? JSON.parse(row.value, BufferJSON.reviver) : null;
        }
        return res;
      },
  
      set: async (data) => {
        const queries = [];
        for (const [type, record] of Object.entries(data)) {
          for (const [id, value] of Object.entries(record)) {
            const strValue = JSON.stringify(value, BufferJSON.replacer);
            queries.push(
              pool.query(
                `INSERT INTO wa_keys (session_id, type, id, value)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (session_id, type, id)
                 DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
                [sessionId, type, id, strValue]
              )
            );
          }
        }
        if (queries.length) await Promise.all(queries);
      },
    };
  
    async function saveCreds() {
      const jsonStr = JSON.stringify(creds, BufferJSON.replacer);
      await pool.query(
        `INSERT INTO wa_sessions (session_id, creds)
         VALUES ($1, $2)
         ON CONFLICT (session_id)
         DO UPDATE SET creds = EXCLUDED.creds, updated_at = now()`,
        [sessionId, jsonStr]
      );
    }
  
    return { state: { creds, keys }, saveCreds };
  }
  

/* ------------------------------------------------------------------ */
/* Runtime in-memory sockets                                           */
/* ------------------------------------------------------------------ */
const sockets = {}; // { sessionId: sock }

/* ------------------------------------------------------------------ */
/* REST APIs                                                           */
/* ------------------------------------------------------------------ */

// list active (connected) sessions in memory
app.get("/sessions", async (req, res) => {
  // If you want to list *all* persisted sessions from DB instead:
  // const { rows } = await pool.query('SELECT session_id FROM wa_sessions ORDER BY updated_at DESC');
  // return res.json(rows.map(r => ({ sessionId: r.session_id })));
  const list = Object.keys(sockets).map(sessionId => ({ sessionId }));
  res.json(list);
});

// logout + delete from DB
app.post("/logout", async (req, res) => {
  const { sessionId } = req.body;

  if (sockets[sessionId]) {
    try {
      await sockets[sessionId].logout();
    } catch (err) {
      console.warn("Error during logout:", err.message);
    }
    delete sockets[sessionId];
  }

  // remove from DB
  await pool.query('DELETE FROM wa_keys WHERE session_id = $1', [sessionId]);
  await pool.query('DELETE FROM wa_sessions WHERE session_id = $1', [sessionId]);

  res.json({ success: true });
});

// send message
app.post("/send", async (req, res) => {
  const { sessionId, number, message } = req.body;
  let sock = sockets[sessionId];

  // (re)load from DB if needed
  if (!sock) {
    try {
      sock = await createSockFromDb(sessionId);
      if (!sock) {
        return res.status(404).json({ error: "Session not found or not logged in" });
      }
    } catch (e) {
      return res.status(500).json({ error: "Failed to reload session: " + e.message });
    }
  }

  try {
    const jid = number.includes("@s.whatsapp.net") ? number : `${number}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to send" });
  }
});

/* ------------------------------------------------------------------ */
/* Socket.io: start a new session                                      */
/* ------------------------------------------------------------------ */
io.on("connection", (socket) => {
  const sessionId = generateSessionId();
  connect(sessionId, socket);
});

/* ------------------------------------------------------------------ */
/* Core connect() using PG-backed auth state                           */
/* ------------------------------------------------------------------ */
async function connect(sessionId, socket) {
  const { state, saveCreds } = await usePgAuthState(sessionId);
  const sock = makeWASocket({ auth: state, printQRInTerminal: false });

  sockets[sessionId] = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      const qrImage = await qrcode.toDataURL(qr);
      socket.emit("qr", { sessionId, qrImage });
    }

    if (connection === "open") {
      console.log(`✅ Connected: ${sessionId}`);
      socket.emit("connected", { sessionId });
    }

    if (connection === "close") {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const reason = DisconnectReason[statusCode] || "Unknown";

      console.log(`❌ Disconnected: ${sessionId}, Reason: ${reason}`);

      const isLoggedOut =
        statusCode === DisconnectReason.loggedOut ||
        statusCode === DisconnectReason.badSession;

      if (isLoggedOut) {
        delete sockets[sessionId];
        await pool.query('DELETE FROM wa_keys WHERE session_id = $1', [sessionId]);
        await pool.query('DELETE FROM wa_sessions WHERE session_id = $1', [sessionId]);
        socket.emit("disconnected", { sessionId, reason });
      } else {
        // reconnect
        connect(sessionId, socket);
      }
    }
  });
}

/* ------------------------------------------------------------------ */
/* Helper: recreate a socket from DB when needed (e.g., /send)         */
/* ------------------------------------------------------------------ */
async function createSockFromDb(sessionId) {
  // check if session exists in DB
  const { rows } = await pool.query('SELECT 1 FROM wa_sessions WHERE session_id = $1', [sessionId]);
  if (!rows.length) return null;

  const { state, saveCreds } = await usePgAuthState(sessionId);
  const sock = makeWASocket({ auth: state, printQRInTerminal: false });

  sockets[sessionId] = sock;
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", ({ connection }) => {
    if (connection === "open") {
      console.log(`✅ Session ${sessionId} reloaded for messaging`);
    }
  });

  return sock;
}

/* ------------------------------------------------------------------ */
function generateSessionId() {
  return crypto.randomBytes(8).toString("hex");
}

server.listen(3000, () => {
  console.log("✅ Server running at http://localhost:3000");
  loadSavedSessions(); // optional, pre-warm sockets
});

/* ------------------------------------------------------------------ */
/* Optionally pre-load all sessions from DB on boot                    */
/* ------------------------------------------------------------------ */
async function loadSavedSessions() {
  const { rows } = await pool.query('SELECT session_id FROM wa_sessions');
  for (const r of rows) {
    try {
      await createSockFromDb(r.session_id);
      console.log(`✅ Auto-loaded session: ${r.session_id}`);
    } catch (e) {
      console.error(`❌ Failed to auto-load ${r.session_id}:`, e.message);
    }
  }
}

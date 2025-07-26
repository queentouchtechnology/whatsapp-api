const express = require("express");
const { Server } = require("socket.io");
const http = require("http");
const path = require("path");
const fs = require("fs");

const crypto = require("crypto");
const qrcode = require("qrcode");
const makeWASocket = require("@whiskeysockets/baileys").default;
const { useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const fsExtra = require("fs-extra"); 


const app = express();
const server = http.createServer(app);
const io = new Server(server);



const sessions = {}; // { sessionId: sock }

// Serve static files
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());


// API: List all sessions
app.get("/sessions", (req, res) => {
    const list = Object.keys(sessions).map(sessionId => ({ sessionId }));
    res.json(list);
});


// API: Logout a session and delete its folder
app.post("/logout", async (req, res) => {
    const { sessionId } = req.body;
    const sessionFolder = path.join(__dirname, "sessions", sessionId);

    if (sessions[sessionId]) {
        try {
            await sessions[sessionId].logout(); // clean disconnect
        } catch (err) {
            console.warn("Error during logout:", err.message);
        }

        delete sessions[sessionId];
    }

    // Delete the session folder
    try {
        await fsExtra.remove(sessionFolder);
        console.log(`🗑️ Deleted session folder: ${sessionFolder}`);
    } catch (err) {
        console.error("❌ Failed to delete session folder:", err.message);
    }

    res.json({ success: true });
});


// API: Send message
app.post("/send", async (req, res) => {
    const { sessionId, number, message } = req.body;
    let sock = sessions[sessionId];

    // Check if not already in memory
    if (!sock) {
        const sessionPath = path.join(__dirname, "sessions", sessionId);
        if (!fs.existsSync(sessionPath)) {
            return res.status(404).json({ error: "Session not found or not logged in" });
        }

        // Load session from disk
        try {
            const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
            sock = makeWASocket({ auth: state, printQRInTerminal: false });
            sock.ev.on("creds.update", saveCreds);
            sessions[sessionId] = sock;

            // Optional: handle connection updates
            sock.ev.on("connection.update", ({ connection }) => {
                if (connection === "open") console.log(`✅ Session ${sessionId} reloaded for messaging`);
            });
        } catch (err) {
            return res.status(500).json({ error: "Failed to reload session: " + err.message });
        }
    }

    // Send message
    try {
        const jid = number.includes("@s.whatsapp.net") ? number : number + "@s.whatsapp.net";
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to send message: " + err.message });
    }
});


function generateSessionId() {
    return crypto.randomBytes(8).toString("hex");
}

// Socket connection
io.on("connection", (socket) => {
    const sessionId = generateSessionId();
    connect(sessionId, socket);
});

// Main WhatsApp connect function

async function connect(sessionId, socket) {
    const sessionPath = `./sessions/${sessionId}`;
   
    // Temporary in-memory store before saving to disk
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const sock = makeWASocket({ auth: state, printQRInTerminal: false });

   



    sessions[sessionId] = sock;

    //Save credentials only after folder is created on successful login
    sock.ev.on("creds.update", async () => {
        // Ensure session folder exists before saving
        if (!fs.existsSync(sessionPath)) {
            fs.mkdirSync(sessionPath, { recursive: true });
        }
        await saveCreds();
    });



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

        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        if (isLoggedOut) {
            // Cleanup
            const sessionPath = path.join(__dirname, "sessions", sessionId);
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
                console.log(`🗑️ Deleted session folder: ${sessionId}`);
            }
            delete sessions[sessionId];
            socket.emit("disconnected", { sessionId });
        } else {
            // Attempt reconnect
            connect(sessionId, socket);
        }

        }
    });
}


server.listen(3000, () => {
    console.log("✅ Server running at http://localhost:3000");
});

// 🔁 Load saved sessions from disk on server start
async function loadSavedSessions() {
    const sessionBase = path.join(__dirname, "sessions");

    if (!fs.existsSync(sessionBase)) return;

    const sessionIds = fs.readdirSync(sessionBase);

    for (const sessionId of sessionIds) {
        const sessionPath = path.join(sessionBase, sessionId);
        if (fs.existsSync(path.join(sessionPath, "creds.json"))) {
            try {
                const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
                const sock = makeWASocket({ auth: state, printQRInTerminal: false });

                sock.ev.on("creds.update", saveCreds);

                sock.ev.on("connection.update", ({ connection }) => {
                    if (connection === "open") {
                        console.log(`✅ Auto-loaded session: ${sessionId}`);
                    }
                });

                sessions[sessionId] = sock;
            } catch (err) {
                console.error(`❌ Failed to load session ${sessionId}:`, err.message);
            }
        }
    }
}

loadSavedSessions();

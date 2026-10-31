import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} from "@musteqeem/baileys";
import { Boom } from "@hapi/boom";
import express from "express";
import fs from "fs";
import pino from "pino";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const AUTH_FOLDER = "./auth_session";

let sock = null;
let isConnected = false;

// ========== Web Dashboard ==========
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>WhatsApp Channel ID Bot</title>
      <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
    </head>
    <body class="bg-slate-950 text-slate-100 min-h-screen flex items-center justify-center p-4">
      <div class="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl">
        <div class="flex items-center justify-between mb-6">
          <h1 class="text-xl font-bold tracking-wide text-emerald-400">📢 Channel ID Bot</h1>
          <span id="status-badge" class="px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
            Checking...
          </span>
        </div>

        <!-- Pairing Section -->
        <div id="setup-section" class="space-y-4">
          <p class="text-sm text-slate-400">
            Enter your WhatsApp number with country code<br>
            (e.g. <span class="text-slate-200">2348123456789</span>)
          </p>
          <div>
            <label class="block text-xs font-medium text-slate-400 mb-1">Phone Number</label>
            <input type="text" id="phone-input" placeholder="2348123456789"
              class="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-slate-100 focus:outline-none focus:border-emerald-500 text-sm">
          </div>
          <button onclick="requestPairingCode()" id="pair-btn"
            class="w-full bg-emerald-600 hover:bg-emerald-500 font-semibold py-3 rounded-xl transition text-sm shadow-lg shadow-emerald-900/30 cursor-pointer">
            Get Pairing Code
          </button>
        </div>

        <div id="code-container" class="hidden mt-6 bg-slate-950 border border-slate-800 rounded-xl p-4 text-center">
          <p class="text-xs text-slate-400 mb-2">Your 8-Digit Pairing Code:</p>
          <div id="pairing-code-display" class="text-3xl font-mono font-bold tracking-widest text-emerald-400 select-all">
            ---- - ----
          </div>
          <p class="text-xs text-slate-500 mt-3">
            WhatsApp → Linked Devices → Link a Device →<br>
            <strong>Link with phone number instead</strong>
          </p>
        </div>

        <div id="connected-banner" class="hidden mt-6 bg-emerald-950/40 border border-emerald-800/50 rounded-xl p-4 text-center">
          <p class="text-emerald-400 font-semibold text-sm">✅ Bot is connected!</p>
        </div>

        <!-- Channel Tools -->
        <div id="tools-section" class="hidden mt-6 space-y-4 border-t border-slate-800 pt-6">
          <h2 class="text-sm font-semibold text-slate-300">Get Channel ID from Invite</h2>
          <input type="text" id="invite-input" placeholder="https://whatsapp.com/channel/0029Va..."
            class="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-slate-100 focus:outline-none focus:border-emerald-500 text-sm">
          <button onclick="resolveInvite()" id="resolve-btn"
            class="w-full bg-blue-600 hover:bg-blue-500 font-semibold py-3 rounded-xl transition text-sm cursor-pointer">
            Get Channel ID
          </button>
          <div id="channel-result" class="hidden bg-slate-950 border border-slate-800 rounded-xl p-4 text-sm"></div>

          <h2 class="text-sm font-semibold text-slate-300 mt-4">Create New Channel</h2>
          <input type="text" id="name-input" placeholder="Channel Name"
            class="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-slate-100 focus:outline-none focus:border-emerald-500 text-sm">
          <input type="text" id="desc-input" placeholder="Description (optional)"
            class="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-slate-100 focus:outline-none focus:border-emerald-500 text-sm">
          <button onclick="createChannel()" id="create-btn"
            class="w-full bg-purple-600 hover:bg-purple-500 font-semibold py-3 rounded-xl transition text-sm cursor-pointer">
            Create Channel
          </button>
          <div id="create-result" class="hidden bg-slate-950 border border-slate-800 rounded-xl p-4 text-sm"></div>
        </div>
      </div>

      <script>
        async function fetchStatus() {
          try {
            const res = await fetch('/api/status');
            const data = await res.json();
            const badge = document.getElementById('status-badge');
            const setupSec = document.getElementById('setup-section');
            const connectedBanner = document.getElementById('connected-banner');
            const tools = document.getElementById('tools-section');

            if (data.connected) {
              badge.className = "px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20";
              badge.innerText = "Connected";
              setupSec.classList.add('hidden');
              document.getElementById('code-container').classList.add('hidden');
              connectedBanner.classList.remove('hidden');
              tools.classList.remove('hidden');
            } else {
              badge.className = "px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20";
              badge.innerText = "Waiting for Pairing";
              setupSec.classList.remove('hidden');
              connectedBanner.classList.add('hidden');
              tools.classList.add('hidden');
            }
          } catch (e) {}
        }

        async function requestPairingCode() {
          const phone = document.getElementById('phone-input').value.trim();
          const btn = document.getElementById('pair-btn');
          if (!phone) {
            alert("Please enter a valid phone number.");
            return;
          }

          btn.innerText = "Generating...";
          btn.disabled = true;

          try {
            const res = await fetch('/api/pair', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ phone })
            });
            const data = await res.json();

            if (data.success && data.code) {
              const formatted = data.code.match(/.{1,4}/g)?.join('-') || data.code;
              document.getElementById('pairing-code-display').innerText = formatted;
              document.getElementById('code-container').classList.remove('hidden');
            } else {
              alert(data.error || "Failed to generate pairing code.");
            }
          } catch (e) {
            alert("Network error occurred.");
          } finally {
            btn.innerText = "Get Pairing Code";
            btn.disabled = false;
          }
        }

        async function resolveInvite() {
          const invite = document.getElementById('invite-input').value.trim();
          const resultDiv = document.getElementById('channel-result');
          if (!invite) return alert("Paste the channel invite link");

          resultDiv.classList.remove('hidden');
          resultDiv.innerHTML = '<p class="text-slate-400">Resolving...</p>';

          try {
            const res = await fetch('/api/channel-from-invite', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ invite })
            });
            const data = await res.json();

            if (!data.success) {
              resultDiv.innerHTML = \`<p class="text-red-400">\${data.error || 'Failed'}</p>\`;
              return;
            }

            const ch = data.channel;
            resultDiv.innerHTML = \`
              <p class="text-slate-400 text-xs mb-1">Channel Name</p>
              <p class="font-semibold mb-3">\${ch.name}</p>
              <p class="text-slate-400 text-xs mb-1">Channel ID</p>
              <p class="font-mono text-emerald-400 break-all mb-2" id="ch-id">\${ch.id}</p>
              <button onclick="navigator.clipboard.writeText(document.getElementById('ch-id').innerText).then(()=>alert('Copied!'))"
                class="text-xs bg-slate-800 hover:bg-slate-700 px-3 py-1.5 rounded-lg cursor-pointer">
                Copy ID
              </button>
            \`;
          } catch (e) {
            resultDiv.innerHTML = '<p class="text-red-400">Network error</p>';
          }
        }

        async function createChannel() {
          const name = document.getElementById('name-input').value.trim();
          const description = document.getElementById('desc-input').value.trim();
          const resultDiv = document.getElementById('create-result');
          if (!name) return alert("Channel name required");

          resultDiv.classList.remove('hidden');
          resultDiv.innerHTML = '<p class="text-slate-400">Creating...</p>';

          try {
            const res = await fetch('/api/create-channel', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name, description })
            });
            const data = await res.json();

            if (!data.success) {
              resultDiv.innerHTML = \`<p class="text-red-400">\${data.error || 'Failed'}</p>\`;
              return;
            }

            const ch = data.channel;
            resultDiv.innerHTML = \`
              <p class="text-emerald-400 font-semibold mb-2">Created!</p>
              <p class="text-slate-400 text-xs mb-1">Channel ID</p>
              <p class="font-mono text-emerald-400 break-all mb-2" id="new-ch-id">\${ch.id}</p>
              <button onclick="navigator.clipboard.writeText(document.getElementById('new-ch-id').innerText).then(()=>alert('Copied!'))"
                class="text-xs bg-slate-800 hover:bg-slate-700 px-3 py-1.5 rounded-lg cursor-pointer">
                Copy ID
              </button>
            \`;
          } catch (e) {
            resultDiv.innerHTML = '<p class="text-red-400">Network error</p>';
          }
        }

        setInterval(fetchStatus, 3000);
        fetchStatus();
      </script>
    </body>
    </html>
  `);
});

// ========== API ==========
app.get("/api/status", (req, res) => {
  res.json({ connected: isConnected });
});

// Same pairing logic as your working bot
app.post("/api/pair", async (req, res) => {
  const { phone } = req.body;
  if (!phone) {
    return res.status(400).json({ success: false, error: "Phone number is required." });
  }

  if (isConnected) {
    return res.json({ success: false, error: "Bot is already connected." });
  }

  try {
    const cleanNumber = phone.replace(/[^0-9]/g, "");

    if (!sock) {
      return res.status(500).json({
        success: false,
        error: "Bot socket not ready yet. Please wait a few seconds and try again."
      });
    }

    // Small delay improves pairing success rate
    await new Promise(r => setTimeout(r, 1500));

    const code = await sock.requestPairingCode(cleanNumber);
    console.log("Pairing code generated:", code);

    res.json({ success: true, code });
  } catch (err) {
    console.error("Pairing code error:", err);
    res.status(500).json({
      success: false,
      error: err.message || "Failed to get pairing code."
    });
  }
});

app.post("/api/channel-from-invite", async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(400).json({ success: false, error: "Bot is not connected yet." });
  }

  try {
    let { invite } = req.body;
    if (!invite) {
      return res.status(400).json({ success: false, error: "Invite link is required." });
    }

    invite = invite.trim();
    const match = invite.match(/channel\/([A-Za-z0-9]+)/);
    const code = match ? match[1] : invite;

    const metadata = await sock.newsletterMetadata("invite", code);

    if (!metadata?.id) {
      return res.status(404).json({ success: false, error: "Channel not found." });
    }

    res.json({
      success: true,
      channel: {
        id: metadata.id,
        name: metadata.name || "Unknown",
        description: metadata.description || "",
        subscribers: metadata.subscribers || 0
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message || "Failed to resolve channel." });
  }
});

app.post("/api/create-channel", async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(400).json({ success: false, error: "Bot is not connected yet." });
  }

  try {
    const { name, description } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, error: "Channel name is required." });
    }

    const metadata = await sock.newsletterCreate(name, description || "");

    res.json({
      success: true,
      channel: {
        id: metadata.id,
        name: metadata.name,
        description: metadata.description || "",
        invite: metadata.invite || ""
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message || "Failed to create channel." });
  }
});

// ========== Baileys (same style as your working bot) ==========
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  let version;
  try {
    const result = await fetchLatestBaileysVersion();
    version = result.version;
  } catch (e) {
    version = undefined; // let the library use its default
  }

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }))
    },
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,

    // Browser identity – helps pairing succeed
    browser: ["Ubuntu", "Chrome", "20.0.04"],

    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
    if (connection === "close") {
      isConnected = false;

      const statusCode =
        lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output?.statusCode
          : lastDisconnect?.error?.output?.statusCode;

      console.log("Connection closed. Code:", statusCode);

      // 515 = normal restart after successful pairing
      // 401 / loggedOut = bad session → delete and restart
      const isLoggedOut =
        statusCode === DisconnectReason.loggedOut || statusCode === 401;

      if (isLoggedOut) {
        try {
          if (fs.existsSync(AUTH_FOLDER)) {
            fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
          }
        } catch (e) {}
      }

      setTimeout(startBot, statusCode === 515 ? 1500 : 3000);
    } else if (connection === "open") {
      isConnected = true;
      console.log("✅ Channel ID Bot connected!");
    }
  });
}

// Start
app.listen(PORT, () => {
  console.log(`🚀 Dashboard: http://localhost:${PORT}`);
  startBot();
});

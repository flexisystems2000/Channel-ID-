const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const fs = require('fs');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers
} = require('@whiskeysockets/baileys');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const AUTH_FOLDER = './auth_info_baileys';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let sock = null;
let clientStatus = 'disconnected'; // disconnected | waiting_number | pairing | connecting | ready
let pairingCode = null;
let pairingRequested = false;

async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,

        // ========== IMPORTANT: Browser Identity ==========
        // This makes pairing more successful
        browser: Browsers.ubuntu('Chrome'),
        // Alternative that also works well:
        // browser: ['Ubuntu', 'Chrome', '20.0.04'],
        // browser: Browsers.macOS('Desktop'),
        // browser: ['Windows', 'Chrome', 'Chrome 114.0.5735.198'],

        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        connectTimeoutMs: 60_000,
        defaultQueryTimeoutMs: 60_000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (connection === 'connecting') {
            clientStatus = 'connecting';
            io.emit('status', { status: 'connecting', message: 'Connecting to WhatsApp...' });
        }

        // When QR event fires → we can request pairing code
        if (qr && !sock.authState.creds.registered && !pairingRequested) {
            clientStatus = 'waiting_number';
            io.emit('status', {
                status: 'waiting_number',
                message: 'Enter your phone number below to get the Pairing Code'
            });
            io.emit('need_number', true);
        }

        if (connection === 'open') {
            clientStatus = 'ready';
            pairingCode = null;
            pairingRequested = false;
            console.log('✅ WhatsApp connected successfully!');
            io.emit('status', {
                status: 'ready',
                message: 'WhatsApp is connected and ready!'
            });
            io.emit('pairing_code', null);
            io.emit('need_number', false);
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output?.statusCode
                : 0;

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log('Connection closed. Code:', statusCode, '| Reconnect:', shouldReconnect);

            clientStatus = 'disconnected';
            pairingCode = null;
            pairingRequested = false;

            io.emit('status', {
                status: 'disconnected',
                message: shouldReconnect
                    ? 'Disconnected. Reconnecting...'
                    : 'Logged out. Please pair again.'
            });
            io.emit('pairing_code', null);
            io.emit('need_number', false);

            if (shouldReconnect) {
                setTimeout(() => startWhatsApp(), 3000);
            } else {
                // Clean session
                try {
                    if (fs.existsSync(AUTH_FOLDER)) {
                        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
                    }
                } catch (e) {}
                setTimeout(() => startWhatsApp(), 2000);
            }
        }
    });
}

// Start on boot
startWhatsApp().catch(console.error);

// ========== Socket.io ==========
io.on('connection', (socket) => {
    console.log('Dashboard connected');

    socket.emit('status', {
        status: clientStatus,
        message: getStatusMessage(clientStatus)
    });

    if (pairingCode) {
        socket.emit('pairing_code', pairingCode);
    }

    if (clientStatus === 'waiting_number') {
        socket.emit('need_number', true);
    }

    // User submitted phone number → request pairing code
    socket.on('request_pairing', async (phoneNumber) => {
        if (!sock || sock.authState.creds.registered) {
            socket.emit('pairing_error', 'Already registered or socket not ready');
            return;
        }

        // Clean number: only digits + country code
        const cleanNumber = String(phoneNumber).replace(/\D/g, '');

        if (cleanNumber.length < 10 || cleanNumber.length > 15) {
            socket.emit('pairing_error', 'Invalid phone number. Use country code + number (e.g. 2348012345678)');
            return;
        }

        try {
            pairingRequested = true;
            clientStatus = 'pairing';
            io.emit('status', { status: 'pairing', message: 'Generating pairing code...' });

            // Small delay improves success rate
            await new Promise(r => setTimeout(r, 2000));

            const code = await sock.requestPairingCode(cleanNumber);

            pairingCode = code;
            console.log('Pairing Code:', code);

            io.emit('pairing_code', code);
            io.emit('status', {
                status: 'pairing',
                message: 'Enter this code on your phone (Linked Devices → Link with phone number)'
            });
            io.emit('need_number', false);

        } catch (err) {
            console.error('Pairing code error:', err);
            pairingRequested = false;
            clientStatus = 'waiting_number';
            io.emit('pairing_error', err.message || 'Failed to generate pairing code');
            io.emit('status', {
                status: 'waiting_number',
                message: 'Failed. Try again with a valid number.'
            });
            io.emit('need_number', true);
        }
    });

    socket.on('restart', async () => {
        try {
            if (sock) {
                sock.end(undefined);
                sock = null;
            }
            pairingRequested = false;
            pairingCode = null;
            clientStatus = 'disconnected';
            io.emit('status', { status: 'disconnected', message: 'Restarting...' });
            setTimeout(() => startWhatsApp(), 1500);
        } catch (err) {
            console.error(err);
        }
    });

    socket.on('logout', async () => {
        try {
            if (sock) {
                await sock.logout();
                sock.end(undefined);
                sock = null;
            }
            if (fs.existsSync(AUTH_FOLDER)) {
                fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
            }
            pairingRequested = false;
            pairingCode = null;
            clientStatus = 'disconnected';
            io.emit('status', { status: 'disconnected', message: 'Logged out. Pair again.' });
            setTimeout(() => startWhatsApp(), 1500);
        } catch (err) {
            console.error(err);
        }
    });
});

function getStatusMessage(status) {
    const map = {
        disconnected: 'Not connected',
        waiting_number: 'Enter your phone number to get Pairing Code',
        pairing: 'Enter the code on your phone',
        connecting: 'Connecting...',
        ready: 'WhatsApp is connected and ready!'
    };
    return map[status] || status;
}

// ========== API ==========

app.get('/api/status', (req, res) => {
    res.json({ status: clientStatus, message: getStatusMessage(clientStatus) });
});

// Resolve Channel ID from Invite Link
app.post('/api/channel-from-invite', async (req, res) => {
    if (clientStatus !== 'ready' || !sock) {
        return res.status(400).json({ success: false, message: 'WhatsApp is not ready yet' });
    }

    try {
        let { invite } = req.body;
        if (!invite) return res.status(400).json({ success: false, message: 'Invite required' });

        invite = invite.trim();
        const match = invite.match(/channel\/([A-Za-z0-9]+)/);
        const code = match ? match[1] : invite;

        const metadata = await sock.newsletterMetadata('invite', code);

        if (!metadata?.id) {
            return res.status(404).json({ success: false, message: 'Channel not found' });
        }

        res.json({
            success: true,
            channel: {
                id: metadata.id,
                name: metadata.name || 'Unknown',
                description: metadata.description || '',
                subscribers: metadata.subscribers || 0,
                invite: metadata.invite || code
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: err.message || 'Failed' });
    }
});

// Create Channel
app.post('/api/create-channel', async (req, res) => {
    if (clientStatus !== 'ready' || !sock) {
        return res.status(400).json({ success: false, message: 'WhatsApp is not ready yet' });
    }

    try {
        const { name, description } = req.body;
        if (!name) return res.status(400).json({ success: false, message: 'Name required' });

        const metadata = await sock.newsletterCreate(name, description || '');

        res.json({
            success: true,
            channel: {
                id: metadata.id,
                name: metadata.name,
                description: metadata.description || '',
                invite: metadata.invite || ''
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: err.message || 'Failed' });
    }
});

server.listen(PORT, () => {
    console.log(`\n🚀 Baileys Channel Bot (Pairing Code)`);
    console.log(`👉 Dashboard: http://localhost:${PORT}\n`);
});

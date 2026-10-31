const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// Render needs an active port to keep the web service alive
app.get('/', (req, res) => {
    res.send('Flexi Educational Consult Bot is running and connected!');
});

app.listen(PORT, () => {
    console.log(`🌐 Server is listening on port ${PORT}`);
    startBot();
});

const TARGET_PHONE_NUMBER = '2347033855206';

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Chrome'),
        auth: state
    });

    sock.ev.on('creds.update', saveCreds);

    // Automatically request the pairing code on startup if not registered
    if (!sock.authState.creds.registered) {
        console.log(`\n⏳ Requesting pairing code for ${TARGET_PHONE_NUMBER} on Render...`);
        
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(TARGET_PHONE_NUMBER);
                console.log('\n=============================================');
                console.log(`🔑 YOUR RENDER PAIRING CODE IS: \x1b[32m${code}\x1b[0m`);
                console.log('=============================================');
                console.log('👉 Go to WhatsApp on your phone -> Linked Devices -> Link a Device -> Link with phone number instead, and enter this code.');
            } catch (err) {
                console.error('❌ Failed to generate pairing code:', err.message);
            }
        }, 5000);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            console.log('\n✅ Bot successfully paired and connected on Render!');

            // --- FETCH YOUR CHANNEL ID AUTOMATICALLY ---
            try {
                console.log('🔍 Fetching channels...');
                const channels = await sock.newsletterFetchSubscribed();
                
                if (channels && channels.length > 0) {
                    console.log('\n================ FOUND CHANNELS ================');
                    channels.forEach((ch, idx) => {
                        console.log(`${idx + 1}. Name : ${ch.name}`);
                        console.log(`   JID  : \x1b[36m${ch.id}\x1b[0m`);
                        console.log('-----------------------------------------------');
                    });
                } else {
                    console.log('ℹ️ No channels found on this account yet.');
                }
            } catch (err) {
                console.log('Could not fetch channels:', err.message);
            }
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log('🔄 Reconnecting...');
                startBot();
            } else {
                console.log('❌ Connection closed. Logged out.');
            }
        }
    });
}

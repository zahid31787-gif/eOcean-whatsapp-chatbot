const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const TEAM_NUMBER = process.env.TEAM_NUMBER;

if (!WEBHOOK_URL) {
    throw new Error('N8N_WEBHOOK_URL is missing.');
}

if (!WEBHOOK_SECRET) {
    throw new Error('WEBHOOK_SECRET is missing.');
}

const client = new Client({
    authStrategy: new LocalAuth({
        clientId: 'eocean-assistant'
    }),
    puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
}
});

// NEW (2): sends a lead alert to the team. A failure here never affects the customer.
async function notifyTeam(msg, message, reply) {
    try {
        const contact = await msg.getContact();
        const name = contact.pushname || contact.name || 'Unknown';
        const number = contact.number ? '+' + contact.number : msg.from;

        await client.sendMessage(
            TEAM_NUMBER + '@c.us',
            'New eOcean customer request\n\n' +
            'Name: ' + name + '\n' +
            'Number: ' + number + '\n' +
            'Chat ID: ' + msg.from + '\n\n' +
            'Customer message:\n' + message + '\n\n' +
            'Bot reply:\n' + reply
        );
        console.log('Team notified about:', msg.from);
    } catch (e) {
        console.error('Team alert failed:', e.message);
    }
}

client.on('qr', (qr) => {
    console.log('Scan this QR code using WhatsApp:');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
    console.log('WhatsApp authenticated.');
});

client.on('ready', () => {
    console.log('Eocean WhatsApp Assistant is ready!');
});

client.on('auth_failure', (error) => {
    console.error('WhatsApp authentication failed:', error);
});

client.on('message', async (msg) => {
    try {
        if (
            msg.fromMe ||
            msg.from.endsWith('@g.us') ||
            msg.from === 'status@broadcast'
        ) {
            return;
        }

        const message = msg.body.trim();
        if (!message) return;

        console.log('Incoming message from:', msg.from);

        const response = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: {
    'Content-Type': 'application/json',
    'x-webhook-secret': WEBHOOK_SECRET
},
            body: JSON.stringify({
                from: msg.from,
                message: message,
                messageId: msg.id._serialized
            }),
            signal: AbortSignal.timeout(90000)
        });

        const responseText = await response.text();

        if (!response.ok) {
            throw new Error(
                `n8n HTTP ${response.status}: ${responseText.slice(0, 300)}`
            );
        }

        let result;

        try {
            result = JSON.parse(responseText);
        } catch {
            throw new Error('n8n returned an invalid JSON response.');
        }

        if (result.success === false) {
            throw new Error('n8n reported that message processing failed.');
        }

        if (typeof result.reply !== 'string' || !result.reply.trim()) {
            throw new Error('n8n response does not contain a valid reply.');
        }

        await msg.reply(result.reply.trim());

        console.log('Reply successfully sent to:', msg.from);

        // NEW (3): after the customer has their reply, alert the team if needed
        if (result.notify === true) {
            await notifyTeam(msg, message, result.reply.trim());
        }

    } catch (error) {
        console.error('Message processing error:', error.message);
    }
});

client.on('disconnected', (reason) => {
    console.log('WhatsApp disconnected:', reason);
});

client.initialize();
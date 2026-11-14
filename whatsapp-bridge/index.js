const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
require('dotenv').config();

const QRCode = require('qrcode');
const http = require('http');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ==========================================
// 1. RAILWAY QR WEBPAGE SERVER
// ==========================================

let latestQR = null;

const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // Health check
  if (url.pathname === '/') {
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Cache-Control': 'no-store'
    });

    return res.end('Eocean WhatsApp Assistant is running!');
  }

  // QR webpage
  if (url.pathname === '/qr') {
    const token = process.env.QR_VIEW_TOKEN;

    if (!token || url.searchParams.get('key') !== token) {
      res.writeHead(403, {
        'Content-Type': 'text/plain'
      });

      return res.end('Access denied. Check your QR access token.');
    }

    // Wait for WhatsApp to generate QR
    if (!latestQR) {
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-store'
      });

      return res.end(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <meta http-equiv="refresh" content="5">
          <title>Eocean WhatsApp QR</title>
        </head>
        <body style="font-family:Arial;text-align:center;padding:30px">
          <h2>Waiting for WhatsApp QR code...</h2>
          <p>This page will refresh automatically.</p>
        </body>
        </html>
      `);
    }

    try {
      const qrImage = await QRCode.toDataURL(latestQR, {
        width: 400,
        margin: 3,
        errorCorrectionLevel: 'M'
      });

      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-store'
      });

      return res.end(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <meta http-equiv="refresh" content="15">
          <title>Eocean WhatsApp QR</title>
        </head>

        <body style="
          font-family:Arial,sans-serif;
          text-align:center;
          padding:20px;
          background:#f5f5f5;
        ">

          <h2>Eocean WhatsApp Assistant</h2>

          <p>Open WhatsApp on your phone and scan this QR code.</p>

          <div style="
            background:white;
            display:inline-block;
            padding:15px;
            border-radius:12px;
          ">
            <img
              src="${qrImage}"
              alt="WhatsApp QR Code"
              style="width:min(400px,85vw);height:auto"
            >
          </div>

          <p>Keep this page open while scanning.</p>
          <p>QR refreshes automatically every 15 seconds.</p>

        </body>
        </html>
      `);

    } catch (error) {
      console.error('QR generation error:', error.message);

      res.writeHead(500);
      return res.end('Could not generate QR code.');
    }
  }

  res.writeHead(404);
  res.end('Page not found.');
});

// Start HTTP server for Railway
server.listen(PORT, '0.0.0.0', () => {
  console.log(`QR webpage server running on port ${PORT}`);
});

server.on('error', (error) => {
  console.error('HTTP server error:', error);
});

// ==========================================
// 2. REMOVE STALE CHROMIUM LOCKS
// ==========================================

// Run only when no other instance is using this WhatsApp profile.
const chromeProfile = path.join(
  '/app/.wwebjs_auth',
  'session-eocean-assistant'
);

for (const lock of [
  'SingletonLock',
  'SingletonSocket',
  'SingletonCookie'
]) {
  const lockPath = path.join(chromeProfile, lock);

  try {
    fs.unlinkSync(lockPath);
    console.log(`Removed stale Chromium lock: ${lock}`);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

// ==========================================
// 3. ENVIRONMENT VARIABLES
// ==========================================

const WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const TEAM_NUMBER = process.env.TEAM_NUMBER;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!WEBHOOK_URL) {
  throw new Error('N8N_WEBHOOK_URL is missing.');
}

if (!WEBHOOK_SECRET) {
  throw new Error('WEBHOOK_SECRET is missing.');
}

const GEMINI_BASE =
  'https://generativelanguage.googleapis.com/v1beta/models';

const TRANSCRIPTION_MODEL =
  process.env.GEMINI_TRANSCRIPTION_MODEL || 'gemini-2.5-flash';

const TTS_MODEL =
  process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';

const TTS_VOICE =
  process.env.GEMINI_TTS_VOICE || 'Kore';

// ==========================================
// 4. WHATSAPP CLIENT
// ==========================================

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: 'eocean-assistant',
    dataPath: '/app/.wwebjs_auth'
  }),

  puppeteer: {
  headless: true,
  protocolTimeout: 180000,

    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      (
        process.platform === 'win32'
          ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
          : '/usr/bin/chromium'
      ),

    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--disable-extensions',
      '--disable-background-networking'
    ]
  }
});

// ==========================================
// 5. GEMINI API
// ==========================================

async function geminiGenerate(model, contents, generationConfig) {
  if (!GEMINI_API_KEY) {
    throw new Error(
      'GEMINI_API_KEY is missing. Add it to enable voice features.'
    );
  }

  const response = await fetch(
    `${GEMINI_BASE}/${model}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
    {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json'
      },

      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: contents
          }
        ],

        ...(generationConfig
          ? { generationConfig }
          : {})
      }),

      signal: AbortSignal.timeout(90000)
    }
  );

  const raw = await response.text();

  if (!response.ok) {
    throw new Error(
      `Gemini ${model} HTTP ${response.status}: ${raw.slice(0, 500)}`
    );
  }

  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Gemini ${model} returned invalid JSON.`);
  }

  return data;
}

// ==========================================
// 6. TRANSCRIBE WHATSAPP VOICE NOTES
// ==========================================

async function transcribeVoiceNote(msg) {
  const media = await msg.downloadMedia();

  if (!media || !media.data) {
    throw new Error('WhatsApp could not download the voice note.');
  }

  const audio = Buffer.from(media.data, 'base64');

  if (!audio.length) {
    throw new Error('Downloaded voice note is empty.');
  }

  if (audio.length > 18 * 1024 * 1024) {
    throw new Error(
      'Voice note is too large for inline Gemini processing (limit: 18 MB).'
    );
  }

  const mimeType = (media.mimetype || 'audio/ogg')
    .split(';')[0]
    .trim()
    .toLowerCase();

  const result = await geminiGenerate(
    TRANSCRIPTION_MODEL,
    [
      {
        text:
          'Transcribe the spoken words exactly. Preserve the original language and script. Support English, Urdu, and mixed Urdu-English/Roman Urdu. Do not translate, summarize, answer the speaker, or add commentary. Return only the transcript.'
      },

      {
        inline_data: {
          mime_type: mimeType,
          data: audio.toString('base64')
        }
      }
    ],
    {
      temperature: 0.1,
      maxOutputTokens: 2048
    }
  );

  const transcript = (
    result.candidates?.[0]?.content?.parts || []
  )
    .map(part => part.text || '')
    .join('')
    .trim();

  if (!transcript) {
    throw new Error('Gemini did not return a transcript.');
  }

  return transcript;
}

// ==========================================
// 7. GENERATE GEMINI VOICE REPLY
// ==========================================

async function createVoiceReply(text) {
  const result = await geminiGenerate(
    TTS_MODEL,
    [
      {
        text: `Read the following customer-support reply aloud in a natural, clear, friendly voice. Speak in the same language and script as the text. Do not translate, summarize, or add words.

${text}`
      }
    ],
    {
      responseModalities: ['AUDIO'],

      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: TTS_VOICE
          }
        }
      }
    }
  );

  const audioPart = (
    result.candidates?.[0]?.content?.parts || []
  ).find(
    part => part.inlineData?.data || part.inline_data?.data
  );

  const audioData =
    audioPart?.inlineData?.data ||
    audioPart?.inline_data?.data;

  if (!audioData) {
    throw new Error('Gemini TTS did not return audio data.');
  }

  const pcm = Buffer.from(audioData, 'base64');

  // Convert PCM audio into OGG/Opus for WhatsApp
  const ogg = execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-f', 's16le',
      '-ar', '24000',
      '-ac', '1',
      '-i', 'pipe:0',
      '-c:a', 'libopus',
      '-b:a', '32k',
      '-vbr', 'on',
      '-f', 'ogg',
      'pipe:1'
    ],
    {
      input: pcm,
      maxBuffer: 20 * 1024 * 1024,
      timeout: 60000
    }
  );

  if (!ogg.length) {
    throw new Error('FFmpeg produced an empty voice reply.');
  }

  return new MessageMedia(
    'audio/ogg',
    ogg.toString('base64'),
    'eocean-reply.ogg'
  );
}

// ==========================================
// 8. NOTIFY TEAM
// ==========================================

async function notifyTeam(msg, message, reply) {
  try {
    if (!TEAM_NUMBER) {
      console.warn(
        'TEAM_NUMBER is not configured; skipping team notification.'
      );

      return;
    }

    const contact = await msg.getContact();

    const name =
      contact.pushname || contact.name || 'Unknown';

    const number =
      contact.number ? '+' + contact.number : msg.from;

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

// ==========================================
// 9. SEND MESSAGE TO EXISTING N8N WORKFLOW
// ==========================================

async function sendToExistingN8n(msg, message) {
  const response = await fetch(WEBHOOK_URL, {
    method: 'POST',

    headers: {
      'Content-Type': 'application/json',
      'x-webhook-secret': WEBHOOK_SECRET
    },

    body: JSON.stringify({
      from: msg.from,
      message,
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
    throw new Error(
      'n8n reported that message processing failed.'
    );
  }

  if (
    typeof result.reply !== 'string' ||
    !result.reply.trim()
  ) {
    throw new Error(
      'n8n response does not contain a valid reply.'
    );
  }

  return result;
}

// ==========================================
// 10. WHATSAPP QR EVENT
// ==========================================

client.on('qr', (qr) => {
  latestQR = qr;

  console.log('New WhatsApp QR received.');
  console.log('Open your Railway domain followed by /qr');
});

// ==========================================
// 11. WHATSAPP CONNECTION EVENTS
// ==========================================

client.on('authenticated', () => {
  console.log('WhatsApp authenticated.');
});

client.on('ready', () => {
  latestQR = null;

  console.log('Eocean WhatsApp Assistant is ready!');
});

client.on('auth_failure', (error) => {
  console.error('WhatsApp authentication failed:', error);
});

client.on('disconnected', (reason) => {
  console.log('WhatsApp disconnected:', reason);
});

// ==========================================
// 12. HANDLE INCOMING WHATSAPP MESSAGES
// ==========================================

client.on('message', async (msg) => {
  try {
    console.log('MESSAGE EVENT RECEIVED:', {
      from: msg.from,
      fromMe: msg.fromMe,
      type: msg.type
    });


    if (
      msg.fromMe ||
      msg.from.endsWith('@g.us') ||
      msg.from === 'status@broadcast'
    ) {
      return;
    }

    const isVoiceNote =
      msg.hasMedia &&
      (msg.type === 'ptt' || msg.type === 'audio');

    let customerMessage;

    // Transcribe voice notes
    if (isVoiceNote) {
      console.log(
        'Incoming WhatsApp voice note from:',
        msg.from
      );

      customerMessage = await transcribeVoiceNote(msg);

      console.log('Voice-note transcript:', customerMessage);

    } else {
      customerMessage = (msg.body || '').trim();

      if (!customerMessage) return;

      console.log('Incoming message from:', msg.from);
    }

    // Send message to existing n8n workflow
    const result = await sendToExistingN8n(
      msg,
      customerMessage
    );

    const reply = result.reply.trim();

    // Send text reply
    await msg.reply(reply);

    console.log(
      'Text reply successfully sent to:',
      msg.from
    );

    // Send additional voice reply only for voice-note inputs
    if (isVoiceNote) {
      try {
        const voiceMedia = await createVoiceReply(reply);

        await client.sendMessage(
          msg.from,
          voiceMedia,
          {
            sendAudioAsVoice: true
          }
        );

        console.log(
          'Voice reply successfully sent to:',
          msg.from
        );

      } catch (voiceError) {
        console.error(
          'Voice reply failed (text reply was already sent):',
          voiceError.message
        );
      }
    }

    // Notify team when requested by n8n
    if (result.notify === true) {
      await notifyTeam(
        msg,
        customerMessage,
        reply
      );
    }

  } catch (error) {
    console.error(
      'Message processing error:',
      error.message
    );
  }
});

// ==========================================
// 13. START WHATSAPP
// ==========================================

console.log('Starting Eocean WhatsApp Assistant...');

client.initialize().catch((error) => {
  console.error(
    'WhatsApp initialization failed:',
    error
  );

  process.exit(1);
});
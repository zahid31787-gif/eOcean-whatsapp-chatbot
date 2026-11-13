
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Remove stale Chromium singleton locks.
// Run only when no other instance is using this WhatsApp profile.
const chromeProfile = path.join(
  '/app/.wwebjs_auth',
  'session-eocean-assistant'
);

for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
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

const WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const TEAM_NUMBER = process.env.TEAM_NUMBER;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!WEBHOOK_URL) throw new Error('N8N_WEBHOOK_URL is missing.');
if (!WEBHOOK_SECRET) throw new Error('WEBHOOK_SECRET is missing.');

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const TRANSCRIPTION_MODEL = process.env.GEMINI_TRANSCRIPTION_MODEL || 'gemini-2.5-flash';
const TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
const TTS_VOICE = process.env.GEMINI_TTS_VOICE || 'Kore';

// WhatsApp client configuration
const client = new Client({
  authStrategy: new LocalAuth({
    clientId: 'eocean-assistant',
    dataPath: '/app/.wwebjs_auth'
  }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
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

// Gemini API
async function geminiGenerate(model, contents, generationConfig) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is missing. Add it to enable voice features.');
  }

  const response = await fetch(
    `${GEMINI_BASE}/${model}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: contents }],
        ...(generationConfig ? { generationConfig } : {})
      }),
      signal: AbortSignal.timeout(90000)
    }
  );

  const raw = await response.text();

  if (!response.ok) {
    throw new Error(`Gemini ${model} HTTP ${response.status}: ${raw.slice(0, 500)}`);
  }

  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Gemini ${model} returned invalid JSON.`);
  }

  return data;
}

// Convert incoming WhatsApp voice note into text
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
    throw new Error('Voice note is too large for inline Gemini processing (limit: 18 MB).');
  }

  const mimeType = (media.mimetype || 'audio/ogg')
    .split(';')[0]
    .trim()
    .toLowerCase();

  const result = await geminiGenerate(
    TRANSCRIPTION_MODEL,
    [
      {
        text: 'Transcribe the spoken words exactly. Preserve the original language and script. Support English, Urdu, and mixed Urdu-English/Roman Urdu. Do not translate, summarize, answer the speaker, or add commentary. Return only the transcript.'
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

  const transcript = (result.candidates?.[0]?.content?.parts || [])
    .map(part => part.text || '')
    .join('')
    .trim();

  if (!transcript) {
    throw new Error('Gemini did not return a transcript.');
  }

  return transcript;
}

// Generate spoken reply using Gemini TTS
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

  const audioPart = (result.candidates?.[0]?.content?.parts || [])
    .find(part => part.inlineData?.data || part.inline_data?.data);

  const audioData = audioPart?.inlineData?.data || audioPart?.inline_data?.data;

  if (!audioData) {
    throw new Error('Gemini TTS did not return audio data.');
  }

  const pcm = Buffer.from(audioData, 'base64');

  // Convert 24 kHz PCM audio into OGG/Opus for WhatsApp
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

// Notify team about customer interaction
async function notifyTeam(msg, message, reply) {
  try {
    if (!TEAM_NUMBER) {
      console.warn('TEAM_NUMBER is not configured; skipping team notification.');
      return;
    }

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

// Send text or transcribed voice message to existing n8n workflow
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
    throw new Error(`n8n HTTP ${response.status}: ${responseText.slice(0, 300)}`);
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

  return result;
}

// Display WhatsApp QR code
client.on('qr', (qr) => {
  console.log('\nScan this QR code using WhatsApp:\n');

  qrcode.generate(qr, {
    small: true,
    errorCorrectionLevel: 'L'
  });
});

// WhatsApp connection events
client.on('authenticated', () => {
  console.log('WhatsApp authenticated.');
});

client.on('ready', () => {
  console.log('Eocean WhatsApp Assistant is ready!');
});

client.on('auth_failure', (error) => {
  console.error('WhatsApp authentication failed:', error);
});

client.on('disconnected', (reason) => {
  console.log('WhatsApp disconnected:', reason);
});

// Handle incoming WhatsApp messages
client.on('message', async (msg) => {
  try {
    if (
      msg.fromMe ||
      msg.from.endsWith('@g.us') ||
      msg.from === 'status@broadcast'
    ) {
      return;
    }

    const isVoiceNote =
      msg.hasMedia && (msg.type === 'ptt' || msg.type === 'audio');

    let customerMessage;

    // Transcribe voice notes
    if (isVoiceNote) {
      console.log('Incoming WhatsApp voice note from:', msg.from);

      customerMessage = await transcribeVoiceNote(msg);

      console.log('Voice-note transcript:', customerMessage);
    } else {
      customerMessage = (msg.body || '').trim();

      if (!customerMessage) return;

      console.log('Incoming message from:', msg.from);
    }

    // Send both text and transcribed voice messages to the same n8n workflow
    const result = await sendToExistingN8n(msg, customerMessage);

    const reply = result.reply.trim();

    // Send text reply
    await msg.reply(reply);

    console.log('Text reply successfully sent to:', msg.from);

    // Send additional voice reply only for voice-note inputs
    if (isVoiceNote) {
      try {
        const voiceMedia = await createVoiceReply(reply);

        await client.sendMessage(
          msg.from,
          voiceMedia,
          { sendAudioAsVoice: true }
        );

        console.log('Voice reply successfully sent to:', msg.from);
      } catch (voiceError) {
        console.error(
          'Voice reply failed (text reply was already sent):',
          voiceError.message
        );
      }
    }

    // Notify team when requested by n8n
    if (result.notify === true) {
      await notifyTeam(msg, customerMessage, reply);
    }

  } catch (error) {
    console.error('Message processing error:', error.message);
  }
});

// Initialize WhatsApp
console.log('Starting Eocean WhatsApp Assistant...');

client.initialize().catch((error) => {
  console.error('WhatsApp initialization failed:', error);
  process.exit(1);
});

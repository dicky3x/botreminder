const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const express = require('express');
const cron = require('node-cron');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

// ==========================================
// CONFIGURATION & CONSTANTS
// ==========================================
const TEST_MODE = false; // Ubah ke true jika ingin testing jeda 2 menit
const TARGET_PHONE = '6282112707476';
const KNOWN_TARGET_LID = '198689582755972@lid';
const TARGET_JID_PHONE = `${TARGET_PHONE}@s.whatsapp.net`;

const PORT = process.env.PORT || 3000;

// In-Memory Storage
let clockInTime = null; // Menyimpan string HH:MM
let scheduledReminderTimer = null; // Handler setTimeout
let sock = null;

// ==========================================
// EXPRESS KEEP-ALIVE SERVER
// ==========================================
const app = express();
app.get('/', (req, res) => {
  res.status(200).send('Bot OK - WhatsApp Reminder Active');
});

app.listen(PORT, () => {
  console.log(`[EXPRESS] Keep-alive server running on port ${PORT}`);
});

// ==========================================
// HELPER FUNCTIONS
// ==========================================

// Safe Message Sender (mencegah crash akibat Error 463 / ACK Timeout)
async function safeSendMessage(jid, content) {
  if (!sock) {
    console.error('[WA] Cannot send message: Socket is not initialized.');
    return;
  }
  try {
    const result = await sock.sendMessage(jid, content);
    console.log(`[WA] Message sent successfully to ${jid}`);
    return result;
  } catch (error) {
    console.error(`[WA ERROR] Failed to send message to ${jid}:`, error);
  }
}

// Menghitung jam pulang (ditambah 9 jam 30 menit)
function calculateClockOut(timeStr) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  const clockInDate = new Date();
  clockInDate.setHours(hours, minutes, 0, 0);

  // Tambah 9.5 jam (9 jam 30 menit)
  const clockOutDate = new Date(clockInDate.getTime() + (9.5 * 60 * 60 * 1000));
  
  const outHours = String(clockOutDate.getHours()).padStart(2, '0');
  const outMinutes = String(clockOutDate.getMinutes()).padStart(2, '0');
  
  return {
    clockOutStr: `${outHours}:${outMinutes}`,
    targetTimestamp: clockOutDate.getTime()
  };
}

// Menjadwalkan pengiriman reminder jam pulang
function scheduleReturnReminder(clockInStr, targetTimestamp) {
  if (scheduledReminderTimer) {
    clearTimeout(scheduledReminderTimer);
  }

  const { clockOutStr } = calculateClockOut(clockInStr);
  let delayMs = 0;

  if (TEST_MODE) {
    delayMs = 2 * 60 * 1000; // 2 Menit dalam Test Mode
    console.log(`[TEST MODE] Reminder dijadwalkan dalam 2 menit.`);
  } else {
    delayMs = targetTimestamp - Date.now();
  }

  if (delayMs <= 0) {
    console.log('[WA] Waktu clock-out sudah lewat untuk hari ini.');
    return;
  }

  console.log(`[SCHEDULE] Reminder pulang dijadwalkan dalam ${(delayMs / 1000 / 60).toFixed(1)} menit.`);

  scheduledReminderTimer = setTimeout(async () => {
    const message = `🔔 Waktunya Pulang! Masuk jam ${clockInStr}, pulang jam ${clockOutStr}`;
    
    // Kirim ke LID utama dan fallback Phone JID
    await safeSendMessage(KNOWN_TARGET_LID, { text: message });
    
    // Reset state
    clockInTime = null;
    scheduledReminderTimer = null;
  }, delayMs);
}

// ==========================================
// MAIN BOT CONNECTION
// ==========================================
async function startBot() {
  console.log('[WA] Starting WhatsApp Bot...');

  // 1. Multi-file Auth State disimpan di /tmp/auth agar terhindar dari krisis izin di Railway
  const { state, saveCreds } = await useMultiFileAuthState('/tmp/auth');
  const { version } = await fetchLatestBaileysVersion();

  // 2. Solusi Wajib atasi Error 463 & ACK Timeout
  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: true,
    fireInitQueries: false,
    browser: ["Chrome", "Chrome", "120"]
  });

  // Handle Event Credentials Update
  sock.ev.on('creds.update', saveCreds);

  // Handle Connection Updates
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n================ QR CODE ================');
      qrcode.generate(qr, { small: true });
      console.log('=========================================\n');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      console.log(`[WA] Connection closed. Reason code: ${statusCode}. Reconnecting in 3s: ${shouldReconnect}`);
      
      if (shouldReconnect) {
        setTimeout(startBot, 3000);
      } else {
        console.log('[WA] Connection logged out. Cleaning auth directory recommended.');
      }
    } else if (connection === 'open') {
      console.log('[WA] WhatsApp Connection Successfully Opened! 🎉');
      setupCronJobs();
    }
  });

  // Handle Incoming Messages
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid;
      const text = (
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        ''
      ).trim();

      // LOG SEMUA PESAN MASUK (Sesuai instruksi debug)
      console.log(`\n[PESAN MASUK] From JID: ${remoteJid} | Text: "${text}"`);

      // RESPONSE DEBUG & UNTUK MENGETAHUI LID PENGIRIM
      if (text.toLowerCase() === 'ping' || text.toLowerCase() === 'lid') {
        await safeSendMessage(remoteJid, {
          text: `🤖 Bot Online!\nJID/LID Anda adalah: *${remoteJid}*`
        });
        continue;
      }

      // CHECK FILTER TARGET SENDER (Bisa via LID atau Phone JID)
      const isTargetUser = (remoteJid === KNOWN_TARGET_LID) || 
                           (remoteJid === TARGET_JID_PHONE) || 
                           (remoteJid.includes(TARGET_PHONE));

      if (!isTargetUser) {
        console.log(`[IGNORE] Pesan diabaikan karena bukan dari target nomor A.`);
        continue;
      }

      // PARSING FORMAT HH:MM (contoh: 08:30 atau 8:30)
      const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
      if (timeRegex.test(text)) {
        // Normalize time (misal "8:30" jadi "08:30")
        const [h, m] = text.split(':');
        clockInTime = `${h.padStart(2, '0')}:${m}`;

        const { clockOutStr, targetTimestamp } = calculateClockOut(clockInTime);

        // Balas Konfirmasi
        const replyText = `Sip! Masuk ${clockInTime} dicatat ✅ Pulang jam ${clockOutStr}`;
        await safeSendMessage(remoteJid, { text: replyText });

        // Jadwalkan Reminder
        scheduleReturnReminder(clockInTime, targetTimestamp);
      }
    }
  });
}

// ==========================================
// CRON JOBS SETUP (Senin - Jumat)
// ==========================================
let cronInitialized = false;

function setupCronJobs() {
  if (cronInitialized) return;
  cronInitialized = true;

  console.log('[CRON] Initializing Scheduled Jobs...');

  // 1. Setiap Senin - Jumat jam 08:10 WIB (Asia/Jakarta)
  cron.schedule('10 8 * * 1-5', async () => {
    console.log('[CRON] Running 08:10 Morning Clock-in Query...');
    const message = 'Selamat pagi. Jam berapa clock in hari ini?';
    await safeSendMessage(KNOWN_TARGET_LID, { text: message });
  }, {
    timezone: 'Asia/Jakarta'
  });

  // 2. Setiap jam 16:40 WIB
  cron.schedule('40 16 * * *', async () => {
    console.log('[CRON] Running 16:40 Kyna Pickup Reminder...');
    const message = 'JEMPUT KYNA full day hari ini!!!';
    await safeSendMessage(KNOWN_TARGET_LID, { text: message });
  }, {
    timezone: 'Asia/Jakarta'
  });
}

// Start Application
startBot();
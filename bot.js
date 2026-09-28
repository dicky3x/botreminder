const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const express = require('express');
const cron = require('node-cron');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// Set timezone proses ke Asia/Jakarta
process.env.TZ = 'Asia/Jakarta';

// ==========================================
// CONFIGURATION & CONSTANTS
// ==========================================
const TEST_MODE = false; // Ubah ke true jika ingin testing jeda 2 menit
const TARGET_PHONE = '6282112707476';
const KNOWN_TARGET_LID = '198689582755972@lid';
const TARGET_JID_PHONE = `${TARGET_PHONE}@s.whatsapp.net`;
const AUTH_DIR = '/tmp/auth';

const PORT = process.env.PORT || 3000;

// State Global
let currentQR = null;
let isConnected = false;
let activeReturnCronTask = null;
let sock = null;

// ==========================================
// EXPRESS KEEP-ALIVE & QR WEB SERVER
// ==========================================
const app = express();

app.get('/', (req, res) => {
  if (isConnected) {
    res.status(200).send('Bot OK - WhatsApp Terhubung & Aktif ✅');
  } else if (currentQR) {
    res.status(200).send(`
      <div style="font-family: sans-serif; text-align: center; padding-top: 50px;">
        <h2>Bot Belum Terhubung!</h2>
        <p>Silakan scan QR Code di URL berikut:</p>
        <a href="/qr" style="display: inline-block; padding: 10px 20px; background: #25D366; color: white; border-radius: 5px; text-decoration: none; font-weight: bold;">Buka Scan QR Code</a>
      </div>
    `);
  } else {
    res.status(200).send('Bot OK - Sedang menghubungkan / menyiapkan QR...');
  }
});

app.get('/qr', async (req, res) => {
  if (isConnected) {
    return res.send(`
      <div style="font-family: sans-serif; text-align: center; padding-top: 50px;">
        <h1 style="color: #25D366;">✅ WhatsApp Sudah Terhubung!</h1>
        <p>Anda tidak perlu melakukan scan QR code lagi.</p>
      </div>
    `);
  }

  if (!currentQR) {
    return res.send(`
      <div style="font-family: sans-serif; text-align: center; padding-top: 50px;">
        <h2>Sedang Memuat QR Code...</h2>
        <p>Halaman akan me-refresh otomatis dalam 5 detik.</p>
        <script>setTimeout(() => location.reload(), 5000);</script>
      </div>
    `);
  }

  try {
    const qrImageUrl = await QRCode.toDataURL(currentQR);
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Scan WA Bot QR Code</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta http-equiv="refresh" content="15">
          <style>
            body { font-family: Arial, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background-color: #f0f2f5; }
            .card { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-align: center; max-width: 90%; }
            img { width: 280px; height: 280px; margin: 20px 0; }
            .info { color: #666; font-size: 14px; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>Scan QR Code WhatsApp</h2>
            <p>Buka WhatsApp > Tautan Perangkat > Tautkan Perangkat</p>
            <img src="${qrImageUrl}" alt="WhatsApp QR Code" />
            <p class="info">Halaman me-refresh otomatis setiap 15 detik.</p>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Gagal membuat gambar QR Code: ' + err.message);
  }
});

app.listen(PORT, () => {
  console.log(`[EXPRESS] Server running on port ${PORT}`);
});

// ==========================================
// HELPER FUNCTIONS
// ==========================================

// Fungsi pembersih folder auth jika terjadi corrupt
function clearAuthFolder() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log('[AUTH] Sesi lama dibersihkan dari /tmp/auth');
    }
  } catch (e) {
    console.error('[AUTH ERROR] Gagal menghapus sesi lama:', e);
  }
}

async function safeSendMessage(jid, content) {
  if (!sock || !isConnected) {
    console.error(`[WA ERROR] Gagal mengirim pesan ke ${jid}: Socket belum siap/terhubung.`);
    return;
  }
  try {
    const result = await sock.sendMessage(jid, content);
    console.log(`[WA] Pesan berhasil terkirim ke ${jid}`);
    return result;
  } catch (error) {
    console.error(`[WA ERROR] Gagal mengirim pesan ke ${jid}:`, error.message || error);
  }
}

// Menghitung jam pulang WIB (Ditambah 9 jam 30 menit)
function calculateClockOutWIB(timeStr) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  
  const now = new Date();
  const nowWibString = now.toLocaleString("en-US", { timeZone: "Asia/Jakarta" });
  const wibDate = new Date(nowWibString);

  const clockInDate = new Date(wibDate);
  clockInDate.setHours(hours, minutes, 0, 0);

  const clockOutDate = new Date(clockInDate.getTime() + (9.5 * 60 * 60 * 1000));

  const outHours = String(clockOutDate.getHours()).padStart(2, '0');
  const outMinutes = String(clockOutDate.getMinutes()).padStart(2, '0');

  return {
    clockOutHours: clockOutDate.getHours(),
    clockOutMinutes: clockOutDate.getMinutes(),
    clockOutStr: `${outHours}:${outMinutes}`
  };
}

// Menjadwalkan pengingat pulang
function scheduleReturnReminder(clockInStr, replyJid) {
  if (activeReturnCronTask) {
    activeReturnCronTask.stop();
    activeReturnCronTask = null;
  }

  const { clockOutHours, clockOutMinutes, clockOutStr } = calculateClockOutWIB(clockInStr);

  if (TEST_MODE) {
    console.log(`[TEST MODE] Reminder akan dikirim dalam 2 menit.`);
    setTimeout(async () => {
      const message = `🔔 Waktunya Pulang! Masuk jam ${clockInStr}, pulang jam ${clockOutStr}`;
      await safeSendMessage(replyJid, { text: message });
    }, 2 * 60 * 1000);
    return;
  }

  const cronExpression = `${clockOutMinutes} ${clockOutHours} * * *`;
  console.log(`[SCHEDULE] Menjadwalkan Cron Reminder Pulang pukul ${clockOutStr} WIB (${cronExpression})`);

  activeReturnCronTask = cron.schedule(cronExpression, async () => {
    console.log(`[CRON] Waktunya pulang! Mengirim pesan...`);
    const message = `🔔 Waktunya Pulang! Masuk jam ${clockInStr}, pulang jam ${clockOutStr}`;
    
    // Kirim ke pengirim spesifik & fallback ke LID
    await safeSendMessage(replyJid, { text: message });
    if (replyJid !== KNOWN_TARGET_LID) {
      await safeSendMessage(KNOWN_TARGET_LID, { text: message });
    }

    if (activeReturnCronTask) {
      activeReturnCronTask.stop();
      activeReturnCronTask = null;
    }
  }, {
    scheduled: true,
    timezone: 'Asia/Jakarta'
  });
}

// ==========================================
// MAIN BOT CONNECTION
// ==========================================
async function startBot() {
  console.log('[WA] Mengawali koneksi WhatsApp Bot...');

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

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

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      console.log('\n[QR] QR Code Baru Tersedia! Buka di browser:');
      console.log('👉 https://botreminder-production.up.railway.app/qr\n');
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === 'close') {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`[WA] Connection closed. Status Code: ${statusCode}`);

      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        console.log('[WA] Sesi telah dihancurkan/logged out. Membersihkan auth...');
        clearAuthFolder();
        currentQR = null;
        setTimeout(startBot, 3000);
      } else {
        console.log('[WA] Mencoba terhubung kembali dalam 3 detik...');
        setTimeout(startBot, 3000);
      }
    } else if (connection === 'open') {
      isConnected = true;
      currentQR = null;
      console.log('================================================');
      console.log('🎉 WhatsApp Connection Successfully Opened! 🎉');
      console.log('================================================');
      setupCronJobs();
    }
  });

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

      // Log untuk debug di Railway Console
      console.log(`\n[PESAN MASUK] From: ${remoteJid} | Text: "${text}"`);

      // 1. Respon PING / LID (Bisa dipakai siapa saja untuk mengecek status & LID)
      if (text.toLowerCase() === 'ping' || text.toLowerCase() === 'lid') {
        await safeSendMessage(remoteJid, {
          text: `🤖 Bot Online!\nJID/LID Anda adalah: *${remoteJid}*`
        });
        continue;
      }

      // 2. Filter Pengirim
      const isTargetUser = (remoteJid === KNOWN_TARGET_LID) || 
                           (remoteJid === TARGET_JID_PHONE) || 
                           (remoteJid.includes(TARGET_PHONE));

      if (!isTargetUser) {
        console.log(`[IGNORE] Pesan dari ${remoteJid} diabaikan (bukan Target).`);
        continue;
      }

      // 3. Format Jam Masuk (HH:MM)
      const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
      if (timeRegex.test(text)) {
        const [h, m] = text.split(':');
        const formattedClockIn = `${h.padStart(2, '0')}:${m}`;

        const { clockOutStr } = calculateClockOutWIB(formattedClockIn);

        const replyText = `Sip! Masuk ${formattedClockIn} dicatat ✅ Pulang jam ${clockOutStr}`;
        await safeSendMessage(remoteJid, { text: replyText });

        // Jadwalkan reminder menggunakan remoteJid pengirim langsung
        scheduleReturnReminder(formattedClockIn, remoteJid);
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

  // 1. Jam 08:10 WIB (Senin - Jumat)
  cron.schedule('10 8 * * 1-5', async () => {
    console.log('[CRON] Running 08:10 Morning Clock-in Query...');
    const message = 'Selamat pagi. Jam berapa clock in hari ini?';
    await safeSendMessage(KNOWN_TARGET_LID, { text: message });
    await safeSendMessage(TARGET_JID_PHONE, { text: message });
  }, {
    timezone: 'Asia/Jakarta'
  });

  // 2. Jam 16:40 WIB (Setiap Hari)
  cron.schedule('40 16 * * *', async () => {
    console.log('[CRON] Running 16:40 Kyna Pickup Reminder...');
    const message = 'JEMPUT KYNA full day hari ini!!!';
    await safeSendMessage(KNOWN_TARGET_LID, { text: message });
    await safeSendMessage(TARGET_JID_PHONE, { text: message });
  }, {
    timezone: 'Asia/Jakarta'
  });
}

startBot();

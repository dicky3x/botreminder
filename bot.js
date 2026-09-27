if (!global.crypto) { global.crypto = require('crypto').webcrypto; }
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const cron = require('node-cron');
const express = require('express');
const app = express();

const NOMOR_KAMU = '6282112707476@s.whatsapp.net'; // GANTI NOMOR KAMU
const JAM_KERJA = 9.5;
let sock;
let jadwalPulang = null;
let latestQR = null; // simpan QR terakhir

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth');
    sock = makeWASocket({ auth: state, printQRInTerminal: false });
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr } = update;
        if (qr) {
            latestQR = qr;
            console.log('QR BARU! Buka link website kamu untuk scan!');
        }
        if (connection === 'close') startBot();
        if (connection === 'open') {
            console.log('✅ Bot Connect!');
            latestQR = null; // hapus QR kalau sudah connect
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;
        if (msg.key.remoteJid!== NOMOR_KAMU) return;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        if (!/^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/.test(text)) return;
        const [jam, menit] = text.split(':').map(Number);
        const datePulang = new Date();
        datePulang.setHours(jam, menit, 0);
        datePulang.setTime(datePulang.getTime() + JAM_KERJA * 3600000);
        if (jadwalPulang) jadwalPulang.stop();
        jadwalPulang = cron.schedule(`${datePulang.getMinutes()} ${datePulang.getHours()} * * *`, async () => {
            await sock.sendMessage(NOMOR_KAMU, { text: `🔔 Waktunya Absen Pulang! Masuk jam ${text}` });
            jadwalPulang.stop();
        }, { timezone: "Asia/Jakarta" });
        const jamPulangStr = `${String(datePulang.getHours()).padStart(2,'0')}:${String(datePulang.getMinutes()).padStart(2,'0')}`;
        await sock.sendMessage(NOMOR_KAMU, { text: `Sip! Masuk jam ${text} dicatat. Pulang jam ${jamPulangStr} WIB ✅` });
    });

    cron.schedule('10 8 * * 1-5', async () => {
        await sock.sendMessage(NOMOR_KAMU, { text: `☀️ Selamat pagi! Jam berapa masuk hari ini? Balas HH:MM contoh 07:45` });
    }, { timezone: "Asia/Jakarta" });
}
startBot();

// HALAMAN UNTUK SCAN QR YANG UTUH
app.get('/', async (req, res) => {
    if (!latestQR) {
        return res.send('<h2>✅ Bot sudah terhubung! Tidak perlu scan lagi.</h2><p>QR akan muncul lagi jika koneksi terputus.</p>');
    }
    try {
        const qrImage = await QRCode.toDataURL(latestQR);
        res.send(`
            <html><body style="text-align:center; font-family:sans-serif; padding:20px">
            <h2>Scan QR WhatsApp Kamu</h2>
            <p>QR akan refresh otomatis tiap 30 detik. Buka di HP > WhatsApp > Linked Devices > Link Device</p>
            <img src="${qrImage}" style="width:300px; height:300px; border:10px solid white; box-shadow:0 0 10px #ccc"/>
            <p><i>Jika gagal, refresh halaman ini</i></p>
            <script>setTimeout(()=>location.reload(), 30000)</script>
            </body></html>
        `);
    } catch (e) {
        res.send('Gagal generate QR, refresh lagi');
    }
});

app.listen(process.env.PORT || 3000);

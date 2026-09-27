if (!global.crypto) { global.crypto = require('crypto').webcrypto; }
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const express = require('express');
const app = express();

const NOMOR_KAMU = '6282112707476@s.whatsapp.net'; // GANTI NOMOR KAMU
const JAM_KERJA = 9.5;
let sock;
let jadwalPulang = null;

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth');
    sock = makeWASocket({ auth: state, printQRInTerminal: false });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // INI YANG BIKIN QR MUNCUL
        if (qr) {
            console.log('QR CODE BARU, SCAN SEKARANG:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            console.log('Koneksi terputus, coba sambung lagi...');
            startBot();
        } else if (connection === 'open') {
            console.log('✅ Bot 24 Jam Connect!');
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
            await sock.sendMessage(NOMOR_KAMU, { text: `🔔 Waktunya Absen Pulang! Masuk jam ${text}, sudah 9.5 jam. Jangan lupa absen!` });
            jadwalPulang.stop();
        }, { timezone: "Asia/Jakarta" });

        const jamPulangStr = `${String(datePulang.getHours()).padStart(2,'0')}:${String(datePulang.getMinutes()).padStart(2,'0')}`;
        await sock.sendMessage(NOMOR_KAMU, { text: `Sip! Masuk jam ${text} dicatat.\nAku ingetin pulang jam ${jamPulangStr} WIB ✅` });
    });

    cron.schedule('10 8 * * 1-5', async () => {
        await sock.sendMessage(NOMOR_KAMU, { text: `☀️ Selamat pagi! Jam berapa masuk hari ini? Balas HH:MM contoh 07:45` });
    }, { timezone: "Asia/Jakarta" });
}
startBot();

app.get('/', (req,res) => res.send('Bot Jalan 24 Jam - QR ada di Logs'));
app.listen(process.env.PORT || 3000);

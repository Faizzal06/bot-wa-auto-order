/**
 * Baileys WhatsApp Client
 * Handles connection, authentication, and message routing
 */

const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const readline = require('readline');
const logger = require('../utils/logger');
const { randomDelay } = require('../utils/helpers');
const { handleMessage } = require('./messageHandler');

let sock = null;

// Konfigurasi Pairing Code
const usePairingCode = process.argv.includes('--use-pairing-code') || process.env.USE_PAIRING_CODE === 'true';

const question = (text) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(text, (answer) => {
    rl.close();
    resolve(answer);
  }));
};

/**
 * Inisialisasi dan koneksi ke WhatsApp
 */
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./sessions');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: usePairingCode ? ['Chrome (Windows)', '', ''] : ['Bot Akun Sharing', 'Chrome', '120.0.0'],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 0,
    keepAliveIntervalMs: 25000,
    markOnlineOnConnect: true,
  });

  if (usePairingCode && !sock.authState.creds.registered) {
    setTimeout(async () => {
      let phoneNumber = process.env.PAIRING_NUMBER;
      if (!phoneNumber) {
        phoneNumber = await question('Masukkan nomor WhatsApp untuk bot (contoh: 6281234567890): ');
      }
      phoneNumber = phoneNumber.replace(/[^0-9]/g, '');
      
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        logger.info(`✅ KODE PAIRING ANDA: ${code}`);
        logger.info('Silakan masukkan kode di atas pada aplikasi WhatsApp Anda (Perangkat Tautkan -> Tautkan dengan nomor telepon).');
      } catch (err) {
        logger.error('Gagal mendapatkan kode pairing:', err.message);
      }
    }, 3000);
  }

  // Connection updates
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !usePairingCode) {
      logger.info('QR Code tersedia, silakan scan:');
      qrcodeTerminal.generate(qr, { small: true });
    } else if (qr && usePairingCode) {
      logger.debug('QR Code diabaikan karena menggunakan Pairing Code.');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logger.warn(`Connection closed (status: ${statusCode}), reconnecting: ${shouldReconnect}`);

      if (shouldReconnect) {
        setTimeout(() => startBot(), 3000);
      } else {
        logger.error('Bot logged out! Hapus folder sessions/ dan scan ulang QR.');
      }
    } else if (connection === 'open') {
      logger.info('✅ Bot WhatsApp terhubung!');
    }
  });

  // Save credentials
  sock.ev.on('creds.update', saveCreds);

  // Handle incoming messages
  sock.ev.on('messages.upsert', async (event) => {
    if (event.type !== 'notify') return;

    for (const msg of event.messages) {
      // Abaikan pesan dari bot sendiri
      if (msg.key.fromMe) continue;
      // Abaikan pesan group
      if (msg.key.remoteJid?.endsWith('@g.us')) continue;
      // Abaikan broadcast
      if (msg.key.remoteJid === 'status@broadcast') continue;

      try {
        await handleMessage(sock, msg);
      } catch (err) {
        logger.error(`Error handling message from ${msg.key.remoteJid}:`, err.message);
      }
    }
  });

  return sock;
}

/**
 * Kirim pesan ke nomor tertentu
 * @param {string} jid - WhatsApp JID
 * @param {object} content - Konten pesan Baileys
 */
async function sendMessageToUser(jid, content) {
  if (!sock) {
    logger.error('sendMessageToUser: sock belum terinisialisasi');
    return;
  }
  try {
    await randomDelay();
    await sock.sendMessage(jid, content);
  } catch (err) {
    logger.error(`Failed to send message to ${jid}:`, err.message);
  }
}

/**
 * Ambil sock instance
 */
function getSock() {
  return sock;
}

module.exports = { startBot, sendMessageToUser, getSock };

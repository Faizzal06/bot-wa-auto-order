/**
 * Baileys WhatsApp Client
 * Handles connection, authentication, and message routing
 */

const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const logger = require('../utils/logger');
const { handleMessage } = require('./messageHandler');

let sock = null;

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
    browser: ['Bot Akun Sharing', 'Chrome', '120.0.0'],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 0,
    keepAliveIntervalMs: 25000,
    markOnlineOnConnect: true,
  });

  // Connection updates
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info('QR Code tersedia, silakan scan:');
      qrcodeTerminal.generate(qr, { small: true });
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

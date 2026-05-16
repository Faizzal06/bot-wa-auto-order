/**
 * Entry Point – Bot WhatsApp Akun Sharing
 *
 * Menjalankan:
 * 1. Database initialization
 * 2. Product sync dari Sekalipay
 * 3. Express server untuk webhook
 * 4. Baileys WhatsApp client
 */

require('dotenv').config();

const express = require('express');
const logger = require('./utils/logger');
const { initDatabase, startAutoSave } = require('./db/database');
const { startBot } = require('./baileys/client');
const productSync = require('./services/productSync');
const uangxCallback = require('./webhook/uangxCallback');
const sekalipayCallback = require('./webhook/sekalipayCallback');

const PORT = process.env.PORT || 3000;

async function main() {
  logger.info('═══════════════════════════════════════════');
  logger.info(' Bot WhatsApp Akun Sharing - Starting...');
  logger.info('═══════════════════════════════════════════');

  // 1. Inisialisasi database
  logger.info('Step 1: Initializing database...');
  await initDatabase();
  startAutoSave();

  // 2. Setup Express server untuk webhook
  logger.info('Step 2: Starting Express server...');
  const app = express();

  // Middleware: simpan raw body untuk verifikasi signature Sekalipay
  app.use(express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString();
    },
  }));
  app.use(express.urlencoded({ extended: true }));

  // Health check
  app.get('/', (_req, res) => {
    res.json({ status: 'ok', service: 'Bot Akun Sharing', timestamp: new Date().toISOString() });
  });

  // Webhook routes
  app.use('/', uangxCallback);
  app.use('/', sekalipayCallback);

  app.listen(PORT, () => {
    logger.info(`Express server running on port ${PORT}`);
    logger.info(`Webhook UangX:     http://localhost:${PORT}/callback-uangx`);
    logger.info(`Webhook Sekalipay: http://localhost:${PORT}/webhook/sekalipay`);
  });

  // 3. Sync produk dari Sekalipay
  logger.info('Step 3: Syncing products from Sekalipay...');
  try {
    const count = await productSync.initialSync();
    logger.info(`Product sync complete: ${count} products loaded`);
  } catch (err) {
    logger.error('Initial product sync failed:', err.message);
    logger.warn('Bot akan tetap berjalan, tapi produk mungkin kosong. Sync akan dicoba lagi dalam 6 jam.');
  }

  // Setup periodic sync
  productSync.startPeriodicSync();

  // 4. Start Baileys WhatsApp bot
  logger.info('Step 4: Connecting to WhatsApp...');
  try {
    await startBot();
  } catch (err) {
    logger.error('Failed to start WhatsApp bot:', err.message);
    process.exit(1);
  }
}

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
});

main().catch((err) => {
  logger.error('Fatal error:', err);
  process.exit(1);
});

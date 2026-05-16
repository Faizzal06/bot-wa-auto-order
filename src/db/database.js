/**
 * Database initialization – SQLite via sql.js (pure JavaScript)
 * sql.js is async for initialization but sync for queries
 */

const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

const DB_PATH = path.resolve(process.env.DB_PATH || './data/transactions.db');

// Pastikan folder data/ ada
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

let db = null;

/**
 * Inisialisasi database (harus dipanggil sekali saat startup)
 */
async function initDatabase() {
  const SQL = await initSqlJs();

  // Load existing database jika ada
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
    logger.info(`Database loaded from ${DB_PATH}`);
  } else {
    db = new SQL.Database();
    logger.info('New database created');
  }

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      variant_id    INTEGER PRIMARY KEY,
      category      TEXT NOT NULL,
      product_name  TEXT NOT NULL,
      variant_name  TEXT NOT NULL,
      price         INTEGER NOT NULL,
      stock         INTEGER DEFAULT 0,
      sekalipay_raw TEXT,
      updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      user_wa             TEXT NOT NULL,
      reference           TEXT UNIQUE NOT NULL,
      sekalipay_ref_id    TEXT,
      variant_id          INTEGER,
      product_name        TEXT,
      amount              INTEGER NOT NULL,
      status              TEXT DEFAULT 'waiting_payment',
      payment_url         TEXT,
      account_credential  TEXT,
      created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
      paid_at             DATETIME,
      completed_at        DATETIME
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_transactions_reference ON transactions(reference)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_transactions_sekalipay_ref ON transactions(sekalipay_ref_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_transactions_user_wa ON transactions(user_wa)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_products_category ON products(category)`);

  saveDatabase();
  logger.info('Database tables initialized');
}

/**
 * Simpan database ke disk
 */
function saveDatabase() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

/**
 * Auto-save setiap 30 detik
 */
function startAutoSave() {
  setInterval(() => {
    saveDatabase();
  }, 30000);
}

/**
 * Ambil instance database
 */
function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

module.exports = { initDatabase, getDb, saveDatabase, startAutoSave };

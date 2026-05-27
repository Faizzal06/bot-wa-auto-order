/**
 * Database models – CRUD operations for products & transactions
 * Uses sql.js (synchronous query API via getDb())
 */

const { getDb, saveDatabase } = require('./database');

// ═══════════════════════════════════════════════════
// PRODUCTS
// ═══════════════════════════════════════════════════

/**
 * Upsert satu produk
 */
function upsertProduct({ variant_id, category, product_name, variant_name, price, stock, sekalipay_raw }) {
  const db = getDb();
  db.run(
    `INSERT INTO products (variant_id, category, product_name, variant_name, price, stock, sekalipay_raw, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(variant_id) DO UPDATE SET
       category = excluded.category,
       product_name = excluded.product_name,
       variant_name = excluded.variant_name,
       price = excluded.price,
       stock = excluded.stock,
       sekalipay_raw = excluded.sekalipay_raw,
       updated_at = datetime('now')`,
    [variant_id, category, product_name, variant_name, price, stock, JSON.stringify(sekalipay_raw)]
  );
}

/**
 * Upsert banyak produk sekaligus
 */
function upsertManyProducts(products) {
  const db = getDb();
  db.run('BEGIN TRANSACTION');
  try {
    for (const p of products) {
      upsertProduct(p);
    }
    db.run('COMMIT');
    saveDatabase();
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
}

/**
 * Helper: convert sql.js result to array of objects
 */
function resultToObjects(result) {
  if (!result || result.length === 0) return [];
  const [{ columns, values }] = result;
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

/**
 * Ambil semua kategori unik yang punya stok
 */
function getCategories() {
  const db = getDb();
  const result = db.exec(`SELECT DISTINCT category FROM products WHERE stock > 0 ORDER BY category`);
  return resultToObjects(result);
}

/**
 * Ambil semua nama produk unik dari semua kategori (stok > 0)
 */
function getAllUniqueProducts() {
  const db = getDb();
  const result = db.exec(`
    SELECT DISTINCT product_name
    FROM products
    WHERE stock > 0
    ORDER BY product_name
  `);
  return resultToObjects(result).map(row => row.product_name);
}

/**
 * Ambil daftar nama produk unik berdasarkan kategori (stok > 0)
 */
function getUniqueProductsByCategory(category) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT DISTINCT product_name
    FROM products
    WHERE category = ? AND stock > 0
    ORDER BY product_name
  `);
  stmt.bind([category]);

  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject().product_name);
  }
  stmt.free();
  return rows;
}

/**
 * Ambil daftar variant berdasarkan nama produk dari semua kategori (stok > 0)
 */
function getVariantsByProductName(productName) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT variant_id, product_name, variant_name, price, stock
    FROM products
    WHERE product_name = ? AND stock > 0
    ORDER BY price
  `);
  stmt.bind([productName]);

  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

/**
 * Ambil daftar variant berdasarkan kategori dan nama produk (stok > 0)
 */
function getVariantsByProduct(category, productName) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT variant_id, product_name, variant_name, price, stock
    FROM products
    WHERE category = ? AND product_name = ? AND stock > 0
    ORDER BY price
  `);
  stmt.bind([category, productName]);

  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

/**
 * Ambil satu produk berdasarkan variant_id
 */
function getProductById(variantId) {
  const db = getDb();
  const stmt = db.prepare(`SELECT * FROM products WHERE variant_id = ?`);
  stmt.bind([variantId]);
  let row = null;
  if (stmt.step()) {
    row = stmt.getAsObject();
  }
  stmt.free();
  return row;
}

// ═══════════════════════════════════════════════════
// TRANSACTIONS
// ═══════════════════════════════════════════════════

/**
 * Buat transaksi baru
 */
function createTransaction({ user_wa, reference, variant_id, product_name, original_price, amount, payment_url }) {
  const db = getDb();
  db.run(
    `INSERT INTO transactions (user_wa, reference, variant_id, product_name, original_price, amount, status, payment_url)
     VALUES (?, ?, ?, ?, ?, ?, 'waiting_payment', ?)`,
    [user_wa, reference, variant_id, product_name, original_price, amount, payment_url]
  );
  saveDatabase();
}

/**
 * Cari transaksi berdasarkan reference UangX
 */
function getTransactionByReference(reference) {
  const db = getDb();
  const stmt = db.prepare(`SELECT * FROM transactions WHERE reference = ?`);
  stmt.bind([reference]);
  let row = null;
  if (stmt.step()) {
    row = stmt.getAsObject();
  }
  stmt.free();
  return row;
}

/**
 * Cari transaksi berdasarkan sekalipay_ref_id
 */
function getTransactionBySekalipayRef(refId) {
  const db = getDb();
  const stmt = db.prepare(`SELECT * FROM transactions WHERE sekalipay_ref_id = ?`);
  stmt.bind([refId]);
  let row = null;
  if (stmt.step()) {
    row = stmt.getAsObject();
  }
  stmt.free();
  return row;
}

/**
 * Update status transaksi
 */
function updateTransactionStatus(reference, status) {
  const db = getDb();
  db.run(`UPDATE transactions SET status = ? WHERE reference = ?`, [status, reference]);
  saveDatabase();
}

/**
 * Update setelah pembayaran (status paid + paid_at + sekalipay_ref_id)
 */
function updateTransactionPaid(reference, sekalipayRefId) {
  const db = getDb();
  db.run(
    `UPDATE transactions SET status = 'paid', paid_at = datetime('now'), sekalipay_ref_id = ? WHERE reference = ?`,
    [sekalipayRefId, reference]
  );
  saveDatabase();
}

/**
 * Update setelah credential diterima
 */
function updateTransactionCompleted(sekalipayRefId, credential) {
  const db = getDb();
  db.run(
    `UPDATE transactions SET status = 'completed', account_credential = ?, completed_at = datetime('now') WHERE sekalipay_ref_id = ?`,
    [credential, sekalipayRefId]
  );
  saveDatabase();
}

/**
 * Update status menjadi failed
 */
function updateTransactionFailed(reference, reason) {
  const db = getDb();
  db.run(
    `UPDATE transactions SET status = 'failed', account_credential = ? WHERE reference = ?`,
    [reason || 'failed', reference]
  );
  saveDatabase();
}

module.exports = {
  // Products
  upsertProduct,
  upsertManyProducts,
  getCategories,
  getUniqueProductsByCategory,
  getAllUniqueProducts,
  getVariantsByProduct,
  getVariantsByProductName,
  getProductById,
  // Transactions
  createTransaction,
  getTransactionByReference,
  getTransactionBySekalipayRef,
  updateTransactionStatus,
  updateTransactionPaid,
  updateTransactionCompleted,
  updateTransactionFailed,
};

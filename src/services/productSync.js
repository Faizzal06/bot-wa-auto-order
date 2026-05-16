/**
 * Product Sync Service
 * Sinkronisasi produk dari Sekalipay ke SQLite
 */

const sekalipay = require('./sekalipay');
const { upsertManyProducts } = require('../db/models');
const logger = require('../utils/logger');

// Simpan server_time terakhir untuk delta sync
let lastServerTime = null;

/**
 * Parse response Sekalipay dan extract semua variant sebagai flat array
 * Hanya ambil produk dengan order_process "auto" atau "h2h"
 *
 * Response structure:
 *   data[] → categories
 *     .products[] → products per category
 *       .variants[] → variant per product
 *
 * @param {Array} categories - Array kategori dari Sekalipay
 * @returns {Array} Array of product objects ready for DB upsert
 */
function parseProducts(categories) {
  const products = [];

  for (const category of categories) {
    const categoryName = category.name || 'Uncategorized';

    for (const product of (category.products || [])) {
      for (const variant of (product.variants || [])) {
        // Filter: hanya auto atau h2h
        if (variant.order_process !== 'auto' && variant.order_process !== 'h2h') {
          continue;
        }

        products.push({
          variant_id: variant.id,
          category: categoryName,
          product_name: product.name,
          variant_name: variant.name,
          price: variant.price,
          stock: variant.stock || 0,
          sekalipay_raw: variant,
        });
      }
    }
  }

  return products;
}

/**
 * Sinkronisasi penuh (pertama kali atau force refresh)
 */
async function initialSync() {
  try {
    logger.info('ProductSync: starting initial sync...');
    const response = await sekalipay.fetchProducts();
    const categories = response.data || [];
    const products = parseProducts(categories);

    if (products.length > 0) {
      upsertManyProducts(products);
    }

    lastServerTime = response.server_time || new Date().toISOString();
    logger.info(`ProductSync: initial sync complete, ${products.length} products upserted, server_time=${lastServerTime}`);
    return products.length;
  } catch (error) {
    logger.error('ProductSync: initial sync failed:', error.message);
    throw error;
  }
}

/**
 * Delta sync – hanya ambil produk yang berubah sejak terakhir kali sync
 */
async function deltaSync() {
  if (!lastServerTime) {
    logger.warn('ProductSync: no lastServerTime, falling back to initial sync');
    return initialSync();
  }

  try {
    logger.info(`ProductSync: delta sync since ${lastServerTime}`);
    const response = await sekalipay.fetchUpdatedProducts(lastServerTime);
    const categories = response.data || [];
    const products = parseProducts(categories);

    if (products.length > 0) {
      upsertManyProducts(products);
    }

    lastServerTime = response.server_time || new Date().toISOString();
    logger.info(`ProductSync: delta sync complete, ${products.length} products updated`);
    return products.length;
  } catch (error) {
    logger.error('ProductSync: delta sync failed:', error.message);
    // Jangan throw, biarkan bot tetap jalan
  }
}

/**
 * Setup periodic sync setiap 6 jam
 */
function startPeriodicSync() {
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  setInterval(() => {
    deltaSync().catch(() => {}); // error sudah di-log di dalam deltaSync
  }, SIX_HOURS);
  logger.info('ProductSync: periodic sync scheduled every 6 hours');
}

module.exports = {
  initialSync,
  deltaSync,
  startPeriodicSync,
};

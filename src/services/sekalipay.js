/**
 * Sekalipay API Service
 * Handles product catalog, transactions, and balance checks
 */

const axios = require('axios');
const logger = require('../utils/logger');

const BASE_URL = process.env.SEKALIPAY_BASE_URL || 'https://sekalipay.com/api';
const API_KEY = process.env.SEKALIPAY_API_KEY;

const client = axios.create({
  baseURL: BASE_URL,
  headers: {
    'X-APIKEY': API_KEY,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  },
  timeout: 30000,
});

/**
 * Ambil produk dari kategori sharing account (category=1)
 * @returns {object} Response data dengan products & server_time
 */
async function fetchProducts() {
  try {
    const res = await client.get('/v1/item', {
      params: { category: 1, per_page: 'all' },
    });
    logger.info(`Sekalipay: fetched ${res.data.data?.length || 0} categories`);
    return res.data;
  } catch (error) {
    logger.error('Sekalipay fetchProducts error:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Ambil produk yang diupdate sejak timestamp tertentu (delta sync)
 * @param {string} since - ISO 8601 timestamp
 * @returns {object} Response data
 */
async function fetchUpdatedProducts(since) {
  try {
    const res = await client.get('/v1/item', {
      params: { category: 1, per_page: 'all', updated_since: since },
    });
    logger.info(`Sekalipay: delta sync fetched ${res.data.data?.length || 0} categories`);
    return res.data;
  } catch (error) {
    logger.error('Sekalipay fetchUpdatedProducts error:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Buat transaksi pembelian di Sekalipay (PRODUCTION)
 * @param {string} refId - Reference ID unik
 * @param {number} variantId - ID variant produk
 * @returns {object} Response data (invoice, status)
 */
async function createTransaction(refId, variantId) {
  try {
    const payload = {
      ref_id: refId,
      carts: [{
        item_id: variantId,
        quantity: 1,
        note: '',
      }],
    };
    const res = await client.post('/v1/trx', payload);
    logger.info(`Sekalipay: transaction created, ref_id=${refId}, invoice=${res.data.data?.invoice}`);
    return res.data;
  } catch (error) {
    logger.error('Sekalipay createTransaction error:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Buat transaksi SANDBOX di Sekalipay (TESTING - tidak memotong saldo)
 * POST /v1/order/sandbox
 * @param {string} refId - Reference ID unik
 * @param {number} variantId - ID variant produk
 * @returns {object} Response data (invoice)
 */
async function createSandboxOrder(refId, variantId) {
  try {
    const payload = {
      ref_id: refId,
      item_id: variantId,
      quantity: 1,
    };
    const res = await client.post('/v1/order/sandbox', payload);
    logger.info(`Sekalipay SANDBOX: order created, ref_id=${refId}, invoice=${res.data.data?.invoice}`);
    return res.data;
  } catch (error) {
    logger.error('Sekalipay createSandboxOrder error:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Wrapper: otomatis pilih sandbox atau production berdasarkan env USE_SANDBOX
 * @param {string} refId - Reference ID unik
 * @param {number} variantId - ID variant produk
 * @returns {object} Response data
 */
async function createOrder(refId, variantId) {
  const useSandbox = process.env.USE_SANDBOX === 'true';
  if (useSandbox) {
    logger.info(`Using SANDBOX mode for order ref_id=${refId}`);
    return createSandboxOrder(refId, variantId);
  }
  return createTransaction(refId, variantId);
}

/**
 * Cek detail transaksi
 * @param {string} refId - Reference ID
 * @returns {object} Transaction detail
 */
async function getTransactionDetail(refId) {
  try {
    const res = await client.get(`/v1/trx/${encodeURIComponent(refId)}`);
    return res.data;
  } catch (error) {
    logger.error('Sekalipay getTransactionDetail error:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Cek saldo Sekalipay
 * @returns {number} Balance amount
 */
async function checkBalance() {
  try {
    const res = await client.get('/v1/balance');
    return res.data.data?.balance || 0;
  } catch (error) {
    logger.error('Sekalipay checkBalance error:', error.response?.data || error.message);
    throw error;
  }
}

module.exports = {
  fetchProducts,
  fetchUpdatedProducts,
  createTransaction,
  createSandboxOrder,
  createOrder,
  getTransactionDetail,
  checkBalance,
};

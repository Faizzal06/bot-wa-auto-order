/**
 * UangX Payment Gateway Service
 * Handles invoice creation and webhook signature verification
 */

const crypto = require('crypto');
const axios = require('axios');
const logger = require('../utils/logger');

const MERCHANT_CODE = process.env.UANGX_MERCHANT_CODE;
const API_KEY = process.env.UANGX_API_KEY;
const BASE_URL = process.env.UANGX_BASE_URL || 'https://uangx.neticonpay.my.id/api';

/**
 * Buat invoice pembayaran
 * Signature: sha256(merchant_code + reference + amount + api_key)
 *
 * @param {number} amount - Nominal pembayaran (bulat, tanpa desimal)
 * @param {string} customerName
 * @param {string} customerEmail
 * @param {string} reference - ID transaksi unik
 * @returns {string} payment_url
 */
async function createInvoice(amount, customerName, customerEmail, reference) {
  const rawString = MERCHANT_CODE + reference + amount + API_KEY;
  const signature = crypto.createHash('sha256').update(rawString).digest('hex');

  const payload = {
    merchant_code: MERCHANT_CODE,
    reference,
    amount,
    customer_name: customerName,
    customer_email: customerEmail,
    signature,
    store_code: '',
  };

  try {
    const res = await axios.post(`${BASE_URL}/create_transaction.php`, payload, { timeout: 15000 });
    if (res.data.success) {
      logger.info(`UangX: invoice created, ref=${reference}, url=${res.data.data.payment_url}`);
      return res.data.data.payment_url;
    } else {
      throw new Error(res.data.message || 'UangX create invoice failed');
    }
  } catch (error) {
    logger.error('UangX createInvoice error:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Verifikasi signature webhook UangX
 * Signature callback: sha256(merchant_code + reference + amount + status + api_key)
 *
 * @param {object} data - Body dari webhook
 * @returns {boolean} true jika signature valid
 */
function verifyCallbackSignature(data) {
  const rawString = data.merchant_code + data.reference + data.amount + data.status + API_KEY;
  const calculated = crypto.createHash('sha256').update(rawString).digest('hex');
  return data.signature === calculated;
}

/**
 * Cek status pembayaran secara manual
 * @param {string} reference - Invoice reference
 * @returns {object} Status data
 */
async function checkStatus(reference) {
  const qs = require('querystring');
  const payload = qs.stringify({
    api_key: API_KEY,
    reference,
  });

  try {
    const res = await axios.post(`${BASE_URL}/cek_status.php`, payload, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    });
    return res.data;
  } catch (error) {
    logger.error('UangX checkStatus error:', error.response?.data || error.message);
    throw error;
  }
}

module.exports = {
  createInvoice,
  verifyCallbackSignature,
  checkStatus,
};

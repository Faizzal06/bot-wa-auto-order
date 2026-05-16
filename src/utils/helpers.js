/**
 * Helper utilities
 */

/**
 * Format angka ke format Rupiah
 * @param {number} amount
 * @returns {string} "Rp1.000"
 */
function formatRupiah(amount) {
  return 'Rp' + Number(amount).toLocaleString('id-ID');
}

/**
 * Generate reference ID unik untuk UangX
 * Format: INV-{timestamp}-{random 4 digit}
 * @returns {string}
 */
function generateReference() {
  const random = Math.floor(1000 + Math.random() * 9000);
  return `INV-${Date.now()}-${random}`;
}

/**
 * Promise-based delay
 * @param {number} ms - milliseconds
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Ekstrak nomor WA dari JID Baileys
 * "628xxx@s.whatsapp.net" → "628xxx"
 * @param {string} jid
 * @returns {string}
 */
function jidToPhone(jid) {
  return jid?.replace(/@s\.whatsapp\.net$/, '') || '';
}

/**
 * Konversi nomor telepon ke JID Baileys
 * "628xxx" → "628xxx@s.whatsapp.net"
 * @param {string} phone
 * @returns {string}
 */
function phoneToJid(phone) {
  const cleaned = phone.replace(/[^0-9]/g, '');
  return `${cleaned}@s.whatsapp.net`;
}

/**
 * Delay acak untuk menghindari resiko banned (misal 1000 - 3000 ms)
 */
function randomDelay(min = 1000, max = 3000) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, delay));
}

module.exports = {
  formatRupiah,
  generateReference,
  sleep,
  randomDelay,
  jidToPhone,
  phoneToJid,
};

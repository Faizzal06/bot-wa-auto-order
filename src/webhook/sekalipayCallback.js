/**
 * Sekalipay Webhook Callback Handler
 * Endpoint: POST /webhook/sekalipay
 *
 * Menerima notifikasi dari Sekalipay,
 * verifikasi SHA256 signature, dan kirim credential ke pelanggan
 *
 * Signature formula:
 *   SHA256(ref_id + ":" + invoice + ":" + status + ":" + webhook_secret)
 *
 * Status values (event-dependent):
 *   - order.paid / order.completed / order.canceled → payload.data.status
 *   - order.item.sent → "item.sent"
 *   - webhook.test → "test"
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const logger = require('../utils/logger');
const { phoneToJid } = require('../utils/helpers');
const models = require('../db/models');
const { sendMessageToUser } = require('../baileys/client');

const WEBHOOK_SECRET = process.env.SEKALIPAY_WEBHOOK_SECRET || '';
const ADMIN_PHONE = process.env.ADMIN_PHONE || '';

/**
 * Resolve status value for signature based on event type
 */
function resolveSignatureStatus(event, dataStatus) {
  if (event === 'order.item.sent') return 'item.sent';
  if (event === 'webhook.test') return 'test';
  // order.paid, order.completed, order.canceled → use payload.data.status
  return dataStatus || '';
}

/**
 * Verifikasi SHA256 signature Sekalipay
 * Formula: SHA256(ref_id + ":" + invoice + ":" + status + ":" + webhook_secret)
 */
function verifySignature(refId, invoice, status, signatureHeader) {
  if (!WEBHOOK_SECRET) {
    logger.warn('Sekalipay webhook secret not set, skipping verification');
    return true;
  }

  const payload = `${refId}:${invoice}:${status}:${WEBHOOK_SECRET}`;
  const expected = crypto.createHash('sha256').update(payload).digest('hex');

  const signature = (signatureHeader || '').replace('sha256=', '');

  logger.info('Sekalipay signature payload:', `${refId}:${invoice}:${status}:<secret>`);
  logger.info('Sekalipay expected hash:', expected);
  logger.info('Sekalipay received signature:', signature);

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(signature, 'hex')
    );
  } catch (err) {
    logger.error('Sekalipay timingSafeEqual error:', err.message);
    return false;
  }
}

router.post('/webhook/sekalipay', async (req, res) => {
  const signatureHeader = req.headers['x-signature'] || '';
  const { event, data } = req.body || {};

  const refId = data?.ref_id || '';
  const invoice = data?.invoice || '';
  const signatureStatus = resolveSignatureStatus(event, data?.status);

  logger.info('Sekalipay webhook received:', { event, ref_id: refId, invoice, status: data?.status });

  // 1. Verifikasi signature
  if (!verifySignature(refId, invoice, signatureStatus, signatureHeader)) {
    logger.warn('Sekalipay webhook: invalid signature!');
    return res.status(401).json({ message: 'Invalid Signature' });
  }


  logger.info('Sekalipay webhook: signature valid ✅');

  // 2. Respond dulu agar Sekalipay tidak retry
  res.status(200).json({ message: 'OK' });

  // 3. Proses berdasarkan event
  if (event === 'order.paid') {
    // Pembayaran diterima, transaksi sedang diproses
    const transaction = models.getTransactionBySekalipayRef(refId);

    if (transaction && transaction.status !== 'completed') {
      const userJid = transaction.user_wa;
      await sendMessageToUser(userJid, {
        text:
          `💰 *Pembayaran telah diterima!*\n\n` +
          `📌 Produk: *${transaction.product_name}*\n` +
          `💵 Nominal: *Rp${Number(transaction.amount).toLocaleString('id-ID')}*\n\n` +
          `⏳ Transaksi sedang diproses, akun akan dikirim otomatis dalam beberapa saat...\n\n` +
          `Mohon ditunggu ya! 🙏`,
      });
      logger.info(`Payment received notification sent to ${transaction.user_wa} for ref=${refId}`);
    }
  } else if (event === 'order.completed' && data?.status === 'completed') {
    const transaction = models.getTransactionBySekalipayRef(refId);

    if (!transaction) {
      logger.warn(`Sekalipay webhook: transaksi dengan ref_id ${refId} tidak ditemukan`);
      return;
    }

    if (transaction.status === 'completed') {
      logger.info(`Transaction ${refId} already completed, skipping`);
      return;
    }

    // Ambil credential/license
    const items = data.items || [];
    let credential = items[0]?.licenses?.[0]?.product_license || '';

    // Jika licenses kosong, coba ambil dari h2h_results (produk H2H)
    if (!credential && data.h2h_results) {
      credential = data.h2h_results[0]?.sn || '';
    }

    const userJid = transaction.user_wa;

    if (credential) {
      // Update database
      models.updateTransactionCompleted(refId, credential);

      // Kirim credential ke pelanggan
      await sendMessageToUser(userJid, {
        text:
          `✅ *Pembayaran berhasil!*\n\n` +
          `📌 Produk: *${transaction.product_name}*\n\n` +
          `🔑 Berikut akun Anda:\n${credential}\n\n` +
          `Terima kasih telah berbelanja! 🙏\n` +
          `Ketik *!menu* untuk membeli lagi.`,
      });

      logger.info(`Credential sent to ${transaction.user_wa} for ref=${refId}`);
    } else {
      // Credential kosong
      logger.warn(`Credential kosong untuk ref=${refId}`);

      await sendMessageToUser(userJid, {
        text: '⏳ Akun sedang dalam proses. Harap tunggu 5 menit atau hubungi admin.',
      });

      // Notifikasi admin
      if (ADMIN_PHONE) {
        await sendMessageToUser(phoneToJid(ADMIN_PHONE), {
          text: `⚠️ *Product license kosong!*\nRef: ${refId}\nUser: ${transaction.user_wa}\nProduk: ${transaction.product_name}\nData: ${JSON.stringify(data)}`,
        });
      }
    }
  } else if (data?.status === 'failed' || data?.status === 'canceled') {
    // Order gagal
    const transaction = models.getTransactionBySekalipayRef(refId);

    if (transaction && transaction.status !== 'completed') {
      models.updateTransactionFailed(transaction.reference, data.status);

      const userJid = transaction.user_wa;
      await sendMessageToUser(userJid, {
        text: '❌ Maaf, pesanan gagal diproses. Silakan hubungi admin untuk bantuan.',
      });

      // Notifikasi admin
      if (ADMIN_PHONE) {
        await sendMessageToUser(phoneToJid(ADMIN_PHONE), {
          text: `❌ *Order gagal!*\nRef: ${refId}\nUser: ${transaction.user_wa}\nStatus: ${data.status}\nProduk: ${transaction.product_name}`,
        });
      }
    }
  }
});

module.exports = router;

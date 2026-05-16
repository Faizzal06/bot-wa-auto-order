/**
 * UangX Webhook Callback Handler
 * Endpoint: POST /callback-uangx
 *
 * Menerima notifikasi pembayaran dari UangX,
 * verifikasi signature, update status, dan trigger pembelian ke Sekalipay
 */

const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { phoneToJid } = require('../utils/helpers');
const uangx = require('../services/uangx');
const sekalipay = require('../services/sekalipay');
const models = require('../db/models');
const { sendMessageToUser } = require('../baileys/client');
const { sleep } = require('../utils/helpers');

const ADMIN_PHONE = process.env.ADMIN_PHONE || '';

router.post('/callback-uangx', async (req, res) => {
  const data = req.body;
  logger.info('UangX callback received:', { reference: data.reference, status: data.status });

  // 1. Verifikasi signature
  if (!uangx.verifyCallbackSignature(data)) {
    logger.warn('UangX callback: invalid signature!', { reference: data.reference });
    return res.status(403).json({ message: 'Invalid Signature' });
  }

  // 2. Cek status
  if (data.status !== 'PAID') {
    logger.info(`UangX callback: status ${data.status} (bukan PAID), skip.`);
    return res.status(200).send('OK');
  }

  // 3. Cari transaksi di database
  const transaction = models.getTransactionByReference(data.reference);
  if (!transaction) {
    logger.warn(`UangX callback: transaksi ${data.reference} tidak ditemukan di DB`);
    return res.status(200).send('OK');
  }

  // 4. Validasi amount (antisipasi manipulasi)
  if (Number(data.amount) !== transaction.amount) {
    logger.error(`UangX callback: amount mismatch! webhook=${data.amount}, db=${transaction.amount}`);
    // Notifikasi admin
    if (ADMIN_PHONE) {
      await sendMessageToUser(phoneToJid(ADMIN_PHONE), {
        text: `⚠️ *ALERT: Amount mismatch!*\nRef: ${data.reference}\nWebhook: ${data.amount}\nDB: ${transaction.amount}`,
      });
    }
    return res.status(200).send('OK');
  }

  // 5. Update status ke paid
  const sekalipayRefId = transaction.reference; // gunakan reference UangX sebagai ref_id Sekalipay
  models.updateTransactionPaid(data.reference, sekalipayRefId);
  logger.info(`Transaction ${data.reference} marked as PAID`);

  // Respond dulu ke UangX agar tidak retry
  res.status(200).send('OK');

  // 6. Beli produk di Sekalipay
  try {
    const result = await sekalipay.createOrder(sekalipayRefId, transaction.variant_id);
    logger.info(`Sekalipay transaction created: ref=${sekalipayRefId}, invoice=${result.data?.invoice}`);

    // Kirim notifikasi ke pelanggan
    const userJid = transaction.user_wa;
    await sendMessageToUser(userJid, {
      text: `✅ *Pembayaran diterima!*\n\n📌 Produk: *${transaction.product_name}*\n💵 Nominal: *Rp${Number(transaction.amount).toLocaleString('id-ID')}*\n\n⏳ Akun sedang diproses, akan dikirim otomatis dalam beberapa saat...`,
    });

    // Set timeout untuk cek manual jika webhook Sekalipay tidak datang dalam 2 menit
    setTimeout(async () => {
      try {
        const trx = models.getTransactionByReference(data.reference);
        if (trx && trx.status === 'paid') {
          // Masih paid setelah 2 menit, cek manual ke Sekalipay
          logger.warn(`Transaction ${sekalipayRefId} still PAID after 2 min, checking manually...`);

          let detail;
          try {
            detail = await sekalipay.getTransactionDetail(sekalipayRefId);
          } catch (fetchErr) {
            // Sekalipay API error — kirim pesan ke buyer & admin
            logger.error(`Manual check API error for ${sekalipayRefId}:`, fetchErr.message);

            await sendMessageToUser(userJid, {
              text:
                `⚠️ *Pembayaran Anda sudah diterima*, namun terjadi gangguan saat memproses pesanan.\n\n` +
                `📌 Produk: *${transaction.product_name}*\n` +
                `🔖 Ref: \`${sekalipayRefId}\`\n\n` +
                `Silakan hubungi admin untuk bantuan:\n` +
                `📞 wa.me/${ADMIN_PHONE.replace(/^62/, '62')}\n\n` +
                `Mohon maaf atas ketidaknyamanannya 🙏`,
            });

            if (ADMIN_PHONE) {
              await sendMessageToUser(phoneToJid(ADMIN_PHONE), {
                text:
                  `🚨 *Transaksi stuck + API error!*\n` +
                  `Ref: ${sekalipayRefId}\n` +
                  `User: ${transaction.user_wa}\n` +
                  `Produk: ${transaction.product_name}\n` +
                  `Error: ${fetchErr.message}`,
              });
            }
            return;
          }

          if (detail.data?.status === 'completed') {
            // Proses credential dari hasil detail
            const items = detail.data.items || [];
            const license = items[0]?.licenses?.[0]?.product_license || detail.data.h2h_results?.[0]?.sn || '';

            if (license) {
              models.updateTransactionCompleted(sekalipayRefId, license);
              await sendMessageToUser(userJid, {
                text: `✅ *Pesanan selesai!*\n\nBerikut akun Anda:\n${license}\n\nTerima kasih telah berbelanja! 🙏`,
              });
            } else {
              // Credential kosong
              if (ADMIN_PHONE) {
                await sendMessageToUser(phoneToJid(ADMIN_PHONE), {
                  text: `⚠️ *Credential kosong!*\nRef: ${sekalipayRefId}\nUser: ${transaction.user_wa}\nProduk: ${transaction.product_name}`,
                });
              }
              await sendMessageToUser(userJid, {
                text:
                  `⚠️ *Pembayaran sudah diterima*, namun akun belum tersedia.\n\n` +
                  `📌 Produk: *${transaction.product_name}*\n` +
                  `🔖 Ref: \`${sekalipayRefId}\`\n\n` +
                  `Silakan hubungi admin untuk bantuan:\n` +
                  `📞 wa.me/${ADMIN_PHONE.replace(/^62/, '62')}\n\n` +
                  `Mohon maaf atas ketidaknyamanannya 🙏`,
              });
            }
          } else if (detail.data?.status === 'failed' || detail.data?.status === 'canceled') {
            models.updateTransactionFailed(data.reference, detail.data.status);
            await sendMessageToUser(userJid, {
              text:
                `❌ Maaf, pembelian akun gagal diproses.\n\n` +
                `📌 Produk: *${transaction.product_name}*\n` +
                `🔖 Ref: \`${sekalipayRefId}\`\n\n` +
                `Silakan hubungi admin untuk refund:\n` +
                `📞 wa.me/${ADMIN_PHONE.replace(/^62/, '62')}`,
            });
            if (ADMIN_PHONE) {
              await sendMessageToUser(phoneToJid(ADMIN_PHONE), {
                text: `❌ *Transaksi gagal!*\nRef: ${sekalipayRefId}\nUser: ${transaction.user_wa}\nStatus: ${detail.data.status}`,
              });
            }
          } else {
            // Status masih pending/processing setelah 2 menit — notify buyer & admin
            logger.warn(`Transaction ${sekalipayRefId} still ${detail.data?.status || 'unknown'} after 2 min`);

            await sendMessageToUser(userJid, {
              text:
                `⚠️ *Pembayaran Anda sudah diterima*, namun pesanan masih dalam proses lebih lama dari biasanya.\n\n` +
                `📌 Produk: *${transaction.product_name}*\n` +
                `🔖 Ref: \`${sekalipayRefId}\`\n\n` +
                `Jika dalam 5 menit belum menerima akun, silakan hubungi admin:\n` +
                `📞 wa.me/${ADMIN_PHONE.replace(/^62/, '62')}\n\n` +
                `Mohon maaf atas ketidaknyamanannya 🙏`,
            });

            if (ADMIN_PHONE) {
              await sendMessageToUser(phoneToJid(ADMIN_PHONE), {
                text:
                  `⏳ *Transaksi belum selesai setelah 2 menit!*\n` +
                  `Ref: ${sekalipayRefId}\n` +
                  `User: ${transaction.user_wa}\n` +
                  `Produk: ${transaction.product_name}\n` +
                  `Status Sekalipay: ${detail.data?.status || 'unknown'}`,
              });
            }
          }
        }
      } catch (err) {
        logger.error(`Manual check failed for ${sekalipayRefId}:`, err.message);
      }
    }, 2 * 60 * 1000); // 2 menit

  } catch (err) {
    logger.error(`Failed to create Sekalipay transaction for ${data.reference}:`, err.message);

    const errMsg = err.response?.data?.message || err.message;
    models.updateTransactionFailed(data.reference, errMsg);

    const userJid = transaction.user_wa;
    if (errMsg === 'BALANCE_IS_INSUFFICIENT') {
      await sendMessageToUser(userJid, {
        text: '❌ Maaf, stok/saldo sedang habis. Silakan coba lagi nanti atau hubungi admin.',
      });
    } else {
      await sendMessageToUser(userJid, {
        text: '❌ Maaf, terjadi kesalahan saat memproses pesanan. Silakan hubungi admin.',
      });
    }

    // Notifikasi admin
    if (ADMIN_PHONE) {
      await sendMessageToUser(phoneToJid(ADMIN_PHONE), {
        text: `❌ *Sekalipay Error!*\nRef: ${data.reference}\nUser: ${transaction.user_wa}\nError: ${errMsg}`,
      });
    }
  }
});

module.exports = router;

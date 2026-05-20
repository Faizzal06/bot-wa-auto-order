/**
 * Message Handler – State Machine per User (Text-Based Navigation)
 *
 * States:
 *   MENU               → tampilkan daftar kategori
 *   SELECTING_CATEGORY  → menunggu pilih kategori
 *   SELECTING_PRODUCT   → menunggu pilih produk
 *   SELECTING_VARIANT   → menunggu pilih varian
 *   CONFIRMING          → menunggu konfirmasi Ya/Tidak
 *   WAITING_PAYMENT     → link sudah dikirim, reset state
 */

const {
  isJidGroup,
} = require('@whiskeysockets/baileys');

const logger = require('../utils/logger');
const { formatRupiah, generateReference, jidToPhone, randomDelay } = require('../utils/helpers');
const { calculateSellingPrice } = require('../utils/profitRules');
const models = require('../db/models');
const uangx = require('../services/uangx');

const ADMIN_PHONE = process.env.ADMIN_PHONE || '';

// In-memory state per user
// Map<jid, { state, data }>
const userStates = new Map();

// ═══════════════════════════════════════════════════
// MESSAGE CONTENT EXTRACTION
// ═══════════════════════════════════════════════════

/**
 * Ekstrak teks dari pesan Baileys.
 * Kita hanya fokus pada teks karena native flow dihilangkan.
 */
function extractMessageContent(msg) {
  const message = msg.message;
  if (!message) return null;

  // Text biasa
  if (message.conversation) {
    return { text: message.conversation, type: 'text' };
  }
  if (message.extendedTextMessage?.text) {
    return { text: message.extendedTextMessage.text, type: 'text' };
  }

  // Support untuk response interaktif jika masih ada yang masuk (untuk backward compatibility)
  if (message.listResponseMessage) {
    return { text: message.listResponseMessage.singleSelectReply?.selectedRowId || '', type: 'list_response' };
  }
  if (message.buttonsResponseMessage) {
    return { text: message.buttonsResponseMessage.selectedButtonId || '', type: 'button_response' };
  }
  if (message.interactiveResponseMessage) {
    try {
      const paramsJson = message.interactiveResponseMessage.nativeFlowResponseMessage?.paramsJson;
      if (paramsJson) {
        const params = JSON.parse(paramsJson);
        return { text: params.id || '', type: 'interactive_response' };
      }
    } catch (e) {
      logger.warn('Failed to parse interactiveResponseMessage:', e.message);
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════
// MENU & PRODUCT DISPLAY (TEXT-BASED)
// ═══════════════════════════════════════════════════

/**
 * Kirim menu utama (Teks Daftar Kategori)
 */
async function sendMainMenu(sock, jid) {
  const categories = models.getCategories();

  if (categories.length === 0) {
    try {
      await randomDelay();
      await sock.sendMessage(jid, { text: '⚠️ Maaf, belum ada produk tersedia saat ini. Silakan coba lagi nanti.' });
    } catch (e) { }
    return;
  }

  let text = '🎉 *Selamat datang di Udinz Store!*\n\nSilakan pilih kategori layanan yang ingin kamu beli:\n\n';
  categories.forEach((cat, i) => {
    text += `*${i + 1}.* ${cat.category}\n`;
  });
  text += `\n👉 *Balas dengan nomor atau nama kategori*\n📞 Hubungi Admin: wa.me/${ADMIN_PHONE}`;

  try {
    await randomDelay();
    await sock.sendMessage(jid, { text });
  } catch (err) {
    logger.error('Failed to send main menu:', err.message);
  }

  userStates.set(jid, {
    state: 'SELECTING_CATEGORY',
    data: { categories: categories.map(c => c.category) },
  });
}

/**
 * Kirim daftar produk (Teks Daftar Produk) per kategori
 */
async function sendProductList(sock, jid, category) {
  const products = models.getUniqueProductsByCategory(category);

  if (products.length === 0) {
    await sock.sendMessage(jid, {
      text: '⚠️ Maaf, produk untuk kategori ini sedang kosong.',
    });
    return sendMainMenu(sock, jid);
  }

  let text = `📦 *Produk ${category}*\n\nSilakan pilih produk yang ingin kamu beli:\n\n`;
  products.forEach((p, i) => {
    text += `*${i + 1}.* ${p}\n`;
  });
  text += `\n👉 *Balas dengan nomor atau nama produk*`;

  try {
    await randomDelay();
    await sock.sendMessage(jid, { text });
  } catch (err) {
    logger.error('Failed to send product list:', err.message);
  }

  userStates.set(jid, {
    state: 'SELECTING_PRODUCT',
    data: { category, products },
  });
}

/**
 * Kirim daftar variant per produk (Teks Daftar Varian)
 */
async function sendVariantList(sock, jid, category, productName) {
  const variants = models.getVariantsByProduct(category, productName);

  if (variants.length === 0) {
    await sock.sendMessage(jid, {
      text: '⚠️ Maaf, varian untuk produk ini sedang kosong.',
    });
    return sendProductList(sock, jid, category);
  }

  let text = `🔖 *Varian ${productName}*\n\nPilih durasi/jenis yang ingin kamu beli:\n\n`;
  variants.forEach((v, i) => {
    const sellingPrice = calculateSellingPrice(v.price);
    text += `*${i + 1}.* ${v.variant_name} 💰 ${formatRupiah(sellingPrice)}\n`;
  });
  text += `\n👉 *Balas dengan nomor varian*`;

  try {
    await randomDelay();
    await sock.sendMessage(jid, { text });
  } catch (err) {
    logger.error('Failed to send variant list:', err.message);
  }

  userStates.set(jid, {
    state: 'SELECTING_VARIANT',
    data: { category, productName, variants },
  });
}

/**
 * Kirim konfirmasi pembelian (Teks Konfirmasi)
 */
async function sendConfirmation(sock, jid, product) {
  const sellingPrice = calculateSellingPrice(product.price);

  const confirmText =
    `🛒 *Detail Pesanan:*\n\n` +
    `📌 Produk: *${product.product_name} - ${product.variant_name}*\n` +
    `💰 Harga: *${formatRupiah(sellingPrice)}*\n\n` +
    `Apakah pesanan sudah benar?\n\n` +
    `👉 Balas *YA* untuk lanjut\n👉 Balas *TIDAK* untuk batal`;

  try {
    await randomDelay();
    await sock.sendMessage(jid, { text: confirmText });
  } catch (err) {
    logger.error('Failed to send confirmation:', err.message);
  }

  userStates.set(jid, {
    state: 'CONFIRMING',
    data: { product },
  });
}

// ═══════════════════════════════════════════════════
// ORDER PROCESSING
// ═══════════════════════════════════════════════════

/**
 * Proses konfirmasi pembelian → buat invoice UangX
 */
async function processOrder(sock, jid, msg) {
  const userState = userStates.get(jid);
  const product = userState?.data?.product;

  if (!product) {
    await sock.sendMessage(jid, { text: '⚠️ Terjadi kesalahan. Silakan mulai ulang dengan !menu' });
    userStates.delete(jid);
    return;
  }

  const pushName = msg.pushName || 'Pelanggan WA';
  const userWa = jid;
  const userPhone = jidToPhone(jid);
  const reference = generateReference();
  const sellingPrice = calculateSellingPrice(product.price);

  try {
    const paymentUrl = await uangx.createInvoice(
      sellingPrice,
      pushName,
      `${userPhone}@wa.me`,
      reference
    );

    models.createTransaction({
      user_wa: userWa,
      reference,
      variant_id: product.variant_id,
      product_name: `${product.product_name} - ${product.variant_name}`,
      original_price: product.price,
      amount: sellingPrice,
      payment_url: paymentUrl,
    });

    await randomDelay();
    await sock.sendMessage(jid, {
      text:
        `💰 *Invoice Pembayaran*\n\n` +
        `📌 Produk: *${product.product_name} - ${product.variant_name}*\n` +
        `💵 Total: *${formatRupiah(sellingPrice)}*\n` +
        `🔖 Ref: \`${reference}\`\n\n` +
        `Silakan lakukan pembayaran melalui link berikut:\n${paymentUrl}\n\n` +
        `📋 *Instruksi:*\n` +
        `1. Buka link di atas\n` +
        `2. Pilih metode pembayaran (QRIS/VA)\n` +
        `3. Bayar sesuai nominal\n\n` +
        `⏳ Pesanan akan otomatis diproses setelah pembayaran dikonfirmasi.`,
    });

    userStates.set(jid, { state: 'WAITING_PAYMENT', data: { reference } });
    logger.info(`Order created: ref=${reference}, user=${userWa}, product=${product.variant_id}, amount=${sellingPrice}`);
  } catch (err) {
    logger.error(`processOrder error for ${userWa}:`, err.message);
    await randomDelay();
    await sock.sendMessage(jid, {
      text: '❌ Maaf, terjadi kesalahan saat membuat invoice. Silakan coba lagi atau hubungi admin.',
    });
    userStates.delete(jid);
  }
}

// ═══════════════════════════════════════════════════
// MAIN MESSAGE HANDLER
// ═══════════════════════════════════════════════════

/**
 * Handler utama untuk setiap pesan masuk
 */
async function handleMessage(sock, msg) {
  try {
    await sock.readMessages([msg.key]);
  } catch (err) {
    logger.warn('Failed to send read receipt:', err.message);
  }

  const jid = msg.key.remoteJid;
  const content = extractMessageContent(msg);

  if (!content) return;

  const text = content.text.trim();
  const userState = userStates.get(jid);
  const currentState = userState?.state || null;

  logger.info(`Message from ${jidToPhone(jid)}: "${text}" (type: ${content.type}, state: ${currentState})`);

  // ─── COMMAND: !menu (selalu bisa dipanggil) ───
  if (text.toLowerCase() === '!menu') {
    userStates.delete(jid);
    return sendMainMenu(sock, jid);
  }

  // ─── STATE: SELECTING_CATEGORY ───
  if (currentState === 'SELECTING_CATEGORY') {
    const categories = userState.data.categories;
    let selectedCategory = null;

    if (text.startsWith('cat_')) {
      selectedCategory = text.replace('cat_', '');
    } else if (/^\d+$/.test(text)) {
      const idx = parseInt(text) - 1;
      if (idx >= 0 && idx < categories.length) {
        selectedCategory = categories[idx];
      }
    } else {
      selectedCategory = categories.find(c => c.toLowerCase() === text.toLowerCase());
    }

    if (selectedCategory) {
      return sendProductList(sock, jid, selectedCategory);
    } else {
      await randomDelay();
      await sock.sendMessage(jid, { text: '⚠️ Pilihan tidak valid. Silakan pilih dengan angka atau ketik !menu' });
      return;
    }
  }

  // ─── STATE: SELECTING_PRODUCT ───
  if (currentState === 'SELECTING_PRODUCT') {
    const products = userState.data.products;
    const category = userState.data.category;
    let selectedProductName = null;

    if (text.startsWith('prod_')) {
      selectedProductName = text.replace('prod_', '');
    } else if (/^\d+$/.test(text)) {
      const idx = parseInt(text) - 1;
      if (idx >= 0 && idx < products.length) {
        selectedProductName = products[idx];
      }
    } else {
      selectedProductName = products.find(p => p.toLowerCase() === text.toLowerCase());
    }

    if (selectedProductName) {
      return sendVariantList(sock, jid, category, selectedProductName);
    } else {
      await randomDelay();
      await sock.sendMessage(jid, { text: '⚠️ Pilihan tidak valid. Silakan pilih dengan angka atau ketik !menu' });
      return;
    }
  }

  // ─── STATE: SELECTING_VARIANT ───
  if (currentState === 'SELECTING_VARIANT') {
    const variants = userState.data.variants;
    let selectedVariant = null;

    if (text.startsWith('var_')) {
      const variantId = parseInt(text.replace('var_', ''));
      selectedVariant = variants.find(v => v.variant_id === variantId);
    } else if (/^\d+$/.test(text)) {
      const idx = parseInt(text) - 1;
      if (idx >= 0 && idx < variants.length) {
        selectedVariant = variants[idx];
      }
    }

    if (selectedVariant) {
      return sendConfirmation(sock, jid, selectedVariant);
    } else {
      await randomDelay();
      await sock.sendMessage(jid, { text: '⚠️ Pilihan tidak valid. Silakan pilih dengan angka atau ketik !menu' });
      return;
    }
  }

  // ─── STATE: CONFIRMING ───
  if (currentState === 'CONFIRMING') {
    const isYes = text === 'confirm_yes' || text.toLowerCase() === 'ya' || text.toLowerCase() === 'yes' || text === '1';
    const isNo = text === 'confirm_no' || text.toLowerCase() === 'tidak' || text.toLowerCase() === 'no' || text === '2';

    if (isYes) {
      return processOrder(sock, jid, msg);
    } else if (isNo) {
      await randomDelay();
      await sock.sendMessage(jid, { text: '❌ Pesanan dibatalkan.' });
      userStates.delete(jid);
      return sendMainMenu(sock, jid);
    } else {
      await randomDelay();
      await sock.sendMessage(jid, { text: '⚠️ Balas *YA* untuk konfirmasi atau *TIDAK* untuk batal.' });
      return;
    }
  }

  // ─── STATE: WAITING_PAYMENT ───
  if (currentState === 'WAITING_PAYMENT') {
    await randomDelay();
    await sock.sendMessage(jid, {
      text: '⏳ Pesanan kamu sedang menunggu pembayaran.\nJika sudah bayar, tunggu konfirmasi otomatis.\n\nKetik *!menu* untuk membuat pesanan baru.',
    });
    return;
  }

  // ─── NO STATE: tampilkan menu ───
  return sendMainMenu(sock, jid);
}

module.exports = { handleMessage, userStates };

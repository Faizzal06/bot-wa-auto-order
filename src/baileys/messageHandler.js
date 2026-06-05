/**
 * Message Handler – State Machine per User
 *
 * States:
 *   MENU               → tampilkan daftar produk
 *   SELECTING_PRODUCT   → menunggu pilih produk
 *   SELECTING_VARIANT   → menunggu pilih varian
 *   CONFIRMING          → menunggu konfirmasi Ya/Tidak
 *   WAITING_PAYMENT     → link sudah dikirim, reset state
 */

const {
  proto,
  generateWAMessageFromContent,
  normalizeMessageContent,
  isJidGroup,
  generateMessageIDV2,
} = require('@whiskeysockets/baileys');

const logger = require('../utils/logger');
const { formatRupiah, generateReference, jidToPhone, randomDelay } = require('../utils/helpers');
const { getFinalSellingPrice } = require('../utils/profitRules');
const models = require('../db/models');
const uangx = require('../services/uangx');
const productSync = require('../services/productSync');

const ADMIN_PHONE = process.env.ADMIN_PHONE || '';

// In-memory state per user
// Map<jid, { state, data }>
const userStates = new Map();

// ═══════════════════════════════════════════════════
// INTERACTIVE MESSAGE HELPERS (Native Flow)
// ═══════════════════════════════════════════════════

/**
 * Build the correct additionalNodes for relayMessage based on the message content.
 * WhatsApp requires specific binary node structures ("biz", "interactive", "bot")
 * for interactive messages to render properly.
 */
function getButtonArgs(message) {
  const nativeFlow = message.interactiveMessage?.nativeFlowMessage;
  if (nativeFlow || message.buttonsMessage) {
    return {
      tag: 'biz',
      attrs: {},
      content: [{
        tag: 'interactive',
        attrs: { type: 'native_flow', v: '1' },
        content: [{
          tag: 'native_flow',
          attrs: { v: '9', name: 'mixed' },
        }],
      }],
    };
  }
  return { tag: 'biz', attrs: {} };
}

/**
 * Send interactive buttons (quick_reply) using nativeFlowMessage.
 * Works on recent WA versions where old buttonsMessage is deprecated.
 */
async function sendInteractiveButtons(sock, jid, { title, body, footer, buttons }) {
  const content = {
    viewOnceMessage: {
      message: {
        interactiveMessage: proto.Message.InteractiveMessage.create({
          ...(title ? { header: proto.Message.InteractiveMessage.Header.create({ title }) } : {}),
          body: proto.Message.InteractiveMessage.Body.create({ text: body }),
          ...(footer ? { footer: proto.Message.InteractiveMessage.Footer.create({ text: footer }) } : {}),
          nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
            buttons: buttons.map(btn => ({
              name: 'quick_reply',
              buttonParamsJson: JSON.stringify({
                display_text: btn.text,
                id: btn.id,
              }),
            })),
          }),
        }),
      },
    },
  };

  const userJid = sock.authState?.creds?.me?.id || sock.user?.id;
  const fullMsg = generateWAMessageFromContent(jid, content, {
    userJid,
    messageId: generateMessageIDV2(userJid),
  });

  const normalizedContent = normalizeMessageContent(fullMsg.message);
  const additionalNodes = [getButtonArgs(normalizedContent)];

  if (!isJidGroup(jid)) {
    additionalNodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
  }

  await randomDelay();
  await sock.relayMessage(jid, fullMsg.message, {
    messageId: fullMsg.key.id,
    additionalNodes,
  });

  return fullMsg;
}

/**
 * Send a list message (single_select) using nativeFlowMessage.
 * The old listMessage format no longer works on recent WA versions.
 */
async function sendListMessage(sock, jid, { title, body, footer, buttonText, sections }) {
  const content = {
    viewOnceMessage: {
      message: {
        interactiveMessage: proto.Message.InteractiveMessage.create({
          ...(title ? { header: proto.Message.InteractiveMessage.Header.create({ title }) } : {}),
          body: proto.Message.InteractiveMessage.Body.create({ text: body }),
          ...(footer ? { footer: proto.Message.InteractiveMessage.Footer.create({ text: footer }) } : {}),
          nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
            buttons: [{
              name: 'single_select',
              buttonParamsJson: JSON.stringify({
                title: buttonText || 'Pilih',
                sections,
              }),
            }],
          }),
        }),
      },
    },
  };

  const userJid = sock.authState?.creds?.me?.id || sock.user?.id;
  const fullMsg = generateWAMessageFromContent(jid, content, {
    userJid,
    messageId: generateMessageIDV2(userJid),
  });

  const normalizedContent = normalizeMessageContent(fullMsg.message);
  const additionalNodes = [getButtonArgs(normalizedContent)];

  if (!isJidGroup(jid)) {
    additionalNodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
  }

  await randomDelay();
  await sock.relayMessage(jid, fullMsg.message, {
    messageId: fullMsg.key.id,
    additionalNodes,
  });

  return fullMsg;
}

// ═══════════════════════════════════════════════════
// MESSAGE CONTENT EXTRACTION
// ═══════════════════════════════════════════════════

/**
 * Ekstrak teks / ID dari berbagai jenis pesan Baileys
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

  // List response (user pilih dari list message)
  if (message.listResponseMessage) {
    return {
      text: message.listResponseMessage.singleSelectReply?.selectedRowId || '',
      title: message.listResponseMessage.title,
      type: 'list_response',
    };
  }

  // Button response (user klik button)
  if (message.buttonsResponseMessage) {
    return {
      text: message.buttonsResponseMessage.selectedButtonId || '',
      title: message.buttonsResponseMessage.selectedDisplayText,
      type: 'button_response',
    };
  }

  // Interactive response (native flow / newer WhatsApp versions)
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

  // Template button reply
  if (message.templateButtonReplyMessage) {
    return {
      text: message.templateButtonReplyMessage.selectedId || '',
      type: 'template_response',
    };
  }

  return null;
}

// ═══════════════════════════════════════════════════
// MENU & PRODUCT DISPLAY
// ═══════════════════════════════════════════════════

/**
 * Kirim menu utama (list message produk)
 */
async function sendMainMenu(sock, jid) {
  const products = models.getAllUniqueProducts();

  if (products.length === 0) {
    try {
      await randomDelay();
      await sock.sendMessage(jid, { text: '⚠️ Maaf, belum ada produk tersedia saat ini. Silakan coba lagi nanti.' });
    } catch (e) { }
    return;
  }

  const sections = [{
    title: '📦 Daftar Produk',
    rows: products.map(productName => ({
      header: 'Produk Premium',
      title: productName,
      id: `prod_${productName}`,
      description: '',
    })),
  }];

  try {
    await sendListMessage(sock, jid, {
      title: 'Menu Utama',
      body: '🎉 *Selamat datang di Udinz Store!*\nSilakan pilih produk yang ingin kamu beli:',
      footer: '📞 Hubungi Admin: wa.me/' + ADMIN_PHONE,
      buttonText: 'Pilih Produk',
      sections,
    });
  } catch (err) {
    // Fallback: kirim sebagai text biasa jika interactive message gagal
    logger.warn('List message failed, using text fallback:', err.message);
    let text = '🎉 *Selamat datang di Udinz Store!*\n\nSilakan pilih produk:\n\n';
    products.forEach((p, i) => {
      text += `*${i + 1}.* ${p}\n`;
    });
    text += `\nBalas dengan *nomor* untuk memilih.\n📞 Hubungi Admin: wa.me/${ADMIN_PHONE}`;
    await randomDelay();
    await sock.sendMessage(jid, { text });
  }

  userStates.set(jid, {
    state: 'SELECTING_PRODUCT',
    data: { products },
  });
}



/**
 * Kirim daftar variant per produk
 */
async function sendVariantList(sock, jid, productName) {
  const variants = models.getVariantsByProductName(productName);

  if (variants.length === 0) {
    await sock.sendMessage(jid, {
      text: '⚠️ Maaf, varian untuk produk ini sedang kosong.',
    });
    return sendMainMenu(sock, jid);
  }

  const sections = [{
    title: `🔖 Varian ${productName}`,
    rows: variants.map(v => {
      const sellingPrice = getFinalSellingPrice(v);
      return {
        header: productName,
        title: v.variant_name,
        id: `var_${v.variant_id}`,
        description: formatRupiah(sellingPrice),
      };
    }),
  }];

  try {
    await sendListMessage(sock, jid, {
      title: `Varian ${productName}`,
      body: `🔖 *Varian ${productName}*\nPilih durasi/jenis yang ingin kamu beli:`,
      footer: 'Harga sudah termasuk biaya layanan',
      buttonText: 'Pilih Varian',
      sections,
    });
  } catch (err) {
    // Fallback text
    logger.warn('List message failed, using text fallback:', err.message);
    let text = `🔖 *Varian ${productName}*\n\n`;
    variants.forEach((v, i) => {
      const sellingPrice = getFinalSellingPrice(v);
      text += `*${i + 1}.* ${v.variant_name}\n    💰 ${formatRupiah(sellingPrice)}\n`;
    });
    text += '\nBalas dengan *nomor* untuk memilih.';
    await randomDelay();
    await sock.sendMessage(jid, { text });
  }

  userStates.set(jid, {
    state: 'SELECTING_VARIANT',
    data: { productName, variants },
  });
}

/**
 * Kirim konfirmasi pembelian
 */
async function sendConfirmation(sock, jid, product) {
  const sellingPrice = getFinalSellingPrice(product);

  const confirmText =
    `🛒 *Detail Pesanan:*\n\n` +
    `📌 Produk: *${product.product_name} - ${product.variant_name}*\n` +
    `💰 Harga: *${formatRupiah(sellingPrice)}*\n\n` +
    `Apakah sudah benar?`;

  try {
    await sendInteractiveButtons(sock, jid, {
      title: 'Konfirmasi Pesanan',
      body: confirmText,
      footer: 'Udinz Store',
      buttons: [
        { text: '✅ Ya', id: 'confirm_yes' },
        { text: '❌ Tidak', id: 'confirm_no' },
      ],
    });
  } catch (err) {
    // Fallback text
    logger.warn('Button message failed, using text fallback:', err.message);
    await randomDelay();
    await sock.sendMessage(jid, {
      text: confirmText + '\n\nBalas *YA* untuk konfirmasi atau *TIDAK* untuk batal.',
    });
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
  const userWa = jid; // Simpan JID asli (bisa @lid atau @s.whatsapp.net)
  const userPhone = jidToPhone(jid);
  const reference = generateReference();
  const sellingPrice = getFinalSellingPrice(product);

  try {
    // Buat invoice UangX
    const paymentUrl = await uangx.createInvoice(
      sellingPrice,
      pushName,
      `${userPhone}@wa.me`,
      reference
    );

    // Simpan transaksi ke database (user_wa = full JID)
    models.createTransaction({
      user_wa: userWa,
      reference,
      variant_id: product.variant_id,
      product_name: `${product.product_name} - ${product.variant_name}`,
      original_price: product.price,
      amount: sellingPrice,
      payment_url: paymentUrl,
    });

    // Kirim link pembayaran ke pelanggan
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
  // Tandai pesan sudah dibaca (mencegah pemblokiran)
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

  const ADMIN_PHONES = ADMIN_PHONE.split(',').map(n => n.trim());
  const isAdmin = ADMIN_PHONES.includes(jidToPhone(jid));

  // ─── ADMIN COMMANDS ───
  if (isAdmin) {
    if (text.toLowerCase() === '!sync') {
      await sock.sendMessage(jid, { text: '⏳ Memulai sinkronisasi produk...' });
      try {
        const count = await productSync.initialSync();
        await sock.sendMessage(jid, { text: `✅ Sinkronisasi selesai. ${count} produk diperbarui.` });
      } catch (err) {
        await sock.sendMessage(jid, { text: `❌ Gagal sinkronisasi: ${err.message}` });
      }
      return;
    }

    if (text.toLowerCase() === '!admin') {
      userStates.delete(jid);
      return sendAdminMenu(sock, jid);
    }
    
    // Check if in admin state
    if (currentState && currentState.startsWith('ADMIN_')) {
      return handleAdminState(sock, jid, text, currentState, userState.data);
    }
  }


  // ─── STATE: SELECTING_PRODUCT ───
  if (currentState === 'SELECTING_PRODUCT') {
    const products = userState.data.products; // array of strings (product_name)
    let selectedProductName = null;

    // Dari interactive response: prod_{nama}
    if (text.startsWith('prod_')) {
      selectedProductName = text.replace('prod_', '');
    }
    // Dari text biasa: nomor
    else if (/^\d+$/.test(text)) {
      const idx = parseInt(text) - 1;
      if (idx >= 0 && idx < products.length) {
        selectedProductName = products[idx];
      }
    }
    // Dari text biasa: nama produk
    else {
      selectedProductName = products.find(p => p.toLowerCase() === text.toLowerCase());
    }

    if (selectedProductName) {
      return sendVariantList(sock, jid, selectedProductName);
    } else {
      await randomDelay();
      await sock.sendMessage(jid, { text: '⚠️ Pilihan tidak valid. Silakan pilih dari daftar atau ketik !menu' });
      return;
    }
  }

  // ─── STATE: SELECTING_VARIANT ───
  if (currentState === 'SELECTING_VARIANT') {
    const variants = userState.data.variants;
    let selectedVariant = null;

    // Dari interactive response: var_{variant_id}
    if (text.startsWith('var_')) {
      const variantId = parseInt(text.replace('var_', ''));
      selectedVariant = variants.find(v => v.variant_id === variantId);
    }
    // Dari text biasa: nomor
    else if (/^\d+$/.test(text)) {
      const idx = parseInt(text) - 1;
      if (idx >= 0 && idx < variants.length) {
        selectedVariant = variants[idx];
      }
    }

    if (selectedVariant) {
      return sendConfirmation(sock, jid, selectedVariant);
    } else {
      await randomDelay();
      await sock.sendMessage(jid, { text: '⚠️ Pilihan tidak valid. Silakan pilih dari daftar atau ketik !menu' });
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

// ═══════════════════════════════════════════════════
// ADMIN COMMANDS
// ═══════════════════════════════════════════════════

async function sendAdminMenu(sock, jid) {
  const products = models.getAllUniqueProducts();
  if (products.length === 0) {
    await sock.sendMessage(jid, { text: 'Belum ada produk untuk di-setting.' });
    return;
  }
  
  let text = '🛠️ *Admin Menu - Pilih Produk untuk Set Markup*\n\n';
  products.forEach((p, i) => {
    text += `*${i + 1}.* ${p}\n`;
  });
  text += '\nBalas dengan *nomor* produk. Ketik !batal untuk membatalkan.';
  
  userStates.set(jid, { state: 'ADMIN_SELECT_PRODUCT', data: { products } });
  await randomDelay();
  await sock.sendMessage(jid, { text });
}

async function handleAdminState(sock, jid, text, currentState, data) {
  if (text.toLowerCase() === '!batal') {
    userStates.delete(jid);
    await sock.sendMessage(jid, { text: 'Aksi admin dibatalkan.' });
    return;
  }

  if (currentState === 'ADMIN_SELECT_PRODUCT') {
    const products = data.products;
    let selectedProductName = null;
    if (/^\d+$/.test(text)) {
      const idx = parseInt(text) - 1;
      if (idx >= 0 && idx < products.length) {
        selectedProductName = products[idx];
      }
    } else {
      selectedProductName = products.find(p => p.toLowerCase() === text.toLowerCase());
    }

    if (selectedProductName) {
      const variants = models.getVariantsByProductName(selectedProductName);
      let replyText = `🛠️ *Admin Menu - Pilih Varian (${selectedProductName})*\n\n`;
      variants.forEach((v, i) => {
        replyText += `*${i + 1}.* ${v.variant_name} (Base: ${formatRupiah(v.price)}, Markup: ${v.markup !== null ? formatRupiah(v.markup) : 'Default'})\n`;
      });
      replyText += '\nBalas dengan *nomor* varian. Ketik !batal untuk membatalkan.';
      
      userStates.set(jid, { state: 'ADMIN_SELECT_VARIANT', data: { productName: selectedProductName, variants } });
      await randomDelay();
      await sock.sendMessage(jid, { text: replyText });
    } else {
      await sock.sendMessage(jid, { text: '⚠️ Pilihan tidak valid.' });
    }
    return;
  }

  if (currentState === 'ADMIN_SELECT_VARIANT') {
    const variants = data.variants;
    let selectedVariant = null;
    if (/^\d+$/.test(text)) {
      const idx = parseInt(text) - 1;
      if (idx >= 0 && idx < variants.length) {
        selectedVariant = variants[idx];
      }
    }

    if (selectedVariant) {
      let replyText = `🛠️ *Admin Menu - Set Markup*\n\n`;
      replyText += `Produk: *${data.productName} - ${selectedVariant.variant_name}*\n`;
      replyText += `Harga Base: *${formatRupiah(selectedVariant.price)}*\n`;
      replyText += `Markup Saat Ini: *${selectedVariant.markup !== null ? formatRupiah(selectedVariant.markup) : 'Default'}*\n\n`;
      replyText += `Balas dengan *angka nominal* untuk set markup (contoh: 5000).\nKetik *0* untuk mengembalikan ke markup Default (if-else).`;
      
      userStates.set(jid, { state: 'ADMIN_INPUT_MARKUP', data: { variant: selectedVariant } });
      await randomDelay();
      await sock.sendMessage(jid, { text: replyText });
    } else {
      await sock.sendMessage(jid, { text: '⚠️ Pilihan tidak valid.' });
    }
    return;
  }

  if (currentState === 'ADMIN_INPUT_MARKUP') {
    const variant = data.variant;
    if (/^\d+$/.test(text)) {
      const markupValue = parseInt(text);
      if (markupValue === 0) {
        models.setProductMarkup(variant.variant_id, null);
        await sock.sendMessage(jid, { text: `✅ Markup untuk ${variant.variant_name} dikembalikan ke Default (if-else).` });
      } else {
        models.setProductMarkup(variant.variant_id, markupValue);
        await sock.sendMessage(jid, { text: `✅ Markup untuk ${variant.variant_name} berhasil diset ke ${formatRupiah(markupValue)}.` });
      }
      userStates.delete(jid);
    } else {
      await sock.sendMessage(jid, { text: '⚠️ Harap masukkan angka yang valid.' });
    }
    return;
  }
}

module.exports = { handleMessage, userStates };

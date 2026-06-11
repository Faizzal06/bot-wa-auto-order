/**
 * Aturan Penentuan Harga Jual (Markup Bertingkat)
 *
 * Harga Pokok (Sekalipay)    Harga Jual
 * < Rp500                    Rp2.000
 * Rp500 – < Rp1.000          Rp3.000
 * Rp1.000 – < Rp3.000        Rp5.000
 * Rp3.000 – < Rp5.000        Rp8.000
 * Rp5.000 – < Rp10.000       Rp12.000
 * Rp10.000 – < Rp20.000      Rp25.000
 * >= Rp20.000                Harga pokok + Rp10.000
 */

function calculateSellingPrice(basePrice) {
  const price = Number(basePrice);

  if (price < 500) {
    return 2000;
  } else if (price >= 500 && price < 1000) {
    return price + 2100;
  } else if (price >= 1000 && price < 3000) {
    return price + 2400;
  } else if (price >= 3000 && price < 5000) {
    return price + 2800;
  } else if (price >= 5000 && price < 10000) {
    return price + 3000;
  } else if (price >= 10000 && price < 20000) {
    return price + 3500;
  } else {
    return price + 5000;
  }
}

function getFinalSellingPrice(product) {
  if (product && product.markup !== null && product.markup !== undefined) {
    return Number(product.price) + Number(product.markup);
  }
  return calculateSellingPrice(product ? product.price : 0);
}

module.exports = {
  calculateSellingPrice,
  getFinalSellingPrice,
};

// GET /api/config
// Public, non-secret display settings. The exchange rate lives on the server so
// the Leones shown beside a room price is the same rate the payment is created
// with. Nothing here is sensitive.

const F = require('./_flot');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.status(200).json({
    leRate: F.LE_RATE,
    currency: { card: F.CURRENCY.card, momo: F.CURRENCY.momo, 'in-app': F.CURRENCY['in-app'] },
  });
};

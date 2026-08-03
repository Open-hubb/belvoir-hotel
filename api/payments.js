const { neon } = require('@neondatabase/serverless');
const { isAdminRequest } = require('./_auth');
const { limit } = require('./_ratelimit');

let _sql = null;
function db() {
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}


module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (limit(req, res, 'admin', 30, 60000)) return;
  if (!(await isAdminRequest(db(), req))) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const sql = db();
    const rows = await sql`
      SELECT p.id, p.received_at, p.booking_id, p.reference, p.payer_name, p.payer_email,
             p.amount, p.currency, p.status, p.provider_ref, p.matched,
             b.guest_name, b.room_name
      FROM payments p
      LEFT JOIN bookings b ON b.id = p.booking_id
      ORDER BY p.received_at DESC
      LIMIT 500`;
    return res.status(200).json({ payments: rows });
  } catch (e) {
    console.error('payments api error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
};

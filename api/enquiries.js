const { neon } = require('@neondatabase/serverless');
const { isAdminRequest } = require('./_auth');
const { limit } = require('./_ratelimit');
const { notifyEnquiry } = require('./_notify');

let _sql = null;
function db() {
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}


const STAY_TYPES = ['', 'short', 'extended', 'long', 'business'];

module.exports = async (req, res) => {
  try {
    const sql = db();

    if (req.method === 'POST') {
      if (limit(req, res, 'enquiry', 6, 60000)) return;
      const b = req.body || {};
      const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

      const name = clip(b.name, 120);
      const email = clip(b.email, 160);
      const message = clip(b.message, 2000);
      const phone = clip(b.phone, 40);
      const stayType = clip(b.stayType, 20);
      const source = ['contact', 'long-stay'].includes(b.source) ? b.source : 'contact';

      if (!name || !email || !message) {
        return res.status(400).json({ error: 'Please fill in your name, email and message.' });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Please enter a valid email address.' });
      }
      if (!STAY_TYPES.includes(stayType)) {
        return res.status(400).json({ error: 'Invalid stay type.' });
      }

      const rows = await sql`
        INSERT INTO enquiries (name, email, phone, stay_type, message, source)
        VALUES (${name}, ${email}, ${phone}, ${stayType}, ${message}, ${source})
        RETURNING id`;

      // Notify the team, but never fail the enquiry because email fell over
      try {
        await notifyEnquiry({ name, email, phone, stay_type: stayType, message, source });
      } catch (err) {
        console.error('enquiry notification failed:', err.message);
      }

      return res.status(201).json({ ok: true, id: rows[0].id });
    }

    if (req.method === 'GET') {
      if (limit(req, res, 'admin', 30, 60000)) return;
      if (!(await isAdminRequest(sql, req))) return res.status(401).json({ error: 'Unauthorized' });
      const rows = await sql`SELECT * FROM enquiries ORDER BY created_at DESC LIMIT 500`;
      return res.status(200).json({ enquiries: rows });
    }

    if (req.method === 'PATCH') {
      if (limit(req, res, 'admin', 30, 60000)) return;
      if (!(await isAdminRequest(sql, req))) return res.status(401).json({ error: 'Unauthorized' });
      const b = req.body || {};
      const id = parseInt(b.id, 10);
      if (!id) return res.status(400).json({ error: 'Missing id' });
      if (!['new', 'handled'].includes(b.status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      const rows = await sql`
        UPDATE enquiries SET status = ${b.status} WHERE id = ${id}
        RETURNING id, status`;
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json({ ok: true, enquiry: rows[0] });
    }

    res.setHeader('Allow', 'GET, POST, PATCH');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('enquiries api error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
};

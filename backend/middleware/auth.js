const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
async function requireAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return res.status(401).json({ message: 'Please log in to continue.' });
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) return res.status(500).json({ message: 'Authentication is not configured securely.' });
    const p = jwt.verify(h.slice(7), process.env.JWT_SECRET, { issuer: 'intelliquiz' });
    const r = await pool.query('SELECT id,name,email,role,roll_number AS "rollNumber",course,branch,mobile,is_active AS "isActive" FROM users WHERE id=$1', [p.sub]);
    if (!r.rowCount || !r.rows[0].isActive) return res.status(401).json({ message: 'Your session is no longer valid.' });
    req.user = r.rows[0]; next();
  } catch (_e) { return res.status(401).json({ message: 'Invalid or expired session. Please log in again.' }); }
}
function requireRole(...roles) {
  return (req, res, next) => roles.includes(req.user?.role) ? next() : res.status(403).json({ message: 'You do not have permission to perform this action.' });
}
module.exports = { requireAuth, requireRole };

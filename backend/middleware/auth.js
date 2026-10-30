const jwt = require('jsonwebtoken');
const User = require('../models/User');
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return res.status(401).json({ message: 'Please log in to continue.' });
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) return res.status(500).json({ message: 'Authentication is not configured securely.' });
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET, { issuer: 'intelliquiz' });
    const user = await User.findOne({ _id: payload.sub, isActive: true }).select('-passwordHash');
    if (!user) return res.status(401).json({ message: 'Account not found or inactive.' });
    if (Number(payload.ver || 0) !== Number(user.tokenVersion || 0)) return res.status(401).json({ message: 'Your session was revoked. Please sign in again.' });
    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired session.' });
  }
}
function requireRole(...roles) {
  return (req, res, next) => roles.includes(req.user?.role) ? next() : res.status(403).json({ message: 'You do not have permission to perform this action.' });
}
module.exports = { requireAuth, requireRole };

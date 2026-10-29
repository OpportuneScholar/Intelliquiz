const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
function token(user) {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw Object.assign(new Error('JWT_SECRET must contain at least 32 characters.'), { status: 500 });
  return jwt.sign({ sub: String(user.id), role: user.role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '8h', issuer: 'intelliquiz' });
}
const publicUser = r => ({ id: r.id, name: r.name, email: r.email, role: r.role, rollNumber: r.roll_number, course: r.course, branch: r.branch, mobile: r.mobile });
router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password, rollNumber, course, branch, mobile } = req.body || {};
    if (![name,email,password,rollNumber,course,branch,mobile].every(v => typeof v === 'string' && v.trim())) return res.status(400).json({ message: 'All registration fields are required.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: 'Enter a valid email address.' });
    if (password.length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters.' });
    if (!/^\d{10}$/.test(mobile.trim())) return res.status(400).json({ message: 'Enter a valid 10-digit mobile number.' });
    const hash = await bcrypt.hash(password, 12);
    const q = await pool.query('INSERT INTO users(name,email,password_hash,role,roll_number,course,branch,mobile) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,name,email,role,roll_number,course,branch,mobile',
      [name.trim(), email.toLowerCase().trim(), hash, 'student', rollNumber.trim(), course.trim(), branch.trim(), mobile.trim()]);
    res.status(201).json({ message: 'Registration successful.', user: publicUser(q.rows[0]) });
  } catch (e) { if (e.code === '23505') return res.status(409).json({ message: 'An account with these details already exists.' }); next(e); }
});
router.post('/login', async (req, res, next) => {
  try {
    const { email, password, role } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string' || !['student','teacher'].includes(role)) return res.status(400).json({ message: 'Email, password and a valid role are required.' });
    const q = await pool.query('SELECT * FROM users WHERE email=$1 AND role=$2 AND is_active=TRUE', [email.toLowerCase().trim(), role]);
    const u = q.rows[0];
    if (!u || !(await bcrypt.compare(password, u.password_hash))) return res.status(401).json({ message: 'Email or password is incorrect.' });
    res.json({ token: token(u), user: publicUser(u) });
  } catch (e) { next(e); }
});
router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));
router.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const allowed = ['name','course','branch','mobile'];
    const fields = allowed.filter(k => req.body[k] !== undefined);
    if (!fields.length) return res.json({ user: req.user });
    const sets = fields.map((k,i) => `${k}=$${i+1}`);
    const vals = fields.map(k => String(req.body[k]).trim()); vals.push(req.user.id);
    const q = await pool.query(`UPDATE users SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING id,name,email,role,roll_number,course,branch,mobile`, vals);
    res.json({ user: publicUser(q.rows[0]) });
  } catch (e) { next(e); }
});
module.exports = router;

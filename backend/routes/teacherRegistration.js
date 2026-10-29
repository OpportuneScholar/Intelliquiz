const router = require('express').Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const pool = require('../db/pool');

function mailer() {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST, port: Number(SMTP_PORT),
    secure: SMTP_SECURE === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
}
function otpDigest(email, otp) {
  return crypto.createHash('sha256').update(email.toLowerCase() + ':' + otp).digest('hex');
}
function validEmail(email) { return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }

// Request an email OTP before creating a teacher account.
router.post('/request-otp', async (req, res, next) => {
  try {
    const { name, email, password } = req.body || {};
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 120 ||
        !validEmail(email) || typeof password !== 'string' || password.length < 10) {
      return res.status(400).json({ message: 'Provide a valid name, email, and password of at least 10 characters.' });
    }
    const sendMail = mailer();
    if (!sendMail) return res.status(503).json({ message: 'Email OTP is not configured yet. Set SMTP settings in the server environment.' });

    const normalizedEmail = email.toLowerCase().trim();
    const exists = await pool.query('SELECT 1 FROM users WHERE email=$1', [normalizedEmail]);
    if (exists.rowCount) return res.status(409).json({ message: 'An account with this email already exists.' });

    const recent = await pool.query(
      "SELECT COUNT(*)::int AS n FROM teacher_registration_otps WHERE email=$1 AND created_at > NOW() - INTERVAL '1 hour'",
      [normalizedEmail]
    );
    if (recent.rows[0].n >= 5) return res.status(429).json({ message: 'Too many OTP requests. Try again later.' });

    const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const passwordHash = await bcrypt.hash(password, 12);
    await pool.query('DELETE FROM teacher_registration_otps WHERE email=$1', [normalizedEmail]);
    await pool.query(
      'INSERT INTO teacher_registration_otps(email,name,password_hash,otp_hash,expires_at) VALUES($1,$2,$3,$4,NOW()+INTERVAL \'10 minutes\')',
      [normalizedEmail, name.trim(), passwordHash, otpDigest(normalizedEmail, otp)]
    );

    try {
      await sendMail.sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        to: normalizedEmail,
        subject: 'Your IntelliQuiz teacher verification code',
        text: 'Your IntelliQuiz teacher verification code is ' + otp + '. It expires in 10 minutes. If you did not request this, ignore this email.',
        html: '<p>Your IntelliQuiz teacher verification code is:</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px">' + otp + '</p><p>This code expires in 10 minutes. If you did not request this, ignore this email.</p>'
      });
    } catch (mailError) {
      await pool.query('DELETE FROM teacher_registration_otps WHERE email=$1', [normalizedEmail]);
      console.error('Teacher OTP email delivery failed:', mailError.message);
      return res.status(502).json({ message: 'Could not send verification email. Check SMTP configuration and try again.' });
    }
    res.status(202).json({ message: 'Verification code sent. Check your email; the code expires in 10 minutes.' });
  } catch (e) { next(e); }
});

router.post('/verify-otp', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase().trim() : '';
    const otp = typeof req.body?.otp === 'string' ? req.body.otp.trim() : '';
    if (!validEmail(email) || !/^\d{6}$/.test(otp)) return res.status(400).json({ message: 'Enter the email address and 6-digit verification code.' });

    await client.query('BEGIN');
    const q = await client.query(
      'SELECT * FROM teacher_registration_otps WHERE email=$1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE',
      [email]
    );
    const pending = q.rows[0];
    if (!pending) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'No active verification request. Request a new code.' });
    }
    if (new Date(pending.expires_at) <= new Date() || pending.attempts >= 5) {
      await client.query('DELETE FROM teacher_registration_otps WHERE id=$1', [pending.id]);
      await client.query('COMMIT');
      return res.status(400).json({ message: 'Code expired or too many attempts. Request a new code.' });
    }
    const supplied = otpDigest(email, otp);
    const correct = crypto.timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(pending.otp_hash, 'hex'));
    if (!correct) {
      await client.query('UPDATE teacher_registration_otps SET attempts=attempts+1 WHERE id=$1', [pending.id]);
      await client.query('COMMIT');
      return res.status(400).json({ message: 'Incorrect verification code.' });
    }
    const created = await client.query(
      "INSERT INTO users(name,email,password_hash,role) VALUES($1,$2,$3,'teacher') RETURNING id,name,email,role",
      [pending.name, pending.email, pending.password_hash]
    );
    await client.query('DELETE FROM teacher_registration_otps WHERE email=$1', [email]);
    await client.query('COMMIT');
    const user = created.rows[0];
    const jwt = require('jsonwebtoken');
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
      return res.status(201).json({ message: 'Teacher account created. Set JWT_SECRET and log in to continue.', user });
    }
    const token = jwt.sign({ sub: String(user.id), role: user.role }, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '8h', issuer: 'intelliquiz'
    });
    res.status(201).json({ message: 'Email verified. Teacher account created successfully.', token, user });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (e.code === '23505') return res.status(409).json({ message: 'An account with this email already exists.' });
    next(e);
  } finally { client.release(); }
});
module.exports = router;

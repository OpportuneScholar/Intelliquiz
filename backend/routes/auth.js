const router = require('express').Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');
const { sendMail } = require('../services/mailer');

function token(u) {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw Object.assign(new Error('JWT_SECRET must contain at least 32 characters.'), { status: 500 });
  }
  return jwt.sign({ sub: String(u._id), role: u.role, ver: Number(u.tokenVersion || 0) }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '8h', issuer: 'intelliquiz'
  });
}
const publicUser = u => ({
  id: String(u._id), name: u.name, email: u.email, role: u.role,
  rollNumber: u.rollNumber, course: u.course, branch: u.branch, mobile: u.mobile
});
const validEmail = email => typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const otpDigest = (email, otp) => crypto.createHash('sha256').update(email.toLowerCase() + ':' + otp).digest('hex');

const RESET_OTP_TTL_MS = 10 * 60 * 1000;
const RESET_RESEND_COOLDOWN_MS = 60 * 1000;
const RESET_MAX_ATTEMPTS = 5;
const minPasswordFor = role => (role === 'teacher' ? 10 : 8);

// ---------- Student registration (no OTP) ----------
router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password, rollNumber, course, branch, mobile } = req.body || {};
    if (![name, email, password, rollNumber, course, branch, mobile].every(v => typeof v === 'string' && v.trim())) return res.status(400).json({ message: 'All registration fields are required.' });
    if (!validEmail(email)) return res.status(400).json({ message: 'Enter a valid email address.' });
    if (password.length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters.' });
    if (!/^\d{10}$/.test(mobile.trim())) return res.status(400).json({ message: 'Enter a valid 10-digit mobile number.' });
    const user = await User.create({
      name: name.trim(), email: email.toLowerCase().trim(), passwordHash: await bcrypt.hash(password, 12),
      role: 'student', rollNumber: rollNumber.trim(), course: course.trim(), branch: branch.trim(), mobile: mobile.trim()
    });
    res.status(201).json({ message: 'Registration successful.', token: token(user), user: publicUser(user) });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ message: 'An account with this email already exists.' });
    next(e);
  }
});

// ---------- Login (students and teachers: email + password only, no OTP) ----------
router.post('/login', async (req, res, next) => {
  try {
    const { email, password, role } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string' || !['student', 'teacher'].includes(role)) return res.status(400).json({ message: 'Email, password and a valid role are required.' });
    const normalizedEmail = email.toLowerCase().trim();
    const u = await User.findOne({ email: normalizedEmail, isActive: true });
    if (!u || u.role !== role || !(await bcrypt.compare(password, u.passwordHash))) return res.status(401).json({ message: 'Email, password or account type is incorrect. Check your details and try again.' });
    res.json({ token: token(u), user: publicUser(u) });
  } catch (e) { next(e); }
});

// ---------- Forgot password: step 1 — email a 6-digit OTP ----------
// The response is always the same for unknown emails, so account existence cannot be discovered.
router.post('/forgot-password', async (req, res, next) => {
  try {
    const email = validEmail(req.body?.email) ? req.body.email.toLowerCase().trim() : '';
    if (!email) return res.status(400).json({ message: 'Enter a valid email address.' });
    const genericMessage = 'If an account exists for that email, a 6-digit OTP has been sent. It expires in 10 minutes.';
    const user = await User.findOne({ email, isActive: true }).select('+passwordResetSentAt');
    if (!user) return res.status(202).json({ message: genericMessage });
    if (user.passwordResetSentAt && Date.now() - user.passwordResetSentAt.getTime() < RESET_RESEND_COOLDOWN_MS) {
      return res.status(202).json({ message: genericMessage }); // resend cooldown, silently
    }

    const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    user.passwordResetOtpHash = otpDigest(email, otp);
    user.passwordResetExpiresAt = new Date(Date.now() + RESET_OTP_TTL_MS);
    user.passwordResetAttempts = 0;
    user.passwordResetSentAt = new Date();
    await user.save();

    try {
      await sendMail({
        to: email,
        subject: 'Your IntelliQuiz password reset code',
        text: 'Your IntelliQuiz password reset code is ' + otp + '. It expires in 10 minutes. If you did not request this, ignore this email.',
        html: '<h2>Reset your IntelliQuiz password</h2><p>Your one-time code:</p><p style="font-size:32px;font-weight:bold;letter-spacing:8px">' + otp + '</p><p>It expires in 10 minutes. Never share this code with anyone.</p><p>If you did not request this, ignore this email.</p>'
      });
    } catch (mailError) {
      user.passwordResetOtpHash = undefined;
      user.passwordResetExpiresAt = undefined;
      user.passwordResetSentAt = undefined;
      await user.save();
      return next(mailError);
    }
    res.status(202).json({ message: genericMessage });
  } catch (e) { next(e); }
});

// ---------- Forgot password: step 2 — verify the OTP and set a new password ----------
router.post('/reset-password', async (req, res, next) => {
  try {
    const email = validEmail(req.body?.email) ? req.body.email.toLowerCase().trim() : '';
    const otp = typeof req.body?.otp === 'string' ? req.body.otp.trim() : '';
    const password = req.body?.password;
    if (!email || !/^\d{6}$/.test(otp) || typeof password !== 'string') {
      return res.status(400).json({ message: 'Enter your email, the 6-digit OTP and a new password.' });
    }
    const invalid = { message: 'This OTP is invalid or has expired. Request a new one.' };
    const user = await User.findOne({ email, isActive: true })
      .select('+passwordResetOtpHash +passwordResetExpiresAt +passwordResetAttempts');
    if (!user || !user.passwordResetOtpHash || !user.passwordResetExpiresAt || user.passwordResetExpiresAt <= new Date()) {
      return res.status(400).json(invalid);
    }
    if (password.length < minPasswordFor(user.role)) {
      return res.status(400).json({ message: 'Password must be at least ' + minPasswordFor(user.role) + ' characters.' });
    }
    if ((user.passwordResetAttempts || 0) >= RESET_MAX_ATTEMPTS) {
      user.passwordResetOtpHash = undefined; user.passwordResetExpiresAt = undefined; user.passwordResetAttempts = 0;
      await user.save();
      return res.status(400).json({ message: 'Too many wrong attempts. Request a new OTP.' });
    }
    const expected = Buffer.from(user.passwordResetOtpHash, 'hex');
    const actual = Buffer.from(otpDigest(email, otp), 'hex');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      user.passwordResetAttempts = (user.passwordResetAttempts || 0) + 1;
      await user.save();
      return res.status(400).json({ message: 'Incorrect OTP. ' + Math.max(0, RESET_MAX_ATTEMPTS - user.passwordResetAttempts) + ' attempt(s) left.' });
    }
    user.passwordHash = await bcrypt.hash(password, 12);
    user.tokenVersion = Number(user.tokenVersion || 0) + 1; // signs out every old session
    user.passwordResetOtpHash = undefined;
    user.passwordResetExpiresAt = undefined;
    user.passwordResetAttempts = 0;
    user.passwordResetSentAt = undefined;
    await user.save();
    res.json({ message: 'Password updated successfully. You can now sign in.' });
  } catch (e) { next(e); }
});

router.get('/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));
router.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const allowed = ['name', 'course', 'branch', 'mobile'];
    for (const k of allowed) if (req.body[k] !== undefined) req.user[k] = String(req.body[k]).trim();
    await req.user.save();
    res.json({ user: publicUser(req.user) });
  } catch (e) { next(e); }
});
module.exports = router;

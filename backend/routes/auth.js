const router = require('express').Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');

function token(u) {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw Object.assign(new Error('JWT_SECRET must contain at least 32 characters.'), { status: 500 });
  }
  return jwt.sign({ sub: String(u._id), role: u.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '8h', issuer: 'intelliquiz'
  });
}
const publicUser = u => ({
  id: String(u._id), name: u.name, email: u.email, role: u.role,
  rollNumber: u.rollNumber, course: u.course, branch: u.branch, mobile: u.mobile
});
const validEmail = email => typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

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

router.post('/login', async (req, res, next) => {
  try {
    const { email, password, role } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string' || !['student', 'teacher'].includes(role)) return res.status(400).json({ message: 'Email, password and a valid role are required.' });
    const u = await User.findOne({ email: email.toLowerCase().trim(), role, isActive: true });
    if (!u || !(await bcrypt.compare(password, u.passwordHash))) return res.status(401).json({ message: 'Email or password is incorrect.' });
    res.json({ token: token(u), user: publicUser(u) });
  } catch (e) { next(e); }
});

// Always return the same message so account existence cannot be discovered.
router.post('/forgot-password', async (req, res, next) => {
  try {
    const email = validEmail(req.body?.email) ? req.body.email.toLowerCase().trim() : '';
    const genericMessage = 'If an account exists for that email, a password reset link will be sent shortly.';
    if (!email) return res.status(400).json({ message: 'Enter a valid email address.' });
    const user = await User.findOne({ email, isActive: true }).select('+passwordResetTokenHash +passwordResetExpiresAt');
    if (!user) return res.status(202).json({ message: genericMessage });
    if (!process.env.RESEND_API_KEY) return res.status(503).json({ message: 'Password reset email is not configured. Please contact the site administrator.' });

    const rawToken = crypto.randomBytes(32).toString('hex');
    user.passwordResetTokenHash = digest(rawToken);
    user.passwordResetExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await user.save();

    const baseUrl = (process.env.CLIENT_ORIGIN || process.env.PUBLIC_URL || '').split(',')[0].trim().replace(/\/$/, '');
    if (!baseUrl) {
      user.passwordResetTokenHash = undefined;
      user.passwordResetExpiresAt = undefined;
      await user.save();
      return res.status(503).json({ message: 'Set CLIENT_ORIGIN to the public IntelliQuiz URL to enable password reset links.' });
    }
    const resetUrl = baseUrl + '/?resetToken=' + encodeURIComponent(rawToken) + '&email=' + encodeURIComponent(email);
    const { error } = await new Resend(process.env.RESEND_API_KEY).emails.send({
      from: process.env.MAIL_FROM || 'IntelliQuiz <onboarding@resend.dev>',
      to: [email],
      subject: 'Reset your IntelliQuiz password',
      text: 'Use this link to reset your IntelliQuiz password within 15 minutes: ' + resetUrl + '\nIf you did not request this, ignore this email.',
      html: '<h2>Reset your IntelliQuiz password</h2><p>This link expires in 15 minutes.</p><p><a href="' + resetUrl + '">Reset password</a></p><p>If you did not request this, ignore this email.</p>'
    });
    if (error) {
      user.passwordResetTokenHash = undefined;
      user.passwordResetExpiresAt = undefined;
      await user.save();
      console.error('Password reset email failed:', error.message);
      return res.status(502).json({ message: 'Could not send reset email. Check Resend sender/domain settings.' });
    }
    res.status(202).json({ message: genericMessage });
  } catch (e) { next(e); }
});

router.post('/reset-password', async (req, res, next) => {
  try {
    const { email, token: rawToken, password } = req.body || {};
    if (!validEmail(email) || typeof rawToken !== 'string' || rawToken.length < 32 || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ message: 'Provide a valid reset link and a password of at least 8 characters.' });
    }
    const user = await User.findOne({ email: email.toLowerCase().trim(), isActive: true })
      .select('+passwordResetTokenHash +passwordResetExpiresAt');
    if (!user || !user.passwordResetTokenHash || !user.passwordResetExpiresAt ||
        user.passwordResetExpiresAt <= new Date() ||
        !crypto.timingSafeEqual(Buffer.from(digest(rawToken), 'hex'), Buffer.from(user.passwordResetTokenHash, 'hex'))) {
      return res.status(400).json({ message: 'This reset link is invalid or expired. Request a new one.' });
    }
    user.passwordHash = await bcrypt.hash(password, 12);
    user.passwordResetTokenHash = undefined;
    user.passwordResetExpiresAt = undefined;
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

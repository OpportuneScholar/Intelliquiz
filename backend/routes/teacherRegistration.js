const router = require('express').Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const TeacherOtp = require('../models/TeacherOtp');
const { sendMail } = require('../services/mailer');

const otpDigest = (email, otp) => crypto.createHash('sha256').update(email.toLowerCase() + ':' + otp).digest('hex');
const validEmail = e => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const publicTeacher = u => ({ id: String(u._id), name: u.name, email: u.email, role: u.role });

// Teacher signup step 1: send a 6-digit email OTP (teachers verify email; students do not).
router.post('/request-otp', async (req, res, next) => {
  try {
    const { name, email, password } = req.body || {};
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 120 || !validEmail(email) || typeof password !== 'string' || password.length < 10) {
      return res.status(400).json({ message: 'Provide a valid name, email, and password of at least 10 characters.' });
    }
    const normalized = email.toLowerCase().trim();
    if (await User.exists({ email: normalized })) return res.status(409).json({ message: 'An account with this email already exists.' });
    const recent = await TeacherOtp.countDocuments({ email: normalized, createdAt: { $gt: new Date(Date.now() - 3600000) } });
    if (recent >= 5) return res.status(429).json({ message: 'Too many OTP requests. Try again later.' });

    const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await TeacherOtp.deleteMany({ email: normalized });
    await TeacherOtp.create({
      email: normalized, name: name.trim(), passwordHash: await bcrypt.hash(password, 12),
      otpHash: otpDigest(normalized, otp), expiresAt: new Date(Date.now() + 600000)
    });
    try {
      await sendMail({
        to: normalized,
        subject: 'Your IntelliQuiz teacher verification code',
        text: 'Your IntelliQuiz verification code is ' + otp + '. It expires in 10 minutes.',
        html: '<h2>IntelliQuiz teacher verification</h2><p>Your one-time code:</p><p style="font-size:32px;font-weight:bold;letter-spacing:8px">' + otp + '</p><p>It expires in 10 minutes. Never share this code.</p>'
      });
    } catch (mailError) {
      await TeacherOtp.deleteMany({ email: normalized });
      return next(mailError);
    }
    res.status(202).json({ message: 'Verification code sent. It expires in 10 minutes.' });
  } catch (e) { next(e); }
});

// Teacher signup step 2: verify the OTP and create the account.
router.post('/verify-otp', async (req, res, next) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase().trim() : '';
    const otp = typeof req.body?.otp === 'string' ? req.body.otp.trim() : '';
    if (!validEmail(email) || !/^\d{6}$/.test(otp)) return res.status(400).json({ message: 'Enter email and the 6-digit code.' });
    const pending = await TeacherOtp.findOne({ email }).sort({ createdAt: -1 });
    if (!pending) return res.status(400).json({ message: 'No active verification request. Request a new code.' });
    if (pending.expiresAt <= new Date() || pending.attempts >= 5) {
      await pending.deleteOne();
      return res.status(400).json({ message: 'Code expired or too many attempts. Request a new code.' });
    }
    const a = Buffer.from(otpDigest(email, otp), 'hex'), b = Buffer.from(pending.otpHash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      pending.attempts++;
      await pending.save();
      return res.status(400).json({ message: 'Incorrect verification code.' });
    }
    const user = await User.create({ name: pending.name, email: pending.email, passwordHash: pending.passwordHash, role: 'teacher' });
    await TeacherOtp.deleteMany({ email });
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
      return res.status(201).json({ message: 'Account created. Configure JWT_SECRET and log in.', user: publicTeacher(user) });
    }
    const token = jwt.sign({ sub: String(user._id), role: user.role, ver: 0 }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '8h', issuer: 'intelliquiz' });
    res.status(201).json({ message: 'Email verified. Teacher account created.', token, user: publicTeacher(user) });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ message: 'An account with this email already exists.' });
    next(e);
  }
});
module.exports = router;

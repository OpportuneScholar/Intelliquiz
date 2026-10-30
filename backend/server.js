require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { connectDatabase, mongoose } = require('./db/pool');
const User = require('./models/User');
const Question = require('./models/Question');
const Exam = require('./models/Exam');
const Submission = require('./models/Submission');
const authRoutes = require('./routes/auth');
const teacherRegistrationRoutes = require('./routes/teacherRegistration');
const questionRoutes = require('./routes/questions');
const examRoutes = require('./routes/exams');
const { requireAuth, requireRole } = require('./middleware/auth');
const { sweepExpiredAttempts } = require('./services/grading');
const app = express();
const publicDir = path.join(__dirname, 'public');
app.disable('x-powered-by');
// Trust the single reverse proxy in front of the Voroa service.
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"], baseUri: ["'self'"], objectSrc: ["'none'"],
      frameAncestors: ["'none'"], formAction: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:"], connectSrc: ["'self'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
    }
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));
const configuredOrigins = (process.env.CLIENT_ORIGIN || '').split(',').map(v => v.trim()).filter(Boolean);
app.use(cors((req, callback) => {
  const requestOrigin = req.header('Origin');
  const forwardedProto = (req.get('x-forwarded-proto') || req.protocol).split(',')[0].trim();
  const sameOrigin = requestOrigin === `${forwardedProto}://${req.get('host')}`;
  const allowed = !requestOrigin || !configuredOrigins.length || configuredOrigins.includes(requestOrigin) || sameOrigin;
  callback(null, { origin: allowed, credentials: true });
}));
app.use((req, res, next) => { if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store'); next(); });
app.use(express.json({ limit: '100kb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use('/api/auth', rateLimit({ windowMs: 900000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false }), authRoutes);
app.use('/api/teacher-registration', rateLimit({ windowMs: 900000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false }), teacherRegistrationRoutes);
app.use('/api/questions', rateLimit({ windowMs: 900000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }), questionRoutes);
app.use('/api/exams', rateLimit({ windowMs: 900000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false }), examRoutes);
app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'IntelliQuiz API', database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' }));
app.get('/api/dashboard/summary', requireAuth, requireRole('teacher'), async (req, res, next) => {
  try {
    const examIds = await Exam.find({ createdBy: req.user._id }).distinct('_id');
    const [students, questions, attempts] = await Promise.all([
      User.countDocuments({ role: 'student', isActive: true }),
      Question.countDocuments({ isActive: true, createdBy: req.user._id }),
      Submission.countDocuments({ exam: { $in: examIds } })
    ]);
    res.json({ students, questions, attempts });
  } catch (error) { next(error); }
});
app.get('/', (_req, res, next) => res.sendFile(path.join(publicDir, 'index.html'), error => { if (error) next(error); }));
app.get(['/index.html', '/exam/:token'], (_req, res, next) => res.sendFile(path.join(publicDir, 'index.html'), error => { if (error) next(error); }));
app.get(['/config.js', '/style.css', '/app.js', '/logo.svg'], (req, res, next) => res.sendFile(path.join(publicDir, path.basename(req.path)), error => { if (error) next(error); }));
app.use('/api', (_req, res) => res.status(404).json({ message: 'API endpoint not found.' }));
app.use((error, _req, res, _next) => {
  console.error(error);
  if (error.code === 11000) return res.status(409).json({ message: 'An account or record with these details already exists.' });
  if (error.name === 'CastError' || error.name === 'ValidationError') return res.status(400).json({ message: 'Invalid field value.' });
  res.status(error.status || 500).json({ message: error.status ? error.message : 'Unexpected server error.' });
});
const port = Number(process.env.PORT || 5000);
async function start() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error('Set JWT_SECRET of at least 32 characters.');
  await connectDatabase();
  // Auto-submit attempts whose timer ended but whose student never came back (closed tab, lost network).
  const sweeper = setInterval(() => sweepExpiredAttempts().catch(error => console.error('Expiry sweep failed:', error.message)), 30000);
  sweeper.unref();
  app.listen(port, '0.0.0.0', () => console.log('IntelliQuiz full-stack app listening on port ' + port));
}
if (require.main === module) start().catch(error => { console.error('Startup failed:', error.message); process.exit(1); });
module.exports = app;
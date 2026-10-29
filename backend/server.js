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
const Submission = require('./models/Submission');
const authRoutes = require('./routes/auth');
const teacherRegistrationRoutes = require('./routes/teacherRegistration');
const questionRoutes = require('./routes/questions');
const examRoutes = require('./routes/exams');
const { requireAuth, requireRole } = require('./middleware/auth');

const app = express();
// Assets are bundled inside backend/public so this works when Voroa root is /backend.
const publicDir = path.join(__dirname, 'public');

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.CLIENT_ORIGIN
    ? process.env.CLIENT_ORIGIN.split(',').map(value => value.trim())
    : true,
  credentials: true
}));
app.use(express.json({ limit: '100kb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

app.use('/api/auth', rateLimit({ windowMs: 900000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false }), authRoutes);
app.use('/api/teacher-registration', rateLimit({ windowMs: 900000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false }), teacherRegistrationRoutes);
app.use('/api/questions', questionRoutes);
app.use('/api/exams', examRoutes);

app.get('/api/health', (_req, res) => res.json({
  status: 'ok',
  service: 'IntelliQuiz API',
  database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
}));

app.get('/api/dashboard/summary', requireAuth, requireRole('teacher'), async (_req, res, next) => {
  try {
    const [students, questions, attempts] = await Promise.all([
      User.countDocuments({ role: 'student', isActive: true }),
      Question.countDocuments({ isActive: true }),
      Submission.countDocuments()
    ]);
    res.json({ students, questions, attempts });
  } catch (error) {
    next(error);
  }
});

// Serve the original IntelliQuiz frontend assets from the same service.
app.get('/', (_req, res, next) => {
  res.sendFile(path.join(publicDir, 'index.html'), error => {
    if (error) next(error);
  });
});
app.get('/index.html', (_req, res, next) => {
  res.sendFile(path.join(publicDir, 'index.html'), error => {
    if (error) next(error);
  });
});
app.get(['/config.js', '/style.css', '/app.js', '/logo.svg'], (req, res, next) => {
  res.sendFile(path.join(publicDir, path.basename(req.path)), error => {
    if (error) next(error);
  });
});

// Keep unknown API paths as JSON 404s rather than returning the HTML page.
app.use('/api', (_req, res) => res.status(404).json({ message: 'API endpoint not found.' }));

app.use((error, _req, res, _next) => {
  console.error(error);
  if (error.code === 11000) {
    return res.status(409).json({ message: 'An account or record with these details already exists.' });
  }
  if (error.name === 'CastError' || error.name === 'ValidationError') {
    return res.status(400).json({ message: 'Invalid field value.' });
  }
  res.status(error.status || 500).json({
    message: error.status ? error.message : 'Unexpected server error.'
  });
});

const port = Number(process.env.PORT || 5000);

async function start() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error('Set JWT_SECRET of at least 32 characters.');
  }
  await connectDatabase();
  app.listen(port, '0.0.0.0', () => {
    console.log('IntelliQuiz full-stack app listening on port ' + port);
  });
}

if (require.main === module) {
  start().catch(error => {
    console.error('Startup failed:', error.message);
    process.exit(1);
  });
}

module.exports = app;

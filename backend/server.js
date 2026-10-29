require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const pool = require('./db/pool');
const authRoutes = require('./routes/auth');
const teacherRegistrationRoutes = require('./routes/teacherRegistration');
const questionRoutes = require('./routes/questions');
const examRoutes = require('./routes/exams');
const { requireAuth, requireRole } = require('./middleware/auth');
const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.CLIENT_ORIGIN ? process.env.CLIENT_ORIGIN.split(',') : true, credentials: true }));
app.use(express.json({ limit: '100kb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false }), authRoutes);
app.use('/api/teacher-registration', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false }), teacherRegistrationRoutes);
app.use('/api/questions', questionRoutes);
app.use('/api/exams', examRoutes);
app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ok', service: 'IntelliQuiz API', database: 'connected' }); }
  catch (_e) { res.status(503).json({ status: 'error', service: 'IntelliQuiz API', database: 'disconnected' }); }
});
app.get('/api/dashboard/summary', requireAuth, requireRole('teacher'), async (_req, res, next) => {
  try {
    const q = await pool.query("SELECT (SELECT COUNT(*)::int FROM users WHERE role='student' AND is_active=TRUE) students,(SELECT COUNT(*)::int FROM questions WHERE is_active=TRUE) questions,(SELECT COUNT(*)::int FROM submissions) attempts");
    res.json(q.rows[0]);
  } catch (e) { next(e); }
});
app.use('/api', (_req, res) => res.status(404).json({ message: 'API endpoint not found.' }));
app.use((err, _req, res, _next) => {
  console.error(err);
  if (err.code === '23505') return res.status(409).json({ message: 'An account or record with these details already exists.' });
  if (err.code === '23503' || err.code === '22P02') return res.status(400).json({ message: 'Invalid reference or field value.' });
  res.status(err.status || 500).json({ message: err.status ? err.message : 'Unexpected server error.' });
});
const port = Number(process.env.PORT || 5000);
async function start() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is missing. Copy .env.example to .env and configure PostgreSQL.');
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error('Set a random JWT_SECRET of at least 32 characters.');
  await pool.query('SELECT 1');
  console.log('PostgreSQL connected.');
  app.listen(port, () => console.log(`IntelliQuiz API running on http://localhost:${port}`));
}
if (require.main === module) start().catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
module.exports = app;

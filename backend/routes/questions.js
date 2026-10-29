const router = require('express').Router();
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
router.use(requireAuth);
router.get('/', async (req,res,next) => {
  try {
    const q = await pool.query(`SELECT id,text,options,${req.user.role === 'teacher' ? 'correct_option' : 'NULL::char(1) AS correct_option'},created_at FROM questions WHERE is_active=TRUE ORDER BY created_at DESC`);
    res.json({ questions: q.rows.map(x => ({ ...x, correctOption: x.correct_option, createdAt: x.created_at })) });
  } catch(e) { next(e); }
});
router.post('/', requireRole('teacher'), async (req,res,next) => {
  try {
    const { text, options, correctOption } = req.body || {};
    if (typeof text !== 'string' || !text.trim() || !Array.isArray(options) || options.length !== 4 || options.some(o => typeof o !== 'string' || !o.trim()) || !['A','B','C','D'].includes(correctOption))
      return res.status(400).json({ message: 'Provide a question, four non-empty options and a valid correct answer.' });
    const q = await pool.query('INSERT INTO questions(text,options,correct_option,created_by) VALUES($1,$2,$3,$4) RETURNING id,text,options,correct_option,created_at', [text.trim(), JSON.stringify(options), correctOption, req.user.id]);
    res.status(201).json({ question: { ...q.rows[0], correctOption: q.rows[0].correct_option } });
  } catch(e) { next(e); }
});
router.patch('/:id', requireRole('teacher'), async (req,res,next) => {
  try {
    const { text, options, correctOption } = req.body || {};
    if (options && (!Array.isArray(options) || options.length !== 4 || options.some(o => typeof o !== 'string' || !o.trim()))) return res.status(400).json({ message: 'Exactly four non-empty options are required.' });
    if (correctOption && !['A','B','C','D'].includes(correctOption)) return res.status(400).json({ message: 'Invalid correct answer.' });
    const q = await pool.query('UPDATE questions SET text=COALESCE($1,text),options=COALESCE($2,options),correct_option=COALESCE($3,correct_option) WHERE id=$4 AND is_active=TRUE RETURNING id,text,options,correct_option',
      [text === undefined ? null : text.trim(), options ? JSON.stringify(options) : null, correctOption || null, req.params.id]);
    if (!q.rowCount) return res.status(404).json({ message: 'Question not found.' });
    res.json({ question: { ...q.rows[0], correctOption: q.rows[0].correct_option } });
  } catch(e) { next(e); }
});
router.delete('/:id', requireRole('teacher'), async (req,res,next) => {
  try {
    const q = await pool.query('UPDATE questions SET is_active=FALSE WHERE id=$1 AND is_active=TRUE', [req.params.id]);
    if (!q.rowCount) return res.status(404).json({ message: 'Question not found.' });
    res.json({ message: 'Question removed.' });
  } catch(e) { next(e); }
});
module.exports = router;

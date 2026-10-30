const router = require('express').Router();
const Question = require('../models/Question');
const Exam = require('../models/Exam');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validateQuestion, RULES } = require('../services/questionRules');
router.use(requireAuth);

const toJson = q => ({
  id: String(q._id), text: q.text, options: q.options, correctOption: q.correctOption,
  marks: q.marks ?? 1, negativeMarks: q.negativeMarks ?? 0, difficulty: q.difficulty || 'medium',
  topic: q.topic || '', explanation: q.explanation || '', createdAt: q.createdAt
});
const usedInPublishedExam = id => Exam.exists({ questionIds: id, status: 'published' });
const sameText = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

// The rules the question form enforces (the UI shows these to the teacher).
router.get('/rules', requireRole('teacher'), (_req, res) => res.json({ rules: RULES }));

router.get('/', requireRole('teacher'), async (req, res, next) => {
  try {
    const rows = await Question.find({ isActive: true, createdBy: req.user._id }).sort({ createdAt: -1 }).lean();
    res.json({ questions: rows.map(toJson) });
  } catch (e) { next(e); }
});

router.post('/', requireRole('teacher'), async (req, res, next) => {
  try {
    const { error, value } = validateQuestion(req.body);
    if (error) return res.status(400).json({ message: error });
    const mine = await Question.find({ createdBy: req.user._id, isActive: true }).select('text').lean();
    if (mine.some(q => sameText(q.text, value.text))) return res.status(409).json({ message: 'You already have a question with this exact text.' });
    const q = await Question.create({ ...value, createdBy: req.user._id });
    res.status(201).json({ question: toJson(q) });
  } catch (e) { next(e); }
});

router.patch('/:id', requireRole('teacher'), async (req, res, next) => {
  try {
    const current = await Question.findOne({ _id: req.params.id, isActive: true, createdBy: req.user._id });
    if (!current) return res.status(404).json({ message: 'Question not found.' });
    const body = req.body || {};
    const fields = ['text', 'options', 'correctOption', 'marks', 'negativeMarks', 'difficulty', 'topic', 'explanation'];
    if (!fields.some(f => body[f] !== undefined)) return res.status(400).json({ message: 'Provide at least one field to update.' });
    // Merge onto the saved question, then validate the whole thing so cross-field rules always hold.
    const merged = {};
    for (const f of fields) merged[f] = body[f] !== undefined ? body[f] : current[f];
    const { error, value } = validateQuestion(merged);
    if (error) return res.status(400).json({ message: error });

    const gradingChanged = JSON.stringify(value.options) !== JSON.stringify(current.options) || value.correctOption !== current.correctOption ||
      value.marks !== (current.marks ?? 1) || value.negativeMarks !== (current.negativeMarks ?? 0);
    if (gradingChanged && await usedInPublishedExam(current._id)) {
      return res.status(409).json({ message: 'This question is in a published exam, so its options, correct answer and marks cannot be changed. Close the exam first.' });
    }
    const mine = await Question.find({ createdBy: req.user._id, isActive: true, _id: { $ne: current._id } }).select('text').lean();
    if (mine.some(q => sameText(q.text, value.text))) return res.status(409).json({ message: 'You already have a question with this exact text.' });

    Object.assign(current, value);
    await current.save();
    res.json({ question: toJson(current) });
  } catch (e) { next(e); }
});

router.delete('/:id', requireRole('teacher'), async (req, res, next) => {
  try {
    const q = await Question.findOne({ _id: req.params.id, createdBy: req.user._id, isActive: true });
    if (!q) return res.status(404).json({ message: 'Question not found.' });
    if (await usedInPublishedExam(q._id)) return res.status(409).json({ message: 'This question is in a published exam and cannot be deleted. Close the exam first.' });
    q.isActive = false;
    await q.save();
    res.json({ message: 'Question removed.' });
  } catch (e) { next(e); }
});
module.exports = router;

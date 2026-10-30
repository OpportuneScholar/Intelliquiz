const router = require('express').Router();
const crypto = require('crypto');
const Exam = require('../models/Exam');
const Question = require('../models/Question');
const Submission = require('../models/Submission');
const ExamAttempt = require('../models/ExamAttempt');
const { requireAuth, requireRole } = require('../middleware/auth');

const examSummary = e => ({
  id: String(e._id), title: e.title, description: e.description,
  durationMinutes: e.durationMinutes, maxAttempts: e.maxAttempts,
  status: e.status, publicToken: e.publicToken || null,
  questionCount: (e.questionIds || []).length, startsAt: e.startsAt, endsAt: e.endsAt,
  createdAt: e.createdAt
});

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const filter = req.user.role === 'teacher' ? { createdBy: req.user._id } : { status: 'published' };
    const rows = await Exam.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ exams: rows.map(examSummary) });
  } catch (e) { next(e); }
});

router.get('/results/mine', requireAuth, requireRole('student'), async (req, res, next) => {
  try {
    const rows = await Submission.find({ student: req.user._id }).populate('exam', 'title durationMinutes').sort({ submittedAt: -1 }).lean();
    res.json({ results: rows.map(s => ({
      id: String(s._id), examTitle: s.exam?.title || 'Deleted exam',
      durationMinutes: s.exam?.durationMinutes || null, score: s.score,
      totalQuestions: s.totalQuestions, percentage: s.percentage,
      durationSeconds: s.durationSeconds, submittedAt: s.submittedAt
    })) });
  } catch (e) { next(e); }
});

router.post('/', requireAuth, requireRole('teacher'), async (req, res, next) => {
  try {
    const { title, description = '', durationMinutes, maxAttempts = 1, questionIds = [], startsAt = null, endsAt = null } = req.body || {};
    const duration = Number(durationMinutes), attempts = Number(maxAttempts);
    if (typeof title !== 'string' || !title.trim() || !Number.isInteger(duration) || duration < 1 || duration > 600 ||
        !Number.isInteger(attempts) || attempts < 1 || attempts > 20 || !Array.isArray(questionIds) || !questionIds.length)
      return res.status(400).json({ message: 'Enter a title, duration (1–600 minutes), 1–20 attempts and select at least one question.' });
    const ids = [...new Set(questionIds.map(String))];
    if (ids.length !== questionIds.length) return res.status(400).json({ message: 'Duplicate questions are not allowed.' });
    const qs = await Question.find({ _id: { $in: ids }, createdBy: req.user._id, isActive: true });
    if (qs.length !== ids.length) return res.status(400).json({ message: 'One or more questions are invalid or not owned by you.' });
    const start = startsAt ? new Date(startsAt) : null, end = endsAt ? new Date(endsAt) : null;
    if ((start && Number.isNaN(start.getTime())) || (end && Number.isNaN(end.getTime())) || (start && end && end <= start))
      return res.status(400).json({ message: 'Check the exam start and end dates.' });
    const exam = await Exam.create({ title: title.trim(), description: String(description).trim(), durationMinutes: duration, maxAttempts: attempts, questionIds: qs.map(q => q._id), startsAt: start, endsAt: end, createdBy: req.user._id });
    res.status(201).json({ exam: examSummary(exam) });
  } catch (e) { next(e); }
});

router.post('/:id/publish', requireAuth, requireRole('teacher'), async (req, res, next) => {
  try {
    const exam = await Exam.findOne({ _id: req.params.id, createdBy: req.user._id });
    if (!exam) return res.status(404).json({ message: 'Exam not found.' });
    if (!exam.questionIds.length) return res.status(400).json({ message: 'Add questions before publishing.' });
    if (!exam.publicToken) exam.publicToken = crypto.randomBytes(18).toString('base64url');
    exam.status = 'published'; await exam.save();
    res.json({ message: 'Exam published.', publicToken: exam.publicToken, sharePath: '/exam/' + exam.publicToken });
  } catch (e) { next(e); }
});


router.patch('/:id/close', requireAuth, requireRole('teacher'), async (req, res, next) => {
  try {
    const exam = await Exam.findOne({ _id: req.params.id, createdBy: req.user._id });
    if (!exam) return res.status(404).json({ message: 'Exam not found.' });
    if (exam.status !== 'published') return res.status(409).json({ message: 'Only a published exam can be closed.' });
    exam.status = 'closed';
    await exam.save();
    res.json({ message: 'Exam closed. Students can no longer start it.', exam: examSummary(exam) });
  } catch (e) { next(e); }
});

router.post('/:id/start', requireAuth, requireRole('student'), async (req, res, next) => {
  try {
    const exam = await Exam.findOne({ _id: req.params.id, status: 'published' });
    if (!exam) return res.status(404).json({ message: 'Exam not found.' });
    const now = new Date();
    if ((exam.startsAt && exam.startsAt > now) || (exam.endsAt && exam.endsAt <= now))
      return res.status(403).json({ message: 'This exam is not currently available.' });
    const active = await ExamAttempt.findOne({ exam: exam._id, student: req.user._id, status: 'in_progress' });
    if (active) return res.json({ attempt: { id: String(active._id), answers: active.answers, startedAt: active.startedAt, expiresAt: active.expiresAt } });
    const count = await ExamAttempt.countDocuments({ exam: exam._id, student: req.user._id });
    if (count >= exam.maxAttempts) return res.status(409).json({ message: 'Maximum attempts reached.' });
    const expiresAt = new Date(now.getTime() + exam.durationMinutes * 60000);
    if (exam.endsAt && exam.endsAt < expiresAt) expiresAt.setTime(exam.endsAt.getTime());
    const attempt = await ExamAttempt.create({ exam: exam._id, student: req.user._id, attemptNumber: count + 1, startedAt: now, expiresAt });
    res.status(201).json({ attempt: { id: String(attempt._id), answers: {}, startedAt: attempt.startedAt, expiresAt: attempt.expiresAt } });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ message: 'An attempt is already being started. Refresh and continue it.' });
    next(e);
  }
});

router.get('/:id/attempt/active', requireAuth, requireRole('student'), async (req, res, next) => {
  try {
    const attempt = await ExamAttempt.findOne({ exam: req.params.id, student: req.user._id, status: 'in_progress' });
    if (!attempt) return res.status(404).json({ message: 'No active attempt.' });
    res.json({ attempt: { id: String(attempt._id), answers: attempt.answers, startedAt: attempt.startedAt, expiresAt: attempt.expiresAt } });
  } catch (e) { next(e); }
});

router.patch('/:id/attempt/:attemptId', requireAuth, requireRole('student'), async (req, res, next) => {
  try {
    const attempt = await ExamAttempt.findOne({ _id: req.params.attemptId, exam: req.params.id, student: req.user._id, status: 'in_progress' });
    if (!attempt) return res.status(404).json({ message: 'Active attempt not found.' });
    if (attempt.expiresAt <= Date.now()) return res.status(410).json({ message: 'Exam time has expired. Submit the saved answers.' });
    const exam = await Exam.findById(attempt.exam).select('questionIds');
    const allowed = new Set(exam.questionIds.map(String));
    const incoming = req.body?.answers;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return res.status(400).json({ message: 'Invalid answers payload.' });
    const nextAnswers = { ...attempt.answers };
    for (const [questionId, answer] of Object.entries(incoming)) {
      if (!allowed.has(questionId) || !['A', 'B', 'C', 'D'].includes(answer)) return res.status(400).json({ message: 'Invalid question or answer.' });
      nextAnswers[questionId] = answer;
    }
    attempt.answers = nextAnswers; await attempt.save();
    res.json({ message: 'Answers saved.', savedAt: new Date() });
  } catch (e) { next(e); }
});

router.get('/:id/results', requireAuth, requireRole('teacher'), async (req, res, next) => {
  try {
    const exam = await Exam.findOne({ _id: req.params.id, createdBy: req.user._id }).select('title');
    if (!exam) return res.status(404).json({ message: 'Exam not found.' });
    const rows = await Submission.find({ exam: exam._id }).populate('student', 'name email rollNumber').sort({ submittedAt: -1 }).lean();
    res.json({ exam: { id: String(exam._id), title: exam.title }, results: rows.map(s => ({
      id: String(s._id), student: s.student?.name || 'Student',
      email: s.student?.email || '', rollNumber: s.student?.rollNumber || '',
      score: s.score, totalQuestions: s.totalQuestions, percentage: s.percentage,
      durationSeconds: s.durationSeconds, submittedAt: s.submittedAt
    })) });
  } catch (e) { next(e); }
});

router.get('/public/:token', async (req, res, next) => {
  try {
    const exam = await Exam.findOne({ publicToken: req.params.token, status: 'published' })
      .populate({ path: 'questionIds', match: { isActive: true }, select: 'text options' });
    if (!exam) return res.status(404).json({ message: 'Exam link not found or no longer available.' });
    if (exam.startsAt && exam.startsAt > Date.now()) return res.status(403).json({ message: 'This exam has not started yet.' });
    if (exam.endsAt && exam.endsAt < Date.now()) return res.status(403).json({ message: 'This exam has ended.' });
    res.json({ exam: { id: String(exam._id), title: exam.title, description: exam.description, durationMinutes: exam.durationMinutes, questions: exam.questionIds.filter(Boolean).map(q => ({ id: String(q._id), text: q.text, options: q.options })) } });
  } catch (e) { next(e); }
});


router.post('/:id/attempt/:attemptId/submit', requireAuth, requireRole('student'), async (req, res, next) => {
  try {
    const attempt = await ExamAttempt.findOne({ _id: req.params.attemptId, exam: req.params.id, student: req.user._id });
    if (!attempt) return res.status(404).json({ message: 'Attempt not found.' });
    const existing = await Submission.findOne({ attempt: attempt._id });
    if (existing) return res.json({ message: 'Exam already submitted.', result: { score: existing.score, totalQuestions: existing.totalQuestions, percentage: existing.percentage, submittedAt: existing.submittedAt } });
    if (attempt.status !== 'in_progress') return res.status(409).json({ message: 'This attempt is no longer active.' });
    const now = new Date();
    const exam = await Exam.findOne({ _id: attempt.exam, status: 'published' }).populate('questionIds');
    if (!exam) return res.status(404).json({ message: 'Exam not found.' });
    const questions = exam.questionIds.filter(q => q && q.isActive);
    if (!questions.length) return res.status(409).json({ message: 'This exam has no active questions.' });
    let score = 0; const safeAnswers = {};
    for (const q of questions) {
      const answer = attempt.answers[String(q._id)];
      if (['A', 'B', 'C', 'D'].includes(answer)) safeAnswers[String(q._id)] = answer;
      if (answer === q.correctOption) score++;
    }
    const total = questions.length;
    const durationSeconds = Math.max(0, Math.min(Math.floor((now - attempt.startedAt) / 1000), Math.floor((attempt.expiresAt - attempt.startedAt) / 1000)));
    const submission = await Submission.create({ exam: exam._id, student: req.user._id, attempt: attempt._id, answers: safeAnswers, score, totalQuestions: total, percentage: Math.round(score / total * 10000) / 100, durationSeconds });
    attempt.status = now >= attempt.expiresAt ? 'expired' : 'submitted'; attempt.submittedAt = now; await attempt.save();
    res.status(201).json({ message: 'Exam submitted.', result: { score, totalQuestions: total, percentage: submission.percentage, submittedAt: submission.submittedAt } });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ message: 'This attempt has already been submitted.' });
    next(e);
  }
});
module.exports = router;
const router = require('express').Router();
const crypto = require('crypto');
const Exam = require('../models/Exam');
const Question = require('../models/Question');
const Submission = require('../models/Submission');
const ExamAttempt = require('../models/ExamAttempt');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sanitizeAnswers, resultPayload, finalizeAttempt } = require('../services/grading');
const { createQuestionOrder, orderQuestions } = require('../services/questionOrder');
const { createQuestionOrder, orderQuestions } = require('../services/questionOrder');

const activeQuestions = e => (e.questionIds || []).filter(q => q && q.isActive !== false);
const sumMarks = qs => Math.round(qs.reduce((t, q) => t + (Number(q.marks) > 0 ? Number(q.marks) : 1), 0) * 100) / 100;

// `e.questionIds` must be populated (at least with marks + isActive).
const examSummary = e => {
  const qs = activeQuestions(e);
  return {
    id: String(e._id), title: e.title, subject: e.subject || e.title, teacherName: e.createdBy?.name || '', description: e.description,
    durationMinutes: e.durationMinutes, maxAttempts: e.maxAttempts,
    passingPercentage: e.passingPercentage ?? 40, tabSwitchAutoSubmit: e.tabSwitchAutoSubmit !== false,
    status: e.status, publicToken: e.publicToken || null,
    questionCount: qs.length, totalMarks: sumMarks(qs), startsAt: e.startsAt, endsAt: e.endsAt, createdAt: e.createdAt
  };
};
const attemptPayload = a => ({ id: String(a._id), answers: a.answers || {}, startedAt: a.startedAt, expiresAt: a.expiresAt });

// Questions sent to a student during an attempt — never includes the answer key.
async function questionsForStudent(examId, orderedIds = []) {
  const exam = await Exam.findById(examId).populate({ path: 'questionIds', match: { isActive: true }, select: 'text options marks negativeMarks' });
  const active = (exam?.questionIds || []).filter(Boolean);
  const ordered = orderedIds.length ? orderQuestions(active, orderedIds) : active;
  return ordered.map(q => ({
    id: String(q._id), text: q.text, options: q.options, marks: q.marks ?? 1, negativeMarks: q.negativeMarks ?? 0
  }));
}

// If a student's earlier attempt ran out of time, close it (graded automatically) before anything else.
async function closeExpiredAttempts(examId, studentId) {
  const stale = await ExamAttempt.find({ exam: examId, student: studentId, status: 'in_progress', expiresAt: { $lte: new Date() } }).select('_id');
  for (const a of stale) await finalizeAttempt(a._id, { reason: 'time_up' });
}

// ---------------------------------------------------------------- listing
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const filter = req.user.role === 'teacher' ? { createdBy: req.user._id } : { status: 'published' };
    let rows = await Exam.find(filter).populate('questionIds', 'marks isActive').populate('createdBy', 'name').sort({ startsAt: 1, createdAt: -1 });
    if (req.user.role === 'student') rows = rows.filter(exam => {
      const mode = exam.visibilityMode || 'all';
      const classMatch = (exam.targetClasses || []).some(target =>
        (!target.course || target.course === req.user.course) &&
        (!target.branch || target.branch === req.user.branch) &&
        (!target.semester || target.semester === req.user.semester) &&
        (!target.section || target.section === req.user.section));
      const selectedMatch = (exam.selectedStudents || []).some(id => String(id) === String(req.user._id));
      return mode === 'all' || (mode === 'class' && classMatch) || (mode === 'selected' && selectedMatch) || (mode === 'both' && (classMatch || selectedMatch));
    });
    res.json({ exams: rows.map(examSummary) });
  } catch (e) { next(e); }
});

router.get('/results/mine', requireAuth, requireRole('student'), async (req, res, next) => {
  try {
    const rows = await Submission.find({ student: req.user._id }).populate('exam', 'title durationMinutes passingPercentage').sort({ submittedAt: -1 }).lean();
    res.json({ results: rows.map(s => ({
      id: String(s._id), examTitle: s.exam?.title || 'Deleted exam', durationMinutes: s.exam?.durationMinutes || null,
      score: s.score, totalMarks: s.totalMarks || s.totalQuestions, totalQuestions: s.totalQuestions, percentage: s.percentage,
      correctCount: s.correctCount ?? null, wrongCount: s.wrongCount ?? null, unansweredCount: s.unansweredCount ?? null,
      passed: s.passed ?? null, submitReason: s.submitReason || 'manual', durationSeconds: s.durationSeconds, submittedAt: s.submittedAt
    })) });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------- teacher: create / publish / close / delete
router.post('/', requireAuth, requireRole('teacher'), async (req, res, next) => {
  try {
    const { title, subject = '', description = '', durationMinutes, maxAttempts = 1, passingPercentage = 40, tabSwitchAutoSubmit = true, questionIds = [], startsAt = null, endsAt = null, visibilityMode = 'all', targetClasses = [], selectedStudents = [] } = req.body || {};
    const duration = Number(durationMinutes), attempts = Number(maxAttempts), passing = Number(passingPercentage);
    if (typeof title !== 'string' || title.trim().length < 3 || title.trim().length > 180) return res.status(400).json({ message: 'Exam title must be 3–180 characters.' });
    if (typeof subject !== 'string' || subject.trim().length > 120) return res.status(400).json({ message: 'Subject must be at most 120 characters.' });
    if (!['all', 'class', 'selected', 'both'].includes(visibilityMode)) return res.status(400).json({ message: 'Invalid exam visibility mode.' });
    if (!Array.isArray(targetClasses) || !Array.isArray(selectedStudents)) return res.status(400).json({ message: 'Invalid exam audience.' });
    if (['class', 'both'].includes(visibilityMode) && !targetClasses.length) return res.status(400).json({ message: 'Select at least one target class.' });
    if (['selected', 'both'].includes(visibilityMode) && !selectedStudents.length) return res.status(400).json({ message: 'Select at least one student.' });
    if (!Number.isInteger(duration) || duration < 1 || duration > 600) return res.status(400).json({ message: 'Duration must be a whole number of minutes from 1 to 600.' });
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 20) return res.status(400).json({ message: 'Maximum attempts must be from 1 to 20.' });
    if (!Number.isFinite(passing) || passing < 0 || passing > 100) return res.status(400).json({ message: 'Passing percentage must be from 0 to 100.' });
    if (!Array.isArray(questionIds) || !questionIds.length) return res.status(400).json({ message: 'Select at least one question.' });
    if (questionIds.length > 200) return res.status(400).json({ message: 'An exam can have at most 200 questions.' });
    const ids = [...new Set(questionIds.map(String))];
    if (ids.length !== questionIds.length) return res.status(400).json({ message: 'Duplicate questions are not allowed.' });
    const qs = await Question.find({ _id: { $in: ids }, createdBy: req.user._id, isActive: true });
    if (qs.length !== ids.length) return res.status(400).json({ message: 'One or more questions are invalid or not owned by you.' });
    const start = startsAt ? new Date(startsAt) : null, end = endsAt ? new Date(endsAt) : null;
    if ((start && Number.isNaN(start.getTime())) || (end && Number.isNaN(end.getTime()))) return res.status(400).json({ message: 'Check the exam start and end dates.' });
    if (start && end && end <= start) return res.status(400).json({ message: 'Exam end time must be after its start time.' });
    if (end && end <= new Date()) return res.status(400).json({ message: 'Exam end time must be in the future.' });
    const exam = await Exam.create({
      title: title.trim(), subject: subject.trim() || title.trim(), description: String(description).trim(), durationMinutes: duration, maxAttempts: attempts, visibilityMode, targetClasses, selectedStudents,
      passingPercentage: passing, tabSwitchAutoSubmit: tabSwitchAutoSubmit !== false && tabSwitchAutoSubmit !== 'false',
      questionIds: ids, startsAt: start, endsAt: end, createdBy: req.user._id
    });
    await exam.populate('questionIds', 'marks isActive');
    res.status(201).json({ exam: examSummary(exam) });
  } catch (e) { next(e); }
});

router.post('/:id/publish', requireAuth, requireRole('teacher'), async (req, res, next) => {
  try {
    const exam = await Exam.findOne({ _id: req.params.id, createdBy: req.user._id }).populate('questionIds', 'marks isActive');
    if (!exam) return res.status(404).json({ message: 'Exam not found.' });
    if (exam.status === 'closed') return res.status(409).json({ message: 'A closed exam cannot be published again. Create a new exam instead.' });
    if (!activeQuestions(exam).length) return res.status(400).json({ message: 'Add at least one active question before publishing.' });
    if (exam.endsAt && exam.endsAt <= new Date()) return res.status(400).json({ message: 'The exam end time has already passed.' });
    if (!exam.publicToken) exam.publicToken = crypto.randomBytes(18).toString('base64url');
    exam.status = 'published';
    await exam.save();
    res.json({ message: 'Exam published.', publicToken: exam.publicToken, sharePath: '/exam/' + exam.publicToken });
  } catch (e) { next(e); }
});

router.patch('/:id/close', requireAuth, requireRole('teacher'), async (req, res, next) => {
  try {
    const exam = await Exam.findOne({ _id: req.params.id, createdBy: req.user._id }).populate('questionIds', 'marks isActive');
    if (!exam) return res.status(404).json({ message: 'Exam not found.' });
    if (exam.status !== 'published') return res.status(409).json({ message: 'Only a published exam can be closed.' });
    exam.status = 'closed';
    await exam.save();
    res.json({ message: 'Exam closed. Students can no longer start it.', exam: examSummary(exam) });
  } catch (e) { next(e); }
});

router.delete('/:id', requireAuth, requireRole('teacher'), async (req, res, next) => {
  try {
    const exam = await Exam.findOne({ _id: req.params.id, createdBy: req.user._id });
    if (!exam) return res.status(404).json({ message: 'Exam not found.' });
    if (exam.status !== 'draft') return res.status(409).json({ message: 'Only draft exams can be deleted. Close a published exam instead.' });
    await exam.deleteOne();
    res.json({ message: 'Draft exam deleted.' });
  } catch (e) { next(e); }
});

router.get('/:id/results', requireAuth, requireRole('teacher'), async (req, res, next) => {
  try {
    const exam = await Exam.findOne({ _id: req.params.id, createdBy: req.user._id }).select('title');
    if (!exam) return res.status(404).json({ message: 'Exam not found.' });
    const rows = await Submission.find({ exam: exam._id }).populate('student', 'name email rollNumber').sort({ submittedAt: -1 }).lean();
    res.json({ exam: { id: String(exam._id), title: exam.title }, results: rows.map(s => ({
      id: String(s._id), student: s.student?.name || 'Student', email: s.student?.email || '', rollNumber: s.student?.rollNumber || '',
      score: s.score, totalMarks: s.totalMarks || s.totalQuestions, totalQuestions: s.totalQuestions, percentage: s.percentage,
      correctCount: s.correctCount ?? null, wrongCount: s.wrongCount ?? null, unansweredCount: s.unansweredCount ?? null,
      passed: s.passed ?? null, submitReason: s.submitReason || 'manual', durationSeconds: s.durationSeconds, submittedAt: s.submittedAt
    })) });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------- student: open link, start, autosave, submit
// Exam info + rules for the share link. Questions are NOT sent here — only after the student starts.
router.get('/public/:token', requireAuth, requireRole('student'), async (req, res, next) => {
  try {
    const exam = await Exam.findOne({ publicToken: req.params.token, status: 'published' }).populate('questionIds', 'marks isActive').populate('createdBy', 'name');
    if (!exam) return res.status(404).json({ message: 'Exam link not found or no longer available.' });
    const mode = exam.visibilityMode || 'all';
    const classMatch = (exam.targetClasses || []).some(target => (!target.course || target.course === req.user.course) && (!target.branch || target.branch === req.user.branch) && (!target.semester || target.semester === req.user.semester) && (!target.section || target.section === req.user.section));
    const selectedMatch = (exam.selectedStudents || []).some(id => String(id) === String(req.user._id));
    const eligible = mode === 'all' || (mode === 'class' && classMatch) || (mode === 'selected' && selectedMatch) || (mode === 'both' && (classMatch || selectedMatch));
    if (!eligible) return res.status(403).json({ message: 'You are not assigned to this exam.' });
    await closeExpiredAttempts(exam._id, req.user._id);
    const [attemptsUsed, active, last] = await Promise.all([
      ExamAttempt.countDocuments({ exam: exam._id, student: req.user._id }),
      ExamAttempt.findOne({ exam: exam._id, student: req.user._id, status: 'in_progress' }),
      Submission.findOne({ exam: exam._id, student: req.user._id }).sort({ submittedAt: -1 })
    ]);
    const now = new Date();
    res.json({
      exam: { ...examSummary(exam), attemptsUsed, hasActiveAttempt: !!active, notStarted: !!(exam.startsAt && exam.startsAt > now), ended: !!(exam.endsAt && exam.endsAt <= now) },
      lastResult: last ? resultPayload(last) : null, serverTime: now
    });
  } catch (e) { next(e); }
});

router.post('/:id/start', requireAuth, requireRole('student'), async (req, res, next) => {
  try {
    const exam = await Exam.findOne({ _id: req.params.id, status: 'published' });
    if (!exam) return res.status(404).json({ message: 'Exam not found or no longer available.' });
    const mode = exam.visibilityMode || 'all';
    const classMatch = (exam.targetClasses || []).some(target => (!target.course || target.course === req.user.course) && (!target.branch || target.branch === req.user.branch) && (!target.semester || target.semester === req.user.semester) && (!target.section || target.section === req.user.section));
    const selectedMatch = (exam.selectedStudents || []).some(id => String(id) === String(req.user._id));
    if (!(mode === 'all' || (mode === 'class' && classMatch) || (mode === 'selected' && selectedMatch) || (mode === 'both' && (classMatch || selectedMatch)))) return res.status(403).json({ message: 'You are not assigned to this exam.' });
    await closeExpiredAttempts(exam._id, req.user._id);
    const now = new Date();
    if (exam.startsAt && exam.startsAt > now) return res.status(403).json({ message: 'This exam has not started yet.' });
    if (exam.endsAt && exam.endsAt <= now) return res.status(403).json({ message: 'This exam has ended.' });
    const active = await ExamAttempt.findOne({ exam: exam._id, student: req.user._id, status: 'in_progress' });
    if (active) {
      if (!active.questionOrder?.length) { active.questionOrder = createQuestionOrder(exam.questionIds.map(String)); await active.save(); }
      return res.json({ attempt: attemptPayload(active), questions: await questionsForStudent(exam._id, active.questionOrder), rules: { tabSwitchAutoSubmit: exam.tabSwitchAutoSubmit !== false }, serverTime: now });
    }
    const count = await ExamAttempt.countDocuments({ exam: exam._id, student: req.user._id });
    if (count >= exam.maxAttempts) return res.status(409).json({ message: 'You have used all attempts for this exam.' });
    const expiresAt = new Date(now.getTime() + exam.durationMinutes * 60000);
    if (exam.endsAt && exam.endsAt < expiresAt) expiresAt.setTime(exam.endsAt.getTime());
    const questionOrder = createQuestionOrder(exam.questionIds.map(String));
    const attempt = await ExamAttempt.create({ exam: exam._id, student: req.user._id, attemptNumber: count + 1, startedAt: now, expiresAt, questionOrder });
    res.status(201).json({ attempt: attemptPayload(attempt), questions: await questionsForStudent(exam._id, questionOrder), rules: { tabSwitchAutoSubmit: exam.tabSwitchAutoSubmit !== false }, serverTime: now });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ message: 'An attempt is already being started. Refresh and continue it.' });
    next(e);
  }
});

router.get('/:id/attempt/active', requireAuth, requireRole('student'), async (req, res, next) => {
  try {
    await closeExpiredAttempts(req.params.id, req.user._id);
    const attempt = await ExamAttempt.findOne({ exam: req.params.id, student: req.user._id, status: 'in_progress' });
    if (!attempt) return res.status(404).json({ message: 'No active attempt.' });
    if (!attempt.questionOrder?.length) {
      const exam = await Exam.findById(req.params.id).select('questionIds');
      attempt.questionOrder = createQuestionOrder(exam.questionIds.map(String));
      await attempt.save();
    }
    res.json({ attempt: attemptPayload(attempt), questions: await questionsForStudent(req.params.id, attempt.questionOrder), serverTime: new Date() });
  } catch (e) { next(e); }
});

router.patch('/:id/attempt/:attemptId', requireAuth, requireRole('student'), async (req, res, next) => {
  try {
    const attempt = await ExamAttempt.findOne({ _id: req.params.attemptId, exam: req.params.id, student: req.user._id, status: 'in_progress' });
    if (!attempt) return res.status(404).json({ message: 'Active attempt not found.' });
    if (attempt.expiresAt <= Date.now()) return res.status(410).json({ message: 'Exam time has expired. Your saved answers will be submitted.' });
    const exam = await Exam.findById(attempt.exam).select('questionIds');
    const incoming = req.body?.answers;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return res.status(400).json({ message: 'Invalid answers payload.' });
    const clean = sanitizeAnswers(incoming, exam.questionIds);
    if (Object.keys(clean).length !== Object.keys(incoming).length) return res.status(400).json({ message: 'Invalid question or answer.' });
    attempt.answers = { ...(attempt.answers || {}), ...clean };
    attempt.markModified('answers');
    await attempt.save();
    res.json({ message: 'Answers saved.', savedAt: new Date() });
  } catch (e) { next(e); }
});

// Body: { reason: 'manual' | 'tab_switch' | 'time_up', answers?: { questionId: 'A'..'D' } }
router.post('/:id/attempt/:attemptId/submit', requireAuth, requireRole('student'), async (req, res, next) => {
  try {
    const attempt = await ExamAttempt.findOne({ _id: req.params.attemptId, exam: req.params.id, student: req.user._id });
    if (!attempt) return res.status(404).json({ message: 'Attempt not found.' });
    const existing = await Submission.findOne({ attempt: attempt._id });
    if (existing) return res.json({ message: 'Exam already submitted.', result: resultPayload(existing) });
    const { submission, created } = await finalizeAttempt(attempt._id, { reason: req.body?.reason, answers: req.body?.answers });
    if (!submission) return res.status(409).json({ message: 'This attempt could not be submitted.' });
    res.status(created ? 201 : 200).json({ message: 'Exam submitted.', result: resultPayload(submission) });
  } catch (e) { next(e); }
});
module.exports = router;

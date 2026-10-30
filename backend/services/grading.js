'use strict';
// Pure grading helpers (no database access) + attempt finalisation used by routes and the expiry sweeper.

const LETTERS = ['A', 'B', 'C', 'D'];
const SUBMIT_REASONS = ['manual', 'time_up', 'tab_switch', 'system'];
const round2 = n => Math.round(n * 100) / 100;

const marksOf = q => (Number(q.marks) > 0 ? Number(q.marks) : 1);
const negativeOf = q => Math.max(0, Number(q.negativeMarks) || 0);

/**
 * Grade answers against questions. Server-side only: `questions` carry the answer key.
 * Unanswered questions score 0 (never negative). Wrong answers lose the question's negative marks.
 * The final score never drops below 0.
 */
function gradeAnswers(questions, answers, passingPercentage = 0) {
  const given = answers && typeof answers === 'object' ? answers : {};
  let score = 0, totalMarks = 0, correctCount = 0, wrongCount = 0, unansweredCount = 0;
  const safeAnswers = {};
  for (const q of questions) {
    const marks = marksOf(q);
    totalMarks += marks;
    const answer = given[String(q._id)];
    if (!LETTERS.includes(answer)) { unansweredCount++; continue; }
    safeAnswers[String(q._id)] = answer;
    if (answer === q.correctOption) { correctCount++; score += marks; }
    else { wrongCount++; score -= Math.min(negativeOf(q), marks); }
  }
  score = Math.max(0, round2(score));
  totalMarks = round2(totalMarks);
  const percentage = totalMarks > 0 ? Math.min(100, round2(score / totalMarks * 100)) : 0;
  return {
    score, totalMarks, percentage, correctCount, wrongCount, unansweredCount,
    totalQuestions: questions.length, passed: percentage >= Number(passingPercentage || 0), answers: safeAnswers
  };
}

/** Decide the stored submit reason. If time is really over, it is always "time_up". */
function resolveReason(requested, now, expiresAt) {
  const msLeft = new Date(expiresAt).getTime() - now.getTime();
  if (msLeft <= 0) return 'time_up';
  // The browser clock may be a couple of seconds off, so a "time_up" report within 3s of the deadline is accepted.
  if (requested === 'time_up') return msLeft <= 3000 ? 'time_up' : 'manual';
  return SUBMIT_REASONS.includes(requested) ? requested : 'manual';
}

/** Keep only answers for questions in the exam with valid options A-D. */
function sanitizeAnswers(incoming, allowedQuestionIds) {
  const allowed = new Set(allowedQuestionIds.map(String));
  const out = {};
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return out;
  for (const [id, answer] of Object.entries(incoming)) {
    if (allowed.has(id) && LETTERS.includes(answer)) out[id] = answer;
  }
  return out;
}

const resultPayload = s => ({
  score: s.score, totalMarks: s.totalMarks, totalQuestions: s.totalQuestions, percentage: s.percentage,
  correctCount: s.correctCount, wrongCount: s.wrongCount, unansweredCount: s.unansweredCount,
  passed: s.passed, submitReason: s.submitReason, submittedAt: s.submittedAt
});

/**
 * Atomically close an in-progress attempt and store the graded submission.
 * Safe to call twice (route + sweeper): the second caller gets the existing submission.
 * Models are required lazily so the pure helpers above can be tested without mongoose.
 */
async function finalizeAttempt(attemptId, { reason = 'manual', answers = null, now = new Date() } = {}) {
  const ExamAttempt = require('../models/ExamAttempt');
  const Exam = require('../models/Exam');
  const Submission = require('../models/Submission');

  const existing = await Submission.findOne({ attempt: attemptId });
  if (existing) return { submission: existing, created: false };

  const attempt = await ExamAttempt.findById(attemptId);
  if (!attempt) return { submission: null, created: false };
  const exam = await Exam.findById(attempt.exam).populate('questionIds');
  if (!exam) return { submission: null, created: false };
  const questions = exam.questionIds.filter(q => q && q.isActive);

  // Claim the attempt atomically so only one caller grades it.
  const expired = now.getTime() >= attempt.expiresAt.getTime();
  const claimed = await ExamAttempt.findOneAndUpdate(
    { _id: attempt._id, status: 'in_progress' },
    { status: expired ? 'expired' : 'submitted', submittedAt: now },
    { new: false }
  );
  if (!claimed) return { submission: await Submission.findOne({ attempt: attemptId }), created: false };

  try {
    let finalAnswers = { ...(attempt.answers || {}) };
    // Accept the last unsaved answers only inside the allowed window (expiry + small network grace).
    if (answers && now.getTime() <= attempt.expiresAt.getTime() + 5000) {
      finalAnswers = { ...finalAnswers, ...sanitizeAnswers(answers, questions.map(q => q._id)) };
    }
    const graded = gradeAnswers(questions, finalAnswers, exam.passingPercentage);
    const durationSeconds = Math.max(0, Math.min(
      Math.floor((now - attempt.startedAt) / 1000),
      Math.floor((attempt.expiresAt - attempt.startedAt) / 1000)
    ));
    const submission = await Submission.create({
      exam: exam._id, student: attempt.student, attempt: attempt._id, answers: graded.answers,
      score: graded.score, totalMarks: graded.totalMarks, totalQuestions: graded.totalQuestions,
      percentage: graded.percentage, correctCount: graded.correctCount, wrongCount: graded.wrongCount,
      unansweredCount: graded.unansweredCount, passed: graded.passed,
      submitReason: resolveReason(reason, now, attempt.expiresAt), durationSeconds, submittedAt: now
    });
    return { submission, created: true };
  } catch (error) {
    // Roll the claim back so the attempt is not lost.
    await ExamAttempt.updateOne({ _id: attempt._id }, { status: 'in_progress', submittedAt: null });
    if (error.code === 11000) return { submission: await Submission.findOne({ attempt: attemptId }), created: false };
    throw error;
  }
}

/** Finalise attempts whose time ran out but whose student never came back (closed tab, lost network). */
async function sweepExpiredAttempts(graceMs = 10000) {
  const ExamAttempt = require('../models/ExamAttempt');
  const cutoff = new Date(Date.now() - graceMs);
  const stale = await ExamAttempt.find({ status: 'in_progress', expiresAt: { $lte: cutoff } }).select('_id').limit(200).lean();
  let done = 0;
  for (const row of stale) {
    try { await finalizeAttempt(row._id, { reason: 'time_up' }); done++; }
    catch (error) { console.error('Auto-finalise failed for attempt', String(row._id), error.message); }
  }
  return done;
}

module.exports = { gradeAnswers, resolveReason, sanitizeAnswers, resultPayload, finalizeAttempt, sweepExpiredAttempts, SUBMIT_REASONS, LETTERS };

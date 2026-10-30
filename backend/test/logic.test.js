'use strict';
// Run with:  node --test test/     (no database or npm packages needed)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { validateQuestion } = require('../services/questionRules');
const { gradeAnswers, resolveReason, sanitizeAnswers } = require('../services/grading');

const goodQuestion = (over = {}) => ({ text: 'What is 2 + 2?', options: ['3', '4', '5', '6'], correctOption: 'B', ...over });

/* ------------------------------------------------------------------ question rules */
test('valid question gets defaults (1 mark, 0 negative, medium)', () => {
  const { value, error } = validateQuestion(goodQuestion());
  assert.equal(error, undefined);
  assert.equal(value.marks, 1); assert.equal(value.negativeMarks, 0); assert.equal(value.difficulty, 'medium');
});
test('rejects short text, missing/duplicate options and bad answer', () => {
  assert.match(validateQuestion(goodQuestion({ text: 'hi' })).error, /at least 5/);
  assert.match(validateQuestion(goodQuestion({ options: ['a', 'b', 'c'] })).error, /exactly four/);
  assert.match(validateQuestion(goodQuestion({ options: ['a', 'b', 'c', ' '] })).error, /filled/);
  assert.match(validateQuestion(goodQuestion({ options: ['Yes', 'yes', 'c', 'd'] })).error, /different/);
  assert.match(validateQuestion(goodQuestion({ correctOption: 'E' })).error, /correct answer/);
});
test('marks and negative marks rules', () => {
  assert.equal(validateQuestion(goodQuestion({ marks: 2.5, negativeMarks: 0.5 })).value.marks, 2.5);
  assert.match(validateQuestion(goodQuestion({ marks: 0 })).error, /Marks must be/);
  assert.match(validateQuestion(goodQuestion({ marks: 101 })).error, /Marks must be/);
  assert.match(validateQuestion(goodQuestion({ marks: 1.1 })).error, /Marks must be/);
  assert.match(validateQuestion(goodQuestion({ marks: 1, negativeMarks: 2 })).error, /cannot be more/);
  assert.match(validateQuestion(goodQuestion({ negativeMarks: -1 })).error, /Negative marks/);
  assert.match(validateQuestion(goodQuestion({ difficulty: 'insane' })).error, /Difficulty/);
});

/* ------------------------------------------------------------------ grading */
const qs = [
  { _id: 'q1', correctOption: 'A', marks: 2, negativeMarks: 0.5 },
  { _id: 'q2', correctOption: 'B', marks: 1, negativeMarks: 0 },
  { _id: 'q3', correctOption: 'C', marks: 3, negativeMarks: 1 },
  { _id: 'q4', correctOption: 'D' } // legacy question: no marks fields => 1 mark, no negative
];
test('grades correct, wrong (negative), unanswered', () => {
  const g = gradeAnswers(qs, { q1: 'A', q2: 'A', q3: 'D' }, 40);
  // q1 +2, q2 wrong 0, q3 wrong -1, q4 unanswered 0  => 1
  assert.equal(g.score, 1); assert.equal(g.totalMarks, 7);
  assert.equal(g.correctCount, 1); assert.equal(g.wrongCount, 2); assert.equal(g.unansweredCount, 1);
  assert.equal(g.percentage, 14.29); assert.equal(g.passed, false);
});
test('score never goes below zero and full marks pass', () => {
  assert.equal(gradeAnswers(qs, { q1: 'B', q3: 'A' }).score, 0);
  const all = gradeAnswers(qs, { q1: 'A', q2: 'B', q3: 'C', q4: 'D' }, 100);
  assert.equal(all.score, 7); assert.equal(all.percentage, 100); assert.equal(all.passed, true);
});
test('ignores invalid answer letters', () => {
  const g = gradeAnswers(qs, { q1: 'Z', q2: 'B' });
  assert.equal(g.unansweredCount, 3); assert.deepEqual(g.answers, { q2: 'B' });
});
test('sanitizeAnswers keeps only exam questions with A-D', () => {
  assert.deepEqual(sanitizeAnswers({ q1: 'A', x: 'B', q2: 'E' }, ['q1', 'q2']), { q1: 'A' });
  assert.deepEqual(sanitizeAnswers([], ['q1']), {});
});
test('submit reason: server time wins, small clock skew tolerated', () => {
  const now = new Date('2026-01-01T10:00:00Z');
  assert.equal(resolveReason('manual', now, new Date('2026-01-01T09:59:59Z')), 'time_up'); // already expired
  assert.equal(resolveReason('tab_switch', now, new Date('2026-01-01T10:10:00Z')), 'tab_switch');
  assert.equal(resolveReason('time_up', now, new Date('2026-01-01T10:00:02Z')), 'time_up'); // 2s skew
  assert.equal(resolveReason('time_up', now, new Date('2026-01-01T10:10:00Z')), 'manual');  // fake time_up
  assert.equal(resolveReason('hacker', now, new Date('2026-01-01T10:10:00Z')), 'manual');
});

/* ------------------------------------------------------------------ finalizeAttempt with in-memory fake models */
function installFakes() {
  const state = { submissions: [], attempt: null, exam: null };
  const stub = (rel, exports) => {
    const file = require.resolve(path.join('..', 'models', rel));
    require.cache[file] = { id: file, filename: file, loaded: true, exports };
  };
  stub('Submission', {
    findOne: async q => state.submissions.find(s => String(s.attempt) === String(q.attempt)) || null,
    create: async doc => {
      if (state.submissions.some(s => String(s.attempt) === String(doc.attempt))) throw Object.assign(new Error('dup'), { code: 11000 });
      const row = { ...doc }; state.submissions.push(row); return row;
    }
  });
  stub('ExamAttempt', {
    findById: async () => state.attempt,
    findOneAndUpdate: async (filter, update) => {
      if (state.attempt._id !== filter._id || state.attempt.status !== filter.status) return null;
      const before = { ...state.attempt }; Object.assign(state.attempt, update); return before;
    },
    updateOne: async (_f, update) => { Object.assign(state.attempt, update); }
  });
  stub('Exam', { findById: () => ({ populate: async () => state.exam }) });
  delete require.cache[require.resolve('../services/grading')];
  return { state, grading: require('../services/grading') };
}
const examFixture = () => ({ _id: 'e1', passingPercentage: 50, questionIds: [
  { _id: 'q1', isActive: true, correctOption: 'A', marks: 2, negativeMarks: 1 },
  { _id: 'q2', isActive: true, correctOption: 'B', marks: 2, negativeMarks: 0 }
] });
const attemptFixture = (over = {}) => ({
  _id: 'a1', exam: 'e1', student: 's1', status: 'in_progress', answers: { q1: 'A' },
  startedAt: new Date('2026-01-01T10:00:00Z'), expiresAt: new Date('2026-01-01T10:30:00Z'), ...over
});

test('finalize: tab switch auto-submit grades saved + final answers once', async () => {
  const { state, grading } = installFakes();
  state.exam = examFixture(); state.attempt = attemptFixture();
  const r1 = await grading.finalizeAttempt('a1', { reason: 'tab_switch', answers: { q2: 'B' }, now: new Date('2026-01-01T10:10:00Z') });
  assert.equal(r1.created, true);
  assert.equal(r1.submission.score, 4); assert.equal(r1.submission.submitReason, 'tab_switch'); assert.equal(r1.submission.passed, true);
  assert.equal(state.attempt.status, 'submitted');
  // second call (e.g. sweeper + student racing) must not create a second submission
  const r2 = await grading.finalizeAttempt('a1', { reason: 'time_up', now: new Date('2026-01-01T10:31:00Z') });
  assert.equal(r2.created, false); assert.equal(state.submissions.length, 1);
});
test('finalize: after expiry it is time_up, attempt expired, late answers ignored', async () => {
  const { state, grading } = installFakes();
  state.exam = examFixture(); state.attempt = attemptFixture();
  const r = await grading.finalizeAttempt('a1', { reason: 'manual', answers: { q2: 'B' }, now: new Date('2026-01-01T10:45:00Z') });
  assert.equal(r.submission.submitReason, 'time_up');
  assert.equal(r.submission.score, 2); // q2 answer sent after the deadline is NOT counted
  assert.equal(state.attempt.status, 'expired');
  assert.equal(r.submission.durationSeconds, 1800); // capped at the allowed duration
});
test('finalize: failure while saving rolls the attempt back to in_progress', async () => {
  const { state, grading } = installFakes();
  state.exam = examFixture(); state.attempt = attemptFixture();
  const SubmissionPath = require.resolve('../models/Submission');
  const original = require.cache[SubmissionPath].exports.create;
  require.cache[SubmissionPath].exports.create = async () => { throw new Error('db down'); };
  await assert.rejects(grading.finalizeAttempt('a1', { reason: 'manual', now: new Date('2026-01-01T10:05:00Z') }), /db down/);
  assert.equal(state.attempt.status, 'in_progress');
  require.cache[SubmissionPath].exports.create = original;
});


const { createQuestionOrder, orderQuestions } = require('../services/questionOrder');
test('question order is shuffled per attempt and stable when persisted', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const order = createQuestionOrder(ids, () => 0);
  assert.deepEqual(order, ['d', 'b', 'a', 'c']);
  assert.deepEqual(ids, ['a', 'b', 'c', 'd']);
  const questions = ids.map(_id => ({ _id }));
  assert.deepEqual(orderQuestions(questions, order).map(q => q._id), order);
});

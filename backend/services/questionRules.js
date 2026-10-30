'use strict';
// Pure validation rules for questions. No database / framework dependencies so they are easy to test.

const LETTERS = ['A', 'B', 'C', 'D'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];

const RULES = {
  textMin: 5,
  textMax: 3000,
  optionCount: 4,
  optionMax: 500,
  marksMin: 0.25,
  marksMax: 100,
  marksStep: 0.25,
  topicMax: 100,
  explanationMax: 1000
};

const isQuarter = n => Math.abs(n * 4 - Math.round(n * 4)) < 1e-9;

/**
 * Validate a COMPLETE question object (callers merge partial updates first).
 * Returns { error } or { value } with trimmed / normalised fields.
 */
function validateQuestion(input) {
  const body = input || {};
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (text.length < RULES.textMin) return { error: `Question text must be at least ${RULES.textMin} characters.` };
  if (text.length > RULES.textMax) return { error: `Question text can be at most ${RULES.textMax} characters.` };

  if (!Array.isArray(body.options) || body.options.length !== RULES.optionCount) {
    return { error: 'A question must have exactly four options (A, B, C, D).' };
  }
  const options = [];
  for (const raw of body.options) {
    const option = typeof raw === 'string' ? raw.trim() : '';
    if (!option) return { error: 'All four options must be filled in.' };
    if (option.length > RULES.optionMax) return { error: `Each option can be at most ${RULES.optionMax} characters.` };
    options.push(option);
  }
  if (new Set(options.map(o => o.toLowerCase())).size !== options.length) {
    return { error: 'Options must be different from each other.' };
  }

  if (!LETTERS.includes(body.correctOption)) return { error: 'Choose the correct answer (A, B, C or D).' };

  const marks = body.marks === undefined || body.marks === null || body.marks === '' ? 1 : Number(body.marks);
  if (!Number.isFinite(marks) || marks < RULES.marksMin || marks > RULES.marksMax || !isQuarter(marks)) {
    return { error: `Marks must be between ${RULES.marksMin} and ${RULES.marksMax} in steps of ${RULES.marksStep}.` };
  }
  const negativeMarks = body.negativeMarks === undefined || body.negativeMarks === null || body.negativeMarks === '' ? 0 : Number(body.negativeMarks);
  if (!Number.isFinite(negativeMarks) || negativeMarks < 0 || !isQuarter(negativeMarks)) {
    return { error: 'Negative marks must be 0 or a positive number in steps of 0.25.' };
  }
  if (negativeMarks > marks) return { error: 'Negative marks cannot be more than the marks of the question.' };

  const difficulty = body.difficulty === undefined || body.difficulty === null || body.difficulty === '' ? 'medium' : body.difficulty;
  if (!DIFFICULTIES.includes(difficulty)) return { error: 'Difficulty must be easy, medium or hard.' };

  const topic = typeof body.topic === 'string' ? body.topic.trim() : '';
  if (topic.length > RULES.topicMax) return { error: `Topic can be at most ${RULES.topicMax} characters.` };
  const explanation = typeof body.explanation === 'string' ? body.explanation.trim() : '';
  if (explanation.length > RULES.explanationMax) return { error: `Explanation can be at most ${RULES.explanationMax} characters.` };

  return { value: { text, options, correctOption: body.correctOption, marks, negativeMarks, difficulty, topic, explanation } };
}

module.exports = { validateQuestion, RULES, LETTERS, DIFFICULTIES };

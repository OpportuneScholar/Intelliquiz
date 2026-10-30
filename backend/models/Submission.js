const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  exam: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true, index: true },
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  attempt: { type: mongoose.Schema.Types.ObjectId, ref: 'ExamAttempt', required: true, index: { unique: true, sparse: true } },
  answers: { type: mongoose.Schema.Types.Mixed, default: {} },
  // `score` = marks obtained (can be fractional because of marks / negative marking).
  score: { type: Number, required: true, min: 0 },
  totalMarks: { type: Number, default: 0, min: 0 },
  totalQuestions: { type: Number, required: true, min: 0 },
  percentage: { type: Number, required: true, min: 0, max: 100 },
  correctCount: { type: Number, default: 0, min: 0 },
  wrongCount: { type: Number, default: 0, min: 0 },
  unansweredCount: { type: Number, default: 0, min: 0 },
  passed: { type: Boolean, default: false },
  submitReason: { type: String, enum: ['manual', 'time_up', 'tab_switch', 'system'], default: 'manual' },
  durationSeconds: { type: Number, default: 0, min: 0 },
  submittedAt: { type: Date, default: Date.now }
}, { timestamps: true, versionKey: false });
schema.index({ exam: 1, student: 1 });
module.exports = mongoose.models.Submission || mongoose.model('Submission', schema);

const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  exam: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true, index: true },
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  attemptNumber: { type: Number, required: true, min: 1 },
  status: { type: String, enum: ['in_progress', 'submitted', 'expired'], default: 'in_progress', index: true },
  answers: { type: mongoose.Schema.Types.Mixed, default: {} },
  startedAt: { type: Date, required: true, default: Date.now },
  expiresAt: { type: Date, required: true },
  submittedAt: { type: Date, default: null }
}, { timestamps: true, versionKey: false });
schema.index({ exam: 1, student: 1, attemptNumber: 1 }, { unique: true });
schema.index({ exam: 1, student: 1, status: 1 });
schema.index({ exam: 1, student: 1 }, { unique: true, partialFilterExpression: { status: 'in_progress' } });
module.exports = mongoose.models.ExamAttempt || mongoose.model('ExamAttempt', schema);

const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 180 },
  subject: { type: String, trim: true, maxlength: 120, default: '' },
  visibilityMode: { type: String, enum: ['all', 'class', 'selected', 'both'], default: 'all' },
  targetClasses: [{ course: String, branch: String, semester: String, section: String }],
  selectedStudents: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  description: { type: String, default: '', maxlength: 3000 },
  durationMinutes: { type: Number, required: true, min: 1, max: 600 },
  maxAttempts: { type: Number, default: 1, min: 1, max: 20 },
  passingPercentage: { type: Number, default: 40, min: 0, max: 100 },
  // When true the student's attempt is submitted automatically the moment they leave the exam tab.
  tabSwitchAutoSubmit: { type: Boolean, default: true },
  status: { type: String, enum: ['draft', 'published', 'closed'], default: 'draft' },
  startsAt: { type: Date, default: null },
  endsAt: { type: Date, default: null },
  publicToken: { type: String, unique: true, sparse: true },
  questionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Question' }],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }
}, { timestamps: true, versionKey: false });
module.exports = mongoose.models.Exam || mongoose.model('Exam', schema);

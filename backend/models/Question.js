const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  text: { type: String, required: true, trim: true, minlength: 5, maxlength: 3000 },
  options: { type: [String], required: true, validate: v => v.length === 4 && v.every(x => typeof x === 'string' && x.trim()) },
  correctOption: { type: String, enum: ['A', 'B', 'C', 'D'], required: true },
  marks: { type: Number, default: 1, min: 0.25, max: 100 },
  negativeMarks: { type: Number, default: 0, min: 0, max: 100 },
  difficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium' },
  topic: { type: String, trim: true, maxlength: 100, default: '' },
  explanation: { type: String, trim: true, maxlength: 1000, default: '' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  isActive: { type: Boolean, default: true }
}, { timestamps: true, versionKey: false });
module.exports = mongoose.models.Question || mongoose.model('Question', schema);

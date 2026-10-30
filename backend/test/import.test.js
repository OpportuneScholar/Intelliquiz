'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {parseText,structured,parseCsvLine}=require('../services/questionImport');
test('parses numbered MCQ with real newline characters and metadata',()=>{const r=parseText('Q1. What is Python?\nA) Snake\nB) Programming language\nC) Database\nD) Operating system\nAnswer: B\nMarks: 2\nDifficulty: easy');assert.equal(r.questions.length,1);assert.equal(r.questions[0].text,'What is Python?');assert.equal(r.questions[0].correctOption,'B');assert.equal(r.questions[0].marks,2);});
test('rejects question missing answer key',()=>{const r=parseText('Q1. What is Python?\nA) Snake\nB) Programming language\nC) Database\nD) Operating system');assert.equal(r.questions.length,0);assert.equal(r.errors.length,1);});
test('normalises structured question keys',()=>{const q=structured([{question:'What is 2+2?',options:['1','2','4','5'],answer:'C'}])[0];assert.equal(q.text,'What is 2+2?');assert.equal(q.correctOption,'C');});
test('CSV parser handles quoted commas and escaped quotes',()=>{assert.deepEqual(parseCsvLine('"question","optionA"'),['question','optionA']);assert.deepEqual(parseCsvLine('"What is 2, plus 2?","A ""quoted"" answer"'),['What is 2, plus 2?','A "quoted" answer']);});

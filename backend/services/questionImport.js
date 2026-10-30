'use strict';
const path=require('path');
const {validateQuestion}=require('./questionRules');
function answerLetter(v){const m=String(v||'').trim().toUpperCase().match(/^(?:OPTION\s*)?([A-D])(?:[).:]|$)/);return m?m[1]:null;}
function structured(rows){return rows.filter(x=>x&&typeof x==='object').map(r=>({text:r.text??r.question??r.Question,options:Array.isArray(r.options)?r.options:[r.optionA??r.A,r.optionB??r.B,r.optionC??r.C,r.optionD??r.D],correctOption:answerLetter(r.correctOption??r.answer??r.correct_answer??r.Answer),marks:r.marks??1,negativeMarks:r.negativeMarks??r.negative_marks??0,difficulty:String(r.difficulty??'medium').toLowerCase(),topic:r.topic??'',explanation:r.explanation??''}));}
function parseText(input){
 const text=String(input||'').replace(/\r/g,'');
 const starts=[...text.matchAll(/^\s*(?:Q(?:uestion)?\s*\d+|\d+[.)]\s*)/gim)].map(m=>m.index);
 const chunks=starts.length?starts.map((s,i)=>text.slice(s,starts[i+1]??text.length).trim()):[text.trim()];
 const questions=[],errors=[];
 for(const block of chunks.filter(Boolean)){
  const lines=block.split('\n').map(x=>x.trim()).filter(Boolean),first=lines.findIndex(x=>/^(?:Q(?:uestion)?\s*\d+|\d+[.)])\s*/i.test(x));
  const qtext=[],opts={},meta={answer:null,marks:1,negativeMarks:0,difficulty:'medium',topic:'',explanation:''};
  for(let i=0;i<lines.length;i++){const l=lines[i],o=l.match(/^([A-D])[).:]\s*(.+)$/i),a=l.match(/^(?:correct\s*(?:answer|option)?|answer|ans)\s*[:=-]\s*(.+)$/i),m=l.match(/^marks?\s*[:=-]\s*(\d+(?:\.\d+)?)$/i),n=l.match(/^negative\s*marks?\s*[:=-]\s*(\d+(?:\.\d+)?)$/i),d=l.match(/^difficulty\s*[:=-]\s*(easy|medium|hard)$/i),t=l.match(/^topic\s*[:=-]\s*(.+)$/i),x=l.match(/^explanation\s*[:=-]\s*(.+)$/i);
   if(o)opts[o[1].toUpperCase()]=o[2];else if(a)meta.answer=answerLetter(a[1]);else if(m)meta.marks=Number(m[1]);else if(n)meta.negativeMarks=Number(n[1]);else if(d)meta.difficulty=d[1].toLowerCase();else if(t)meta.topic=t[1];else if(x)meta.explanation=x[1];else if(i>=first){const clean=l.replace(/^(?:Q(?:uestion)?\s*\d+|\d+[.)])\s*[:.)-]?\s*/i,'');if(clean)qtext.push(clean);}
  }
  const q={text:qtext.join(' '),options:['A','B','C','D'].map(k=>opts[k]||''),correctOption:meta.answer,marks:meta.marks,negativeMarks:meta.negativeMarks,difficulty:meta.difficulty,topic:meta.topic,explanation:meta.explanation};
  const checked=validateQuestion(q);if(checked.error)errors.push({message:checked.error,text:q.text.slice(0,120)});else questions.push(checked.value);
 }
 return {questions,errors};
}
function parseCsvLine(line){const cells=[];let v='',quoted=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'&&quoted&&line[i+1]==='"'){v+='"';i++;}else if(c==='"')quoted=!quoted;else if(c===','&&!quoted){cells.push(v);v='';}else v+=c;}cells.push(v);return cells;}
async function extractQuestions(name,buf){
 const ext=path.extname(name).toLowerCase();
 if(ext==='.json'){const d=JSON.parse(buf.toString('utf8'));return {format:'JSON',questions:structured(Array.isArray(d)?d:(d.questions||[])),errors:[]};}
 if(ext==='.csv'){const lines=buf.toString('utf8').replace(/^\uFEFF/,'').split(/\r?\n/).filter(Boolean);if(lines.length<2)return {format:'CSV',questions:[],errors:[{message:'CSV needs a header row and at least one question row.'}]};const head=parseCsvLine(lines.shift()).map(x=>x.trim().toLowerCase().replace(/[ _-]/g,''));const rows=lines.map(line=>{const c=parseCsvLine(line),r={};head.forEach((h,i)=>r[h]=c[i]??'');return {question:r.question||r.text,optionA:r.optiona||r.a,optionB:r.optionb||r.b,optionC:r.optionc||r.c,optionD:r.optiond||r.d,answer:r.answer||r.correctoption,marks:r.marks,negativeMarks:r.negativemarks,difficulty:r.difficulty,topic:r.topic,explanation:r.explanation};});return {format:'CSV',questions:structured(rows),errors:[]};}
 let text='';if(ext==='.txt')text=buf.toString('utf8');else if(ext==='.pdf'){const p=await require('pdf-parse')(buf);text=p.text||'';if(!text.trim())return {format:'PDF',questions:[],errors:[{message:'No selectable text found; scanned PDFs need OCR.'}]};}else if(ext==='.docx'){const d=await require('mammoth').extractRawText({buffer:buf});text=d.value||'';}else throw Object.assign(new Error('Supported formats: PDF, DOCX, TXT, CSV and JSON.'),{status:400});return {format:ext.slice(1).toUpperCase(),...parseText(text)};
}
module.exports={extractQuestions,parseText,structured,parseCsvLine};

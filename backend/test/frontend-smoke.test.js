'use strict';
// Runs public/app.js inside a tiny fake DOM that only knows the element ids present in public/index.html.
// A reference to an id that does not exist (the original `#refresh` bug) returns null, exactly like a browser,
// so such a crash is caught here.   Run: node --test test/frontend-smoke.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const code = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function createEnv({ pathname = '/', token = null, routes }) {
  const staticIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
  const dynamicIds = new Set();
  const els = new Map();
  const registerIds = h => { for (const m of String(h).matchAll(/id=\\?"([A-Za-z0-9_-]+)/g)) dynamicIds.add(m[1]); };

  class Element {}
  class HTMLFormElement extends Element {}
  function makeEl(id) {
    const listeners = {};
    let inner = '';
    const el = {
      id, listeners, dataset: {}, style: {}, hidden: false, disabled: false, checked: false, value: '', textContent: '',
      classList: { s: new Set(), add(...c) { c.forEach(x => this.s.add(x)); }, remove(...c) { c.forEach(x => this.s.delete(x)); },
        toggle(c, f) { (f === undefined ? !this.s.has(c) : f) ? this.s.add(c) : this.s.delete(c); }, contains(c) { return this.s.has(c); } },
      addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); }, removeEventListener() {},
      querySelector: sel => query(sel), querySelectorAll: () => [], closest: () => null, matches: () => false,
      setAttribute() {}, getAttribute() { return null; }, scrollIntoView() {}, prepend() {}, appendChild() {}, remove() {}, click() {}, reset() {},
      insertAdjacentHTML(_p, h) { registerIds(h); inner = h + inner; },
      elements: new Proxy({}, { get: (t, k) => (t[k] = t[k] || { value: '' }) })
    };
    Object.defineProperty(el, 'innerHTML', { get: () => inner, set: v => { inner = String(v); registerIds(inner); } });
    return el;
  }
  const getEl = id => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
  const generic = makeEl('generic');
  function query(sel) {
    const m = /^#([A-Za-z0-9_-]+)/.exec(sel);
    if (m) return staticIds.has(m[1]) || dynamicIds.has(m[1]) ? (sel === '#' + m[1] ? getEl(m[1]) : generic) : null;
    return generic;
  }

  const calls = [];
  const store = new Map(token ? [['iq_token', token]] : []);
  const docListeners = {}, winListeners = {};
  const document = {
    visibilityState: 'visible', hasFocus: () => true, body: { dataset: {}, appendChild() {} }, documentElement: { dataset: {} },
    querySelector: query, querySelectorAll: () => [], createElement: () => makeEl('created'),
    addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); }, removeEventListener(t, fn) { docListeners[t] = (docListeners[t] || []).filter(f => f !== fn); }
  };
  const win = {
    INTELLIQUIZ_API: '', addEventListener(t, fn) { (winListeners[t] = winListeners[t] || []).push(fn); },
    removeEventListener(t, fn) { winListeners[t] = (winListeners[t] || []).filter(f => f !== fn); }
  };
  const sandbox = {
    window: win, document, Element, HTMLFormElement, console: { log() {}, error() {}, warn() {} },
    location: { pathname, search: '', origin: 'http://localhost:5000', href: '' },
    history: { replaceState() {} }, navigator: {}, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, Blob: class {},
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    URLSearchParams, FormData: class { constructor(f) { this.f = (f && f.__data) || {}; } get(k) { return this.f[k] ?? null; }
      getAll(k) { const v = this.f[k]; return v === undefined ? [] : Array.isArray(v) ? v : [v]; } entries() { return Object.entries(this.f); } },
    confirm: () => true, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date, Math, JSON, Object, String, Number, Set, Array, Error,
    fetch: async (url, opts = {}) => {
      const body = opts.body ? JSON.parse(opts.body) : undefined;
      calls.push({ url, method: opts.method || 'GET', body });
      const out = routes(url, opts.method || 'GET', body);
      return { ok: out.status === undefined || out.status < 400, status: out.status || 200, json: async () => out.json };
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox, { filename: 'app.js' });
  const fire = async (target, type, evt) => { for (const fn of (target[type] || [])) await fn(evt); };
  const formEvent = (id, data) => {
    const form = Object.create(HTMLFormElement.prototype);
    Object.assign(form, { id, __data: data, elements: new Proxy({}, { get: (t, k) => (t[k] = t[k] || { value: '' }) }),
      querySelector: () => makeEl('btn'), reset() {}, scrollIntoView() {} });
    return { target: form, currentTarget: form, preventDefault() {}, stopPropagation() {} };
  };
  const clickEvent = map => {
    const target = Object.create(Element.prototype);
    target.closest = sel => (map[sel] ? { dataset: map[sel] } : null);
    return { target, preventDefault() {}, stopPropagation() {} };
  };
  return { calls, getEl, docListeners, winListeners, document, fire, formEvent, clickEvent, sandbox, store };
}

const teacher = { id: 't1', name: 'Teach', email: 't@x.com', role: 'teacher' };
const student = { id: 's1', name: 'Stu', email: 's@x.com', role: 'student' };

test('app.js loads against the real index.html ids and wires every form/button (original crash is gone)', () => {
  const env = createEnv({ routes: () => ({ json: {} }) });
  for (const id of ['loginForm', 'registerForm', 'forgotForm', 'resetForm']) assert.ok(env.getEl(id).listeners.submit?.length, id + ' submit handler missing');
  for (const id of ['requestOtp', 'verifyOtp', 'resendOtp', 'forgotLink', 'backToLogin', 'resetBack', 'logout', 'themeToggle']) assert.ok(env.getEl(id).listeners.click?.length, id + ' click handler missing');
  assert.ok(env.docListeners.click?.length && env.docListeners.submit?.length, 'document click/submit delegates missing');
});

test('teacher: login -> question bank (rules shown) -> add question with marks', async () => {
  const env = createEnv({ routes: (url, method) => {
    if (url === '/api/auth/login') return { json: { token: 'tok', user: teacher } };
    if (url === '/api/dashboard/summary') return { json: { students: 3, questions: 0, attempts: 0 } };
    if (url === '/api/questions' && method === 'GET') return { json: { questions: [] } };
    if (url === '/api/questions' && method === 'POST') return { status: 201, json: { question: {} } };
    if (url === '/api/exams') return { json: { exams: [] } };
    return { status: 404, json: { message: 'nope ' + url } };
  } });
  await env.fire(env.getEl('loginForm').listeners, 'submit', env.formEvent('loginForm', { email: 't@x.com', password: 'pw', role: 'teacher' }));
  await sleep(30);
  assert.match(env.getEl('dashboardContent').innerHTML, /Teaching overview/);
  await env.fire(env.docListeners, 'click', env.clickEvent({ '[data-page]': { page: 'questions' } }));
  await sleep(30);
  assert.match(env.getEl('dashboardContent').innerHTML, /Question rules/);
  assert.match(env.getEl('dashboardContent').innerHTML, /name="marks"/);
  await env.fire(env.docListeners, 'submit', env.formEvent('addQuestionForm', { text: 'What is 2+2?', optionA: '3', optionB: '4', optionC: '5', optionD: '6', correctOption: 'B', marks: '2', negativeMarks: '0.5', difficulty: 'easy', topic: 'Math', explanation: '' }));
  await sleep(30);
  const post = env.calls.find(c => c.url === '/api/questions' && c.method === 'POST');
  assert.ok(post, 'question was not sent to the API');
  assert.equal(post.body.marks, 2); assert.equal(post.body.negativeMarks, 0.5); assert.deepEqual(post.body.options, ['3', '4', '5', '6']);
});

test('teacher: client blocks bad question (negative marks > marks, duplicate options) before calling the API', async () => {
  const env = createEnv({ token: 'tok', routes: (url) => url === '/api/auth/me' ? { json: { user: teacher } } : url === '/api/dashboard/summary' ? { json: { students: 0, questions: 0, attempts: 0 } } : { json: { questions: [], exams: [] } } });
  await sleep(30);
  await env.fire(env.docListeners, 'submit', env.formEvent('addQuestionForm', { text: 'Valid question?', optionA: 'x', optionB: 'x', optionC: 'y', optionD: 'z', correctOption: 'A', marks: '1', negativeMarks: '0' }));
  await env.fire(env.docListeners, 'submit', env.formEvent('addQuestionForm', { text: 'Valid question?', optionA: 'a', optionB: 'b', optionC: 'c', optionD: 'd', correctOption: 'A', marks: '1', negativeMarks: '3' }));
  await sleep(20);
  assert.equal(env.calls.filter(c => c.url === '/api/questions' && c.method === 'POST').length, 0);
});

test('forgot password: email -> OTP screen -> reset with OTP', async () => {
  const env = createEnv({ routes: (url) => {
    if (url === '/api/auth/forgot-password') return { status: 202, json: { message: 'OTP sent' } };
    if (url === '/api/auth/reset-password') return { json: { message: 'Password updated successfully.' } };
    return { json: {} };
  } });
  await env.fire(env.getEl('forgotForm').listeners, 'submit', env.formEvent('forgotForm', { email: 'S@X.com' }));
  await sleep(20);
  assert.match(env.getEl('resetHint').textContent, /S@X\.com/);
  await env.fire(env.getEl('resetForm').listeners, 'submit', env.formEvent('resetForm', { otp: '123456', password: 'newpassword1', confirmPassword: 'newpassword1' }));
  await sleep(20);
  const reset = env.calls.find(c => c.url === '/api/auth/reset-password');
  assert.deepEqual(reset.body, { email: 's@x.com', otp: '123456', password: 'newpassword1' });
  // wrong confirm password never reaches the server
  const before = env.calls.length;
  await env.fire(env.getEl('resetForm').listeners, 'submit', env.formEvent('resetForm', { otp: '123456', password: 'abcdefgh1', confirmPassword: 'different1' }));
  assert.equal(env.calls.length, before);
});

function examRoutes(expiresInMs) {
  const questions = [{ id: 'q1', text: 'Q one?', options: ['a', 'b', 'c', 'd'], marks: 2, negativeMarks: 0.5 }, { id: 'q2', text: 'Q two?', options: ['a', 'b', 'c', 'd'], marks: 1, negativeMarks: 0 }];
  return (url, method, body) => {
    if (url === '/api/auth/me') return { json: { user: student } };
    if (url.startsWith('/api/exams/public/')) return { json: { exam: { id: 'e1', title: 'Unit Test', description: '', durationMinutes: 30, maxAttempts: 1, attemptsUsed: 0, hasActiveAttempt: false, questionCount: 2, totalMarks: 3, passingPercentage: 40, tabSwitchAutoSubmit: true }, lastResult: null, serverTime: new Date().toISOString() } };
    if (url === '/api/exams/e1/start') return { status: 201, json: { attempt: { id: 'a1', answers: {}, startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + expiresInMs).toISOString() }, questions, rules: { tabSwitchAutoSubmit: true }, serverTime: new Date().toISOString() } };
    if (url === '/api/exams/e1/attempt/a1' && method === 'PATCH') return { json: { message: 'saved' } };
    if (url === '/api/exams/e1/attempt/a1/submit') return { status: 201, json: { result: { score: 2, totalMarks: 3, percentage: 66.67, correctCount: 1, wrongCount: 0, unansweredCount: 1, passed: true, submitReason: body.reason } } };
    return { status: 404, json: { message: 'nope ' + url } };
  };
}
async function startExam(env) {
  await sleep(30);
  assert.match(env.getEl('dashboardContent').innerHTML, /EXAM RULES/);
  assert.match(env.getEl('dashboardContent').innerHTML, /submitted automatically/);
  const agree = env.getEl('agreeRules'), start = env.getEl('startExamBtn');
  agree.checked = true;
  await env.fire(agree.listeners, 'change', {});
  assert.equal(start.disabled, false);
  await env.fire(start.listeners, 'click', {});
  await sleep(30);
  assert.match(env.getEl('dashboardContent').innerHTML, /SECURE ASSESSMENT/);
}

test('exam: rules screen -> start -> answer autosaves -> TAB SWITCH auto-submits with answers', async () => {
  const env = createEnv({ pathname: '/exam/tok123', token: 'tok', routes: examRoutes(10 * 60 * 1000) });
  await startExam(env);
  await env.fire(env.getEl('dashboardContent').listeners, 'change', { target: { matches: () => true, name: 'q-q1', value: 'B' } });
  await sleep(20);
  assert.ok(env.calls.find(c => c.method === 'PATCH' && c.body.answers.q1 === 'B'), 'answer was not autosaved');
  env.document.visibilityState = 'hidden';
  await env.fire(env.docListeners, 'visibilitychange', {});
  await sleep(30);
  const submit = env.calls.find(c => c.url.endsWith('/submit'));
  assert.ok(submit, 'tab switch did not submit the exam');
  assert.equal(submit.body.reason, 'tab_switch'); assert.deepEqual(submit.body.answers, { q1: 'B' });
  assert.match(env.getEl('dashboardContent').innerHTML, /left the exam tab/);
  assert.equal(env.calls.filter(c => c.url.endsWith('/submit')).length, 1, 'must submit only once');
});

test('exam: window blur (switching to another app) also auto-submits', async () => {
  const env = createEnv({ pathname: '/exam/tok123', token: 'tok', routes: examRoutes(10 * 60 * 1000) });
  await startExam(env);
  env.document.hasFocus = () => false;
  await env.fire(env.winListeners, 'blur', {});
  await sleep(700);
  assert.equal(env.calls.find(c => c.url.endsWith('/submit'))?.body.reason, 'tab_switch');
});

test('exam: timer reaching zero auto-submits with reason time_up', async () => {
  const env = createEnv({ pathname: '/exam/tok123', token: 'tok', routes: examRoutes(1500) });
  await startExam(env);
  await sleep(2400);
  const submit = env.calls.find(c => c.url.endsWith('/submit'));
  assert.ok(submit, 'timer end did not submit the exam');
  assert.equal(submit.body.reason, 'time_up');
  assert.match(env.getEl('dashboardContent').innerHTML, /Time is up/);
});

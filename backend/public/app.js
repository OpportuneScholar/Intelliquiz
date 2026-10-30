'use strict';
/* IntelliQuiz frontend — auth, teacher console, student portal and the secure exam runner. */

const API_BASE = (window.INTELLIQUIZ_API || '').replace(/\/$/, '');
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = s => (s ? new Date(s).toLocaleString() : '—');
const fmtNum = n => String(Math.round(Number(n || 0) * 100) / 100);
const REASON_LABEL = { manual: 'Submitted by student', time_up: 'Time up (auto)', tab_switch: 'Tab switch (auto)', system: 'Auto-submitted' };

const forms = { login: $('#loginForm'), register: $('#registerForm'), teacher: $('#teacherForm'), forgot: $('#forgotForm'), reset: $('#resetForm') };
let currentUser = null;
let dashCache = { questions: [], exams: [], results: [] };
let pendingTeacher = null;
let resetEmail = '';
let resendTimer = null;
let activeExam = null; // set while an exam is running so we never navigate away silently

$('#year').textContent = new Date().getFullYear();

/* ------------------------------------------------------------------ helpers */
function message(text, isError = false) {
  const el = $('#message');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('hidden', 'error');
  if (isError) el.classList.add('error');
}
function clearMessage() { const el = $('#message'); if (el) el.classList.add('hidden'); }

function withBusy(button, busyText, task) {
  const original = button.innerHTML;
  button.disabled = true;
  button.classList.add('is-loading');
  button.innerHTML = '<span class="spinner" aria-hidden="true"></span> ' + busyText;
  return Promise.resolve().then(task).finally(() => {
    button.disabled = false;
    button.classList.remove('is-loading');
    button.innerHTML = original;
  });
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = localStorage.getItem('iq_token');
  if (token) headers.Authorization = 'Bearer ' + token;
  let response;
  try { response = await fetch(API_BASE + path, { ...options, headers }); }
  catch (_) { throw new Error('Cannot reach the IntelliQuiz server. Check your internet connection and try again.'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.message || 'Request failed (' + response.status + ')'), { status: response.status });
  return data;
}

function applyTheme(theme) {
  const selected = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = selected;
  document.body.dataset.theme = selected;
  const b = $('#themeToggle');
  b.textContent = selected === 'light' ? '🌙 Dark mode' : '☀ Light mode';
  b.setAttribute('aria-pressed', String(selected === 'light'));
}
let savedTheme = 'dark';
try { savedTheme = localStorage.getItem('iq_theme') || 'dark'; } catch (_) { /* storage blocked */ }
applyTheme(savedTheme);
$('#themeToggle').addEventListener('click', () => {
  const next = document.body.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  try { localStorage.setItem('iq_theme', next); } catch (_) { /* ignore */ }
});

/* ------------------------------------------------------------------ auth views */
function showView(view) {
  clearMessage();
  Object.entries(forms).forEach(([k, f]) => f.classList.toggle('hidden', k !== view));
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.querySelector('.tabs').classList.toggle('hidden', view === 'forgot' || view === 'reset');
  $('#teacherStepOne').classList.remove('hidden');
  $('#teacherStepTwo').classList.add('hidden');
}
document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));

const requestedRole = new URLSearchParams(location.search).get('role');
if (['student', 'teacher'].includes(requestedRole)) $('#loginForm [name=role]').value = requestedRole;

// ---- login (email + password only, no OTP for students or teachers)
forms.login.addEventListener('submit', async e => {
  e.preventDefault();
  clearMessage();
  const f = new FormData(e.currentTarget), b = e.currentTarget.querySelector('[type=submit]');
  try {
    await withBusy(b, 'Signing in…', async () => {
      const d = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: String(f.get('email') || '').trim(), password: String(f.get('password') || ''), role: f.get('role') }) });
      if (!d.token || !d.user) throw new Error('The server response was incomplete. Please try again.');
      localStorage.setItem('iq_token', d.token);
      afterLogin(d);
    });
  } catch (err) { message(err.message || 'Sign in failed. Check account type, email and password.', true); }
});

// ---- student registration (no OTP)
forms.register.addEventListener('submit', async e => {
  e.preventDefault();
  clearMessage();
  const body = Object.fromEntries(new FormData(e.currentTarget).entries());
  const b = e.currentTarget.querySelector('[type=submit]');
  try {
    await withBusy(b, 'Creating account…', async () => {
      const d = await api('/api/auth/register', { method: 'POST', body: JSON.stringify(body) });
      localStorage.setItem('iq_token', d.token);
      afterLogin(d);
    });
  } catch (err) { message(err.message, true); }
});

// ---- teacher signup (email OTP)
$('#requestOtp').addEventListener('click', async () => {
  clearMessage();
  const f = new FormData(forms.teacher);
  pendingTeacher = { name: String(f.get('name') || '').trim(), email: String(f.get('email') || '').trim(), password: String(f.get('password') || '') };
  if (!pendingTeacher.name || !pendingTeacher.email || pendingTeacher.password.length < 10) { message('Enter your name, a valid email and a password of at least 10 characters.', true); return; }
  try {
    await withBusy($('#requestOtp'), 'Sending code…', async () => {
      const d = await api('/api/teacher-registration/request-otp', { method: 'POST', body: JSON.stringify(pendingTeacher) });
      $('#teacherStepOne').classList.add('hidden');
      $('#teacherStepTwo').classList.remove('hidden');
      message(d.message || 'Verification code sent.');
    });
  } catch (err) { message(err.message, true); }
});
$('#verifyOtp').addEventListener('click', async () => {
  const otp = $('#otp').value.trim();
  if (!pendingTeacher || !/^\d{6}$/.test(otp)) { message('Enter the 6-digit verification code.', true); return; }
  try {
    await withBusy($('#verifyOtp'), 'Verifying…', async () => {
      const d = await api('/api/teacher-registration/verify-otp', { method: 'POST', body: JSON.stringify({ email: pendingTeacher.email, otp }) });
      const email = pendingTeacher.email;
      pendingTeacher = null;
      showView('login');
      $('#loginForm [name=email]').value = email;
      $('#loginForm [name=role]').value = 'teacher';
      message(d.message || 'Email verified. Please sign in.');
    });
  } catch (err) { message(err.message, true); }
});

// ---- forgot password: email OTP -> new password
$('#forgotLink').addEventListener('click', () => {
  const email = $('#loginForm [name=email]').value.trim();
  showView('forgot');
  $('#forgotForm [name=email]').value = email;
});
$('#backToLogin').addEventListener('click', () => showView('login'));
$('#resetBack').addEventListener('click', () => { clearInterval(resendTimer); showView('login'); });

function startResendCooldown(seconds = 60) {
  const btn = $('#resendOtp');
  clearInterval(resendTimer);
  let left = seconds;
  const tick = () => {
    if (left > 0) { btn.disabled = true; btn.textContent = 'Resend OTP in ' + left + 's'; left--; }
    else { clearInterval(resendTimer); btn.disabled = false; btn.textContent = 'Resend OTP'; }
  };
  tick();
  resendTimer = setInterval(tick, 1000);
}
forms.forgot.addEventListener('submit', async e => {
  e.preventDefault();
  clearMessage();
  const email = String(new FormData(e.currentTarget).get('email') || '').trim();
  try {
    await withBusy(e.currentTarget.querySelector('[type=submit]'), 'Sending OTP…', async () => {
      const d = await api('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
      resetEmail = email.toLowerCase();
      showView('reset');
      $('#resetHint').textContent = 'Enter the 6-digit OTP sent to ' + email + '. It expires in 10 minutes.';
      startResendCooldown();
      message(d.message || 'OTP sent.');
    });
  } catch (err) { message(err.message, true); }
});
$('#resendOtp').addEventListener('click', async () => {
  clearMessage();
  try {
    $('#resendOtp').disabled = true;
    const d = await api('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email: resetEmail }) });
    message(d.message || 'OTP sent again.');
    startResendCooldown();
  } catch (err) { message(err.message, true); $('#resendOtp').disabled = false; }
});
forms.reset.addEventListener('submit', async e => {
  e.preventDefault();
  clearMessage();
  const f = new FormData(e.currentTarget);
  const otp = String(f.get('otp') || '').trim();
  if (!/^\d{6}$/.test(otp)) return message('Enter the 6-digit OTP from your email.', true);
  if (f.get('password') !== f.get('confirmPassword')) return message('Passwords do not match.', true);
  try {
    await withBusy(e.currentTarget.querySelector('[type=submit]'), 'Updating…', async () => {
      const d = await api('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ email: resetEmail, otp, password: f.get('password') }) });
      clearInterval(resendTimer);
      e.currentTarget.reset();
      showView('login');
      $('#loginForm [name=email]').value = resetEmail;
      message(d.message || 'Password updated. Please sign in.');
    });
  } catch (err) { message(err.message, true); }
});

/* ------------------------------------------------------------------ session / shell */
const examPathMatch = location.pathname.match(/^\/exam\/([^/]+)/);

function afterLogin(data) {
  if (examPathMatch) { currentUser = data.user; loadExamPage(decodeURIComponent(examPathMatch[1])); }
  else showDashboard(data);
}
function enterShell(user, roleLine) {
  currentUser = user;
  $('#auth').classList.add('hidden');
  $('#dashboard').classList.remove('hidden');
  $('#welcome').textContent = 'Welcome, ' + (user.name || 'there');
  $('#roleText').textContent = roleLine;
}
function showDashboard(data) {
  enterShell(data.user, (data.user.role === 'teacher' ? 'Teacher workspace' : 'Student workspace') + ' · Signed in securely');
  renderWorkspace('overview');
}
function logout() {
  localStorage.removeItem('iq_token');
  currentUser = null;
  activeExam = null;
  $('#dashboard').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  showView('login');
}
$('#logout').addEventListener('click', () => {
  if (activeExam && !confirm('Your exam is still running. Signing out will NOT stop the timer. Sign out anyway?')) return;
  logout();
});

function shell(content, nav, role) {
  return '<div class="iq-shell"><aside class="iq-side"><div class="iq-side-brand">INTELLIQUIZ <small>' + role + ' PORTAL</small></div>' + nav + '</aside><section class="iq-main">' + content + '</section></div>';
}
const navButton = (id, label, active) => '<button class="iq-nav ' + (active ? 'active' : '') + '" data-page="' + id + '">' + label + '</button>';
function workspaceNotice(text, isError = false) {
  const root = $('#dashboardContent');
  if (!root) return;
  let box = $('#iq-action-notice');
  if (!box) { box = document.createElement('div'); box.id = 'iq-action-notice'; box.className = 'iq-action-notice'; root.prepend(box); }
  box.textContent = text;
  box.classList.toggle('error', isError);
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ------------------------------------------------------------------ teacher pages */
const QUESTION_RULES_HTML = '<div class="iq-rules"><b>Question rules</b><ul>' +
  '<li>Question text: 5–3000 characters. The same question text cannot be added twice.</li>' +
  '<li>Exactly <b>4 different options</b> (A, B, C, D), each up to 500 characters, and exactly <b>one correct answer</b>.</li>' +
  '<li><b>Marks</b>: 0.25 to 100 (steps of 0.25). Default is 1.</li>' +
  '<li><b>Negative marks</b>: 0 up to the question marks. Deducted only for a <i>wrong</i> answer; an unanswered question scores 0. The final score never goes below 0.</li>' +
  '<li>Once a question is in a <b>published</b> exam, its options, correct answer and marks cannot be changed and it cannot be deleted.</li></ul></div>';

function questionFormHtml() {
  return '<form id="addQuestionForm" class="iq-form"><input type="hidden" name="questionId" value="">' +
    '<label>Question text<textarea name="text" rows="3" required minlength="5" maxlength="3000" placeholder="Write your question…"></textarea></label>' +
    '<div class="iq-options">' + ['A', 'B', 'C', 'D'].map(v => '<label>Option ' + v + '<input name="option' + v + '" required maxlength="500"></label>').join('') + '</div>' +
    '<div class="iq-options"><label>Correct answer<select name="correctOption"><option>A</option><option>B</option><option>C</option><option>D</option></select></label>' +
    '<label>Difficulty<select name="difficulty"><option value="easy">Easy</option><option value="medium" selected>Medium</option><option value="hard">Hard</option></select></label></div>' +
    '<div class="iq-options"><label>Marks<input name="marks" type="number" min="0.25" max="100" step="0.25" value="1" required></label>' +
    '<label>Negative marks (wrong answer)<input name="negativeMarks" type="number" min="0" max="100" step="0.25" value="0" required></label></div>' +
    '<label>Topic (optional)<input name="topic" maxlength="100" placeholder="e.g. Arrays"></label>' +
    '<label>Explanation (optional, for your reference)<textarea name="explanation" rows="2" maxlength="1000"></textarea></label>' +
    '<div class="iq-actions"><button class="primary" type="submit" id="saveQuestionButton">Save question</button><button class="secondary" type="button" id="cancelQuestionEdit" data-cancel-question hidden>Cancel edit</button></div></form>';
}
function questionCardHtml(q, i) {
  return '<article class="iq-question"><div><small>QUESTION ' + (i + 1) + '</small><p>' + esc(q.text) + '</p>' +
    '<div class="iq-muted">' + q.options.map((o, j) => '<span>' + String.fromCharCode(65 + j) + '. ' + esc(o) + '</span>').join(' · ') + '</div>' +
    '<div class="iq-chips"><b class="iq-correct">Correct: ' + q.correctOption + '</b><span class="iq-chip">+' + fmtNum(q.marks) + ' marks</span>' +
    (q.negativeMarks ? '<span class="iq-chip neg">−' + fmtNum(q.negativeMarks) + ' wrong</span>' : '') +
    '<span class="iq-chip">' + esc(q.difficulty) + '</span>' + (q.topic ? '<span class="iq-chip">' + esc(q.topic) + '</span>' : '') + '</div></div>' +
    '<div class="iq-actions"><button class="secondary iq-small" data-edit-question="' + q.id + '">Edit</button><button class="iq-danger" data-delete-question="' + q.id + '">Delete</button></div></article>';
}
function createExamHtml() {
  const qs = dashCache.questions;
  return '<div class="iq-page-head"><div><span class="eyebrow">ASSESSMENT BUILDER</span><h2>Create an exam</h2><p class="muted">Pick questions from your bank, set the timer and rules, then publish.</p></div></div>' +
    '<div class="iq-panel"><form id="createExamForm" class="iq-form">' +
    '<label>Exam title<input name="title" required minlength="3" maxlength="180" placeholder="e.g. Data Structures — Unit Test 1"></label>' +
    '<label>Description / instructions (optional)<textarea name="description" rows="2" maxlength="3000"></textarea></label>' +
    '<div class="iq-options"><label>Duration (minutes)<input name="durationMinutes" type="number" min="1" max="600" value="30" required></label><label>Maximum attempts per student<input name="maxAttempts" type="number" min="1" max="20" value="1" required></label></div>' +
    '<div class="iq-options"><label>Passing percentage<input name="passingPercentage" type="number" min="0" max="100" value="40" required></label><label>&nbsp;<span class="iq-check iq-inline"><input type="checkbox" name="tabSwitchAutoSubmit" checked><span>Auto-submit if the student switches tab / window</span></span></label></div>' +
    '<div class="iq-options"><label>Starts at (optional)<input name="startsAt" type="datetime-local"></label><label>Ends at (optional)<input name="endsAt" type="datetime-local"></label></div>' +
    '<h3>Select questions</h3><div class="iq-select-questions">' +
    (qs.length ? qs.map(q => '<label class="iq-check"><input type="checkbox" name="questionIds" value="' + q.id + '"><span>' + esc(q.text) + ' <small class="iq-muted">(+' + fmtNum(q.marks) + (q.negativeMarks ? ' / −' + fmtNum(q.negativeMarks) : '') + ')</small></span></label>').join('') : '<p class="muted">Your question bank is empty. Add questions first.</p>') +
    '</div><p class="iq-muted" id="examPickSummary">0 questions selected · 0 total marks</p>' +
    '<button class="primary" ' + (!qs.length ? 'disabled' : '') + '>Save exam as draft</button></form></div>';
}
function examCardHtml(e) {
  const link = e.publicToken ? location.origin + '/exam/' + e.publicToken : '';
  return '<article class="iq-exam-card"><div class="iq-exam-top"><div><h3>' + esc(e.title) + '</h3><p class="muted">' + esc(e.description || 'No description') + '</p></div><span class="iq-status ' + e.status + '">' + e.status + '</span></div>' +
    '<div class="iq-muted">' + e.questionCount + ' questions · ' + fmtNum(e.totalMarks) + ' marks · ' + e.durationMinutes + ' min · ' + e.maxAttempts + ' attempt(s) · pass ' + fmtNum(e.passingPercentage) + '% · ' + (e.tabSwitchAutoSubmit ? 'tab-switch auto-submit ON' : 'tab-switch auto-submit off') + '</div>' +
    (e.startsAt || e.endsAt ? '<div class="iq-muted">Window: ' + fmtDate(e.startsAt) + ' → ' + fmtDate(e.endsAt) + '</div>' : '') +
    (link ? '<div class="iq-share"><input readonly value="' + esc(link) + '"><button class="secondary" data-copy="' + esc(link) + '">Copy link</button></div>' : '') +
    '<div class="iq-actions">' +
    (e.status === 'draft' ? '<button class="primary iq-small" data-publish="' + e.id + '">Publish exam</button><button class="iq-danger" data-delete-exam="' + e.id + '">Delete draft</button>'
      : e.status === 'published' ? '<button class="secondary iq-small" data-close-exam="' + e.id + '">Close exam</button>' : '<span class="iq-muted">This exam is closed</span>') +
    '<button class="secondary iq-small" data-results="' + e.id + '">View results</button><button class="secondary iq-small" data-export-results="' + e.id + '">Export CSV</button></div><div id="results-' + e.id + '"></div></article>';
}

/* ------------------------------------------------------------------ student pages */
function studentExamCardHtml(e) {
  const now = Date.now();
  const upcoming = e.startsAt && new Date(e.startsAt).getTime() > now;
  const ended = e.endsAt && new Date(e.endsAt).getTime() <= now;
  const label = upcoming ? 'Starts ' + fmtDate(e.startsAt) : ended ? 'Ended' : 'Open exam →';
  return '<article class="iq-exam-card"><div class="iq-exam-top"><div><h3>' + esc(e.title) + '</h3><p class="muted">' + esc(e.description || 'No additional instructions.') + '</p></div><span class="iq-status published">Published</span></div>' +
    '<div class="iq-muted">' + e.questionCount + ' questions · ' + fmtNum(e.totalMarks) + ' marks · ' + e.durationMinutes + ' minutes · ' + e.maxAttempts + ' attempt(s) · pass ' + fmtNum(e.passingPercentage) + '%</div>' +
    '<button class="primary iq-small" data-start-exam="' + esc(e.publicToken || '') + '" ' + (!e.publicToken || upcoming || ended ? 'disabled' : '') + '>' + label + '</button></article>';
}
function resultCardHtml(r) {
  return '<article class="iq-exam-card"><div class="iq-exam-top"><h3>' + esc(r.examTitle) + '</h3>' + (r.passed === null ? '' : '<span class="iq-status ' + (r.passed ? 'published' : 'failed') + '">' + (r.passed ? 'Passed' : 'Not passed') + '</span>') + '</div>' +
    '<div class="iq-stats compact"><article><small>Score</small><b>' + fmtNum(r.score) + '/' + fmtNum(r.totalMarks) + '</b></article><article><small>Percentage</small><b>' + fmtNum(r.percentage) + '%</b></article><article><small>Submitted</small><b class="iq-date">' + esc(fmtDate(r.submittedAt)) + '</b></article></div>' +
    '<div class="iq-muted">' + (r.correctCount === null ? '' : r.correctCount + ' correct · ' + r.wrongCount + ' wrong · ' + r.unansweredCount + ' unanswered · ') + esc(REASON_LABEL[r.submitReason] || '') + '</div></article>';
}

async function renderWorkspace(page = 'overview') {
  const root = $('#dashboardContent');
  if (!root || !currentUser) return;
  try {
    if (currentUser.role === 'teacher') {
      const [summary, qs, es] = await Promise.all([api('/api/dashboard/summary'), api('/api/questions'), api('/api/exams')]);
      dashCache = { questions: qs.questions || [], exams: es.exams || [], results: [] };
      const nav = navButton('overview', 'Overview', page === 'overview') + navButton('questions', 'Question bank', page === 'questions') + navButton('create-exam', 'Create exam', page === 'create-exam') + navButton('exams', 'Manage exams', page === 'exams');
      let content = '';
      if (page === 'overview') {
        content = '<div class="iq-page-head"><div><span class="eyebrow">TEACHER CONSOLE</span><h2>Teaching overview</h2><p class="muted">Create assessments, organise questions and review student performance.</p></div><button class="primary iq-small" data-page="create-exam">＋ Create exam</button></div>' +
          '<div class="iq-stats"><article><small>Total students</small><b>' + summary.students + '</b></article><article><small>Your questions</small><b>' + summary.questions + '</b></article><article><small>Exam submissions</small><b>' + summary.attempts + '</b></article></div>' +
          '<div class="iq-panel"><h3>Quick actions</h3><div class="iq-actions"><button class="secondary" data-page="questions">＋ Add questions</button><button class="secondary" data-page="exams">Manage assessments</button></div></div>';
      } else if (page === 'questions') {
        content = '<div class="iq-page-head"><div><span class="eyebrow">QUESTION LIBRARY</span><h2>Question bank</h2><p class="muted">Questions you create are private to your teacher account.</p></div></div>' +
          '<div class="iq-panel"><h3 id="questionFormTitle">Add a question</h3>' + QUESTION_RULES_HTML + questionFormHtml() + '</div>' +
          '<div class="iq-panel"><h3>Your questions (' + dashCache.questions.length + ')</h3>' + (dashCache.questions.length ? dashCache.questions.map(questionCardHtml).join('') : '<p class="muted">No questions yet. Add your first question above.</p>') + '</div>';
      } else if (page === 'create-exam') {
        content = createExamHtml();
      } else if (page === 'exams') {
        content = '<div class="iq-page-head"><div><span class="eyebrow">ASSESSMENT MANAGEMENT</span><h2>Your exams</h2><p class="muted">Publish exams and share the secure exam link with students.</p></div><button class="primary iq-small" data-page="create-exam">＋ Create exam</button></div>' +
          (dashCache.exams.length ? dashCache.exams.map(examCardHtml).join('') : '<div class="iq-panel"><p class="muted">No exams created yet. Create your first assessment.</p><button class="primary" data-page="create-exam">Create exam</button></div>');
      }
      root.innerHTML = shell(content, nav, 'TEACHER');
    } else {
      const [es, rs] = await Promise.all([api('/api/exams'), api('/api/exams/results/mine')]);
      dashCache = { questions: [], exams: es.exams || [], results: rs.results || [] };
      const nav = navButton('overview', 'My learning', page === 'overview') + navButton('results', 'My results', page === 'results');
      const content = page === 'results'
        ? '<div class="iq-page-head"><div><span class="eyebrow">PERFORMANCE</span><h2>My results</h2><p class="muted">Your submitted assessments and scores.</p></div></div>' + (dashCache.results.length ? dashCache.results.map(resultCardHtml).join('') : '<div class="iq-panel"><p class="muted">No submitted exam results yet.</p></div>')
        : '<div class="iq-page-head"><div><span class="eyebrow">STUDENT PORTAL</span><h2>Available assessments</h2><p class="muted">Open an exam, read the rules, then start. The timer runs on the server.</p></div></div>' + (dashCache.exams.length ? dashCache.exams.map(studentExamCardHtml).join('') : '<div class="iq-panel"><p class="muted">No published assessments are available right now. Check again later.</p></div>');
      root.innerHTML = shell(content, nav, 'STUDENT');
    }
  } catch (e) {
    if (e.status === 401) { message('Session expired. Please sign in again.', true); logout(); return; }
    root.innerHTML = '<div class="iq-panel"><h3>Could not load workspace</h3><p class="muted">' + esc(e.message) + '</p><button class="secondary" data-page="overview">Try again</button></div>';
  }
}

/* ------------------------------------------------------------------ teacher actions (delegated clicks) */
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  return '"' + s.replace(/"/g, '""') + '"';
}
function resultsRowHtml(x) {
  return '<div class="iq-result-row"><span><b>' + esc(x.student) + '</b><small>' + esc(x.email) + ' · ' + esc(x.rollNumber) + '</small><small>' + esc(REASON_LABEL[x.submitReason] || '') + ' · ' + (x.correctCount === null ? '' : x.correctCount + ' correct, ' + x.wrongCount + ' wrong, ' + x.unansweredCount + ' skipped') + '</small></span><strong>' + fmtNum(x.score) + '/' + fmtNum(x.totalMarks) + ' (' + fmtNum(x.percentage) + '%) ' + (x.passed === null ? '' : x.passed ? '✔' : '✘') + '</strong></div>';
}

document.addEventListener('click', async e => {
  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;
  const stop = () => { e.preventDefault(); e.stopPropagation(); };

  const nav = target.closest('[data-page]');
  if (nav) { stop(); await renderWorkspace(nav.dataset.page); return; }

  if (target.closest('[data-home]')) { stop(); location.href = '/'; return; }

  const edit = target.closest('[data-edit-question]')?.dataset.editQuestion;
  if (edit) {
    stop();
    const q = dashCache.questions.find(x => x.id === edit), form = $('#addQuestionForm');
    if (q && form) {
      form.elements.questionId.value = q.id;
      form.elements.text.value = q.text;
      q.options.forEach((v, i) => { form.elements['option' + String.fromCharCode(65 + i)].value = v; });
      form.elements.correctOption.value = q.correctOption;
      form.elements.marks.value = q.marks;
      form.elements.negativeMarks.value = q.negativeMarks;
      form.elements.difficulty.value = q.difficulty;
      form.elements.topic.value = q.topic || '';
      form.elements.explanation.value = q.explanation || '';
      $('#questionFormTitle').textContent = 'Edit question';
      $('#saveQuestionButton').textContent = 'Update question';
      $('#cancelQuestionEdit').hidden = false;
      form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    return;
  }
  if (target.closest('[data-cancel-question]')) {
    stop();
    const form = $('#addQuestionForm');
    if (form) { form.reset(); form.elements.questionId.value = ''; $('#questionFormTitle').textContent = 'Add a question'; $('#saveQuestionButton').textContent = 'Save question'; $('#cancelQuestionEdit').hidden = true; }
    return;
  }
  const del = target.closest('[data-delete-question]')?.dataset.deleteQuestion;
  if (del) {
    stop();
    if (!confirm('Delete this question from your question bank?')) return;
    try { await api('/api/questions/' + encodeURIComponent(del), { method: 'DELETE' }); await renderWorkspace('questions'); workspaceNotice('Question deleted successfully.'); }
    catch (err) { workspaceNotice(err.message, true); }
    return;
  }
  const pub = target.closest('[data-publish]')?.dataset.publish;
  if (pub) {
    stop();
    try { await api('/api/exams/' + encodeURIComponent(pub) + '/publish', { method: 'POST', body: '{}' }); await renderWorkspace('exams'); workspaceNotice('Exam published. You can now copy and share its link.'); }
    catch (err) { workspaceNotice(err.message, true); }
    return;
  }
  const delExam = target.closest('[data-delete-exam]')?.dataset.deleteExam;
  if (delExam) {
    stop();
    if (!confirm('Delete this draft exam?')) return;
    try { await api('/api/exams/' + encodeURIComponent(delExam), { method: 'DELETE' }); await renderWorkspace('exams'); workspaceNotice('Draft exam deleted.'); }
    catch (err) { workspaceNotice(err.message, true); }
    return;
  }
  const closeId = target.closest('[data-close-exam]')?.dataset.closeExam;
  if (closeId) {
    stop();
    if (!confirm('Close this exam? Students will no longer be able to start it.')) return;
    try { await api('/api/exams/' + encodeURIComponent(closeId) + '/close', { method: 'PATCH', body: '{}' }); await renderWorkspace('exams'); workspaceNotice('Exam closed.'); }
    catch (err) { workspaceNotice(err.message, true); }
    return;
  }
  const copy = target.closest('[data-copy]')?.dataset.copy;
  if (copy) {
    stop();
    try { await navigator.clipboard.writeText(copy); workspaceNotice('Exam link copied.'); }
    catch (_) { workspaceNotice('Copy this link: ' + copy, true); }
    return;
  }
  const resultId = target.closest('[data-results]')?.dataset.results;
  if (resultId) {
    stop();
    try {
      const d = await api('/api/exams/' + encodeURIComponent(resultId) + '/results');
      const slot = $('#results-' + resultId);
      if (!slot) throw new Error('Results area is not available. Refresh the page.');
      slot.innerHTML = '<div class="iq-results"><h4>Student submissions (' + d.results.length + ')</h4>' + (d.results.length ? d.results.map(resultsRowHtml).join('') : '<p class="muted">No submissions yet.</p>') + '</div>';
    } catch (err) { workspaceNotice(err.message, true); }
    return;
  }
  const exportId = target.closest('[data-export-results]')?.dataset.exportResults;
  if (exportId) {
    stop();
    try {
      const d = await api('/api/exams/' + encodeURIComponent(exportId) + '/results');
      const rows = [['Student', 'Email', 'Roll number', 'Score', 'Total marks', 'Percentage', 'Passed', 'Correct', 'Wrong', 'Unanswered', 'Submit reason', 'Duration seconds', 'Submitted at'],
        ...d.results.map(x => [x.student, x.email, x.rollNumber, x.score, x.totalMarks, x.percentage, x.passed === null ? '' : x.passed ? 'Yes' : 'No', x.correctCount ?? '', x.wrongCount ?? '', x.unansweredCount ?? '', REASON_LABEL[x.submitReason] || x.submitReason, x.durationSeconds, x.submittedAt])];
      const csv = rows.map(row => row.map(csvCell).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url; a.download = 'intelliquiz-results-' + exportId + '.csv';
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      workspaceNotice('Results CSV downloaded.');
    } catch (err) { workspaceNotice(err.message, true); }
    return;
  }
  const examToken = target.closest('[data-start-exam]')?.dataset.startExam;
  if (examToken) { stop(); location.href = '/exam/' + encodeURIComponent(examToken); }
});

// live "N questions · M marks" summary while a teacher ticks questions
document.addEventListener('change', e => {
  if (!(e.target instanceof Element) || !e.target.matches('#createExamForm [name=questionIds]')) return;
  const ids = new Set([...document.querySelectorAll('#createExamForm [name=questionIds]:checked')].map(i => i.value));
  const picked = dashCache.questions.filter(q => ids.has(q.id));
  $('#examPickSummary').textContent = picked.length + ' question(s) selected · ' + fmtNum(picked.reduce((t, q) => t + Number(q.marks || 1), 0)) + ' total marks';
});

/* ------------------------------------------------------------------ teacher forms: add / edit question, create exam */
document.addEventListener('submit', async e => {
  const form = e.target;
  if (!(form instanceof HTMLFormElement) || (form.id !== 'addQuestionForm' && form.id !== 'createExamForm')) return;
  e.preventDefault();
  const button = form.querySelector('[type="submit"]');
  try {
    await withBusy(button, form.id === 'addQuestionForm' ? 'Saving question…' : 'Creating exam…', async () => {
      const f = new FormData(form);
      if (form.id === 'addQuestionForm') {
        const options = ['A', 'B', 'C', 'D'].map(x => String(f.get('option' + x) || '').trim());
        const text = String(f.get('text') || '').trim();
        const marks = Number(f.get('marks')), negativeMarks = Number(f.get('negativeMarks'));
        if (text.length < 5) throw new Error('Question text must be at least 5 characters.');
        if (options.some(x => !x)) throw new Error('Please fill all four options.');
        if (new Set(options.map(x => x.toLowerCase())).size !== 4) throw new Error('Options must be different from each other.');
        if (!(marks >= 0.25 && marks <= 100)) throw new Error('Marks must be between 0.25 and 100.');
        if (!(negativeMarks >= 0) || negativeMarks > marks) throw new Error('Negative marks must be 0 or more, and not more than the marks.');
        const id = String(f.get('questionId') || '');
        await api(id ? '/api/questions/' + encodeURIComponent(id) : '/api/questions', {
          method: id ? 'PATCH' : 'POST',
          body: JSON.stringify({ text, options, correctOption: f.get('correctOption'), marks, negativeMarks, difficulty: f.get('difficulty'), topic: String(f.get('topic') || '').trim(), explanation: String(f.get('explanation') || '').trim() })
        });
        await renderWorkspace('questions');
        workspaceNotice(id ? 'Question updated successfully.' : 'Question added successfully.');
      } else {
        const questionIds = f.getAll('questionIds');
        if (!questionIds.length) throw new Error('Select at least one question before creating the exam.');
        const startRaw = String(f.get('startsAt') || ''), endRaw = String(f.get('endsAt') || '');
        const start = startRaw ? new Date(startRaw) : null, end = endRaw ? new Date(endRaw) : null;
        if ((start && !Number.isFinite(start.getTime())) || (end && !Number.isFinite(end.getTime()))) throw new Error('Please enter valid exam dates.');
        if (start && end && end <= start) throw new Error('Exam end time must be after its start time.');
        await api('/api/exams', {
          method: 'POST',
          body: JSON.stringify({
            title: String(f.get('title') || '').trim(), description: String(f.get('description') || ''),
            durationMinutes: Number(f.get('durationMinutes')), maxAttempts: Number(f.get('maxAttempts')),
            passingPercentage: Number(f.get('passingPercentage')), tabSwitchAutoSubmit: f.get('tabSwitchAutoSubmit') === 'on',
            questionIds, startsAt: start ? start.toISOString() : null, endsAt: end ? end.toISOString() : null
          })
        });
        await renderWorkspace('exams');
        workspaceNotice('Exam saved as draft. Publish it below and share the link.');
      }
    });
  } catch (err) { workspaceNotice(err.message || 'The action could not be completed.', true); }
});

/* ------------------------------------------------------------------ student: exam page (rules -> exam -> result) */
const examNotice = (title, text, withHome = true) =>
  '<div class="iq-panel"><h2>' + esc(title) + '</h2><p class="muted">' + esc(text) + '</p>' + (withHome ? '<button class="secondary" data-home>Return to portal</button>' : '') + '</div>';

function resultScreenHtml(result, reason) {
  const banner = reason === 'tab_switch'
    ? '<div class="iq-banner warn">Your exam was submitted automatically because you left the exam tab or window.</div>'
    : reason === 'time_up' ? '<div class="iq-banner warn">Time is up. Your exam was submitted automatically.</div>' : '';
  return '<div class="iq-panel iq-result-final">' + banner + '<span class="eyebrow">ASSESSMENT COMPLETE</span><h2>Your exam has been submitted.</h2>' +
    '<div class="iq-score">' + fmtNum(result.score) + ' / ' + fmtNum(result.totalMarks) + '</div><h3>' + fmtNum(result.percentage) + '% · ' + (result.passed ? 'Passed' : 'Not passed') + '</h3>' +
    '<p class="muted">' + result.correctCount + ' correct · ' + result.wrongCount + ' wrong · ' + result.unansweredCount + ' unanswered</p>' +
    '<p class="muted">Your result has been saved. You can find it in My results.</p><button class="primary" data-home>Back to portal</button></div>';
}

async function loadExamPage(token) {
  const root = $('#dashboardContent');
  enterShell(currentUser || { name: '' }, 'Exam session');
  root.innerHTML = '<div class="iq-panel"><p class="muted">Loading exam…</p></div>';
  try {
    if (!currentUser || !currentUser.role) { const me = await api('/api/auth/me'); currentUser = me.user; enterShell(currentUser, 'Exam session'); }
    if (currentUser.role !== 'student') throw Object.assign(new Error('Only student accounts can attempt an exam. Sign out and log in with a student account.'), { handled: true });
    const meta = await api('/api/exams/public/' + encodeURIComponent(token));
    const exam = meta.exam;
    if (exam.notStarted) { root.innerHTML = examNotice('Exam has not started yet', 'This exam opens on ' + fmtDate(exam.startsAt) + '.'); return; }
    if (exam.ended) { root.innerHTML = examNotice('Exam has ended', 'The exam window closed on ' + fmtDate(exam.endsAt) + '.'); return; }
    const outOfAttempts = !exam.hasActiveAttempt && exam.attemptsUsed >= exam.maxAttempts;
    const last = meta.lastResult;
    root.innerHTML = '<div class="iq-exam-run"><div class="iq-page-head"><div><span class="eyebrow">EXAM RULES</span><h2>' + esc(exam.title) + '</h2><p class="muted">' + esc(exam.description || 'Read the rules carefully before you start.') + '</p></div></div>' +
      '<div class="iq-panel"><div class="iq-stats compact"><article><small>Questions</small><b>' + exam.questionCount + '</b></article><article><small>Total marks</small><b>' + fmtNum(exam.totalMarks) + '</b></article><article><small>Time</small><b>' + exam.durationMinutes + ' min</b></article></div>' +
      '<ul class="iq-rule-list">' +
      '<li>The timer starts when you press <b>Start</b> and is kept by the server. When it reaches zero your exam is <b>submitted automatically</b>.</li>' +
      (exam.tabSwitchAutoSubmit ? '<li class="danger"><b>Do not switch tabs, windows or apps, and do not minimise the browser.</b> The moment you leave this tab your exam is <b>submitted automatically</b>.</li>' : '') +
      '<li>Answers are saved automatically. If the page is refreshed you continue the same attempt and the timer keeps running.</li>' +
      '<li>Each question shows its marks. A wrong answer may lose negative marks (shown on the question). Unanswered questions score 0.</li>' +
      '<li>You need <b>' + fmtNum(exam.passingPercentage) + '%</b> to pass. Attempts used: <b>' + exam.attemptsUsed + ' / ' + exam.maxAttempts + '</b>.</li></ul>' +
      (last ? '<div class="iq-muted">Your last result: <b>' + fmtNum(last.score) + '/' + fmtNum(last.totalMarks) + ' (' + fmtNum(last.percentage) + '%)</b></div>' : '') +
      (outOfAttempts ? '<div class="iq-banner warn">You have used all attempts for this exam.</div><button class="secondary" data-home>Return to portal</button>'
        : (exam.hasActiveAttempt ? '<div class="iq-banner warn">You have an attempt in progress. Its timer is still running.</div>' : '') +
          '<label class="iq-check iq-inline"><input type="checkbox" id="agreeRules"><span>I have read and understood the rules.</span></label><button class="primary" id="startExamBtn" disabled>' + (exam.hasActiveAttempt ? 'Resume exam →' : 'Start exam →') + '</button>') +
      '</div></div>';
    const agree = $('#agreeRules'), startBtn = $('#startExamBtn');
    if (!startBtn) return;
    agree.addEventListener('change', () => { startBtn.disabled = !agree.checked; });
    startBtn.addEventListener('click', async () => {
      try {
        await withBusy(startBtn, 'Starting…', async () => {
          const data = await api('/api/exams/' + encodeURIComponent(exam.id) + '/start', { method: 'POST', body: '{}' });
          runExam(exam, data);
        });
      } catch (err) { root.insertAdjacentHTML('afterbegin', '<div class="iq-banner warn">' + esc(err.message) + '</div>'); }
    });
  } catch (err) {
    if (err.status === 401) { message('Please sign in with your student account to attempt this exam.', true); logout(); return; }
    root.innerHTML = examNotice('Unable to open exam', err.status === 403 && !err.handled ? 'Only student accounts can attempt an exam. Sign out and log in with a student account.' : err.message);
  }
}

function runExam(exam, data) {
  const root = $('#dashboardContent');
  const attempt = data.attempt, questions = data.questions || [];
  const guardTabs = data.rules ? data.rules.tabSwitchAutoSubmit : exam.tabSwitchAutoSubmit;
  const answers = { ...(attempt.answers || {}) };
  const clockOffset = data.serverTime ? new Date(data.serverTime).getTime() - Date.now() : 0; // server time - local time
  const deadline = new Date(attempt.expiresAt).getTime();
  let saving = Promise.resolve(), finished = false, dialogOpen = false, tickTimer = null;
  const letter = j => String.fromCharCode(65 + j);

  activeExam = { id: exam.id, attemptId: attempt.id };
  root.innerHTML = '<div class="iq-exam-run"><div class="iq-page-head iq-run-head"><div><span class="eyebrow">SECURE ASSESSMENT</span><h2>' + esc(exam.title) + '</h2></div><div class="iq-clock" id="examClock">--:--</div></div>' +
    (guardTabs ? '<div class="iq-banner warn">Stay on this tab. Leaving it submits your exam automatically.</div>' : '') +
    '<div class="iq-panel"><div class="iq-muted">' + questions.length + ' questions · ' + fmtNum(exam.totalMarks) + ' marks · Answered <b id="answeredCount">0</b>/' + questions.length + ' · <span id="saveState">All answers saved</span></div></div>' +
    questions.map((q, i) => '<article class="iq-panel iq-run-question"><small>QUESTION ' + (i + 1) + ' OF ' + questions.length + ' · +' + fmtNum(q.marks) + (q.negativeMarks ? ' / −' + fmtNum(q.negativeMarks) + ' if wrong' : '') + '</small><h3>' + esc(q.text) + '</h3>' +
      q.options.map((o, j) => '<label class="iq-answer"><input type="radio" name="q-' + q.id + '" value="' + letter(j) + '" ' + (answers[q.id] === letter(j) ? 'checked' : '') + '><span><b>' + letter(j) + '.</b> ' + esc(o) + '</span></label>').join('') + '</article>').join('') +
    '<button class="primary" id="submitExam">Submit exam</button></div>';

  const updateCount = () => { const c = $('#answeredCount'); if (c) c.textContent = Object.keys(answers).length; };
  updateCount();

  const setSave = text => { const s = $('#saveState'); if (s) s.textContent = text; };
  const save = () => {
    setSave('Saving…');
    saving = saving.then(() => api('/api/exams/' + exam.id + '/attempt/' + attempt.id, { method: 'PATCH', body: JSON.stringify({ answers }) }))
      .then(() => setSave('All answers saved'))
      .catch(err => { if (err.status === 410) { submitExam('time_up'); return; } setSave('Save failed — check connection'); console.error(err); });
  };

  async function submitExam(reason) {
    if (finished) return;
    finished = true;
    clearInterval(tickTimer);
    removeGuards();
    const btn = $('#submitExam');
    if (btn) btn.disabled = true;
    try {
      // keepalive lets the request finish even if the tab is being hidden or closed.
      const out = await api('/api/exams/' + exam.id + '/attempt/' + attempt.id + '/submit', { method: 'POST', keepalive: true, body: JSON.stringify({ reason, answers }) });
      activeExam = null;
      root.innerHTML = resultScreenHtml(out.result, out.result.submitReason || reason);
    } catch (err) {
      activeExam = null;
      root.innerHTML = examNotice('Submission failed', err.message + ' Open the exam link again — your saved answers are kept and are graded automatically when time ends.');
    }
  }

  const tick = () => {
    const remaining = Math.max(0, Math.ceil((deadline - (Date.now() + clockOffset)) / 1000));
    const clock = $('#examClock');
    if (clock) {
      clock.textContent = Math.floor(remaining / 60) + ':' + String(remaining % 60).padStart(2, '0');
      clock.classList.toggle('low', remaining <= 60);
    }
    if (remaining === 0) submitExam('time_up');
  };
  tickTimer = setInterval(tick, 1000);
  tick();

  // ---- tab switch / window leave => auto submit
  const onHidden = () => { if (document.visibilityState === 'hidden' && !dialogOpen) submitExam('tab_switch'); };
  let blurTimer = null;
  const onBlur = () => {
    clearTimeout(blurTimer);
    // small delay so our own confirm() dialog or a quick focus flicker does not count
    blurTimer = setTimeout(() => { if (!dialogOpen && !finished && !document.hasFocus()) submitExam('tab_switch'); }, 500);
  };
  const onFocus = () => clearTimeout(blurTimer);
  function removeGuards() {
    document.removeEventListener('visibilitychange', onHidden);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('focus', onFocus);
    clearTimeout(blurTimer);
  }
  if (guardTabs) {
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
  }

  root.addEventListener('change', ev => {
    if (finished || !ev.target.matches('.iq-answer input')) return;
    answers[ev.target.name.slice(2)] = ev.target.value;
    updateCount();
    save();
  });
  $('#submitExam').addEventListener('click', () => {
    if (finished) return;
    const left = questions.length - Object.keys(answers).length;
    dialogOpen = true;
    const ok = confirm((left ? 'You have ' + left + ' unanswered question(s). ' : '') + 'Submit your exam now? You cannot change answers after submitting.');
    setTimeout(() => { dialogOpen = false; }, 600);
    if (ok) submitExam('manual');
  });
}

/* ------------------------------------------------------------------ boot */
(function boot() {
  const token = localStorage.getItem('iq_token');
  if (examPathMatch) {
    if (token) loadExamPage(decodeURIComponent(examPathMatch[1]));
    else { showView('login'); message('Please sign in with your student account to attempt this exam.', true); }
  } else if (token) {
    api('/api/auth/me').then(showDashboard).catch(err => {
      localStorage.removeItem('iq_token');
      message('Session verification failed: ' + (err.message || 'Please sign in again.'), true);
    });
  }
})();

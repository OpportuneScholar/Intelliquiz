# IntelliQuiz Backend (MongoDB Atlas)

Node.js/Express API using MongoDB Atlas through Mongoose. PostgreSQL is no longer used by the active backend.

## Run locally
1. Copy `.env.example` to `.env`.
2. Set `MONGODB_URI` to your MongoDB Atlas connection string. Replace the username/password placeholders and ensure the URI targets the `intelliquiz` database.
3. Set `JWT_SECRET` to a random secret of at least 32 characters.
4. For email OTP (teacher signup + forgot password) set `RESEND_API_KEY` and a verified `MAIL_FROM`. In development you can leave `RESEND_API_KEY` empty: the OTP is printed in the server console. Note: with the default `onboarding@resend.dev` sender, Resend only delivers to your own account email — verify a domain to email everyone.
5. Run `npm install`, then `npm start` from this `backend` directory.

## API
- `GET /api/health` — API/database status
- `POST /api/auth/register` — student registration (no OTP)
- `POST /api/auth/login` — student/teacher login (email + password, no OTP)
- `POST /api/auth/forgot-password` — email a 6-digit OTP (valid 10 min, 60 s resend cooldown)
- `POST /api/auth/reset-password` — `{ email, otp, password }`; max 5 wrong OTPs; signs out old sessions
- `GET /api/auth/me` — current account (Bearer token)
- `POST /api/teacher-registration/request-otp` / `verify-otp` — teacher signup with email OTP
- `/api/questions` — teacher question bank. Rules: text 5–3000 chars, exactly 4 different options, one correct answer, `marks` 0.25–100 (step 0.25), `negativeMarks` 0…marks, difficulty, topic, explanation. No duplicate text. Options/answer/marks of a question in a *published* exam are locked and it cannot be deleted. `GET /api/questions/rules` returns the limits.
- `/api/exams` — teacher exam create (duration, attempts, passing %, tab-switch rule, window) / list / publish / close / delete draft / results
- `GET /api/exams/public/:token` — student: exam info + rules for the share link (no questions yet)
- `POST /api/exams/:id/start` — starts or resumes a server-timed attempt; returns questions (without answers) and server time
- `PATCH /api/exams/:id/attempt/:attemptId` — autosaves validated answers
- `POST /api/exams/:id/attempt/:attemptId/submit` — body `{ reason: manual|tab_switch|time_up, answers }`; graded on the server (marks, negative marks, pass/fail)

## Exam behaviour
- **Timer** is kept by the server (`expiresAt`). The browser counts down using the server clock offset and auto-submits at 0.
- **Tab switch / window blur / app switch** → the browser submits immediately (`reason: tab_switch`) when the exam has *tab-switch auto-submit* on (default on).
- **Student closes the tab or loses network** → a background job (every 30 s) auto-submits any attempt past its deadline using the saved answers.
- **Scoring**: `+marks` for correct, `−negativeMarks` for wrong, `0` for unanswered; the total never goes below 0.
- Browsers cannot be made fully tamper-proof; tab-switch detection is a deterrent, not proctoring.

## Tests
`npm test` (no database needed) — question rules, grading, auto-submit logic and a fake-DOM smoke test of the frontend.

## Deployment
For Voroa, use the backend directory as the app root if supported. Build command: `npm install`; start command: `npm start`. If the platform builds from repository root, use `cd backend && npm install` and start with `cd backend && npm start`. If logs say `npm: not found`, select/enable the Node.js runtime/build environment; changing the database does not fix that platform runtime issue.

Set these environment variables in the host dashboard, not in GitHub:
- `MONGODB_URI`
- `JWT_SECRET`
- `NODE_ENV=production`
- `CLIENT_ORIGIN` (the deployed frontend origin)
- `RESEND_API_KEY`
- `MAIL_FROM` (a sender verified in Resend)

## MongoDB Atlas setup
Create a database user with only the required database access where possible. Add the deployment host's outbound IP range to Network Access; only use `0.0.0.0/0` if required by the hosting platform and you understand it permits connections from any IP, with credentials still required. URL-encode special characters in the database password. Never commit real connection strings or API keys.

## Current limitations
Not yet verified against a live Atlas cluster or live Resend account (automated tests cover the logic, not the database/email). Tab-switch detection runs in the browser and cannot stop a determined cheater. Root-level `app.js`, `index.html`, `style.css` outside `backend/public/` are older copies and are not served — `backend/public/` is the live frontend.


## Per-student question order
Each new attempt receives a randomized question sequence. The sequence is stored on the attempt, so refreshing or resuming that attempt preserves the same order. Question numbers are presented sequentially by the frontend (Question 1, Question 2, ...); the answer options remain in their authored A–D order. Grading remains keyed by question ID, so changing display order does not change the answer key or marks.

## Exam audience fields
Exams now support a subject label and visibility modes: `all` (legacy/default), `class`, `selected`, or `both`. Class targeting can match course, branch, semester, and section; selected targeting uses student user IDs. The server checks eligibility both when listing exams and when opening/starting a shared exam link. Student profiles now include optional semester and section fields; older accounts remain compatible.

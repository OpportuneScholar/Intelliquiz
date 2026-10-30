# IntelliQuiz Backend (MongoDB Atlas)

Node.js/Express API using MongoDB Atlas through Mongoose. PostgreSQL is no longer used by the active backend.

## Run locally
1. Copy `.env.example` to `.env`.
2. Set `MONGODB_URI` to your MongoDB Atlas connection string. Replace the username/password placeholders and ensure the URI targets the `intelliquiz` database.
3. Set `JWT_SECRET` to a random secret of at least 32 characters.
4. Set `RESEND_API_KEY` and a verified `MAIL_FROM` sender for teacher email OTP.
5. Run `npm install`, then `npm start` from this `backend` directory.

## API
- `GET /api/health` — API/database status
- `POST /api/auth/register` — student registration
- `POST /api/auth/login` — student/teacher login
- `GET /api/auth/me` — current account (Bearer token)
- `POST /api/teacher-registration/request-otp` — send teacher email OTP
- `POST /api/teacher-registration/verify-otp` — verify OTP and create teacher
- `/api/questions` — teacher question management; student reads omit correct answers
- `/api/exams` — teacher exam create/list/publish/results; student exam listing and result history
- `POST /api/exams/:id/start` — starts or resumes a server-timed student attempt
- `GET /api/exams/:id/attempt/active` — restores the current attempt after refresh
- `PATCH /api/exams/:id/attempt/:attemptId` — autosaves validated student answers
- `POST /api/exams/:id/attempt/:attemptId/submit` — grades saved answers using server-side answer keys and server timestamps

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
This backend has not yet been verified against a live Atlas cluster or live Resend account. Exam submission currently checks attempt count but is not a transactional, server-timed attempt system; complete timed-attempt enforcement before using for high-stakes exams. The existing frontend files still need to be added/integrated with these APIs.

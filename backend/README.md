# IntelliQuiz SQL Backend (PostgreSQL)

## Requirements
- Node.js 20+
- PostgreSQL 14+ (local installation or hosted PostgreSQL)

## Setup
1. Create a PostgreSQL database named `intelliquiz`.
2. Run `schema.sql` against that database, then run `migrations/001_teacher_email_otp.sql`.
3. Copy `.env.example` to `.env` and set `DATABASE_URL`, a unique random `JWT_SECRET` (at least 32 characters), and Resend API key (`RESEND_API_KEY`) and sender (`MAIL_FROM`) so teacher OTP emails can be sent.
4. In this folder run `npm install`.
5. Run `npm run check` to validate JavaScript syntax.
6. Run `npm run seed:teacher` to create/update the teacher account.
7. Run `npm run dev`; test `GET http://localhost:5000/api/health`.

## Main endpoints
- `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`
- `POST /api/teacher-registration/request-otp` (name, email, password)
- `POST /api/teacher-registration/verify-otp` (email, six-digit otp)
- `GET/POST /api/questions`, `PATCH/DELETE /api/questions/:id`
- `GET/POST /api/exams`, `PATCH /api/exams/:id`
- `POST /api/exams/:id/submit`
- `GET /api/exams/:id/results` (teacher)
- `GET /api/exams/student/my-results` (student)
- `GET /api/dashboard/summary` (teacher)

Send `Authorization: Bearer <token>` for authenticated routes. Public `/api/auth/register` creates student accounts. Teachers can self-register only after email OTP verification using the teacher-registration endpoints. OTP expires after 10 minutes and has a maximum of 5 verification attempts. Resend must be configured for email delivery. Use `onboarding@resend.dev` for initial testing only; to send to arbitrary recipients/from your own branded address, configure and verify your sending domain in Resend. Keep `RESEND_API_KEY` secret and set it in your hosting provider's environment variables, not in frontend code or Git.

## Status
This is a development starter. The existing HTML/CSS/JS frontend has not yet been fully wired to these APIs. Complete frontend integration, end-to-end tests, deployment configuration, and security review before production use. Test exam attempt enforcement under concurrent requests before production.

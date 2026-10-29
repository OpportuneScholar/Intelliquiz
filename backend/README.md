# IntelliQuiz SQL Backend (PostgreSQL)

## Requirements
- Node.js 20+
- PostgreSQL 14+ (local installation or hosted PostgreSQL)

## Setup
1. Create a PostgreSQL database named `intelliquiz`.
2. Run `schema.sql` against that database.
3. Copy `.env.example` to `.env` and set `DATABASE_URL`, a unique random `JWT_SECRET` (at least 32 characters), and teacher credentials.
4. In this folder run `npm install`.
5. Run `npm run check` to validate JavaScript syntax.
6. Run `npm run seed:teacher` to create/update the teacher account.
7. Run `npm run dev`; test `GET http://localhost:5000/api/health`.

## Main endpoints
- `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`
- `GET/POST /api/questions`, `PATCH/DELETE /api/questions/:id`
- `GET/POST /api/exams`, `PATCH /api/exams/:id`
- `POST /api/exams/:id/submit`
- `GET /api/exams/:id/results` (teacher)
- `GET /api/exams/student/my-results` (student)
- `GET /api/dashboard/summary` (teacher)

Send `Authorization: Bearer <token>` for authenticated routes. Public registration creates student accounts; teacher accounts are created by the seed script.

## Status
This is a development starter. The existing HTML/CSS/JS frontend has not yet been fully wired to these APIs. Complete frontend integration, end-to-end tests, deployment configuration, and security review before production use. Test exam attempt enforcement under concurrent requests before production.

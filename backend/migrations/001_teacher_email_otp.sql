-- Run this migration on an existing IntelliQuiz database to enable email-verified teacher signup.
CREATE TABLE IF NOT EXISTS teacher_registration_otps (
  id BIGSERIAL PRIMARY KEY,
  email VARCHAR(254) NOT NULL,
  name VARCHAR(120) NOT NULL,
  password_hash TEXT NOT NULL,
  otp_hash CHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_teacher_otp_email_created ON teacher_registration_otps(email, created_at DESC);

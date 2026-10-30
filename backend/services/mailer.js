'use strict';
// Single place that sends email through Resend.
// In development (NODE_ENV != production) with no RESEND_API_KEY the message is printed to the server
// console so OTP flows can be tested locally. In production a missing key is a clear 503 error.

async function sendMail({ to, subject, text, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    if (process.env.NODE_ENV === 'production') {
      throw Object.assign(new Error('Email is not configured. Set RESEND_API_KEY and MAIL_FROM on the server.'), { status: 503 });
    }
    console.log('\n[DEV MAIL — RESEND_API_KEY not set]\nTo: %s\nSubject: %s\n%s\n', to, subject, text);
    return { dev: true };
  }
  const { Resend } = require('resend');
  const { error } = await new Resend(apiKey).emails.send({
    from: process.env.MAIL_FROM || 'IntelliQuiz <onboarding@resend.dev>', to: [to], subject, text, html
  });
  if (error) {
    console.error('Email delivery failed:', error.message || error);
    throw Object.assign(new Error('Could not send the email. Check the Resend API key and verified sender/domain.'), { status: 502 });
  }
  return { dev: false };
}

module.exports = { sendMail };

// utils/mailer.js
const nodemailer = require('nodemailer');

const host = process.env.SMTP_HOST || 'smtp.gmail.com';
const port = Number(process.env.SMTP_PORT || 587);
// ✅ 465 = SSL (secure true), 587 = STARTTLS (secure false)
const secure = port === 465;

const transporter = nodemailer.createTransport({
  host,
  port,
  secure,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  // STARTTLS sẽ tự được nâng cấp khi server hỗ trợ (port 587).
  // Không cần thêm requireTLS, để mặc định là tốt nhất cho Gmail.
});

async function verifyTransport() {
  try {
    await transporter.verify();
    console.log('[MAIL] SMTP ready');
  } catch (e) {
    console.error('[MAIL] SMTP verify failed:', e.message);
  }
}

async function sendMail({ to, subject, html, text }) {
  const info = await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
    html,
  });
  console.log('[MAIL] sent to', to, 'messageId=', info.messageId);
  return info;
}

module.exports = { verifyTransport, sendMail };

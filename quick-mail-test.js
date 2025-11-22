const nodemailer = require('nodemailer');
require('dotenv').config();

(async () => {
  try {
    const t = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await t.verify();
    console.log('OK: SMTP ready');

    const info = await t.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: process.env.SMTP_USER, // gửi thử cho chính mình
      subject: 'SMTP test',
      text: 'Xin chào, đây là mail test.',
    });
    console.log('Sent:', info.messageId);
  } catch (e) {
    console.error('FAIL:', e);
  }
})();

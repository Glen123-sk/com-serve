const nodemailer = require('nodemailer');

function createMailer(config) {
  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: {
      user: config.smtpUser,
      pass: config.smtpPass
    }
  });

  return transporter;
}

async function sendOtpEmail(transporter, from, to, otp) {
  const subject = 'Your OTP Code';
  const text = `Your verification code is ${otp}. It expires in 5 minutes.`;

  await transporter.sendMail({
    from,
    to,
    subject,
    text
  });
}

module.exports = { createMailer, sendOtpEmail };

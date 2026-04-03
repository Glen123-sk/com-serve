const path = require('path');
const express = require('express');
const helmet = require('helmet');
const dotenv = require('dotenv');
const { connectDatabase } = require('./config/db');
const { createMailer, sendOtpEmail } = require('./config/mailer');
const { createAuthRouter } = require('./routes/authRoutes');

dotenv.config();

const config = {
  port: Number(process.env.PORT || 5000),
  mongoUri: process.env.MONGO_URI,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1d',
  resetTokenExpiresIn: process.env.RESET_TOKEN_EXPIRES_IN || '10m',
  smtpHost: process.env.SMTP_HOST,
  smtpPort: Number(process.env.SMTP_PORT || 587),
  smtpSecure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
  smtpUser: process.env.SMTP_USER,
  smtpPass: process.env.SMTP_PASS,
  smtpFrom: process.env.SMTP_FROM || 'Auth App <no-reply@example.com>'
};

function validateConfig() {
  const required = [
    ['MONGO_URI', config.mongoUri],
    ['JWT_SECRET', config.jwtSecret],
    ['SMTP_HOST', config.smtpHost],
    ['SMTP_USER', config.smtpUser],
    ['SMTP_PASS', config.smtpPass]
  ];

  const missing = required.filter(([, value]) => !value).map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

async function startServer() {
  validateConfig();
  await connectDatabase(config.mongoUri);

  const transporter = createMailer(config);
  try {
    await transporter.verify();
    console.log('SMTP transporter verified');
  } catch (error) {
    console.warn(`SMTP verification failed: ${error.message}`);
    console.warn('The server will still start, but OTP email sending will fail until SMTP credentials are fixed.');
  }

  const app = express();

  app.use(helmet());
  app.use(express.json({ limit: '10kb' }));

  const mailer = {
    sendOtpEmail: (from, to, otp) => sendOtpEmail(transporter, from, to, otp)
  };

  app.use(
    '/',
    createAuthRouter({
      mailer,
      smtpFrom: config.smtpFrom,
      jwtSecret: config.jwtSecret,
      jwtExpiresIn: config.jwtExpiresIn,
      resetTokenExpiresIn: config.resetTokenExpiresIn
    })
  );

  app.use(express.static(path.join(__dirname, '..', '..', 'client')));

  app.get('/health', (req, res) => {
    res.status(200).json({ ok: true, timestamp: new Date().toISOString() });
  });

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ message: 'Unexpected server error.' });
  });

  app.listen(config.port, () => {
    console.log(`Server running on http://localhost:${config.port}`);
  });
}

startServer().catch((error) => {
  console.error('Failed to start server:', error.message);
  process.exit(1);
});

const express = require('express');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const PendingSignup = require('../models/PendingSignup');
const OtpCode = require('../models/OtpCode');
const {
  normalizeEmail,
  isValidEmail,
  isStrongPassword,
  generateOtp,
  hashSecret,
  compareSecret,
  otpExpiresAt,
  otpRateLimitState,
  otpOnCooldown,
  createAccessToken,
  createResetToken,
  verifyResetToken
} = require('../utils/auth');

function createAuthRouter({ mailer, smtpFrom, jwtSecret, jwtExpiresIn, resetTokenExpiresIn }) {
  const router = express.Router();

  const otpEndpointLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many requests. Try again later.' }
  });

  router.use(['/register', '/forgot-password'], otpEndpointLimiter);

  router.post('/register', async (req, res) => {
    try {
      const { username, email, password, confirmPassword, resend } = req.body;
      const normalizedEmail = normalizeEmail(email);

      if (!isValidEmail(normalizedEmail)) {
        return res.status(400).json({ message: 'Invalid email format.' });
      }

      const existingUser = await User.findOne({ email: normalizedEmail });
      if (existingUser) {
        return res.status(409).json({ message: 'Email is already registered.' });
      }

      let pending = await PendingSignup.findOne({ email: normalizedEmail });

      if (resend) {
        if (!pending) {
          return res.status(404).json({ message: 'No pending signup found for this email.' });
        }
      } else {
        if (!username || String(username).trim().length < 3) {
          return res.status(400).json({ message: 'Username must be at least 3 characters.' });
        }
        if (!isStrongPassword(password)) {
          return res.status(400).json({ message: 'Password must be at least 8 chars and include upper, lower, number, and symbol.' });
        }
        if (password !== confirmPassword) {
          return res.status(400).json({ message: 'Passwords do not match.' });
        }
      }

      if (otpOnCooldown(pending)) {
        return res.status(429).json({ message: 'Please wait before requesting another OTP.' });
      }

      const rateState = otpRateLimitState(pending);
      if (rateState.blocked) {
        return res.status(429).json({ message: 'OTP request limit reached. Try again in 1 hour.' });
      }

      const otp = generateOtp();
      const otpHash = await hashSecret(otp);
      const expiresAt = otpExpiresAt();
      const now = new Date();

      if (!pending) {
        const passwordHash = await hashSecret(password);
        pending = await PendingSignup.create({
          username: String(username).trim(),
          email: normalizedEmail,
          passwordHash,
          otpHash,
          otpExpiresAt: expiresAt,
          otpSentAt: now,
          otpWindowStart: rateState.otpWindowStart,
          otpRequestCount: rateState.otpRequestCount
        });
      } else {
        pending.otpHash = otpHash;
        pending.otpExpiresAt = expiresAt;
        pending.otpSentAt = now;
        pending.otpWindowStart = rateState.otpWindowStart;
        pending.otpRequestCount = rateState.otpRequestCount;

        if (!resend) {
          pending.username = String(username).trim();
          pending.passwordHash = await hashSecret(password);
        }

        await pending.save();
      }

      await mailer.sendOtpEmail(smtpFrom, normalizedEmail, otp);

      return res.status(200).json({
        message: 'OTP sent to email.',
        email: normalizedEmail,
        purpose: 'signup'
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Server error while processing signup.' });
    }
  });

  router.post('/verify-otp', async (req, res) => {
    try {
      const { email, otp, purpose } = req.body;
      const normalizedEmail = normalizeEmail(email);

      if (!normalizedEmail || !otp || !purpose) {
        return res.status(400).json({ message: 'Email, OTP, and purpose are required.' });
      }

      if (!/^\d{6}$/.test(String(otp))) {
        return res.status(400).json({ message: 'OTP must be a 6-digit number.' });
      }

      if (purpose === 'signup') {
        const pending = await PendingSignup.findOne({ email: normalizedEmail });
        if (!pending) {
          return res.status(404).json({ message: 'No pending signup found.' });
        }

        if (new Date(pending.otpExpiresAt).getTime() < Date.now()) {
          return res.status(400).json({ message: 'OTP expired. Please request a new OTP.', expired: true });
        }

        const isMatch = await compareSecret(String(otp), pending.otpHash);
        if (!isMatch) {
          return res.status(400).json({ message: 'Incorrect OTP.' });
        }

        const duplicate = await User.findOne({ email: normalizedEmail });
        if (duplicate) {
          await PendingSignup.deleteOne({ _id: pending._id });
          return res.status(409).json({ message: 'Email is already registered.' });
        }

        await User.create({
          username: pending.username,
          email: pending.email,
          passwordHash: pending.passwordHash
        });

        await PendingSignup.deleteOne({ _id: pending._id });

        return res.status(201).json({ message: 'Account created successfully.' });
      }

      if (purpose === 'reset_password') {
        const otpRecord = await OtpCode.findOne({
          email: normalizedEmail,
          purpose: 'reset_password',
          consumed: false
        }).sort({ createdAt: -1 });

        if (!otpRecord) {
          return res.status(404).json({ message: 'No reset OTP found.' });
        }

        if (new Date(otpRecord.expiresAt).getTime() < Date.now()) {
          return res.status(400).json({ message: 'OTP expired. Please request a new OTP.', expired: true });
        }

        const isMatch = await compareSecret(String(otp), otpRecord.otpHash);
        if (!isMatch) {
          return res.status(400).json({ message: 'Incorrect OTP.' });
        }

        otpRecord.consumed = true;
        await otpRecord.save();

        const resetToken = createResetToken(normalizedEmail, jwtSecret, resetTokenExpiresIn);
        return res.status(200).json({ message: 'OTP verified.', resetToken });
      }

      return res.status(400).json({ message: 'Invalid purpose.' });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Server error while verifying OTP.' });
    }
  });

  router.post('/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      const normalizedEmail = normalizeEmail(email);

      if (!normalizedEmail || !password) {
        return res.status(400).json({ message: 'Email and password are required.' });
      }

      const user = await User.findOne({ email: normalizedEmail });
      if (!user) {
        return res.status(401).json({ message: 'Invalid email or password.' });
      }

      const validPassword = await compareSecret(password, user.passwordHash);
      if (!validPassword) {
        return res.status(401).json({ message: 'Invalid email or password.' });
      }

      const token = createAccessToken(
        { userId: String(user._id), email: user.email },
        jwtSecret,
        jwtExpiresIn
      );

      return res.status(200).json({
        message: 'Login successful.',
        token,
        user: {
          id: String(user._id),
          username: user.username,
          email: user.email
        }
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Server error while logging in.' });
    }
  });

  router.post('/forgot-password', async (req, res) => {
    try {
      const { email } = req.body;
      const normalizedEmail = normalizeEmail(email);

      if (!isValidEmail(normalizedEmail)) {
        return res.status(400).json({ message: 'Invalid email format.' });
      }

      const user = await User.findOne({ email: normalizedEmail });
      if (!user) {
        return res.status(200).json({ message: 'If this email exists, OTP has been sent.' });
      }

      let otpRecord = await OtpCode.findOne({ email: normalizedEmail, purpose: 'reset_password' }).sort({ createdAt: -1 });

      if (otpOnCooldown(otpRecord)) {
        return res.status(429).json({ message: 'Please wait before requesting another OTP.' });
      }

      const rateState = otpRateLimitState(otpRecord);
      if (rateState.blocked) {
        return res.status(429).json({ message: 'OTP request limit reached. Try again in 1 hour.' });
      }

      const otp = generateOtp();
      const otpHash = await hashSecret(otp);
      const now = new Date();
      const expiresAt = otpExpiresAt();

      if (!otpRecord) {
        otpRecord = await OtpCode.create({
          email: normalizedEmail,
          purpose: 'reset_password',
          otpHash,
          expiresAt,
          sentAt: now,
          consumed: false,
          otpWindowStart: rateState.otpWindowStart,
          otpRequestCount: rateState.otpRequestCount
        });
      } else {
        otpRecord.otpHash = otpHash;
        otpRecord.expiresAt = expiresAt;
        otpRecord.sentAt = now;
        otpRecord.consumed = false;
        otpRecord.otpWindowStart = rateState.otpWindowStart;
        otpRecord.otpRequestCount = rateState.otpRequestCount;
        await otpRecord.save();
      }

      await mailer.sendOtpEmail(smtpFrom, normalizedEmail, otp);

      return res.status(200).json({
        message: 'If this email exists, OTP has been sent.',
        email: normalizedEmail,
        purpose: 'reset_password'
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Server error while processing forgot password.' });
    }
  });

  router.post('/reset-password', async (req, res) => {
    try {
      const { email, resetToken, password, confirmPassword } = req.body;
      const normalizedEmail = normalizeEmail(email);

      if (!normalizedEmail || !resetToken || !password || !confirmPassword) {
        return res.status(400).json({ message: 'Email, reset token, and passwords are required.' });
      }

      if (password !== confirmPassword) {
        return res.status(400).json({ message: 'Passwords do not match.' });
      }

      if (!isStrongPassword(password)) {
        return res.status(400).json({ message: 'Password must be at least 8 chars and include upper, lower, number, and symbol.' });
      }

      let payload;
      try {
        payload = verifyResetToken(resetToken, jwtSecret);
      } catch (err) {
        return res.status(401).json({ message: 'Invalid or expired reset token.' });
      }

      if (payload.purpose !== 'reset_password' || normalizeEmail(payload.email) !== normalizedEmail) {
        return res.status(401).json({ message: 'Invalid reset token payload.' });
      }

      const user = await User.findOne({ email: normalizedEmail });
      if (!user) {
        return res.status(404).json({ message: 'User not found.' });
      }

      user.passwordHash = await hashSecret(password);
      await user.save();

      await OtpCode.deleteMany({ email: normalizedEmail, purpose: 'reset_password' });

      return res.status(200).json({ message: 'Password reset successful.' });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Server error while resetting password.' });
    }
  });

  router.get('/testmail/latest-otp', async (req, res) => {
    try {
      const namespace = process.env.TESTMAIL_NAMESPACE;
      const apiKey = process.env.TESTMAIL_API_KEY;
      const tag = String(req.query.tag || '').trim();

      if (!namespace || !apiKey) {
        return res.status(400).json({ message: 'TESTMAIL_NAMESPACE or TESTMAIL_API_KEY is not configured.' });
      }

      if (!tag) {
        return res.status(400).json({ message: 'Missing required query parameter: tag' });
      }

      const query = new URLSearchParams({
        apikey: apiKey,
        namespace,
        tag,
        limit: '1'
      });

      if (req.query.timestamp_from) {
        query.set('timestamp_from', String(req.query.timestamp_from));
      }

      const response = await fetch(`https://api.testmail.app/api/json?${query.toString()}`);
      if (!response.ok) {
        return res.status(502).json({ message: 'Testmail API request failed.' });
      }

      const payload = await response.json();
      if (payload.result !== 'success') {
        return res.status(502).json({ message: payload.message || 'Testmail API returned an error.' });
      }

      const latest = Array.isArray(payload.emails) && payload.emails.length > 0 ? payload.emails[0] : null;
      if (!latest) {
        return res.status(404).json({ message: 'No email found for this tag yet.' });
      }

      const text = String(latest.text || latest.html || '');
      const match = text.match(/\b(\d{6})\b/);
      if (!match) {
        return res.status(404).json({ message: 'No 6-digit OTP found in the latest email.' });
      }

      return res.status(200).json({
        otp: match[1],
        tag: latest.tag,
        to: latest.to,
        subject: latest.subject,
        timestamp: latest.timestamp
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: 'Server error while querying Testmail.' });
    }
  });

  return router;
}

module.exports = { createAuthRouter };

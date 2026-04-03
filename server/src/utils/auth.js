const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const OTP_EXPIRY_MS = 5 * 60 * 1000;
const OTP_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_PER_WINDOW = 5;
const OTP_WINDOW_MS = 60 * 60 * 1000;
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^\w\s]).{8,}$/;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  const value = normalizeEmail(email);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isStrongPassword(password) {
  return PASSWORD_REGEX.test(String(password || ''));
}

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function hashSecret(value) {
  return bcrypt.hash(value, 12);
}

async function compareSecret(value, hash) {
  return bcrypt.compare(value, hash);
}

function otpExpiresAt() {
  return new Date(Date.now() + OTP_EXPIRY_MS);
}

function otpRateLimitState(existing) {
  const now = new Date();
  const windowStart = existing?.otpWindowStart ? new Date(existing.otpWindowStart) : now;
  const sameWindow = now.getTime() - windowStart.getTime() < OTP_WINDOW_MS;

  let requestCount = sameWindow ? existing?.otpRequestCount || 0 : 0;
  if (requestCount >= OTP_MAX_PER_WINDOW) {
    return { blocked: true };
  }

  requestCount += 1;
  return {
    blocked: false,
    otpWindowStart: sameWindow ? windowStart : now,
    otpRequestCount: requestCount
  };
}

function otpOnCooldown(existing) {
  if (!existing?.otpSentAt) {
    return false;
  }
  return Date.now() - new Date(existing.otpSentAt).getTime() < OTP_COOLDOWN_MS;
}

function createAccessToken(payload, secret, expiresIn) {
  return jwt.sign(payload, secret, { expiresIn });
}

function createResetToken(email, secret, expiresIn) {
  return jwt.sign({ email, purpose: 'reset_password' }, secret, { expiresIn });
}

function verifyResetToken(token, secret) {
  return jwt.verify(token, secret);
}

module.exports = {
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
};

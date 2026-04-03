const mongoose = require('mongoose');

const pendingSignupSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      trim: true
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true
    },
    passwordHash: {
      type: String,
      required: true
    },
    otpHash: {
      type: String,
      required: true
    },
    otpExpiresAt: {
      type: Date,
      required: true
    },
    otpSentAt: {
      type: Date,
      required: true
    },
    otpRequestCount: {
      type: Number,
      default: 1
    },
    otpWindowStart: {
      type: Date,
      required: true
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('PendingSignup', pendingSignupSchema);

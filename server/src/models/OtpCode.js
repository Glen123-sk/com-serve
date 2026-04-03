const mongoose = require('mongoose');

const otpCodeSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true
    },
    purpose: {
      type: String,
      enum: ['reset_password'],
      required: true
    },
    otpHash: {
      type: String,
      required: true
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true
    },
    sentAt: {
      type: Date,
      required: true
    },
    consumed: {
      type: Boolean,
      default: false
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

module.exports = mongoose.model('OtpCode', otpCodeSchema);

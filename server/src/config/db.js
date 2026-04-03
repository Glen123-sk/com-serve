const mongoose = require('mongoose');

async function connectDatabase(mongoUri) {
  if (!mongoUri) {
    throw new Error('MONGO_URI is not configured.');
  }

  await mongoose.connect(mongoUri);
  console.log('MongoDB connected');
}

module.exports = { connectDatabase };

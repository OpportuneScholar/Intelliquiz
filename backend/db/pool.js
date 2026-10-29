const mongoose = require('mongoose');

async function connectDatabase() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is missing. Set it in the service environment.');
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10000,
    maxPoolSize: 10
  });
  console.log('MongoDB connected.');
}

module.exports = { mongoose, connectDatabase };

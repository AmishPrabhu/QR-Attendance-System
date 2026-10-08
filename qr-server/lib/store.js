const fs = require('fs');
const path = require('path');
const os = require('os');
const mongoose = require('mongoose');

// Mongoose schema for persistent live sessions shared across all Vercel instances
const LiveSessionSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  secret: { type: String, required: true },
  className: { type: String, default: '' },
  subject: { type: String, default: '' },
  createdAt: { type: Number, required: true },
  expiresAt: { type: Number, required: true },
  endedAt: { type: Number, default: null },
  roster: { type: Array, default: [] },
  marked: { type: mongoose.Schema.Types.Mixed, default: {} }
}, {
  timestamps: true,
  minimize: false
});

const LiveSession = mongoose.models.LiveSession || mongoose.model('LiveSession', LiveSessionSchema);

// Local fallback store
const DATA_DIR = process.env.VERCEL ? path.join(os.tmpdir(), 'data') : path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'sessions.json');

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch {}

let memorySessions = [];
try {
  if (fs.existsSync(DATA_FILE)) {
    memorySessions = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
} catch {
  memorySessions = [];
}

function persistLocal() {
  try {
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(memorySessions, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch {}
}

const db = require('./db');

module.exports = {
  async create(session) {
    memorySessions.push(session);
    persistLocal();
    await db.connectDB();
    if (mongoose.connection.readyState === 1) {
      try {
        await LiveSession.findOneAndUpdate(
          { id: session.id },
          { $set: session },
          { upsert: true }
        );
      } catch (err) {
        console.warn('[store] Mongo create error:', err.message);
      }
    }
    return session;
  },

  async get(id) {
    if (!id) return null;
    await db.connectDB();
    if (mongoose.connection.readyState === 1) {
      try {
        const doc = await LiveSession.findOne({ id }).lean();
        if (doc) return doc;
      } catch (err) {
        console.warn('[store] Mongo get error:', err.message);
      }
    }
    return memorySessions.find((s) => s.id === id) || null;
  },

  async latest() {
    await db.connectDB();
    if (mongoose.connection.readyState === 1) {
      try {
        const doc = await LiveSession.findOne().sort({ createdAt: -1 }).lean();
        if (doc) return doc;
      } catch (err) {
        console.warn('[store] Mongo latest error:', err.message);
      }
    }
    return memorySessions[memorySessions.length - 1] || null;
  },

  async list() {
    await db.connectDB();
    if (mongoose.connection.readyState === 1) {
      try {
        const docs = await LiveSession.find().sort({ createdAt: -1 }).limit(50).lean();
        if (docs && docs.length > 0) return docs;
      } catch (err) {
        console.warn('[store] Mongo list error:', err.message);
      }
    }
    return [...memorySessions].reverse();
  },

  async save(session) {
    if (session && session.id) {
      const idx = memorySessions.findIndex((s) => s.id === session.id);
      if (idx !== -1) {
        memorySessions[idx] = session;
      } else {
        memorySessions.push(session);
      }
      persistLocal();
      await db.connectDB();
      if (mongoose.connection.readyState === 1) {
        try {
          await LiveSession.updateOne(
            { id: session.id },
            { $set: { marked: session.marked || {}, endedAt: session.endedAt } }
          );
        } catch (err) {
          console.warn('[store] Mongo save error:', err.message);
        }
      }
    } else {
      persistLocal();
    }
  }
};

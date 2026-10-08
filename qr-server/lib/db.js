const mongoose = require('mongoose');

const AttendanceSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true, index: true },
  className: { type: String, default: '' },
  subject: { type: String, default: '' },
  date: { type: String, default: () => new Date().toISOString().slice(0, 10) },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date },
  endedAt: { type: Date },
  totalStudents: { type: Number, default: 0 },
  presentCount: { type: Number, default: 0 },
  absentCount: { type: Number, default: 0 },
  absentStudents: [
    {
      prn: { type: String, required: true },
      name: { type: String, default: '' }
    }
  ],
  presentStudents: [
    {
      prn: { type: String, required: true },
      name: { type: String, default: '' },
      at: { type: Number },
      deviceId: { type: String },
      ip: { type: String }
    }
  ],
  syncedToErp: { type: Boolean, default: false },
  syncedAt: { type: Date }
}, {
  timestamps: true
});

const AttendanceRecord = mongoose.model('AttendanceRecord', AttendanceSchema);

let isConnected = false;
let cachedPromise = null;

async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn('[MongoDB] MONGODB_URI not defined in environment. Cloud sync disabled.');
    return false;
  }
  if (mongoose.connection.readyState === 1) {
    isConnected = true;
    return true;
  }
  if (cachedPromise) {
    return cachedPromise;
  }
  cachedPromise = mongoose.connect(uri, {
    serverSelectionTimeoutMS: 5000
  }).then(() => {
    isConnected = true;
    console.log('[MongoDB] Connected successfully to Atlas cluster!');
    return true;
  }).catch((err) => {
    cachedPromise = null;
    isConnected = false;
    console.error('[MongoDB] Connection error:', err.message);
    return false;
  });
  return cachedPromise;
}

async function saveSessionToCloud(session) {
  if (!isConnected) {
    const ok = await connectDB();
    if (!ok) return { ok: false, error: 'Database connection not available.' };
  }

  try {
    const nameOf = new Map((session.roster || []).map((s) => [s.prn, s.name]));
    const absent = (session.roster || [])
      .filter((s) => !session.marked || !session.marked[s.prn])
      .map((s) => ({ prn: String(s.prn).trim(), name: s.name || '' }));

    const present = Object.entries(session.marked || {}).map(([prn, m]) => ({
      prn: String(prn).trim(),
      name: nameOf.get(prn) || '',
      at: m.at,
      deviceId: m.deviceId,
      ip: m.ip
    }));

    const updateDoc = {
      sessionId: session.id,
      className: session.className || '',
      subject: session.subject || '',
      date: new Date(session.createdAt || Date.now()).toISOString().slice(0, 10),
      createdAt: session.createdAt ? new Date(session.createdAt) : new Date(),
      expiresAt: session.expiresAt ? new Date(session.expiresAt) : null,
      endedAt: session.endedAt ? new Date(session.endedAt) : new Date(),
      totalStudents: (session.roster || []).length,
      presentCount: present.length,
      absentCount: absent.length,
      absentStudents: absent,
      presentStudents: present
    };

    const doc = await AttendanceRecord.findOneAndUpdate(
      { sessionId: session.id },
      { $set: updateDoc },
      { upsert: true, returnDocument: 'after' }
    );

    console.log(`[MongoDB] Session ${session.id} synced to cloud (${absent.length} absent, ${present.length} present).`);
    return { ok: true, data: doc };
  } catch (err) {
    console.error(`[MongoDB] Failed to save session ${session.id}:`, err.message);
    return { ok: false, error: err.message };
  }
}

async function getLatestCloudSession() {
  if (!isConnected) await connectDB();
  return AttendanceRecord.findOne().sort({ createdAt: -1 });
}

async function getCloudSessionById(id) {
  if (!isConnected) await connectDB();
  return AttendanceRecord.findOne({ sessionId: id });
}

async function listCloudSessions(limit = 20) {
  if (!isConnected) await connectDB();
  return AttendanceRecord.find({}, 'sessionId className subject date totalStudents presentCount absentCount syncedToErp createdAt')
    .sort({ createdAt: -1 })
    .limit(limit);
}

async function markSessionSynced(id) {
  if (!isConnected) await connectDB();
  return AttendanceRecord.findOneAndUpdate(
    { sessionId: id },
    { $set: { syncedToErp: true, syncedAt: new Date() } },
    { returnDocument: 'after' }
  );
}

module.exports = {
  connectDB,
  saveSessionToCloud,
  getLatestCloudSession,
  getCloudSessionById,
  listCloudSessions,
  markSessionSynced,
  AttendanceRecord
};

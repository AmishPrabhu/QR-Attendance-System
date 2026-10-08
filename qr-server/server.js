require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');

const store = require('./lib/store');
const { loadRoster, toAbsentCsv } = require('./lib/roster');
const db = require('./lib/db');

// Connect to MongoDB Atlas (non-blocking)
db.connectDB().catch((err) => console.warn('[MongoDB] Init warning:', err.message));

const PORT = Number(process.env.PORT) || 3001;

// Key that lets the professor's own PC (running the Chrome extension) read the absent list over the Wi-Fi.
// Generated once, saved in data/professor-key.txt, and entered into the extension a single time.
// Override with PROFESSOR_KEY. It is never shown on the student-facing QR screen.
const KEY_FILE = path.join(__dirname, 'data', 'professor-key.txt');
const PROFESSOR_KEY = (() => {
  if (process.env.PROFESSOR_KEY) return process.env.PROFESSOR_KEY;
  try {
    const saved = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (saved) return saved;
  } catch {
    // no key yet: create one below
  }
  const key = crypto.randomBytes(6).toString('hex'); // 12 characters
  try {
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    fs.writeFileSync(KEY_FILE, key);
  } catch {}
  return key;
})();
const TOKEN_WINDOW_MS = 30 * 1000; // QR code rotates every 30s so a photo of it quickly becomes useless
const MIN_DURATION_MIN = 1;
const MAX_DURATION_MIN = 60;
const EXPORT_DIR = process.env.VERCEL ? path.join(os.tmpdir(), 'exports') : path.join(__dirname, 'exports');

try {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
} catch {}

const app = express();
app.use(express.json({ limit: '2kb' }));

// ---------------------------------------------------------------- helpers

function lanAddress() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return 'localhost';
}

// Students' phones must reach this URL. Automatically uses Vercel URL in production.
const publicUrl = () => {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return `http://${lanAddress()}:${PORT}`;
};

const isOpen = (s, now = Date.now()) => !s.endedAt && now < s.expiresAt;

// One check-in per network address. Set IP_LOCK=off only if all phones appear to the server as the same
// address (e.g. the Wi-Fi sits behind a NAT/router that hides individual phones).
const IP_LOCK = process.env.IP_LOCK !== 'off';
const clientIp = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
const isLoopbackIp = (ip) => ip === '127.0.0.1' || ip === '::1';

// TESTING ONLY. With REMOTE_PROFESSOR=on, the dashboard and session controls can be used from ANY device
// on the network (so you can open the dashboard on another device). Anyone on the Wi-Fi, including
// students, could then start/end sessions and read the absent list. Never use it in a real class.
const REMOTE_PROFESSOR = process.env.REMOTE_PROFESSOR === 'on';

function tokenFor(session, windowIndex) {
  return crypto.createHmac('sha256', session.secret).update(`${session.id}:${windowIndex}`).digest('hex').slice(0, 16);
}

function currentToken(session, now = Date.now()) {
  return tokenFor(session, Math.floor(now / TOKEN_WINDOW_MS));
}

function isValidToken(session, token, now = Date.now()) {
  if (typeof token !== 'string') return false;
  const w = Math.floor(now / TOKEN_WINDOW_MS);
  // Accept the current and previous window so a scan right at rotation time still works.
  return [w, w - 1].some((i) => {
    const expected = Buffer.from(tokenFor(session, i));
    const given = Buffer.from(token);
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  });
}

function absentList(session) {
  return session.roster.filter((s) => !session.marked[s.prn]);
}

function resolveSession(req, res) {
  const session = req.params.id === 'latest' ? store.latest() : store.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return null;
  }
  return session;
}

/** Professor-only endpoints: reachable from this machine (dashboard + Chrome extension), not from student phones. */
function localOnly(req, res, next) {
  if (process.env.VERCEL) return next();
  const addr = req.socket.remoteAddress || '';
  const loopback = ['::1', '127.0.0.1', '::ffff:127.0.0.1'].includes(addr);
  if (!loopback && !REMOTE_PROFESSOR) {
    return res.status(403).json({ error: 'Professor endpoints are only available on the host machine.' });
  }
  const origin = req.get('origin');
  if (origin) {
    const localOrigin = /^(https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?|chrome-extension:\/\/.+)$/.test(origin);
    // In remote-testing mode the dashboard is served from this server's LAN address, so same-origin is fine.
    let sameOrigin = false;
    try {
      sameOrigin = REMOTE_PROFESSOR && new URL(origin).host === req.get('host');
    } catch {
      sameOrigin = false;
    }
    if (!localOrigin && !sameOrigin) {
      return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
    }
  }
  next();
}

/**
 * For the endpoints the Chrome extension reads: allowed from this machine (no key needed) OR from any
 * other machine on the network that sends the professor key in the X-Professor-Key header.
 * Starting/ending sessions stays localOnly, so only the class-screen PC can control a session.
 */
const keyFailures = new Map();
function keyMatches(given) {
  if (!given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(PROFESSOR_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function localOrKey(req, res, next) {
  const given = req.get('x-professor-key') || req.query.key;
  if (!given) {
    if (!REMOTE_PROFESSOR && !isLoopbackIp(clientIp(req))) {
      return res.status(401).json({ error: 'Professor key required.' });
    }
    return localOnly(req, res, next);
  }

  // Brute-force guard: 10 wrong keys per minute per address.
  const ip = clientIp(req);
  const now = Date.now();
  const recent = (keyFailures.get(ip) || []).filter((t) => now - t < 60 * 1000);
  if (recent.length >= 10) return res.status(429).json({ error: 'Too many wrong keys. Wait a minute.' });
  if (keyMatches(given)) return next();

  recent.push(now);
  keyFailures.set(ip, recent);
  return res.status(403).json({ error: 'Wrong professor key.' });
}

// Cache QR images per session + token window (avoids re-rendering on every dashboard poll).
const qrCache = new Map();
async function qrFor(session, now = Date.now()) {
  const url = `${publicUrl()}/s/${session.id}?t=${currentToken(session, now)}`;
  if (!qrCache.has(url)) {
    if (qrCache.size > 50) qrCache.clear();
    qrCache.set(url, await QRCode.toDataURL(url, { width: 380, margin: 1, errorCorrectionLevel: 'M' }));
  }
  return { url, image: qrCache.get(url) };
}

// Basic per-IP rate limit for the public student endpoint.
const hits = new Map();
function rateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < 60 * 1000);
  if (recent.length >= 20) return res.status(429).json({ error: 'Too many attempts. Wait a minute and try again.' });
  recent.push(now);
  hits.set(key, recent);
  next();
}

// ---------------------------------------------------------------- pages

// 1. Classroom Projector Screen (Public & Read-Only)
app.get(['/', '/display', '/screen'], (_req, res) => res.sendFile(path.join(__dirname, 'public', 'display.html')));

// 2. Secret Professor Controller (Accessible ONLY via the secret key path)
app.get(['/p/:key', '/portal/:key'], (req, res) => {
  if (!keyMatches(req.params.key)) return res.status(404).send('Not Found');
  res.sendFile(path.join(__dirname, 'public', 'professor.html'));
});

// Protect common guessable words from revealing anything
app.get(['/teacher', '/admin', '/prof', '/professor', '/portal'], (_req, res) => res.status(404).send('Not Found'));

// Legacy desktop dashboard
app.get('/dashboard', localOrKey, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'professor.html')));

// Mock ERP testing simulator
app.get('/mock-erp', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'mock-erp.html')));
app.get('/mock-erp.html', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'mock-erp.html')));

// Student check-in page
app.get('/s/:id', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'student.html')));

// ---------------------------------------------------------------- public display API (for classroom screen)

app.get('/api/display/live', async (_req, res) => {
  const session = store.list().find((s) => isOpen(s)) || store.latest();
  if (!session) {
    return res.json({ hasSession: false, open: false });
  }
  const now = Date.now();
  const open = isOpen(session, now);
  const body = {
    hasSession: true,
    open,
    id: session.id,
    className: session.className,
    subject: session.subject,
    remainingSec: open ? Math.max(0, Math.round((session.expiresAt - now) / 1000)) : 0,
    presentCount: Object.keys(session.marked || {}).length,
    total: (session.roster || []).length,
  };
  if (open) {
    const qr = await qrFor(session, now);
    body.qr = qr.image;
    body.qrUrl = qr.url;
  }
  res.json(body);
});

// ---------------------------------------------------------------- professor API

app.get('/api/info', localOrKey, (_req, res) => {
  try {
    const { file, students } = loadRoster();
    res.json({ publicUrl: publicUrl(), rosterFile: file, rosterSize: students.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Shown on demand in the dashboard so the professor can type it into the extension once.
app.get('/api/connection', localOrKey, (_req, res) => {
  res.json({ serverUrl: publicUrl(), key: PROFESSOR_KEY });
});

app.post('/api/sessions', localOrKey, (req, res) => {
  const className = String(req.body.className || '').trim().slice(0, 60);
  const subject = String(req.body.subject || '').trim().slice(0, 60);
  const minutes = Math.min(MAX_DURATION_MIN, Math.max(MIN_DURATION_MIN, Number(req.body.durationMinutes) || 2));

  if (store.list().some((s) => isOpen(s))) {
    return res.status(409).json({ error: 'A session is already open. End it before starting a new one.' });
  }

  let roster;
  try {
    roster = loadRoster().students;
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const now = Date.now();
  const session = store.create({
    id: crypto.randomBytes(3).toString('hex').toUpperCase(), // short code, e.g. "A3F9C2"
    secret: crypto.randomBytes(24).toString('hex'),
    className,
    subject,
    createdAt: now,
    expiresAt: now + minutes * 60 * 1000,
    endedAt: null,
    roster, // snapshot, so later roster edits don't change past sessions
    marked: {}, // prn -> { at, deviceId }
  });
  res.status(201).json({ id: session.id });
});

app.get('/api/sessions', localOrKey, (_req, res) => {
  res.json(
    store.list().map((s) => ({
      id: s.id,
      className: s.className,
      subject: s.subject,
      createdAt: s.createdAt,
      open: isOpen(s),
      presentCount: Object.keys(s.marked).length,
      total: s.roster.length,
    }))
  );
});

app.get('/api/sessions/:id', localOrKey, async (req, res) => {
  const session = resolveSession(req, res);
  if (!session) return;
  const now = Date.now();
  const open = isOpen(session, now);

  const nameOf = new Map(session.roster.map((s) => [s.prn, s.name]));
  const recent = Object.entries(session.marked)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, 15)
    .map(([prn, m]) => ({ prn, name: nameOf.get(prn) || '', at: m.at }));

  const body = {
    id: session.id,
    className: session.className,
    subject: session.subject,
    open,
    remainingSec: open ? Math.max(0, Math.round((session.expiresAt - now) / 1000)) : 0,
    presentCount: Object.keys(session.marked).length,
    total: session.roster.length,
    recent,
  };
  if (open) {
    const qr = await qrFor(session, now);
    body.qr = qr.image;
    body.qrUrl = qr.url;
  }
  res.json(body);
});

app.post('/api/sessions/:id/end', localOrKey, async (req, res) => {
  const session = resolveSession(req, res);
  if (!session) return;
  if (!session.endedAt) {
    session.endedAt = Math.min(Date.now(), session.expiresAt);
    store.save();
    // Auto-save to MongoDB Atlas on session completion
    db.saveSessionToCloud(session).catch((err) => console.warn('[MongoDB] Auto-save error:', err.message));
  }
  res.json({ ok: true });
});

// Explicit endpoint to sync a session to MongoDB Cloud from dashboard
app.post('/api/sessions/:id/sync-cloud', localOrKey, async (req, res) => {
  const session = resolveSession(req, res);
  if (!session) return;
  const result = await db.saveSessionToCloud(session);
  if (!result.ok) return res.status(500).json({ error: result.error });
  res.json({ ok: true, data: result.data });
});

// Used by the Chrome extension ("latest" is accepted as an id).
app.get('/api/sessions/:id/absent', localOrKey, (req, res) => {
  const session = resolveSession(req, res);
  if (!session) return;
  res.json({
    id: session.id,
    className: session.className,
    subject: session.subject,
    open: isOpen(session),
    // When the attendance window closed (manual end or timeout); null while still open.
    closedAt: session.endedAt || (Date.now() >= session.expiresAt ? session.expiresAt : null),
    total: session.roster.length,
    presentCount: Object.keys(session.marked).length,
    absent: absentList(session),
  });
});

// Download absent_students.csv AND automatically save to MongoDB cloud
app.get('/api/sessions/:id/absent.csv', localOrKey, async (req, res) => {
  const session = resolveSession(req, res);
  if (!session) return;
  const csv = toAbsentCsv(absentList(session));
  fs.writeFileSync(path.join(EXPORT_DIR, `absent_students_${session.id}.csv`), csv);

  // Sync to MongoDB Atlas on download
  try {
    await db.saveSessionToCloud(session);
    console.log(`[Cloud Sync] Session ${session.id} synced to MongoDB upon CSV download.`);
  } catch (err) {
    console.warn(`[Cloud Sync] Could not save to MongoDB: ${err.message}`);
  }

  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="absent_students.csv"',
  });
  res.send(csv);
});

// ---------------------------------------------------------------- Cloud API (Accessible from anywhere / Chrome extension)
// Enable CORS for cloud endpoints so the Chrome Extension and Web apps can access them anywhere
app.use('/api/cloud', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Professor-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Get latest attendance session saved in MongoDB
app.get('/api/cloud/sessions/latest', async (req, res) => {
  try {
    const doc = await db.getLatestCloudSession();
    if (!doc) return res.status(404).json({ error: 'No attendance records found in MongoDB cloud.' });
    res.json({ ok: true, data: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List recent attendance records saved in MongoDB
app.get('/api/cloud/sessions', async (req, res) => {
  try {
    const docs = await db.listCloudSessions(25);
    res.json({ ok: true, data: docs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get specific attendance session from MongoDB
app.get('/api/cloud/sessions/:id', async (req, res) => {
  try {
    const doc = await db.getCloudSessionById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Session not found in MongoDB.' });
    res.json({ ok: true, data: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark session as synced to ERP in MongoDB
app.post('/api/cloud/sessions/:id/synced', async (req, res) => {
  try {
    const doc = await db.markSessionSynced(req.params.id);
    res.json({ ok: true, data: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------- student API (public on the LAN)

app.get('/api/student/session/:id', (req, res) => {
  const session = store.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ className: session.className, subject: session.subject, open: isOpen(session) });
});

app.post('/api/mark', rateLimit, (req, res) => {
  const { sessionId, token } = req.body;
  const prn = String(req.body.prn || '').trim();
  const deviceId = String(req.body.deviceId || '').slice(0, 64);

  const session = store.get(String(sessionId || ''));
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  if (!isOpen(session)) return res.status(403).json({ error: 'Attendance window is closed.' });
  if (!isValidToken(session, token)) {
    return res.status(403).json({ error: 'This QR code has expired. Scan the code on the screen again.' });
  }
  if (!/^[A-Za-z0-9]{4,20}$/.test(prn) || !deviceId) {
    return res.status(400).json({ error: 'Enter a valid PRN.' });
  }

  const student = session.roster.find((s) => s.prn === prn);
  if (!student) return res.status(404).json({ error: 'PRN not found in the class list.' });

  // The network address is what the server sees directly. Unlike the deviceId (browser storage), it is NOT
  // reset by incognito/private tabs, clearing site data, or switching browsers on the same phone.
  const ip = clientIp(req);
  const lockByIp = IP_LOCK && !isLoopbackIp(ip);

  const existing = session.marked[prn];
  if (existing) {
    // Same person retrying (same browser, or same phone via another tab/incognito): harmless.
    if (existing.deviceId === deviceId || (lockByIp && existing.ip === ip)) {
      return res.json({ ok: true, alreadyMarked: true, name: student.name });
    }
    return res.status(409).json({ error: 'This PRN is already marked from another device.' });
  }
  if (lockByIp) {
    const ipUsedFor = Object.keys(session.marked).find((p) => session.marked[p].ip === ip);
    if (ipUsedFor) {
      console.warn(`[blocked] session ${session.id}: ${prn} tried from ${ip}, already used for ${ipUsedFor}`);
      return res.status(409).json({ error: 'This phone has already marked attendance for another student.' });
    }
  }
  const deviceUsedFor = Object.keys(session.marked).find((p) => session.marked[p].deviceId === deviceId);
  if (deviceUsedFor) {
    return res.status(409).json({ error: 'This phone has already marked attendance for another student.' });
  }

  session.marked[prn] = { at: Date.now(), deviceId, ip };
  store.save();
  res.json({ ok: true, name: student.name, subject: session.subject });
});

// ---------------------------------------------------------------- start

if (process.env.VERCEL !== '1') {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Classroom Projector (Public)  : http://localhost:${PORT}/ (or /display)`);
    console.log(`Professor Controller (SECRET) : http://localhost:${PORT}/p/${PROFESSOR_KEY}`);
    console.log(`Students connect to           : ${publicUrl()}`);
    console.log(`One check-in per IP           : ${IP_LOCK ? 'ON' : 'OFF (IP_LOCK=off)'}`);
    console.log(`Extension settings            : server ${publicUrl()}  |  professor key ${PROFESSOR_KEY}`);
    try {
      const { file, students } = loadRoster();
      console.log(`Roster                        : ${students.length} students from ${file}`);
    } catch (err) {
      console.warn(`Roster warning                : ${err.message}`);
    }
  });
}

module.exports = app;

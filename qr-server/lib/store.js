const fs = require('fs');
const path = require('path');
const os = require('os');

// On Vercel / serverless, __dirname is read-only. Use os.tmpdir() for writes.
const DATA_DIR = process.env.VERCEL ? path.join(os.tmpdir(), 'data') : path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'sessions.json');

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  // ignore read-only error
}

let sessions = [];
try {
  if (fs.existsSync(DATA_FILE)) {
    sessions = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } else {
    // Fallback: try bundled repo data if tmp is not yet populated
    const bundledFile = path.join(__dirname, '..', 'data', 'sessions.json');
    if (fs.existsSync(bundledFile)) {
      sessions = JSON.parse(fs.readFileSync(bundledFile, 'utf8'));
    }
  }
} catch {
  sessions = [];
}

function persist() {
  try {
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(sessions, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    // Ignore read-only filesystem errors in serverless
  }
}

module.exports = {
  create(session) {
    sessions.push(session);
    persist();
    return session;
  },
  get(id) {
    return sessions.find((s) => s.id === id);
  },
  latest() {
    return sessions[sessions.length - 1];
  },
  list() {
    return [...sessions].reverse();
  },
  save: persist,
};

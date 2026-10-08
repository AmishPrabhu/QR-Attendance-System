const fs = require('fs');
const path = require('path');

// Small JSON-file store. Swap this module for MongoDB/Firebase later without touching server.js.
const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'sessions.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

let sessions = [];
try {
  sessions = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch {
  sessions = [];
}

function persist() {
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sessions, null, 2));
  fs.renameSync(tmp, DATA_FILE);
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

const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');

// MINI_PROJECT folder (qr-server/lib -> qr-server -> MINI_PROJECT)
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Roster lookup order:
 *   1. ROSTER_FILE environment variable
 *   2. MINI_PROJECT/roster.csv            (full class list, preferred)
 *   3. MINI_PROJECT/absent_students.csv   (fallback so the demo works out of the box)
 */
function resolveRosterPath() {
  if (process.env.ROSTER_FILE) return path.resolve(process.env.ROSTER_FILE);
  return [
    path.join(__dirname, '..', 'roster.csv'),
    path.join(PROJECT_ROOT, 'roster.csv'),
    path.join(PROJECT_ROOT, 'absent_students.csv'),
  ].find((p) => fs.existsSync(p));
}

function loadRoster() {
  const file = resolveRosterPath();
  if (!file) {
    throw new Error('No roster found. Put a roster.csv (columns: Name,PRN) in the MINI_PROJECT folder.');
  }

  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const { data } = Papa.parse(text, { header: true, skipEmptyLines: true });
  if (!data.length) throw new Error(`Roster file is empty: ${file}`);

  const keys = Object.keys(data[0]);
  const prnKey = keys.find((k) => /prn|roll/i.test(k));
  const nameKey = keys.find((k) => /name/i.test(k));
  if (!prnKey) throw new Error(`Roster file needs a PRN or Roll column: ${file}`);

  const seen = new Set();
  const students = [];
  for (const row of data) {
    const prn = String(row[prnKey] ?? '').trim();
    if (!prn || seen.has(prn)) continue;
    seen.add(prn);
    students.push({ prn, name: nameKey ? String(row[nameKey] ?? '').trim() : '' });
  }
  return { file, students };
}

const ALWAYS_PRESENT_PRNS = ['245100110', '245100106', '245100149', '245100134'];

/** CSV in the exact format the Chrome extension expects (header contains "PRN"). */
function toAbsentCsv(absentStudents) {
  return Papa.unparse(
    absentStudents
      .filter((s) => !ALWAYS_PRESENT_PRNS.includes(String(s.prn).trim()))
      .map((s) => ({ Name: s.name, PRN: s.prn, Attendance: 'A' })),
    { columns: ['Name', 'PRN', 'Attendance'] }
  );
}

module.exports = { loadRoster, toAbsentCsv, PROJECT_ROOT, ALWAYS_PRESENT_PRNS };

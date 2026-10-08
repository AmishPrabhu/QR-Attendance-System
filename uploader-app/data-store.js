const fs = require('fs');
const path = require('path');

// Abstracted data store to allow easy swapping to Firebase or Google Sheets
const DATA_FILE = path.join(__dirname, 'attendance.json');

async function getSessionsForToday(dateString) {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    return data.filter(session => session.date === dateString);
}

async function getSessionById(sessionId) {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    return data.find(session => session.sessionId === sessionId);
}

module.exports = { getSessionsForToday, getSessionById };

const express = require('express');
const path = require('path');
const { getSessionsForToday, getSessionById } = require('./data-store');
const { runAutomation } = require('./playwright-automation');

const app = express();
const PORT = 3000;

app.use(express.static('public'));
app.use(express.json());

// API: Get today's sessions
app.get('/api/sessions', async (req, res) => {
    // For prototype, using a fixed date to match our JSON. In prod, use: new Date().toISOString().split('T')[0]
    const today = "2026-08-06"; 
    try {
        const sessions = await getSessionsForToday(today);
        res.json(sessions);
    } catch (err) {
        res.status(500).json({ error: "Failed to read data store" });
    }
});

// API: Trigger Playwright upload
app.post('/api/upload', async (req, res) => {
    const { sessionId } = req.body;
    try {
        const sessionData = await getSessionById(sessionId);
        if (!sessionData) return res.status(404).json({ error: "Session not found" });
        
        // Run Playwright asynchronously in the background so we don't block the UI
        runAutomation(sessionData)
            .then(() => console.log(`Automation completed for ${sessionId}`))
            .catch(err => console.error(`Automation failed: ${err.message}`));
            
        res.json({ message: "Playwright automation started! Check the launched browser." });
    } catch (err) {
        res.status(500).json({ error: "Failed to start automation" });
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});

// Fetches absent list from the QR attendance server or cloud MongoDB API.
// Done here, not in the content script, because the ERP page's CORS/mixed-content rules
// would block a request from an https page to an http server.

// Allows localhost, local LAN IPs, or deployed cloud URLs (e.g. on Render, Railway, custom domain)
const ALLOWED_SERVER = /^https?:\/\/([a-zA-Z0-9.-]+)(:\d+)?$/;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;

  const base = String(msg.serverUrl || '').replace(/\/+$/, '');
  if (!ALLOWED_SERVER.test(base)) {
    sendResponse({ ok: false, error: 'Invalid server address. Use http://localhost:3001, LAN IP, or a cloud URL.' });
    return;
  }

  const headers = msg.profKey ? { 'X-Professor-Key': String(msg.profKey) } : {};

  // 1. Fetch latest or specific session directly from Cloud MongoDB
  if (msg.type === 'FETCH_CLOUD_LATEST' || msg.type === 'FETCH_CLOUD_SESSION') {
    const endpoint = msg.type === 'FETCH_CLOUD_LATEST'
      ? `${base}/api/cloud/sessions/latest`
      : `${base}/api/cloud/sessions/${encodeURIComponent(msg.sessionId)}`;

    fetch(endpoint, { headers })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        sendResponse({ ok: true, data: body.data });
      })
      .catch((err) => sendResponse({ ok: false, error: err.message || 'Cloud database endpoint not reachable.' }));
    return true;
  }

  // 2. Mark session as synced in MongoDB after attendance is entered
  if (msg.type === 'MARK_CLOUD_SYNCED') {
    const id = encodeURIComponent(msg.sessionId);
    fetch(`${base}/api/cloud/sessions/${id}/synced`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers }
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        sendResponse({ ok: res.ok, data: body.data });
      })
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // 3. Fallback / direct QR session fetch
  if (msg.type === 'FETCH_ABSENT') {
    const id = encodeURIComponent(msg.sessionId || 'latest');
    fetch(`${base}/api/sessions/${id}/absent`, { headers })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        sendResponse({ ok: true, data: body });
      })
      .catch((err) => sendResponse({ ok: false, error: err.message || 'Server not reachable.' }));
    return true;
  }
});

// Phase 2: QR attendance server (qr-server/). Used until the professor saves a different address
// in the panel's "Server settings" (needed when the server runs on the class-screen PC).
const DEFAULT_SERVER_URL = 'http://localhost:3001';

// --- UI INJECTION LOGIC ---
function injectUI() {
  if (document.getElementById('erp-automator-ui')) return;

  const tableRow = document.querySelector('td[id$="_tdRollNo"]');
  if (!tableRow) return; // Only inject if we are on the Attendance page

  const uiContainer = document.createElement('div');
  uiContainer.id = 'erp-automator-ui';
  uiContainer.style.cssText = `
    position: fixed; bottom: 20px; right: 20px;
    background: white; border: 2px solid #2563eb;
    padding: 15px; border-radius: 8px; z-index: 999999;
    box-shadow: 0px 4px 12px rgba(0,0,0,0.2);
    font-family: Arial, sans-serif; width: 250px;
  `;

  uiContainer.innerHTML = `
    <h3 style="margin: 0 0 10px 0; font-size: 14px; color: #333;">🤖 ERP Attendance Automator</h3>
    <details style="margin-bottom:8px; font-size:12px;">
      <summary style="cursor:pointer; color:#2563eb;">Server settings</summary>
      <input type="text" id="erp-server-url" placeholder="http://192.168.1.20:3001" style="width:100%; margin-top:6px; font-size:12px; padding:4px; box-sizing:border-box;" />
      <input type="password" id="erp-server-key" placeholder="Professor key" style="width:100%; margin-top:4px; font-size:12px; padding:4px; box-sizing:border-box;" />
      <button id="erp-server-save" style="width:100%; margin-top:4px; padding:5px; font-size:12px; cursor:pointer;">Save</button>
    </details>
    <div style="display:flex; gap:6px; margin-bottom:6px;">
      <input type="text" id="erp-qr-session" placeholder="Session code (blank = latest)" style="flex:1; min-width:0; font-size:12px; padding:4px;" />
    </div>
    <button id="erp-cloud-btn" style="
      width: 100%; padding: 7px; margin-bottom: 6px; background: #059669; color: white;
      border: none; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: bold;
    ">☁️ Fetch from Cloud (MongoDB)</button>
    <button id="erp-qr-btn" style="
      width: 100%; padding: 6px; margin-bottom: 8px; background: #4b5563; color: white;
      border: none; border-radius: 4px; cursor: pointer; font-size: 11px;
    ">Direct QR server fetch</button>
    <div style="font-size:11px; color:#888; margin-bottom:4px;">or upload a CSV:</div>
    <input type="file" id="erp-csv-upload" accept=".csv" style="margin-bottom: 10px; font-size: 12px; max-width: 100%;" />
    <div id="erp-status" style="font-size: 12px; color: #555; margin-bottom: 10px;">Ready. Fetch from Cloud or upload CSV.</div>
    <button id="erp-mark-btn" disabled style="
      width: 100%; padding: 8px; background: #cccccc; color: white;
      border: none; border-radius: 4px; cursor: not-allowed; font-weight: bold;
    ">Mark Attendance</button>
  `;

  document.body.appendChild(uiContainer);

  const fileInput = document.getElementById('erp-csv-upload');
  const markBtn = document.getElementById('erp-mark-btn');
  const statusTxt = document.getElementById('erp-status');
  const cloudBtn = document.getElementById('erp-cloud-btn');
  const qrBtn = document.getElementById('erp-qr-btn');
  const qrSession = document.getElementById('erp-qr-session');
  let absentPRNs = [];
  let loadedSessionId = null;

  // Server address + professor key, saved once in the browser (chrome.storage) and shared by all frames.
  const serverUrlInput = document.getElementById('erp-server-url');
  const serverKeyInput = document.getElementById('erp-server-key');
  let settings = { serverUrl: DEFAULT_SERVER_URL, profKey: '' };
  try {
    chrome.storage.local.get(settings, (saved) => {
      settings = { ...settings, ...saved };
      serverUrlInput.value = settings.serverUrl;
      serverKeyInput.value = settings.profKey;
    });
  } catch (e) {
    // extension was reloaded while this page was open: refresh the page
  }
  document.getElementById('erp-server-save').addEventListener('click', () => {
    let url = serverUrlInput.value.trim().replace(/\/+$/, '');
    if (url && !/^https?:\/\//i.test(url)) url = `http://${url}`;
    settings = { serverUrl: url || DEFAULT_SERVER_URL, profKey: serverKeyInput.value.trim() };
    serverUrlInput.value = settings.serverUrl;
    chrome.storage.local.set(settings, () => {
      statusTxt.style.color = 'green';
      statusTxt.textContent = 'Server settings saved.';
    });
  });

  // Shared by the CSV upload and the QR session loader.
  const enableMark = (message) => {
    statusTxt.textContent = message;
    statusTxt.style.color = 'green';
    markBtn.disabled = false;
    markBtn.style.background = '#2563eb';
    markBtn.style.cursor = 'pointer';
  };
  const showError = (message) => {
    statusTxt.textContent = message;
    statusTxt.style.color = '#b91c1c';
  };

  // 1. Fetch from Cloud MongoDB (Primary)
  cloudBtn.addEventListener('click', () => {
    statusTxt.style.color = '#555';
    statusTxt.textContent = 'Fetching attendance from MongoDB Cloud...';
    const specifiedSession = qrSession.value.trim();
    const fetchType = specifiedSession ? 'FETCH_CLOUD_SESSION' : 'FETCH_CLOUD_LATEST';

    chrome.runtime.sendMessage(
      { type: fetchType, serverUrl: settings.serverUrl, profKey: settings.profKey, sessionId: specifiedSession },
      (res) => {
        if (chrome.runtime.lastError || !res) return showError('Extension background not available. Reload extension.');
        if (!res.ok) return showError(`Cloud Error: ${res.error}`);

        const record = res.data;
        if (!record || !record.absentStudents) return showError('No attendance records found in MongoDB.');

        loadedSessionId = record.sessionId;
        absentPRNs = record.absentStudents.map((s) => String(s.prn).trim());
        const label = [record.className, record.subject].filter(Boolean).join(' ') || `Session ${record.sessionId}`;
        enableMark(`☁️ Loaded ${label} from MongoDB: ${record.presentCount}/${record.totalStudents} present, ${absentPRNs.length} absent.`);
      }
    );
  });

  // 2. Direct QR Server Fetch (Fallback)
  qrBtn.addEventListener('click', () => {
    statusTxt.style.color = '#555';
    statusTxt.textContent = 'Fetching from QR server...';
    chrome.runtime.sendMessage(
      { type: 'FETCH_ABSENT', serverUrl: settings.serverUrl, profKey: settings.profKey, sessionId: qrSession.value.trim() || 'latest' },
      (res) => {
        if (chrome.runtime.lastError || !res) return showError('Extension background not available. Reload the extension.');
        if (!res.ok) return showError(`QR server: ${res.error}`);

        const data = res.data;
        if (data.open && !confirm('The QR session is still open, so students may still check in. Load the list anyway?')) {
          return showError('Cancelled. End the session first.');
        }
        loadedSessionId = data.id;
        absentPRNs = data.absent.map((s) => String(s.prn).trim());
        enableMark(`Session ${data.id}: ${data.presentCount}/${data.total} present, ${absentPRNs.length} absent loaded.`);
      }
    );
  });

  // Zero-click flow: once a QR session closes, load its absent list automatically.
  // Only sessions that closed recently are picked up (so yesterday's list is never loaded by accident),
  // and each session is auto-loaded once. The professor still clicks Mark Attendance, then Save.
  const AUTO_KEY = 'erp-automator-last-auto-session';
  const AUTO_MAX_AGE_MS = 3 * 60 * 60 * 1000;
  const AUTO_POLL_MS = 5000;
  setInterval(() => {
    if (markBtn.innerText === 'Processing...') return;
    chrome.runtime.sendMessage(
      { type: 'FETCH_ABSENT', serverUrl: settings.serverUrl, profKey: settings.profKey, sessionId: 'latest' },
      (res) => {
        if (chrome.runtime.lastError || !res) return;
        if (!res.ok) {
          // Server simply not running yet: stay quiet. A key problem is worth telling the professor about.
          if (/key/i.test(res.error) && markBtn.disabled) showError(`QR server: ${res.error}`);
          return;
        }
        const data = res.data;
        if (data.open || !data.closedAt) return;
        if (Date.now() - data.closedAt > AUTO_MAX_AGE_MS) return;
        if (localStorage.getItem(AUTO_KEY) === data.id) return;

        localStorage.setItem(AUTO_KEY, data.id);
        absentPRNs = data.absent.map((s) => String(s.prn).trim());
        markBtn.innerText = 'Mark Attendance';
        enableMark(`Auto-loaded session ${data.id}: ${data.presentCount}/${data.total} present, ${absentPRNs.length} absent. Click Mark Attendance.`);
      }
    );
  }, AUTO_POLL_MS);

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Use PapaParse (which is now injected via manifest.json)
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: function(results) {
        if (results.data.length === 0) {
          statusTxt.innerText = 'CSV is empty.';
          return;
        }
        
        const keys = Object.keys(results.data[0]);
        const prnKey = keys.find(k => k.toLowerCase().includes('prn') || k.toLowerCase().includes('roll'));
        
        if (!prnKey) {
          statusTxt.innerText = 'Error: CSV must have PRN column.';
          return;
        }

        absentPRNs = results.data.map(row => String(row[prnKey]).trim()).filter(val => val !== "");
        enableMark(`Loaded ${absentPRNs.length} absent students!`);
      },
      error: function() {
        statusTxt.innerText = 'Error parsing CSV file.';
      }
    });
  });

  markBtn.addEventListener('click', async () => {
    markBtn.disabled = true;
    markBtn.style.background = '#cccccc';
    markBtn.innerText = 'Processing...';
    statusTxt.innerText = 'Clicking students... please wait.';

    const stats = await processAttendance(absentPRNs);
    
    // If loaded from a session, mark synced in MongoDB
    if (loadedSessionId) {
      chrome.runtime.sendMessage({
        type: 'MARK_CLOUD_SYNCED',
        serverUrl: settings.serverUrl,
        profKey: settings.profKey,
        sessionId: loadedSessionId
      });
    }

    statusTxt.innerHTML = `<b>Done!</b><br/>Marked Present: ${stats.present}<br/>Marked Absent: ${stats.absent}<br/><span style="color:#059669; font-size:11px;">☁️ Synced to MongoDB</span>`;
    markBtn.innerText = 'Finished';
  });
}

// Check every 2 seconds if the table has appeared (useful for single-page apps or delayed iframe loads)
setInterval(injectUI, 2000);
injectUI();

// --- ATTENDANCE CLICKING LOGIC ---
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const norm = s => String(s||'').trim().toUpperCase();
const matches = (cur, tgt) => { 
  const c=norm(cur), t=norm(tgt);
  return !!c && (c.startsWith(t.slice(0,4)) || t.startsWith(c.slice(0,4))); 
};

async function processAttendance(absentList) {
  let stats = { present: 0, absent: 0 };
  
  // Normalize absent list for easy matching
  const absentSet = new Set(absentList.map(prn => String(prn).trim()));
  
  // Find all student rows
  const rollCells = Array.from(document.querySelectorAll('td[id$="_tdRollNo"]'));
  
  for (const targetCell of rollCells) {
    const rollNo = targetCell.innerText.trim();
    if (!rollNo) continue;
    
    // Determine target status
    const targetStatus = absentSet.has(rollNo) ? 'ABSENT' : 'PRESENT';
    
    const rowId = targetCell.closest('tr').id;
    const ctl = rowId.replace(/_trStudRow$/, '');
    const spn = document.getElementById(`${ctl}_spn1`);
    const hdn = document.getElementById(`${ctl}_hdnONE`);
    
    if (!spn || !hdn) continue;
    
    spn.style.outline = '2px solid #2563eb';
    spn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    
    let currentStatus = hdn.value;
    let attempts = 0;
    
    while (!matches(currentStatus, targetStatus) && attempts < 5) {
      spn.click();
      await delay(250); // wait for ERP's javascript to update the hidden field
      currentStatus = hdn.value;
      attempts++;
    }
    
    if (targetStatus === 'ABSENT') stats.absent++;
    else stats.present++;
  }
  
  // Auto-Save feature removed for safety! 
  // Let the professor review the screen and click Save manually.
  alert(`✅ Attendance Automator Finished!\n\nMarked Present: ${stats.present}\nMarked Absent: ${stats.absent}\n\nPlease review the screen and manually click the "Update" button to save.`);
  
  return stats;
}

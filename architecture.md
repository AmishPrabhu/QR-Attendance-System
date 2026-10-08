# Attendance Automation Chrome Extension Architecture

## 1. Overall Architecture

The solution will be built as a **Manifest V3 Chrome Extension**. The extension operates on a strict separation of concerns, ensuring that the heavy lifting of data parsing is separated from the brittle nature of DOM manipulation.

The architecture consists of three main pillars:
1. **Popup Script**: Handles user interaction, file uploading (CSV/Excel), and data parsing. It acts as the controller.
2. **Content Script**: Injected into the ERP page. It acts as the executor, receiving structured data from the popup and interacting with the DOM.
3. **Configuration / DOM Abstraction Layer**: Decouples hardcoded ASP.NET Web Forms logic (IDs, classes) from the core business logic of the extension.

**Workflow**:
1. User uploads a CSV in the Popup.
2. Popup parses the CSV into a normalized JSON array (`[{ rollNumber: '101', status: 'P' }, ...]`).
3. Popup sends a message to the Content Script with the JSON payload.
4. Content Script reads the DOM, matches rows, simulates clicks, and reports back statistics (Total, Present, Absent, Not Found).
5. Popup displays the statistics to the user for review.
6. User manually clicks the ERP's native "Save" button on the webpage.

---

## 2. Folder Structure

```text
/
├── manifest.json
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── content/
│   ├── content-main.js         # Entry point for content script
│   ├── dom-manager.js          # DOM Abstraction Layer
│   └── matching-engine.js      # Row matching and mapping logic
├── config/
│   └── selectors.js            # Externalized CSS selectors & IDs
├── lib/
│   └── papaparse.min.js        # CSV Parsing library
├── background/
│   └── service-worker.js       # (Optional) For extension state management
└── assets/
    └── icons/                  # 16x16, 48x48, 128x128 icons
```

---

## 3. manifest.json (Manifest V3)

```json
{
  "manifest_version": 3,
  "name": "ERP Attendance Automator",
  "version": "1.0",
  "description": "Automates filling attendance on the college ERP system.",
  "permissions": [
    "activeTab",
    "scripting",
    "storage"
  ],
  "host_permissions": [
    "https://wic.walchandsangli.ac.in/*"
  ],
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": "assets/icons/icon-48.png"
  },
  "background": {
    "service_worker": "background/service-worker.js"
  },
  "content_scripts": [
    {
      "matches": ["https://wic.walchandsangli.ac.in/*"],
      "js": ["config/selectors.js", "content/dom-manager.js", "content/matching-engine.js", "content/content-main.js"],
      "run_at": "document_idle"
    }
  ]
}
```

---

## 4. Popup UI Design

The UI will be built with vanilla HTML/CSS focusing on a clean, responsive, and intuitive interface.

**Sections:**
1. **Header**: Extension Title & Status Indicator (e.g., 🔴 "Not on ERP page" vs 🟢 "Ready").
2. **File Upload Zone**: Drag-and-drop or click to upload CSV/Excel.
3. **Data Preview**: A small table showing parsed rows (e.g., "Found 65 valid records").
4. **Action Button**: A prominent "Mark Attendance" button (disabled until file is parsed).
5. **Statistics & Review Panel (Post-execution)**:
   - ✅ Present: `X`
   - ❌ Absent: `Y`
   - ⚠️ Not Found: `Z` (with a scrollable list of missing roll numbers).

---

## 5. Content Script Architecture

The Content Script is designed to be purely responsive to messages.
- **Message Listener**: Waits for a `START_ATTENDANCE` message containing the student data array.
- **Execution Flow**:
  1. Freeze UI/Show a loading overlay on the webpage to prevent user interference.
  2. Invoke `MatchingEngine` to process the data.
  3. Compile results.
  4. Unfreeze UI and send results back to Popup.

---

## 6. Config File (`selectors.js`)

Web Forms generates heavily nested and dynamic IDs. Hardcoding them in the logic makes the extension brittle. All selectors are stored here.

```javascript
const CONFIG = {
  TABLE_REPEATER: 'table[id$="rpttopiclist"]',
  ROW: 'tr[id^="rpttopiclist_ctl"]',
  ROLL_NO_CELL: 'td:nth-child(2)', // Example: assuming 2nd column is Roll No
  CHECKBOX_PRESENT: 'input[id$="_chktaught"]',
  CHECKBOX_ABSENT: 'input[id$="_chkabsent"]',
  SAVE_BUTTON: 'input[id$="btnPopUpSave"]'
};
```

---

## 7. DOM Abstraction Layer (`dom-manager.js`)

This layer isolates actual DOM manipulation. It prevents the core logic from dealing with raw HTML elements.

**Key Responsibilities:**
- Extracting all rows from the target table.
- Reading the Roll Number from a specific row safely.
- Simulating human interactions.

**Important Detail:** Instead of just changing `checkbox.checked = true`, we must dispatch a `change` and `click` event so that ASP.NET's internal JavaScript (which updates ViewState) registers the change.

```javascript
function simulateClick(element) {
  element.checked = true;
  element.dispatchEvent(new Event('change', { bubbles: true }));
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}
```

---

## 8. CSV Parser Strategy

- **Library**: `PapaParse` for CSV handling (lightweight, robust, no dependencies).
- **Strategy**: 
  - Read file in the popup using `FileReader`.
  - Pass the text to PapaParse.
  - Map the output to a standard format regardless of CSV column headers. Provide a UI step to map columns if headers are inconsistent (e.g., mapping "Roll" or "ID" to our internal `rollNumber` key).

---

## 9. Row Matching Algorithm (`matching-engine.js`)

An efficient mapping strategy to avoid O(N^2) loops:
1. **DOM Scrape**: Scrape the ERP page once and build a Hash Map (Dictionary) of the DOM elements.
   - `Key`: Roll Number (string, trimmed)
   - `Value`: HTMLTableRowElement
2. **Iteration**: Loop through the parsed CSV array.
3. **Lookup & Mutate**: 
   - `let row = domMap.get(csvRecord.rollNumber)`
   - If `row` exists: Call `DOMManager.markStatus(row, csvRecord.status)`.
   - If not: Push to `notFound` array.

---

## 10. Error Handling Strategy

- **Missing Selectors**: If `document.querySelector(CONFIG.TABLE_REPEATER)` returns null, immediately abort and send an error to the popup ("Attendance table not found on this page").
- **Malformed CSV**: Catch parsing errors in the popup and display validation messages before hitting the content script.
- **Graceful Degradation**: If a single row throws an error during marking, log it, increment an `errors` counter, and continue to the next student. Do not crash the entire loop.

---

## 11. Future Scalability

- **Multi-ERP Support**: By wrapping configuration in a Factory pattern, the extension could detect the URL and load different `selectors.js` for different portals.
- **Excel Support**: Drop in `SheetJS` (xlsx) alongside PapaParse to handle native Excel files.
- **Automated Logging**: Store history of applied attendances in `chrome.storage.local` so professors can look back at what they uploaded on a given day.

---

## 12. Technical Risks & Proposed Solutions

### Risk 1: Dynamic ASP.NET Client IDs
ASP.NET Web Forms changes IDs based on naming containers (e.g., `ctl00$MainContent$rpttopiclist$ctl01$chktaught`).
**Solution**: Use CSS attribute selectors. `input[id$='_chktaught']` (ends with) or `input[id*='rpttopiclist_ctl']` (contains) rather than exact matching.

### Risk 2: ASP.NET Event Validation & ViewState Corruptions
If you modify hidden fields or alter DOM elements that ASP.NET didn't render (or change form values in a way that bypasses client-side scripts), the server will throw an `Invalid postback or callback argument` error when the professor clicks Save.
**Solution**: Act strictly like a human. ONLY modify checkboxes/dropdowns by dispatching native DOM `change` and `click` events. Never manually mutate `__VIEWSTATE`, `__EVENTVALIDATION`, or hidden fields like `hdnPresent`/`hdnAbsent` directly—let the native scripts update them in response to our simulated clicks.

### Risk 3: Partial Postbacks (UpdatePanels)
If clicking a checkbox triggers an AJAX request (UpdatePanel), the DOM structure might be destroyed and recreated, invalidating our saved HTML elements.
**Solution**: 
- *Check first*: Observe if clicking a checkbox manually causes a network request or loading spinner.
- *If yes*: We must use a `MutationObserver` or implement a delay queue. Mark one row -> wait for DOM to settle -> mark next row.
- *If no (purely client-side logic)*: We can safely loop and mark all rapidly.

### Risk 4: Pagination
If the student list is paginated, the extension can only mark students on the current page.
**Solution**: 
- **Short term**: Notify the user ("Only students on the current page were marked. Please go to the next page and run again").
- **Long term**: Include instructions for the professor to set "Rows per page" to a maximum value before running the extension.

### Risk 5: Brittle Table Layouts
The exact column index of the "Roll Number" might change if the college adds new columns (e.g., "Student Name", "Email").
**Solution**: Instead of hardcoding `td:nth-child(2)`, inspect the table header (`<th>`) text during the initial DOM scrape to dynamically find the index of the column labeled "Roll No".

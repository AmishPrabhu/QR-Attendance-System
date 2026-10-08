# DOM Requirements & Extraction Guide

Because I am an AI, I do not have direct access to your college's ERP system (it requires authentication and is not public). To write the exact logic for your Chrome Extension, I need you to extract a few pieces of HTML from the live ERP page while you are logged in.

Please follow these instructions and provide the requested information.

## 1. Extracting a Student Row

We need to see exactly how the ERP structures a student's row in the attendance table. This will tell us if they use checkboxes, radio buttons, or dropdowns, and how the student's roll number is stored (e.g., as text, or inside a data attribute).

**Instructions:**
1. Log into the ERP and navigate to the attendance page.
2. Open your browser's Developer Tools (Press `F12` or `Ctrl+Shift+I`).
3. Go to the **Console** tab.
4. Run the following command and press Enter:
   ```javascript
   copy(document.querySelector('[id*="rptStudent"] tr, table tr:has(input[type=radio]), table tr:has(input[type=checkbox])')?.outerHTML)
   ```
   *(Note: If you know the exact table ID, you can run `copy(document.querySelector('#YOUR_TABLE_ID tbody tr').outerHTML)` instead).*
5. The HTML for one student's row is now copied to your clipboard.
6. **Paste that HTML directly back into our chat** (or into a new file in this workspace).

## 2. Confirm Toggle Vocabulary

Once you see the row (or by just looking at the page), please confirm:
- Are the attendance options (Present/Absent/Exemption) represented as **three radio buttons** per student?
- Or are they **checkboxes**? (e.g., check for present, uncheck for absent)
- Or something else? (e.g., a dropdown/select menu)

## 3. Extract the "Save Attendance" Button

We need the exact selector for the button the professor clicks to submit the attendance for the entire list.

**Instructions:**
1. Right-click the "Save" or "Update" button on the webpage and select **Inspect**.
2. Look at the highlighted element in the Elements tab.
3. Right-click that element in the DOM tree, go to **Copy** > **Copy outerHTML**.
4. **Paste that HTML here** as well.

---

**Next Steps:**
Once you provide the row HTML and the Save button HTML, I can finalize the `selectors.js` and write the exact, bulletproof DOM manipulation logic for the content script.

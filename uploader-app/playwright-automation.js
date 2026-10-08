const { chromium } = require('playwright');

// GUARDRAILS ENFORCED:
const CLICK_SAVE = false; // NEVER auto-save without review
const MAX_CYCLE_CLICKS = 5;

const DELAY = () => 600 + Math.floor(Math.random() * 200);
const norm = s => String(s||'').trim().toUpperCase();
const matches = (cur, tgt) => { const c=norm(cur), t=norm(tgt);
  return !!c && (c.startsWith(t.slice(0,4)) || t.startsWith(c.slice(0,4))); };

async function findFrameWith(page, selector, secs = 120) {
  for (let i = 0; i < secs; i++) {
    for (const f of page.frames()) if (await f.locator(selector).count().catch(()=>0) > 0) return f;
    await page.waitForTimeout(1000);
  }
  return null;
}

async function robustClick(loc) {
  await loc.scrollIntoViewIfNeeded().catch(()=>{});
  await loc.click({ force: true }).catch(async()=>{ await loc.dispatchEvent('click'); });
}

const TEST_MODE = true; // Set to false when ready for real ERP!

async function runAutomation(data) {
  console.log(`[Playwright] Loaded ${data.students.length} students; topic: "${data.topicDesc||'(none)'}"`);

  const browser = await chromium.launch({ headless:false, slowMo:300 });
  const context = browser.contexts()[0] || await browser.newContext();
  const page = context.pages()[0] || await context.newPage();
  
  if (TEST_MODE) {
      console.log('\n[Playwright] Running in TEST MODE! Navigating to local mock ERP...');
      await page.goto('http://localhost:3000/mock-attendance.html');
  } else {
      // Guardrail 1: Manual login enforced (due to Captcha)
      await page.goto('https://wic.walchandsangli.ac.in/ERP_Main.aspx');
      console.log('\n[Playwright] Please manually log in. Waiting for the Student Attendance page...');
      
      // Wait for the Date box inside the frame (this means they successfully navigated to the page)
      const frame = await findFrameWith(page, '#txtattendancedate', 120);
      if (frame) {
          console.log('[Playwright] Attendance Page detected! Automating Date and Class selection...');
          
          // 1. Fill Date (Today's Date)
          const dateInput = frame.locator('#txtattendancedate');
          const today = new Date();
          const d = String(today.getDate()).padStart(2, '0');
          const m = String(today.getMonth() + 1).padStart(2, '0');
          const y = today.getFullYear();
          await dateInput.fill(`${d}/${m}/${y}`);
          
          // 2. Click "Show"
          const showBtn = frame.locator('#btshow');
          await robustClick(showBtn);
          
          // Wait briefly for the class list to load
          await page.waitForTimeout(2000);
          
          // 3. Click the first available Class Link in the table
          const classLink = frame.locator('a[id$="_linkString"]').first();
          if (await classLink.count() > 0) {
              console.log('[Playwright] Clicking Class link...');
              await robustClick(classLink);
          } else {
              console.log('[Playwright] No class link found. Please select it manually.');
          }
      }
      
      console.log('[Playwright] Waiting for student list to load...');
  }

  // Wait for the attendance list to appear in the frame
  const frame = await findFrameWith(page, 'td[id$="_tdRollNo"]', 120);
  if (!frame) { 
      console.log('Attendance list not found. Timing out.'); 
      return; 
  }
  console.log(`[Playwright] Attendance list detected (${await frame.locator('td[id$="_tdRollNo"]').count()} students).`);

  // Topic Selection
  if (data.topicDesc) {
    const row = frame.locator('tr[id^="rpttopiclist_"]', { hasText: data.topicDesc }).first();
    if (await row.count() > 0) {
      const t = row.locator('input[id$="_chktaught"]');
      if (await t.count() > 0 && !(await t.isChecked().catch(()=>false)))
        await t.check({ force:true }).catch(async()=>{ await t.dispatchEvent('click'); });
      console.log(`[Playwright] Topic taught marked: "${data.topicDesc}"`);
    } else {
      console.log(`[Playwright] Topic "${data.topicDesc}" not found (skipped).`);
    }
  }

  // Student Attendance
  let done=0; const failed=[];
  for (const s of data.students) {
    const rollCell = frame.locator('td[id$="_tdRollNo"]', { hasText: new RegExp(`^\\s*${s.roll}\\s*$`) }).first();
    if (await rollCell.count() === 0) { failed.push(`${s.roll} (not in list)`); continue; }
    
    const rowId = await rollCell.evaluate(el => el.closest('tr')?.id || '');
    const ctl = rowId.replace(/_trStudRow$/, '');
    const spn = frame.locator(`#${ctl}_spn1`), hdn = frame.locator(`#${ctl}_hdnONE`);
    
    if (await spn.count() === 0) { failed.push(`${s.roll} (no status cell)`); continue; }
    
    await spn.evaluate(el => el.style.outline = '2px solid #2563eb');
    
    let cur = await hdn.inputValue().catch(()=> ''), n = 0;
    while (!matches(cur, s.status) && n < MAX_CYCLE_CLICKS) {
      await robustClick(spn); 
      await page.waitForTimeout(250);
      cur = await hdn.inputValue().catch(()=>cur); 
      n++;
    }
    if (matches(cur, s.status)) { console.log(`${s.roll}: ${cur}`); done++; }
    else { console.log(`${s.roll}: could NOT reach "${s.status}" (stuck "${cur}")`); failed.push(`${s.roll}`); }
    
    await page.waitForTimeout(DELAY());
  }
  
  console.log(`\n[Playwright] Set ${done}/${data.students.length}. Problems: ${failed.join(', ')||'none'}`);

  // Guardrail 2 & 3: Save button logic
  if (CLICK_SAVE) { 
    const b = frame.locator('#btnPopUpSave');
    if (await b.count()>0) { await robustClick(b); console.log('Clicked "Update".'); } 
  } else {
    console.log('\n>>> [Playwright] Review the attendance on screen, then click "Update" yourself.');
    console.log('>>> [Playwright] Script will NEVER click Save&Lock or Unlock.');
  }

  console.log('\n[Playwright] Done. Browser left open for review.');
  // Keep browser open
  await new Promise(()=>{});
}

module.exports = { runAutomation };

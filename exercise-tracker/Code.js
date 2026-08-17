// ─── CONFIG ───────────────────────────────────────────────────────────────────
const PLAN_TAB = 'Plan';
const LOG_TAB  = 'Log';

// ─── SERVE HTML ───────────────────────────────────────────────────────────────
function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Exercise Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ─── SHEET HELPERS ────────────────────────────────────────────────────────────
function getSheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}

function planHeaders() {
  return ['Version','ValidFrom','Day','Session','Exercise','Sets','Reps','Duration','Weight','Order','Active'];
}

function logHeaders() {
  return ['Date','Day','Session','Exercise','Order','PlannedSets','PlannedReps','PlannedDuration','PlannedWeight',
          'Status','ActualSets','ActualReps','ActualDuration','ActualWeight','Note','LoggedAt'];
}

function ensureHeaders() {
  const plan = getSheet(PLAN_TAB);
  const log  = getSheet(LOG_TAB);
  if (plan.getLastRow() === 0) plan.appendRow(planHeaders());
  if (log.getLastRow()  === 0) log.appendRow(logHeaders());
}

function sheetToObjects(sheet) {
  if (sheet.getLastRow() < 2) return [];
  const data    = sheet.getDataRange().getValues();
  const headers = data[0];
  // Date columns — Sheets returns these as JS Date objects, not strings
  const dateCols = new Set(['ValidFrom','Date','LoggedAt']);
  // Boolean columns — Sheets auto-converts typed TRUE/FALSE to native booleans,
  // which String() lowercases to "true"/"false", breaking === 'TRUE' checks.
  const boolCols = new Set(['Active']);
  return data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      const val = row[i];
      if (dateCols.has(h) && val instanceof Date) {
        // Format as ISO date string (yyyy-MM-dd) for date columns
        obj[h] = (h === 'LoggedAt') ? val.toISOString() : toIso(val);
      } else if (boolCols.has(h)) {
        obj[h] = (val === true || String(val).toUpperCase() === 'TRUE') ? 'TRUE' : 'FALSE';
      } else {
        obj[h] = String(val ?? '');
      }
    });
    return obj;
  });
}

function toIso(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function getDayName(date) {
  return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][date.getDay()];
}

function prevDay(isoStr) {
  const d = new Date(isoStr + 'T12:00:00');
  d.setDate(d.getDate() - 1);
  return toIso(d);
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toIso(d);
}

// ─── LOAD ALL — single call on app start ─────────────────────────────────────
// Returns everything the frontend needs: full plan, last 60 days of log, dashboard
function loadAll() {
  ensureHeaders();

  const planSheet = getSheet(PLAN_TAB);
  const logSheet  = getSheet(LOG_TAB);
  const planRows  = sheetToObjects(planSheet);
  const logRows   = sheetToObjects(logSheet);
  const today     = toIso(new Date());

  // ── PLAN: active exercises per day+session ──────────────────────────────
  // For each day, find the latest active version valid on or before today.
  // We use today's date for all days — the plan is the same regardless of
  // which calendar date we're looking at (it's a weekly recurring schedule).
  const days = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const plan = {};

  days.forEach(day => {
    // Get all active rows for this day, valid on or before today
    const dayRows = planRows.filter(r =>
      r.Active === 'TRUE' &&
      r.Day === day &&
      r.ValidFrom <= today
    );

    // For each exercise name, keep only the latest version
    const byExercise = {};
    dayRows.forEach(r => {
      if (!byExercise[r.Exercise] || r.ValidFrom > byExercise[r.Exercise].ValidFrom) {
        byExercise[r.Exercise] = r;
      }
    });

    const allEx = Object.values(byExercise);
    plan[day] = {
      morning: allEx.filter(r => r.Session === 'Morning').sort((a,b) => +a.Order - +b.Order).map(r => planRowToEx(r)),
      evening: allEx.filter(r => r.Session === 'Evening').sort((a,b) => +a.Order - +b.Order).map(r => planRowToEx(r))
    };
  });

  // ── LOG: last 60 days ───────────────────────────────────────────────────
  const cutoff = daysAgo(60);
  const recentLog = logRows.filter(r => r.Date >= cutoff);

  // ── DASHBOARD ───────────────────────────────────────────────────────────
  const dashboard = buildDashboard(logRows, today);

  return { plan, log: recentLog, dashboard, today, dayName: getDayName(new Date()) };
}

function planRowToEx(r) {
  return {
    exercise: r.Exercise,
    session:  r.Session,
    sets:     r.Sets,
    reps:     r.Reps,
    duration: r.Duration,
    weight:   r.Weight,
    order:    r.Order
  };
}

// ─── LOG EXERCISE ─────────────────────────────────────────────────────────────
function logExercise(payload) {
  const sheet     = getSheet(LOG_TAB);
  const planSheet = getSheet(PLAN_TAB);
  const dateIso   = payload.date || toIso(new Date());
  const planRows  = sheetToObjects(planSheet);

  const planRow = planRows.filter(r =>
    r.Active === 'TRUE' &&
    r.Day === payload.day &&
    r.Session === payload.session &&
    r.Exercise === payload.exercise &&
    r.ValidFrom <= dateIso
  ).sort((a,b) => b.ValidFrom.localeCompare(a.ValidFrom))[0] || {};

  const logRows    = sheetToObjects(sheet);
  const existingIdx = logRows.findIndex(r =>
    r.Date === dateIso && r.Session === payload.session && r.Exercise === payload.exercise
  );

  const newRow = [
    dateIso, payload.day, payload.session, payload.exercise,
    planRow.Order || '',
    planRow.Sets || '', planRow.Reps || '', planRow.Duration || '', planRow.Weight || '',
    payload.status,
    payload.actualSets || '', payload.actualReps || '',
    payload.actualDuration || '', payload.actualWeight || '',
    payload.note || '',
    new Date().toISOString()
  ];

  if (existingIdx >= 0) {
    sheet.getRange(existingIdx + 2, 1, 1, newRow.length).setValues([newRow]);
  } else {
    sheet.appendRow(newRow);
  }
  return { success: true };
}

// ─── BATCH LOG — write multiple entries at once (debounced from frontend) ─────
function batchLog(entries) {
  entries.forEach(e => logExercise(e));
  return { success: true, count: entries.length };
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function buildDashboard(logRows, today) {
  // Streak
  const doneDates = [...new Set(
    logRows.filter(r => r.Status === 'done' || r.Status === 'modified').map(r => r.Date)
  )].sort().reverse();

  let streak = 0;
  let cursor = today;
  for (const d of doneDates) {
    if (d === cursor) { streak++; cursor = prevDay(cursor); }
    else if (d < cursor) break;
  }

  // Per-exercise history (last 16 entries each)
  const byExercise = {};
  logRows.forEach(r => {
    if (!byExercise[r.Exercise]) byExercise[r.Exercise] = [];
    byExercise[r.Exercise].push({
      date: r.Date, status: r.Status,
      plannedReps: r.PlannedReps, actualReps:  r.ActualReps  || r.PlannedReps,
      plannedSets: r.PlannedSets, actualSets:  r.ActualSets  || r.PlannedSets,
      plannedDuration: r.PlannedDuration, actualDuration: r.ActualDuration || r.PlannedDuration,
      plannedWeight: r.PlannedWeight, actualWeight: r.ActualWeight || r.PlannedWeight,
    });
  });
  Object.keys(byExercise).forEach(k => {
    byExercise[k] = byExercise[k].sort((a,b) => a.date.localeCompare(b.date)).slice(-16);
  });

  // Last 28 days consistency
  const consistency = [];
  for (let i = 27; i >= 0; i--) {
    const d = daysAgo(i);
    const dayRows = logRows.filter(r => r.Date === d);
    consistency.push({
      date: d, total: dayRows.length,
      done:    dayRows.filter(r => r.Status === 'done' || r.Status === 'modified').length,
      skipped: dayRows.filter(r => r.Status === 'skipped').length
    });
  }

  // Planned vs actual per exercise
  const planVsActual = {};
  Object.keys(byExercise).forEach(ex => {
    planVsActual[ex] = byExercise[ex].map(e => ({
      date: e.date,
      plannedReps: +e.plannedReps || 0,
      actualReps:  +e.actualReps  || 0,
    }));
  });

  return { streak, byExercise, consistency, planVsActual };
}

function getDashboard() {
  const logSheet = getSheet(LOG_TAB);
  const logRows  = sheetToObjects(logSheet);
  return buildDashboard(logRows, toIso(new Date()));
}

// ─── HISTORY ──────────────────────────────────────────────────────────────────
function getHistory(page) {
  const sheet = getSheet(LOG_TAB);
  const rows  = sheetToObjects(sheet);
  const pageSize = 40;
  const start = ((page || 1) - 1) * pageSize;

  const byDate = {};
  rows.forEach(r => {
    if (!byDate[r.Date]) byDate[r.Date] = [];
    byDate[r.Date].push(r);
  });

  const dates     = Object.keys(byDate).sort().reverse();
  const pageDates = dates.slice(start, start + pageSize);

  return {
    page: +page, totalDates: dates.length,
    entries: pageDates.map(d => ({ date: d, exercises: byDate[d] }))
  };
}

// ─── PLAN EDITOR ──────────────────────────────────────────────────────────────
function updatePlan(payload) {
  const sheet   = getSheet(PLAN_TAB);
  const rows    = sheetToObjects(sheet);
  const dateIso = toIso(new Date());

  const idx = rows.findIndex(r =>
    r.Active === 'TRUE' &&
    r.Day === payload.day &&
    r.Session === payload.session &&
    r.Exercise === payload.exercise
  );
  if (idx < 0) return { error: 'Exercise not found' };

  const current = { ...rows[idx] };
  sheet.getRange(idx + 2, planHeaders().indexOf('Active') + 1).setValue('FALSE');

  const maxVersion = Math.max(...rows.map(r => +r.Version || 0));
  Object.assign(current, payload.fields);
  current.Version   = maxVersion + 1;
  current.ValidFrom = dateIso;
  current.Active    = 'TRUE';
  sheet.appendRow(planHeaders().map(h => current[h] || ''));
  return { success: true };
}

function addExercise(payload) {
  const sheet   = getSheet(PLAN_TAB);
  const rows    = sheetToObjects(sheet);
  const dateIso = toIso(new Date());
  const maxVer  = Math.max(...rows.map(r => +r.Version || 0), 0);
  const sessRows = rows.filter(r =>
    r.Active === 'TRUE' && r.Day === payload.day && r.Session === payload.session
  );
  const maxOrder = Math.max(...sessRows.map(r => +r.Order || 0), 0);
  sheet.appendRow([
    maxVer + 1, dateIso, payload.day, payload.session, payload.exercise,
    payload.sets || '', payload.reps || '', payload.duration || '', payload.weight || '',
    maxOrder + 1, 'TRUE'
  ]);
  return { success: true };
}

function removeExercise(payload) {
  const sheet = getSheet(PLAN_TAB);
  const rows  = sheetToObjects(sheet);
  const idx   = rows.findIndex(r =>
    r.Active === 'TRUE' &&
    r.Day === payload.day &&
    r.Session === payload.session &&
    r.Exercise === payload.exercise
  );
  if (idx < 0) return { error: 'Not found' };
  sheet.getRange(idx + 2, planHeaders().indexOf('Active') + 1).setValue('FALSE');
  return { success: true };
}

// ─── SETUP — run once manually ────────────────────────────────────────────────
function setupInitialPlan() {
  ensureHeaders();
  const sheet = getSheet(PLAN_TAB);
  if (sheet.getLastRow() > 1) sheet.deleteRows(2, sheet.getLastRow() - 1);

  const today = toIso(new Date());
  const morning = [
    ['Cat-cow',                  '','','2 min','',1],
    ["World's Greatest Stretch", '','','2 min','',2],
    ['Dead bug',                 '2','8','',   '',3],
    ['Clam Shell',               '3','15','',  '',4],
    ['Glute Bridge',             '3','12','',  '',5],
    ['Single-leg Glute Bridge',  '2','8', '',  '',6],
    ['IYT on TRX',               '1','10','',  '',7],
  ];
  const strength = [
    ['TRX Squat',              '3','10','','',1],
    ['Romanian Deadlift (RDL)','3','10','','',2],
    ['TRX Pulls',              '3','10','','',3],
  ];
  const rowing = [['Rowing','','','25 min','',1]];
  const days   = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

  let v = 1;
  const rows = [];
  days.forEach(day => {
    morning.forEach(([ex,s,r,d,w,o]) => rows.push([v++,today,day,'Morning',ex,s,r,d,w,o,'TRUE']));
    if (['Monday','Wednesday','Friday'].includes(day))
      strength.forEach(([ex,s,r,d,w,o]) => rows.push([v++,today,day,'Evening',ex,s,r,d,w,o,'TRUE']));
    else if (['Tuesday','Thursday','Saturday'].includes(day))
      rowing.forEach(([ex,s,r,d,w,o]) => rows.push([v++,today,day,'Evening',ex,s,r,d,w,o,'TRUE']));
    // Sunday: morning only
  });
  rows.forEach(r => sheet.appendRow(r));
  return { success: true, rowsAdded: rows.length };
}

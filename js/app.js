import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getFirestore, collection, getDocs, addDoc, updateDoc, deleteDoc, setDoc, doc, query, where
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const fbApp = initializeApp(firebaseConfig);
const db = getFirestore(fbApp);

// ── APP STATE ────────────────────────────────────────────────────────────────
const appState = {
  plan:      {},   // { Monday: { morning: [], evening: [] }, ... }
  log:       [],   // recent log rows from Firestore
  planRowsRaw: [],  // raw plan docs incl. Firestore doc id, all versions
  dashboard: null,
  today:     '',   // ISO date string
  dayName:   '',   // 'Monday' etc
  // Runtime session log (what user has done today, keyed by session|exercise)
  sessionLog: {}
};

// ── DATE HELPERS (local-time safe — no UTC-shift near midnight) ──────────────
function toIso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function getDayName(date) {
  return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][date.getDay()];
}
function getDateDayName(iso) { return getDayName(new Date(iso + 'T12:00:00')); }
function prevDay(isoStr) { const d = new Date(isoStr + 'T12:00:00'); d.setDate(d.getDate() - 1); return toIso(d); }
function nextDay(isoStr) { const d = new Date(isoStr + 'T12:00:00'); d.setDate(d.getDate() + 1); return toIso(d); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return toIso(d); }

const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

// ── PLAN RESOLUTION (ported from Code.js) ─────────────────────────────────────
// For a given day-of-week, the exercises active as of a specific date —
// i.e. the latest plan version per exercise with ValidFrom <= dateIso.
function resolveDayPlan(day, dateIso, planRows) {
  const dayRows = planRows.filter(r => r.Active === true && r.Day === day && r.ValidFrom <= dateIso);
  const byExercise = {};
  dayRows.forEach(r => {
    if (!byExercise[r.Exercise] || r.ValidFrom > byExercise[r.Exercise].ValidFrom) {
      byExercise[r.Exercise] = r;
    }
  });
  return Object.values(byExercise);
}

// A planned exercise with no matching log row on a past date counts as an
// implicit skip. Synthesize placeholder rows for those so History/Progress
// see them without needing an explicit "Skip" action from the user.
function fillSkippedEntries(logRows, planRows, cutoff, today) {
  const logged = new Set(logRows.map(r => r.Date + '|' + r.Session + '|' + r.Exercise));
  const synthetic = [];
  for (let d = cutoff; d < today; d = nextDay(d)) {
    const day = getDateDayName(d);
    resolveDayPlan(day, d, planRows).forEach(r => {
      const key = d + '|' + r.Session + '|' + r.Exercise;
      if (logged.has(key)) return;
      synthetic.push({
        Date: d, Day: day, Session: r.Session, Exercise: r.Exercise, Order: r.Order,
        PlannedSets: r.Sets, PlannedReps: r.Reps, PlannedDuration: r.Duration, PlannedWeight: r.Weight,
        Status: 'skipped',
        ActualSets: '', ActualReps: '', ActualDuration: '', ActualWeight: '', Note: '', LoggedAt: ''
      });
    });
  }
  return logRows.concat(synthetic);
}

function planRowToEx(r) {
  return { exercise: r.Exercise, session: r.Session, sets: r.Sets, reps: r.Reps, duration: r.Duration, weight: r.Weight, order: r.Order };
}

// ── DASHBOARD (ported from Code.js) ───────────────────────────────────────────
function buildDashboard(logRows, today) {
  const doneDates = [...new Set(
    logRows.filter(r => r.Status === 'done' || r.Status === 'modified').map(r => r.Date)
  )].sort().reverse();

  let streak = 0;
  let cursor = today;
  for (const d of doneDates) {
    if (d === cursor) { streak++; cursor = prevDay(cursor); }
    else if (d < cursor) break;
  }

  // A skipped day should show as 0 done, not silently fall back to the
  // planned value (which would make it look identical to "done as planned").
  const byExercise = {};
  logRows.forEach(r => {
    if (!byExercise[r.Exercise]) byExercise[r.Exercise] = [];
    const skipped = r.Status === 'skipped';
    byExercise[r.Exercise].push({
      date: r.Date, status: r.Status,
      plannedReps: r.PlannedReps, actualReps:  skipped ? 0 : (r.ActualReps  || r.PlannedReps),
      plannedSets: r.PlannedSets, actualSets:  skipped ? 0 : (r.ActualSets  || r.PlannedSets),
      plannedDuration: r.PlannedDuration, actualDuration: skipped ? '' : (r.ActualDuration || r.PlannedDuration),
      plannedWeight: r.PlannedWeight, actualWeight: skipped ? '' : (r.ActualWeight || r.PlannedWeight),
    });
  });
  Object.keys(byExercise).forEach(k => {
    byExercise[k] = byExercise[k].sort((a,b) => a.date.localeCompare(b.date)).slice(-16);
  });

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

  const planVsActual = {};
  Object.keys(byExercise).forEach(ex => {
    planVsActual[ex] = byExercise[ex].map(e => ({
      date: e.date, plannedReps: +e.plannedReps || 0, actualReps: +e.actualReps || 0,
    }));
  });

  return { streak, byExercise, consistency, planVsActual };
}

// ── FIRESTORE DATA LAYER ───────────────────────────────────────────────────────
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }
function logDocId(date, session, exercise) { return `${date}_${session}_${slug(exercise)}`; }

async function loadAll() {
  const planSnap = await getDocs(collection(db, 'plan'));
  const planRowsRaw = planSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  appState.planRowsRaw = planRowsRaw;

  const today  = toIso(new Date());
  const cutoff = daysAgo(60);

  const logSnap = await getDocs(query(collection(db, 'log'), where('Date', '>=', cutoff)));
  const logRows = logSnap.docs.map(d => d.data());

  const plan = {};
  DAYS.forEach(day => {
    const allEx = resolveDayPlan(day, today, planRowsRaw);
    plan[day] = {
      morning: allEx.filter(r => r.Session === 'Morning').sort((a,b) => +a.Order - +b.Order).map(planRowToEx),
      evening: allEx.filter(r => r.Session === 'Evening').sort((a,b) => +a.Order - +b.Order).map(planRowToEx)
    };
  });

  const recentLog = fillSkippedEntries(logRows, planRowsRaw, cutoff, today);
  const dashboard = buildDashboard(recentLog, today);

  return { plan, log: recentLog, dashboard, today, dayName: getDayName(new Date()) };
}

async function logExercise(payload) {
  const dateIso = payload.date;
  const planRow = appState.planRowsRaw.filter(r =>
    r.Active === true && r.Day === payload.day && r.Session === payload.session &&
    r.Exercise === payload.exercise && r.ValidFrom <= dateIso
  ).sort((a,b) => b.ValidFrom.localeCompare(a.ValidFrom))[0] || {};

  const newRow = {
    Date: dateIso, Day: payload.day, Session: payload.session, Exercise: payload.exercise,
    Order: planRow.Order || '',
    PlannedSets: planRow.Sets || '', PlannedReps: planRow.Reps || '',
    PlannedDuration: planRow.Duration || '', PlannedWeight: planRow.Weight || '',
    Status: payload.status,
    ActualSets: payload.actualSets || '', ActualReps: payload.actualReps || '',
    ActualDuration: payload.actualDuration || '', ActualWeight: payload.actualWeight || '',
    Note: payload.note || '',
    LoggedAt: new Date().toISOString()
  };
  return setDoc(doc(db, 'log', logDocId(dateIso, payload.session, payload.exercise)), newRow);
}

// Un-log an exercise (e.g. the user unchecks it again before it's over) so
// it reverts to being implicitly skipped rather than leaving a stale row.
function removeLog(payload) {
  return deleteDoc(doc(db, 'log', logDocId(payload.date, payload.session, payload.exercise)));
}

async function updatePlan(payload) {
  const rows    = appState.planRowsRaw;
  const dateIso = toIso(new Date());
  const current = rows.find(r => r.Active === true && r.Day === payload.day && r.Session === payload.session && r.Exercise === payload.exercise);
  if (!current) return;

  const maxVersion = Math.max(...rows.map(r => +r.Version || 0));
  await updateDoc(doc(db, 'plan', current.id), { Active: false });
  current.Active = false;

  const updated = { ...current };
  delete updated.id;
  Object.assign(updated, payload.fields, { Version: String(maxVersion + 1), ValidFrom: dateIso, Active: true });
  const ref = await addDoc(collection(db, 'plan'), updated);
  rows.push({ id: ref.id, ...updated });
}

async function addExercise(payload) {
  const rows = appState.planRowsRaw;
  const dateIso = toIso(new Date());
  const maxVer = Math.max(...rows.map(r => +r.Version || 0), 0);
  const sessRows = rows.filter(r => r.Active === true && r.Day === payload.day && r.Session === payload.session);
  const maxOrder = Math.max(...sessRows.map(r => +r.Order || 0), 0);
  const newRow = {
    Version: String(maxVer + 1), ValidFrom: dateIso, Day: payload.day, Session: payload.session,
    Exercise: payload.exercise, Sets: payload.sets || '', Reps: payload.reps || '',
    Duration: payload.duration || '', Weight: payload.weight || '',
    Order: String(maxOrder + 1), Active: true
  };
  const ref = await addDoc(collection(db, 'plan'), newRow);
  rows.push({ id: ref.id, ...newRow });
}

async function removeExercise(payload) {
  const rows = appState.planRowsRaw;
  const current = rows.find(r => r.Active === true && r.Day === payload.day && r.Session === payload.session && r.Exercise === payload.exercise);
  if (!current) return;
  await updateDoc(doc(db, 'plan', current.id), { Active: false });
  current.Active = false;
}

// ── PENDING-WRITE INDICATOR — spinner while any Firestore write is in flight ──
let pendingWrites = 0;
function trackWrite(promise) {
  pendingWrites++;
  updateSyncIndicator();
  promise.then(() => {
    pendingWrites--;
    updateSyncIndicator();
  }).catch(err => {
    pendingWrites--;
    updateSyncIndicator();
    console.error(err);
  });
}

function updateSyncIndicator() {
  const el = document.getElementById('sync-indicator');
  if (!el) return;
  if (pendingWrites > 0) {
    el.classList.remove('done');
    el.classList.add('visible', 'syncing');
  } else if (el.classList.contains('visible')) {
    el.classList.remove('syncing');
    el.classList.add('done');
    setTimeout(() => {
      if (pendingWrites === 0) el.classList.remove('visible', 'done');
    }, 1500);
  }
}

// ── UTILS ────────────────────────────────────────────────────────────────────
function formatDate(iso) {
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString(undefined, { weekday:'long', month:'short', day:'numeric' });
}

function fmtTarget(ex) {
  const p = [];
  if (ex.sets && ex.reps) p.push(ex.sets + ' × ' + ex.reps);
  else if (ex.reps)       p.push(ex.reps + ' reps');
  if (ex.duration) p.push(ex.duration);
  if (ex.weight)   p.push(ex.weight);
  return p.join(' · ') || '—';
}

function fmtActual(ex) {
  const p = [];
  if (ex.actualSets && ex.actualReps) p.push(ex.actualSets + ' × ' + ex.actualReps);
  else if (ex.actualReps) p.push(ex.actualReps + ' reps');
  if (ex.actualDuration) p.push(ex.actualDuration);
  if (ex.actualWeight)   p.push(ex.actualWeight);
  return p.join(' · ');
}

function esc(s) { return String(s).replace(/'/g, "\\'").replace(/"/g, '&quot;'); }

// ── INIT ─────────────────────────────────────────────────────────────────────
let currentDate = toIso(new Date());

function initApp(data) {
  appState.plan      = data.plan;
  appState.log       = data.log;
  appState.dashboard = data.dashboard;
  appState.today     = data.today;
  appState.dayName   = data.dayName;

  appState.log.forEach(row => {
    if (row.Date === currentDate) {
      const key = row.Session + '|' + row.Exercise;
      appState.sessionLog[key] = {
        status:         row.Status,
        actualSets:     row.ActualSets,
        actualReps:     row.ActualReps,
        actualDuration: row.ActualDuration,
        actualWeight:   row.ActualWeight,
        note:           row.Note
      };
    }
  });

  document.getElementById('loading-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  renderToday();
}

loadAll().then(initApp).catch(err => {
  document.querySelector('#loading-screen p').textContent = 'Error loading data. Please reload.';
  console.error(err);
});

// ── TABS ─────────────────────────────────────────────────────────────────────
let activeTab = 'today';
function switchTab(tab) {
  if (activeTab === tab) return;
  activeTab = tab;
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
  document.getElementById('screen-' + tab).classList.add('active');
  document.getElementById('nav-' + tab).classList.add('active');
  if (tab === 'today')    renderToday();
  if (tab === 'history')  renderHistory();
  if (tab === 'progress') renderProgress();
  if (tab === 'plan')     renderPlanScreen();
}

// ── TODAY ─────────────────────────────────────────────────────────────────────
function getExStatus(session, exercise) {
  const key = session + '|' + exercise;
  return appState.sessionLog[key] || { status: 'pending' };
}

function renderToday() {
  const dayName = getDateDayName(currentDate);
  const plan    = appState.plan[dayName] || { morning: [], evening: [] };

  document.getElementById('today-title').textContent = dayName;
  document.getElementById('topbar-date').textContent  = formatDate(currentDate).split(',')[1].trim();
  document.getElementById('date-input').value         = currentDate;

  let html = '';
  if (plan.morning.length) {
    const statuses = plan.morning.map(ex => getExStatus('Morning', ex.exercise).status);
    const done = statuses.filter(s => s !== 'pending').length;
    html += `<div class="section-header">
      <span class="section-dot" style="background:var(--orange)"></span>
      <span class="section-title">Morning</span>
      <span class="section-count">${done}/${plan.morning.length}</span>
    </div>`;
    plan.morning.forEach(ex => { html += exCard(ex, 'Morning'); });
  }

  if (plan.evening.length) {
    const statuses = plan.evening.map(ex => getExStatus('Evening', ex.exercise).status);
    const done = statuses.filter(s => s !== 'pending').length;
    const isRowing = ['Tuesday','Thursday','Saturday'].includes(dayName);
    html += `<div class="section-header">
      <span class="section-dot" style="background:${isRowing ? 'var(--blue)' : 'var(--accent)'}"></span>
      <span class="section-title">Evening</span>
      <span class="section-count">${done}/${plan.evening.length}</span>
    </div>`;
    plan.evening.forEach(ex => { html += exCard(ex, 'Evening'); });
  }

  if (!plan.morning.length && !plan.evening.length) {
    html = '<div class="empty"><div class="empty-icon">🌿</div><p>Rest day — enjoy it.</p></div>';
  }

  document.getElementById('today-content').innerHTML = html;
}

function exCard(ex, session) {
  const logged = getExStatus(session, ex.exercise);
  const s      = logged.status || 'pending';
  const checkSvg = s === 'skipped'
    ? `<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`
    : `<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>`;
  const actual = logged.actualSets || logged.actualReps || logged.actualDuration || logged.actualWeight
    ? fmtActual({ actualSets: logged.actualSets, actualReps: logged.actualReps, actualDuration: logged.actualDuration, actualWeight: logged.actualWeight })
    : '';
  return `<div class="exercise-card status-${s}">
    <div class="exercise-row">
      <div class="ex-check ${s}" onclick="quickDone('${session}','${esc(ex.exercise)}')">${checkSvg}</div>
      <div class="ex-info">
        <div class="ex-name">${ex.exercise}</div>
        <div class="ex-target">${fmtTarget(ex)}</div>
        ${actual ? `<div class="ex-actual">Done: ${actual}</div>` : ''}
        ${logged.note ? `<div class="ex-note">${logged.note}</div>` : ''}
      </div>
      <button class="icon-btn" onclick="openLogModal('${session}','${esc(ex.exercise)}')">
        <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
    </div>
  </div>`;
}

// Keep appState.log (History's data source) in sync with an optimistic local
// edit, so History/Progress reflect changes immediately without a reload.
// fields=null means "un-log this", removing any local row for it.
function upsertLocalLog(date, day, session, exercise, planned, fields) {
  const idx = appState.log.findIndex(r => r.Date === date && r.Session === session && r.Exercise === exercise);
  if (!fields) {
    if (idx >= 0) appState.log.splice(idx, 1);
    return;
  }
  if (idx >= 0) {
    Object.assign(appState.log[idx], {
      Status: fields.status, ActualSets: fields.actualSets, ActualReps: fields.actualReps,
      ActualDuration: fields.actualDuration, ActualWeight: fields.actualWeight, Note: fields.note
    });
  } else {
    appState.log.push({
      Date: date, Day: day, Session: session, Exercise: exercise, Order: '',
      PlannedSets: planned.sets || '', PlannedReps: planned.reps || '',
      PlannedDuration: planned.duration || '', PlannedWeight: planned.weight || '',
      Status: fields.status, ActualSets: fields.actualSets, ActualReps: fields.actualReps,
      ActualDuration: fields.actualDuration, ActualWeight: fields.actualWeight,
      Note: fields.note, LoggedAt: new Date().toISOString()
    });
  }
}

function quickDone(session, exercise) {
  const key     = session + '|' + exercise;
  const logged  = appState.sessionLog[key] || {};
  const dayName = getDateDayName(currentDate);
  const plan    = appState.plan[dayName] || { morning:[], evening:[] };
  const arr     = session === 'Morning' ? plan.morning : plan.evening;
  const ex      = arr.find(e => e.exercise === exercise);
  if (!ex) return;

  const newStatus = logged.status === 'done' ? 'pending' : 'done';

  if (newStatus === 'pending') {
    // Un-ticking reverts to "not logged", which counts as an implicit skip
    // for any day but today (today just isn't over yet).
    delete appState.sessionLog[key];
    upsertLocalLog(currentDate, dayName, session, exercise, null, null);
    trackWrite(removeLog({ date: currentDate, session, exercise }));
  } else {
    const fields = { status: 'done', actualSets: ex.sets, actualReps: ex.reps,
      actualDuration: ex.duration, actualWeight: ex.weight, note: '' };
    appState.sessionLog[key] = fields;
    upsertLocalLog(currentDate, dayName, session, exercise, ex, fields);
    trackWrite(logExercise({ date: currentDate, day: dayName, session, exercise, ...fields }));
  }
  renderToday();
  if (activeTab === 'history') renderHistory();
}

// ── LOG MODAL ────────────────────────────────────────────────────────────────
// Opened either from Today (currentDate, live plan) or from History (an
// arbitrary past date, using that date's planned/logged values).
let editingEx = null;

function openLogModal(session, exercise) {
  const dayName = getDateDayName(currentDate);
  const plan    = appState.plan[dayName] || { morning:[], evening:[] };
  const arr     = session === 'Morning' ? plan.morning : plan.evening;
  const ex      = arr.find(e => e.exercise === exercise);
  if (!ex) return;
  showLogModal(currentDate, dayName, session, exercise, ex, getExStatus(session, exercise));
}

function openHistoryLogModal(dateIso, session, exercise) {
  const entry = appState.log.find(r => r.Date === dateIso && r.Session === session && r.Exercise === exercise);
  if (!entry) return;
  const dayName = entry.Day || getDateDayName(dateIso);
  const planned = { sets: entry.PlannedSets, reps: entry.PlannedReps, duration: entry.PlannedDuration, weight: entry.PlannedWeight };
  const logged  = entry.Status && entry.Status !== 'skipped'
    ? { status: entry.Status, actualSets: entry.ActualSets, actualReps: entry.ActualReps, actualDuration: entry.ActualDuration, actualWeight: entry.ActualWeight, note: entry.Note }
    : { status: 'pending' };
  showLogModal(dateIso, dayName, session, exercise, planned, logged);
}

function showLogModal(date, day, session, exercise, planned, logged) {
  editingEx = { date, day, session, exercise, planned };
  document.getElementById('modal-ex-name').textContent      = exercise;
  document.getElementById('modal-planned-info').textContent = 'Plan: ' + fmtTarget(planned);
  document.getElementById('modal-sets').value     = logged.actualSets     || planned.sets     || 0;
  document.getElementById('modal-reps').value     = logged.actualReps     || planned.reps     || 0;
  document.getElementById('modal-duration').value = logged.actualDuration || planned.duration || '';
  document.getElementById('modal-weight').value   = logged.actualWeight   || planned.weight   || '';
  document.getElementById('modal-note').value     = logged.note || '';
  openModal('log-modal');
}

function commitLog(status) {
  const { date, day, session, exercise, planned } = editingEx;
  const key  = session + '|' + exercise;
  const sets = document.getElementById('modal-sets').value;
  const reps = document.getElementById('modal-reps').value;
  const dur  = document.getElementById('modal-duration').value;
  const wt   = document.getElementById('modal-weight').value;
  const note = document.getElementById('modal-note').value;

  const fields = { status, actualSets: sets, actualReps: reps, actualDuration: dur, actualWeight: wt, note };

  if (date === currentDate) appState.sessionLog[key] = fields;
  upsertLocalLog(date, day, session, exercise, planned, fields);

  trackWrite(logExercise({ date, day, session, exercise, ...fields }));

  closeModal('log-modal');
  renderToday();
  if (activeTab === 'history') renderHistory();
}

function logDone()     { commitLog('done'); }
function logModified() { commitLog('modified'); }

// ── HISTORY ──────────────────────────────────────────────────────────────────
function renderHistory() {
  const log = appState.log;
  if (!log.length) {
    document.getElementById('history-content').innerHTML = '<div class="empty"><div class="empty-icon">📋</div><p>No sessions logged yet.</p></div>';
    return;
  }

  const byDate = {};
  log.forEach(r => {
    if (!byDate[r.Date]) byDate[r.Date] = [];
    byDate[r.Date].push(r);
  });

  const dates = Object.keys(byDate).sort().reverse();
  let html = '';
  dates.forEach(date => {
    const morning = byDate[date].filter(e => e.Session === 'Morning').sort((a,b) => +a.Order - +b.Order);
    const evening = byDate[date].filter(e => e.Session === 'Evening').sort((a,b) => +a.Order - +b.Order);
    html += `<div class="history-date-group">
      <div class="history-date-label">${formatDate(date)}</div>
      <div class="history-grid">
        <div class="history-col">${historyCol(date, morning)}</div>
        <div class="history-col">${historyCol(date, evening)}</div>
      </div>
    </div>`;
  });
  document.getElementById('history-content').innerHTML = html;
}

function historyCol(date, entries) {
  if (!entries.length) return '';
  const session = entries[0].Session;
  return `<div class="plan-session-label">${session}</div>` + entries.map(e => `
    <div class="history-item" onclick="openHistoryLogModal('${date}','${e.Session}','${esc(e.Exercise)}')">
      <span class="history-item-name">${e.Exercise}</span>
      <span class="history-status ${e.Status}">${e.Status}</span>
    </div>`).join('');
}

// ── PROGRESS ─────────────────────────────────────────────────────────────────
let chartEx = null, chartPva = null;

function renderProgress() {
  const d = appState.dashboard;
  if (!d) { document.getElementById('progress-content').innerHTML = '<div class="loader"><div class="spinner"></div> Loading…</div>'; return; }

  let gridHtml = '';
  d.consistency.forEach(day => {
    const cls     = day.done === day.total && day.total > 0 ? 'full' : day.done > 0 ? 'part' : '';
    const isToday = day.date === appState.today ? 'today' : '';
    const label   = new Date(day.date + 'T12:00:00').getDate();
    gridHtml += `<div class="day-cell ${cls} ${isToday}" title="${day.date}: ${day.done}/${day.total}">${label}</div>`;
  });

  const exercises = Object.keys(d.byExercise);
  const opts = exercises.map(e => `<option value="${esc(e)}">${e}</option>`).join('');

  document.getElementById('progress-content').innerHTML = `
    <div class="streak-card"><div class="streak-num">${d.streak}</div><div class="streak-lbl">day streak 🔥</div></div>
    <div class="dash-section"><h2>Last 28 Days</h2></div>
    <div class="consistency-grid">${gridHtml}</div>
    <div class="dash-section"><h2>Reps over time</h2></div>
    <div class="chart-container">
      <select class="chart-select" id="ex-select" onchange="renderExChart()">${opts}</select>
      <canvas id="ex-chart" height="200"></canvas>
    </div>
    <div class="dash-section"><h2>Planned vs Actual</h2></div>
    <div class="chart-container">
      <select class="chart-select" id="pva-select" onchange="renderPvaChart()">${opts}</select>
      <canvas id="pva-chart" height="200"></canvas>
    </div>`;

  if (exercises.length) { renderExChart(); renderPvaChart(); }
}

function chartColors() {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  return { grid: dark ? '#2c2c2e' : '#f2f2f7', text: dark ? '#636366' : '#8e8e93' };
}

function renderExChart() {
  const ex   = document.getElementById('ex-select').value;
  const data = appState.dashboard.byExercise[ex] || [];
  const { grid, text } = chartColors();
  if (chartEx) chartEx.destroy();
  chartEx = new Chart(document.getElementById('ex-chart').getContext('2d'), {
    type: 'line',
    data: {
      labels: data.map(d => d.date.slice(5)),
      datasets: [{ label:'Reps', data: data.map(d => +d.actualReps || 0),
        borderColor:'#34c759', backgroundColor:'rgba(52,199,89,0.1)',
        tension:0.3, fill:true, pointRadius:5, pointBackgroundColor:'#34c759' }]
    },
    options: { responsive:true, plugins:{ legend:{ display:false } },
      scales: { x:{ grid:{color:grid}, ticks:{color:text,maxTicksLimit:8} }, y:{ grid:{color:grid}, ticks:{color:text}, beginAtZero:true } } }
  });
}

function renderPvaChart() {
  const ex   = document.getElementById('pva-select').value;
  const data = appState.dashboard.planVsActual[ex] || [];
  const { grid, text } = chartColors();
  if (chartPva) chartPva.destroy();
  chartPva = new Chart(document.getElementById('pva-chart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: data.map(d => d.date.slice(5)),
      datasets: [
        { label:'Planned', data: data.map(d => d.plannedReps), backgroundColor:'rgba(0,122,255,0.3)', borderColor:'#007aff', borderWidth:1.5 },
        { label:'Actual',  data: data.map(d => d.actualReps),  backgroundColor:'rgba(52,199,89,0.5)', borderColor:'#34c759', borderWidth:1.5 }
      ]
    },
    options: { responsive:true, plugins:{ legend:{ labels:{ color:text } } },
      scales: { x:{ grid:{color:grid}, ticks:{color:text,maxTicksLimit:8} }, y:{ grid:{color:grid}, ticks:{color:text}, beginAtZero:true } } }
  });
}

// ── PLAN SCREEN ───────────────────────────────────────────────────────────────
let editingPlan = null;

function renderPlanScreen() {
  let html = '<div style="padding-bottom:12px;">';
  DAYS.forEach(day => {
    const dp = appState.plan[day];
    if (!dp) return;
    html += `<div class="plan-day-group"><div class="plan-day-label">${day}</div>`;
    ['Morning','Evening'].forEach(session => {
      const exs = session === 'Morning' ? dp.morning : dp.evening;
      html += `<div class="plan-session-label">${session}</div>`;
      (exs || []).forEach(ex => {
        html += `<div class="plan-exercise-row">
          <div class="plan-ex-name">${ex.exercise}</div>
          <div class="plan-ex-meta">${fmtTarget(ex)}</div>
          <button class="plan-edit-btn" onclick="openPlanEdit('${esc(day)}','${session}','${esc(ex.exercise)}')">
            <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="plan-del-btn" onclick="deletePlanEx('${esc(day)}','${session}','${esc(ex.exercise)}')">
            <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
          </button>
        </div>`;
      });
      html += `<button class="add-exercise-btn" onclick="openPlanAdd('${esc(day)}','${session}')">+ Add exercise</button>`;
    });
    html += '</div>';
  });
  html += '</div>';
  document.getElementById('plan-content').innerHTML = html;
}

function openPlanEdit(day, session, exercise) {
  const arr = session === 'Morning' ? appState.plan[day].morning : appState.plan[day].evening;
  const ex  = arr.find(e => e.exercise === exercise);
  if (!ex) return;
  editingPlan = { mode:'edit', day, session, exercise };
  document.getElementById('plan-modal-title').textContent = 'Edit Exercise';
  document.getElementById('plan-ex-name').value  = ex.exercise;
  document.getElementById('plan-sets').value     = ex.sets     || 0;
  document.getElementById('plan-reps').value     = ex.reps     || 0;
  document.getElementById('plan-duration').value = ex.duration || '';
  document.getElementById('plan-weight').value   = ex.weight   || '';
  openModal('plan-modal');
}

function openPlanAdd(day, session) {
  editingPlan = { mode:'add', day, session };
  document.getElementById('plan-modal-title').textContent = 'Add Exercise';
  document.getElementById('plan-ex-name').value  = '';
  document.getElementById('plan-sets').value     = 3;
  document.getElementById('plan-reps').value     = 10;
  document.getElementById('plan-duration').value = '';
  document.getElementById('plan-weight').value   = '';
  openModal('plan-modal');
}

function savePlanEdit() {
  const name = document.getElementById('plan-ex-name').value.trim();
  if (!name) return;
  const sets = document.getElementById('plan-sets').value;
  const reps = document.getElementById('plan-reps').value;
  const dur  = document.getElementById('plan-duration').value;
  const wt   = document.getElementById('plan-weight').value;
  const { mode, day, session, exercise } = editingPlan;

  closeModal('plan-modal');

  if (mode === 'edit') {
    const arr = session === 'Morning' ? appState.plan[day].morning : appState.plan[day].evening;
    const ex  = arr.find(e => e.exercise === exercise);
    if (ex) { ex.sets = sets; ex.reps = reps; ex.duration = dur; ex.weight = wt; }
    trackWrite(updatePlan({ day, session, exercise, fields: { Sets: sets, Reps: reps, Duration: dur, Weight: wt } }));
  } else {
    const newEx = { exercise: name, session, sets, reps, duration: dur, weight: wt, order: 99 };
    const arr   = session === 'Morning' ? appState.plan[day].morning : appState.plan[day].evening;
    arr.push(newEx);
    trackWrite(addExercise({ day, session, exercise: name, sets, reps, duration: dur, weight: wt }));
  }
  renderPlanScreen();
  if (activeTab === 'today') renderToday();
}

function deletePlanEx(day, session, exercise) {
  if (!confirm('Remove "' + exercise + '" from ' + day + ' ' + session + '?')) return;
  const arr = session === 'Morning' ? appState.plan[day].morning : appState.plan[day].evening;
  const idx = arr.findIndex(e => e.exercise === exercise);
  if (idx >= 0) arr.splice(idx, 1);
  trackWrite(removeExercise({ day, session, exercise }));
  renderPlanScreen();
  if (activeTab === 'today') renderToday();
}

// ── DATE PICKER — the date-btn label triggers the native picker directly ───────
function applyDate() {
  const val = document.getElementById('date-input').value;
  if (!val) return;
  currentDate = val;
  appState.sessionLog = {};
  appState.log.forEach(row => {
    if (row.Date === currentDate) {
      const key = row.Session + '|' + row.Exercise;
      appState.sessionLog[key] = {
        status:         row.Status,
        actualSets:     row.ActualSets,
        actualReps:     row.ActualReps,
        actualDuration: row.ActualDuration,
        actualWeight:   row.ActualWeight,
        note:           row.Note
      };
    }
  });
  renderToday();
}

// ── MODAL HELPERS ─────────────────────────────────────────────────────────────
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function step(id, d)    { const el = document.getElementById(id); el.value = Math.max(0, (+el.value || 0) + d); }

// ── EXPOSE HANDLERS — this file is a module, so inline onclick/onchange
// attributes in the HTML need these attached to window explicitly.
Object.assign(window, {
  switchTab, applyDate, closeModal, step,
  quickDone, openLogModal, openHistoryLogModal, logDone, logModified,
  openPlanEdit, openPlanAdd, savePlanEdit, deletePlanEx,
  renderExChart, renderPvaChart
});

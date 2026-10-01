import { firebaseConfig } from './firebase-config.js';
import { BUILD } from './build.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getFirestore, collection, getDocs, addDoc, updateDoc, deleteDoc, setDoc, doc, query, where
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';

const fbApp = initializeApp(firebaseConfig);
const db = getFirestore(fbApp);
const auth = getAuth(fbApp);

document.getElementById('build-number').textContent = 'Build ' + BUILD;

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
// For a given day-of-week, the exercises in effect on a specific date.
//
// Live resolution (historical falsy — the weekly template, logging today or
// later) only considers Active versions: that's what makes an edit or removal
// take hold going forward.
//
// Historical resolution (past dates) asks which version was actually in
// effect back then: a version runs from its ValidFrom until
//   - its ValidTo, stamped when it was deactivated (edit or removal), or
//   - for older docs with no ValidTo: the ValidFrom of the next version of
//     the same day/session/exercise (it was superseded by an edit), or
//   - never, if it's inactive with no successor — a removal from before
//     ValidTo existed, whose date is unknown. Counting it as planned on every
//     past date would invent skips (e.g. Sundays that were never planned).
function versionEnd(r, planRows) {
  if (r.Active === true) return '9999-12-31';
  if (r.ValidTo) return r.ValidTo;
  const next = planRows
    .filter(s => s !== r && s.Day === r.Day && s.Session === r.Session && s.Exercise === r.Exercise &&
                 (+s.Version || 0) > (+r.Version || 0))
    .sort((a, b) => a.ValidFrom.localeCompare(b.ValidFrom))[0];
  return next ? next.ValidFrom : r.ValidFrom;
}

function resolveDayPlan(day, dateIso, planRows, historical) {
  const dayRows = planRows.filter(r =>
    r.Day === day && r.ValidFrom <= dateIso &&
    (historical ? dateIso < versionEnd(r, planRows) : r.Active === true)
  );
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
    resolveDayPlan(day, d, planRows, true).forEach(r => {
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

  // Progress series per exercise, from completed (done/modified) entries only
  // — skipped days are left out rather than plotted as a dip to zero. Each
  // point is either total reps (sets × reps) or minutes, depending on how the
  // exercise is measured; the exercise's unit follows its latest entry.
  const byExercise = {};
  logRows.filter(r => r.Status === 'done' || r.Status === 'modified').forEach(r => {
    (byExercise[r.Exercise] = byExercise[r.Exercise] || []).push(r);
  });
  Object.keys(byExercise).forEach(k => {
    const rows = byExercise[k].sort((a,b) => a.Date.localeCompare(b.Date)).slice(-16);
    const last = rows[rows.length - 1];
    const unit = isDurationEx({ reps: last.ActualReps || last.PlannedReps, duration: last.ActualDuration || last.PlannedDuration }) ? 'min' : 'reps';
    byExercise[k] = {
      unit,
      points: rows.map(r => {
        const sets = +(r.ActualSets || r.PlannedSets) || 1;
        const reps = +(r.ActualReps || r.PlannedReps) || 0;
        return {
          date: r.Date,
          value: unit === 'min' ? parseMinutes(r.ActualDuration || r.PlannedDuration) : sets * reps,
          label: unit === 'min' ? parseMinutes(r.ActualDuration || r.PlannedDuration) + ' min' : sets + ' × ' + reps
        };
      }).filter(pt => pt.value > 0)
    };
    if (!byExercise[k].points.length) delete byExercise[k];
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

  return { streak, byExercise, consistency };
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

  // Status 'deleted' docs are tombstones: they suppress the implicit skip for
  // that date (see deleteLog), then get dropped so History never shows them.
  const recentLog = fillSkippedEntries(logRows, planRowsRaw, cutoff, today)
    .filter(r => r.Status !== 'deleted');
  const dashboard = buildDashboard(recentLog, today);

  return { plan, log: recentLog, dashboard, today, dayName: getDayName(new Date()) };
}

async function logExercise(payload) {
  const dateIso = payload.date;
  // Same historical-vs-live distinction as resolveDayPlan(): logging/editing
  // a past date (e.g. fixing a History entry) should snapshot what was
  // actually planned back then, not get orphaned by a later edit that
  // deactivated that version.
  const historical = dateIso < appState.today;
  const planRow = appState.planRowsRaw.filter(r =>
    (historical || r.Active === true) && r.Day === payload.day && r.Session === payload.session &&
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

// Renaming a plan exercise only touches the plan doc — log rows still carry
// the old Exercise name, so every by-name lookup (today's ticked state,
// history, the dashboard's per-exercise buckets) silently stops matching.
// It's the same logged entry, just under a new name, so update the Exercise
// field on each existing log doc in place — do not delete/recreate under a
// new ID, that's reserved for genuinely new log entries. The doc's ID stays
// derived from the old name; that's fine, IDs are only ever looked up by
// date+session+exercise at write time, never read back out.
// Synthetic implicit-skip rows (no LoggedAt) exist only in appState.log and
// have no Firestore doc to touch.
function renameLogExercise(session, oldExercise, newExercise) {
  const oldKey = session + '|' + oldExercise;
  const newKey = session + '|' + newExercise;
  if (appState.sessionLog[oldKey]) {
    appState.sessionLog[newKey] = appState.sessionLog[oldKey];
    delete appState.sessionLog[oldKey];
  }

  appState.log.forEach(r => {
    if (r.Session !== session || r.Exercise !== oldExercise) return;
    r.Exercise = newExercise;
    if (!r.LoggedAt) return;
    const id = logDocId(r.Date, session, oldExercise);
    trackWrite(updateDoc(doc(db, 'log', id), { Exercise: newExercise }));
  });
}

async function updatePlan(payload) {
  const rows    = appState.planRowsRaw;
  const dateIso = toIso(new Date());
  const current = rows.find(r => r.Active === true && r.Day === payload.day && r.Session === payload.session && r.Exercise === payload.exercise);
  if (!current) return;

  const maxVersion = Math.max(...rows.map(r => +r.Version || 0));
  await updateDoc(doc(db, 'plan', current.id), { Active: false, ValidTo: dateIso });
  current.Active = false;
  current.ValidTo = dateIso;

  const updated = { ...current };
  delete updated.id;
  delete updated.ValidTo;
  Object.assign(updated, payload.fields, { Version: String(maxVersion + 1), ValidFrom: dateIso, Active: true });
  const ref = await addDoc(collection(db, 'plan'), updated);
  rows.push({ id: ref.id, ...updated });
}

// payload.order lets a caller pin the row to a specific position (e.g. the
// plan grid re-adding an exercise to a day it was previously unchecked from,
// or adding one new exercise across several days at once) so its order
// stays in sync across every day instead of drifting to "last" on each one
// independently. Omit it to auto-append (existing single-day add behavior).
async function addExercise(payload) {
  const rows = appState.planRowsRaw;
  const dateIso = toIso(new Date());
  const maxVer = Math.max(...rows.map(r => +r.Version || 0), 0);
  let order = payload.order;
  if (order === undefined || order === null || order === '') {
    const sessRows = rows.filter(r => r.Active === true && r.Day === payload.day && r.Session === payload.session);
    order = Math.max(...sessRows.map(r => +r.Order || 0), 0) + 1;
  }
  const newRow = {
    Version: String(maxVer + 1), ValidFrom: dateIso, Day: payload.day, Session: payload.session,
    Exercise: payload.exercise, Sets: payload.sets || '', Reps: payload.reps || '',
    Duration: payload.duration || '', Weight: payload.weight || '',
    Order: String(order), Active: true
  };
  const ref = await addDoc(collection(db, 'plan'), newRow);
  rows.push({ id: ref.id, ...newRow });
}

async function removeExercise(payload) {
  const rows = appState.planRowsRaw;
  const current = rows.find(r => r.Active === true && r.Day === payload.day && r.Session === payload.session && r.Exercise === payload.exercise);
  if (!current) return;
  const dateIso = toIso(new Date());
  await updateDoc(doc(db, 'plan', current.id), { Active: false, ValidTo: dateIso });
  current.Active = false;
  current.ValidTo = dateIso;
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

// An exercise is measured either in reps (sets × reps) or in minutes
// (Duration, stored as "N min"). Duration-only means minutes.
function isDurationEx(ex) { return !!ex.duration && !(+ex.reps); }
function parseMinutes(s) { return parseFloat(String(s || '').replace(',', '.')) || 0; }
function fmtMinutes(n) { return n ? n + ' min' : ''; }

function esc(s) { return String(s).replace(/'/g, "\\'").replace(/"/g, '&quot;'); }
// For values placed in a plain HTML attribute (e.g. data-exercise="..."),
// not inside a JS string literal like esc() above is for.
function escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }

// ── INIT ─────────────────────────────────────────────────────────────────────
let currentDate = toIso(new Date());

// A logged (done/modified/skipped) exercise freezes its displayed target to
// whatever was actually planned at the moment it was logged (PlannedSets
// etc., already snapshotted on the log row) rather than the live plan, so
// editing the plan later doesn't retroactively change what an already-
// resolved exercise appears to have asked of you. Only a still-pending
// exercise keeps reading the live plan, which is what makes plan edits
// show up immediately for today/future's unchecked exercises.
function hydrateSessionLog(dateIso) {
  const sessionLog = {};
  appState.log.forEach(row => {
    if (row.Date !== dateIso) return;
    const key = row.Session + '|' + row.Exercise;
    sessionLog[key] = {
      status:          row.Status,
      actualSets:      row.ActualSets,
      actualReps:      row.ActualReps,
      actualDuration:  row.ActualDuration,
      actualWeight:    row.ActualWeight,
      plannedSets:     row.PlannedSets,
      plannedReps:     row.PlannedReps,
      plannedDuration: row.PlannedDuration,
      plannedWeight:   row.PlannedWeight,
      note:            row.Note
    };
  });
  return sessionLog;
}

function initApp(data) {
  appState.plan      = data.plan;
  appState.log       = data.log;
  appState.dashboard = data.dashboard;
  appState.today     = data.today;
  appState.dayName   = data.dayName;
  appState.sessionLog = hydrateSessionLog(currentDate);

  document.getElementById('loading-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  renderToday();
}

// Firestore rules only admit the owner's Google account, so nothing can be
// read until sign-in completes. Auth persists in IndexedDB, so this is a
// one-time step per device; afterwards onAuthStateChanged fires straight away.
function showLoadingMessage(text) {
  document.querySelector('#loading-screen p').textContent = text;
}

async function signIn() {
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    // Popups can be blocked (notably in installed PWAs) — fall back to a
    // full-page redirect, which onAuthStateChanged picks up on return.
    if (err.code === 'auth/popup-blocked' || err.code === 'auth/operation-not-supported-in-this-environment') {
      return signInWithRedirect(auth, provider);
    }
    if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') {
      showLoadingMessage('Sign-in failed: ' + (err.code || err.message));
      console.error(err);
    }
  }
}
document.getElementById('sign-in-btn').addEventListener('click', signIn);

let started = false;
onAuthStateChanged(auth, user => {
  const screen = document.getElementById('loading-screen');
  if (!user) {
    screen.classList.add('signed-out');
    showLoadingMessage('Sign in to load your plan.');
    return;
  }
  screen.classList.remove('signed-out');
  if (started) return;
  started = true;
  showLoadingMessage('Loading your plan…');
  loadAll().then(initApp).catch(err => {
    // initApp may already have hidden the loading screen; bring it back so
    // the error is visible instead of an empty screen.
    document.getElementById('app').style.display = 'none';
    screen.style.display = '';
    showLoadingMessage(err.code === 'permission-denied'
      ? 'This account (' + user.email + ') has no access.'
      : 'Error loading data (' + (err.code || err.message) + '). Please reload.');
    console.error(err);
  });
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
  // Null-safe: a cached older index.html may lack the badge, and throwing
  // here would leave the whole Today screen blank.
  const badge = document.getElementById('today-badge');
  if (badge) badge.hidden = currentDate === toIso(new Date());

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
  // Once an exercise is logged, its target freezes to what was actually
  // planned at that moment (so a later plan edit doesn't rewrite history);
  // a still-pending exercise keeps showing the live plan.
  const target = s === 'pending'
    ? fmtTarget(ex)
    : fmtTarget({ sets: logged.plannedSets, reps: logged.plannedReps, duration: logged.plannedDuration, weight: logged.plannedWeight });
  return `<div class="exercise-card status-${s}">
    <div class="exercise-row" data-session="${session}" data-exercise="${escAttr(ex.exercise)}">
      <div class="ex-check ${s}">${checkSvg}</div>
      <div class="ex-info">
        <div class="ex-name">${ex.exercise}</div>
        <div class="ex-actual">${actual ? `Done: ${actual}` : ''}</div>
        ${logged.note ? `<div class="ex-note">${logged.note}</div>` : ''}
      </div>
      <div class="ex-target-side">${target}</div>
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

// Recompute the dashboard (streak, per-exercise charts, consistency grid)
// from the current log after every write, and re-render Progress in place
// if it's the visible tab, so it never shows stale data from initial load.
function refreshDashboard() {
  appState.dashboard = buildDashboard(appState.log, appState.today);
  if (activeTab === 'progress') renderProgress();
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
      actualDuration: ex.duration, actualWeight: ex.weight,
      plannedSets: ex.sets, plannedReps: ex.reps, plannedDuration: ex.duration, plannedWeight: ex.weight,
      note: '' };
    appState.sessionLog[key] = fields;
    upsertLocalLog(currentDate, dayName, session, exercise, ex, fields);
    trackWrite(logExercise({ date: currentDate, day: dayName, session, exercise, ...fields }));
  }
  renderToday();
  if (activeTab === 'history') renderHistory();
  refreshDashboard();
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
  document.getElementById('modal-minutes').value  = parseMinutes(logged.actualDuration || planned.duration) || 0;
  const byDuration = isDurationEx(planned);
  document.getElementById('modal-reps-fields').style.display     = byDuration ? 'none' : '';
  document.getElementById('modal-duration-fields').style.display = byDuration ? '' : 'none';
  editingEx.byDuration = byDuration;
  document.getElementById('modal-note').value     = logged.note || '';
  openModal('log-modal');
}

function commitLog(status) {
  const { date, day, session, exercise, planned } = editingEx;
  const key  = session + '|' + exercise;
  const byDuration = editingEx.byDuration;
  const sets = byDuration ? '' : document.getElementById('modal-sets').value;
  const reps = byDuration ? '' : document.getElementById('modal-reps').value;
  const dur  = byDuration ? fmtMinutes(parseMinutes(document.getElementById('modal-minutes').value)) : '';
  const wt   = '';
  const note = document.getElementById('modal-note').value;

  const fields = { status, actualSets: sets, actualReps: reps, actualDuration: dur, actualWeight: wt,
    plannedSets: planned.sets, plannedReps: planned.reps, plannedDuration: planned.duration, plannedWeight: planned.weight,
    note };

  if (date === currentDate) appState.sessionLog[key] = fields;
  upsertLocalLog(date, day, session, exercise, planned, fields);

  trackWrite(logExercise({ date, day, session, exercise, ...fields }));

  closeModal('log-modal');
  renderToday();
  if (activeTab === 'history') renderHistory();
  refreshDashboard();
}

// Removes the entry from History. Written as a 'deleted' tombstone rather
// than deleting the doc, so a past exercise that was never logged doesn't
// come straight back as an implicit skip.
function deleteLog() {
  const { date, day, session, exercise } = editingEx;
  if (!confirm('Delete "' + exercise + '" on ' + formatDate(date) + ' from history?')) return;
  if (date === currentDate) delete appState.sessionLog[session + '|' + exercise];
  upsertLocalLog(date, day, session, exercise, null, null);
  trackWrite(logExercise({ date, day, session, exercise, status: 'deleted' }));

  closeModal('log-modal');
  renderToday();
  if (activeTab === 'history') renderHistory();
  refreshDashboard();
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
let chartEx = null;

function renderProgress() {
  const d = appState.dashboard;
  if (!d) { document.getElementById('progress-content').innerHTML = '<div class="loader"><div class="spinner"></div> Loading…</div>'; return; }

  // Only days that had something planned (or logged) — rest days and days
  // before the plan existed are left out of the grid entirely.
  const hasPlan = day => day.total > 0 ||
    resolveDayPlan(getDateDayName(day.date), day.date, appState.planRowsRaw, day.date < appState.today).length > 0;
  let gridHtml = '';
  d.consistency.filter(hasPlan).forEach(day => {
    const cls     = day.done === day.total && day.total > 0 ? 'full' : day.done > 0 ? 'part' : '';
    const isToday = day.date === appState.today ? 'today' : '';
    const label   = new Date(day.date + 'T12:00:00').getDate();
    gridHtml += `<div class="day-cell ${cls} ${isToday}" title="${day.date}: ${day.done}/${day.total}" onclick="openDay('${day.date}')">${label}</div>`;
  });

  // Only exercises with at least one completed entry in History.
  const exercises = Object.keys(d.byExercise).sort((a, b) => a.localeCompare(b));
  const prev = document.getElementById('ex-select');
  const selected = prev && exercises.includes(prev.value) ? prev.value : exercises[0];
  const opts = exercises.map(e => `<option value="${escAttr(e)}"${e === selected ? ' selected' : ''}>${e}</option>`).join('');

  document.getElementById('progress-content').innerHTML = `
    <div class="streak-card"><div class="streak-num">${d.streak}</div><div class="streak-lbl">day streak 🔥</div></div>
    <div class="dash-section"><h2>Last 28 Days</h2></div>
    <div class="consistency-grid">${gridHtml}</div>
    <div class="dash-section"><h2 id="ex-chart-title">Progress</h2></div>
    <div class="chart-container">
      ${exercises.length
        ? `<select class="chart-select" id="ex-select" onchange="renderExChart()">${opts}</select>
           <canvas id="ex-chart" height="200"></canvas>`
        : '<div class="empty"><p>Complete an exercise to see progress.</p></div>'}
    </div>`;

  if (exercises.length) renderExChart();
}

function chartColors() {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  return { grid: dark ? '#2c2c2e' : '#f2f2f7', text: dark ? '#636366' : '#8e8e93' };
}

function renderExChart() {
  const ex = document.getElementById('ex-select').value;
  const { unit, points } = appState.dashboard.byExercise[ex] || { unit: 'reps', points: [] };
  const yLabel = unit === 'min' ? 'Minutes' : 'Total reps (sets × reps)';
  document.getElementById('ex-chart-title').textContent = unit === 'min' ? 'Minutes over time' : 'Reps over time';
  const { grid, text } = chartColors();
  if (chartEx) chartEx.destroy();
  chartEx = new Chart(document.getElementById('ex-chart').getContext('2d'), {
    type: 'line',
    data: {
      labels: points.map(p => p.date.slice(5)),
      datasets: [{ label: yLabel, data: points.map(p => p.value),
        borderColor:'#34c759', backgroundColor:'rgba(52,199,89,0.1)', borderWidth:2,
        tension:0.3, fill:true, pointRadius:4, pointHoverRadius:6, pointBackgroundColor:'#34c759' }]
    },
    options: { responsive:true, interaction:{ mode:'index', intersect:false },
      plugins:{ legend:{ display:false },
        tooltip:{ callbacks:{ label: c => points[c.dataIndex].label } } },
      scales: { x:{ grid:{color:grid}, ticks:{color:text,maxTicksLimit:8} },
        y:{ grid:{color:grid}, ticks:{color:text}, beginAtZero:true, title:{ display:true, text:yLabel, color:text } } } }
  });
}

// ── PLAN SCREEN ───────────────────────────────────────────────────────────────
// A "row" is one exercise within a session, shown once regardless of how
// many of the 7 weekdays it's scheduled on. Its sets/reps/duration/weight
// are a single shared definition (mirroring how this plan is actually used
// in practice — the same exercise at the same values on every day it's
// scheduled), taken from whichever day happens to be checked first; editing
// it applies to every currently-checked day at once.
const DAY_ABBR = { Monday:'Mo', Tuesday:'Tu', Wednesday:'We', Thursday:'Th', Friday:'Fr', Saturday:'Sa', Sunday:'Su' };
let editingPlan = null;

function planArr(day, session) {
  const dp = appState.plan[day];
  return dp ? (session === 'Morning' ? dp.morning : dp.evening) : null;
}

function buildPlanGrid(session) {
  const rows = new Map(); // exercise name -> row
  DAYS.forEach(day => {
    (planArr(day, session) || []).forEach(ex => {
      if (!rows.has(ex.exercise)) {
        rows.set(ex.exercise, { exercise: ex.exercise, sets: ex.sets, reps: ex.reps, duration: ex.duration, weight: ex.weight, order: ex.order, days: new Set() });
      }
      rows.get(ex.exercise).days.add(day);
    });
  });
  return [...rows.values()].sort((a, b) => (+a.order || 0) - (+b.order || 0));
}

function findCanonicalExercise(session, exercise) {
  for (const day of DAYS) {
    const found = (planArr(day, session) || []).find(e => e.exercise === exercise);
    if (found) return found;
  }
  return null;
}

function getCheckedDays(session, exercise) {
  return DAYS.filter(day => (planArr(day, session) || []).some(e => e.exercise === exercise));
}

function nextPlanOrder(session) {
  let max = 0;
  DAYS.forEach(day => (planArr(day, session) || []).forEach(e => { max = Math.max(max, +e.order || 0); }));
  return max + 1;
}

function renderPlanScreen() {
  let html = '<div style="padding-bottom:12px;">';
  ['Morning', 'Evening'].forEach(session => {
    html += `<div class="plan-session-label" style="margin:0 16px;">${session}</div>`;
    buildPlanGrid(session).forEach(row => {
      html += `<div class="plan-grid-row">
        <div class="plan-grid-header" data-session="${session}" data-exercise="${escAttr(row.exercise)}">
          <div class="plan-grid-name">${row.exercise}</div>
          <div class="plan-grid-meta">${fmtTarget(row)}</div>
        </div>
        <div class="plan-grid-days">
          <div class="day-chip-row">
            ${DAYS.map(day => `<button type="button" class="day-chip${row.days.has(day) ? ' checked' : ''}" onclick="togglePlanDay('${session}','${esc(row.exercise)}','${day}')">${DAY_ABBR[day]}</button>`).join('')}
          </div>
          <button class="plan-grid-del" onclick="deletePlanExGrid('${session}','${esc(row.exercise)}')">
            <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
          </button>
        </div>
      </div>`;
    });
    html += `<button class="add-exercise-btn" onclick="openPlanAdd('${session}')">+ Add exercise</button>`;
  });
  html += '</div>';
  document.getElementById('plan-content').innerHTML = html;
}

function togglePlanDay(session, exercise, day) {
  const arr = planArr(day, session);
  if (!arr) return;
  const idx = arr.findIndex(e => e.exercise === exercise);
  if (idx >= 0) {
    arr.splice(idx, 1);
    trackWrite(removeExercise({ day, session, exercise }));
  } else {
    const canon = findCanonicalExercise(session, exercise);
    if (!canon) return;
    const payload = { day, session, exercise, sets: canon.sets, reps: canon.reps, duration: canon.duration, weight: canon.weight, order: canon.order };
    arr.push({ exercise, session, sets: canon.sets, reps: canon.reps, duration: canon.duration, weight: canon.weight, order: canon.order });
    trackWrite(addExercise(payload));
  }
  renderPlanScreen();
  if (activeTab === 'today') renderToday();
}

function openPlanEditGrid(session, exercise) {
  const canon = findCanonicalExercise(session, exercise);
  if (!canon) return;
  editingPlan = { mode: 'edit', session, exercise, days: getCheckedDays(session, exercise) };
  document.getElementById('plan-modal-title').textContent = 'Edit Exercise';
  document.getElementById('plan-modal-days-group').style.display = 'none';
  document.getElementById('plan-ex-name').value  = canon.exercise;
  document.getElementById('plan-sets').value     = canon.sets || 3;
  document.getElementById('plan-reps').value     = canon.reps || 10;
  document.getElementById('plan-minutes').value  = parseMinutes(canon.duration) || 10;
  setPlanMode(isDurationEx(canon) ? 'duration' : 'reps');
  openModal('plan-modal');
}

function openPlanAdd(session) {
  editingPlan = { mode: 'add', session };
  document.getElementById('plan-modal-title').textContent = 'Add Exercise';
  document.getElementById('plan-modal-days-group').style.display = '';
  document.querySelectorAll('#plan-modal-days .day-chip').forEach(c => c.classList.remove('checked'));
  document.getElementById('plan-ex-name').value  = '';
  document.getElementById('plan-sets').value     = 3;
  document.getElementById('plan-reps').value     = 10;
  document.getElementById('plan-minutes').value  = 10;
  setPlanMode('reps');
  openModal('plan-modal');
}

// Reps mode stores Sets × Reps and clears Duration; duration mode stores
// "N min" and clears Sets/Reps — so every exercise has exactly one measure.
let planMode = 'reps';
function setPlanMode(mode) {
  planMode = mode;
  document.querySelectorAll('#plan-mode .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  document.getElementById('plan-reps-fields').style.display     = mode === 'reps' ? '' : 'none';
  document.getElementById('plan-duration-fields').style.display = mode === 'duration' ? '' : 'none';
}

function savePlanEdit() {
  const name = document.getElementById('plan-ex-name').value.trim();
  if (!name) return;
  const byReps = planMode === 'reps';
  const sets = byReps ? document.getElementById('plan-sets').value : '';
  const reps = byReps ? document.getElementById('plan-reps').value : '';
  const dur  = byReps ? '' : fmtMinutes(parseMinutes(document.getElementById('plan-minutes').value));
  const wt   = '';
  if (byReps ? !(+reps) : !dur) return;
  const { mode, session } = editingPlan;

  closeModal('plan-modal');

  if (mode === 'edit') {
    const { exercise, days } = editingPlan;
    if (name !== exercise) { renameLogExercise(session, exercise, name); refreshDashboard(); }
    days.forEach(day => {
      const arr = planArr(day, session);
      const ex  = arr && arr.find(e => e.exercise === exercise);
      if (ex) { ex.exercise = name; ex.sets = sets; ex.reps = reps; ex.duration = dur; ex.weight = wt; }
      trackWrite(updatePlan({ day, session, exercise, fields: { Exercise: name, Sets: sets, Reps: reps, Duration: dur, Weight: wt } }));
    });
  } else {
    const days = [...document.querySelectorAll('#plan-modal-days .day-chip.checked')].map(c => c.dataset.day);
    if (!days.length) return;
    const order = nextPlanOrder(session);
    days.forEach(day => {
      const arr = planArr(day, session);
      if (arr) arr.push({ exercise: name, session, sets, reps, duration: dur, weight: wt, order });
      trackWrite(addExercise({ day, session, exercise: name, sets, reps, duration: dur, weight: wt, order }));
    });
  }
  renderPlanScreen();
  if (activeTab === 'today') renderToday();
  if (activeTab === 'history') renderHistory();
}

function deletePlanExGrid(session, exercise) {
  if (!confirm('Remove "' + exercise + '" from every scheduled day?')) return;
  getCheckedDays(session, exercise).forEach(day => {
    const arr = planArr(day, session);
    const idx = arr ? arr.findIndex(e => e.exercise === exercise) : -1;
    if (idx >= 0) arr.splice(idx, 1);
    trackWrite(removeExercise({ day, session, exercise }));
  });
  renderPlanScreen();
  if (activeTab === 'today') renderToday();
}

// Long-press on a row's name/meta (not its day chips or delete button, which
// are plain taps) opens the edit modal — same pattern as the Today screen's
// exercise rows.
function initPlanRowGestures() {
  const el = document.getElementById('plan-content');
  const LONG_PRESS_MS = 500;
  let timer = null, startX = 0, startY = 0;

  function cancelTimer() { clearTimeout(timer); timer = null; }

  el.addEventListener('touchstart', e => {
    const header = e.target.closest('.plan-grid-header');
    if (!header || e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    timer = setTimeout(() => {
      timer = null;
      if (navigator.vibrate) navigator.vibrate(12);
      openPlanEditGrid(header.dataset.session, header.dataset.exercise);
    }, LONG_PRESS_MS);
  }, { passive: true });

  el.addEventListener('touchmove', e => {
    if (!timer) return;
    const dx = Math.abs(e.touches[0].clientX - startX);
    const dy = Math.abs(e.touches[0].clientY - startY);
    if (dx > 10 || dy > 10) cancelTimer();
  }, { passive: true });

  el.addEventListener('touchend', cancelTimer, { passive: true });
  el.addEventListener('touchcancel', cancelTimer, { passive: true });
}
initPlanRowGestures();

// ── DATE PICKER — the date-btn label triggers the native picker directly ───────
// direction ('prev'|'next') plays a small slide-in animation on today-content,
// matching the swipe gesture that triggered it; omitted for date-picker jumps.
function goToDate(newDate, direction) {
  currentDate = newDate;
  appState.sessionLog = hydrateSessionLog(currentDate);
  renderToday();
  if (direction) animateDaySwipe(direction);
}

function animateDaySwipe(direction) {
  const el = document.getElementById('today-content');
  if (!el) return;
  el.classList.remove('day-in-prev', 'day-in-next');
  void el.offsetWidth; // restart the animation even if the same class was just used
  el.classList.add(direction === 'next' ? 'day-in-next' : 'day-in-prev');
}

// Tapping a day tile on Progress opens that day on the Today screen.
function openDay(dateIso) {
  goToDate(dateIso);
  switchTab('today');
}

// "Today" badge next to the date, shown only while viewing another day.
function goToToday() {
  const today = toIso(new Date());
  if (currentDate !== today) goToDate(today, currentDate < today ? 'next' : 'prev');
}

function applyDate() {
  const val = document.getElementById('date-input').value;
  if (!val) return;
  goToDate(val);
}

// ── SWIPE NAV — horizontal swipe on the Today screen moves ±1 day ────────────
function initSwipeNav() {
  const el = document.getElementById('screen-today');
  let startX = 0, startY = 0, tracking = false;

  el.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    tracking = true;
  }, { passive: true });

  el.addEventListener('touchend', e => {
    if (!tracking) return;
    tracking = false;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    // Require a clearly horizontal, deliberate swipe so vertical scrolling
    // and taps on checkboxes/buttons are never mistaken for a day change.
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (dx < 0) goToDate(nextDay(currentDate), 'next');
    else        goToDate(prevDay(currentDate), 'prev');
  }, { passive: true });
}
initSwipeNav();

// ── EXERCISE ROW GESTURES — tap toggles done, long-press opens the log modal ──
// Delegated on the stable #today-content container rather than bound per row,
// since renderToday() replaces the rows' HTML (and any listeners on them) on
// every re-render.
function initExerciseRowGestures() {
  const el = document.getElementById('today-content');
  const LONG_PRESS_MS = 500;
  let timer = null, startX = 0, startY = 0, longPressed = false;

  function cancelTimer() { clearTimeout(timer); timer = null; }

  el.addEventListener('touchstart', e => {
    const row = e.target.closest('.exercise-row');
    if (!row || e.touches.length !== 1) return;
    longPressed = false;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    timer = setTimeout(() => {
      timer = null;
      longPressed = true;
      if (navigator.vibrate) navigator.vibrate(12);
      openLogModal(row.dataset.session, row.dataset.exercise);
    }, LONG_PRESS_MS);
  }, { passive: true });

  // Cancel the pending long-press once the touch drifts enough to look like
  // a scroll or the swipe-day gesture rather than a deliberate hold.
  el.addEventListener('touchmove', e => {
    if (!timer) return;
    const dx = Math.abs(e.touches[0].clientX - startX);
    const dy = Math.abs(e.touches[0].clientY - startY);
    if (dx > 10 || dy > 10) cancelTimer();
  }, { passive: true });

  el.addEventListener('touchend', cancelTimer, { passive: true });
  el.addEventListener('touchcancel', cancelTimer, { passive: true });

  el.addEventListener('click', e => {
    const row = e.target.closest('.exercise-row');
    if (!row) return;
    // The long-press already acted; swallow the click that follows touchend
    // so it doesn't also toggle done/pending.
    if (longPressed) { longPressed = false; return; }
    quickDone(row.dataset.session, row.dataset.exercise);
  });
}
initExerciseRowGestures();

// ── MODAL HELPERS ─────────────────────────────────────────────────────────────
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function step(id, d)    { const el = document.getElementById(id); el.value = Math.max(0, (+el.value || 0) + d); }

// ── EXPOSE HANDLERS — this file is a module, so inline onclick/onchange
// attributes in the HTML need these attached to window explicitly.
Object.assign(window, {
  switchTab, applyDate, goToToday, openDay, closeModal, step,
  quickDone, openLogModal, openHistoryLogModal, logDone, logModified, deleteLog, setPlanMode,
  openPlanAdd, savePlanEdit, togglePlanDay, deletePlanExGrid,
  renderExChart
});

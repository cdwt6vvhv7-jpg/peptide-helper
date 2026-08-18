// Peptide Tracker — single-file local app. No build step, no server required.

const STORAGE_KEY = 'peptideTrackerState_v1';
const PALETTE = ['#3f6b52', '#6c4f9c', '#a25b2a', '#2a6c8f', '#8c3a5b'];
// The M2_H print head is 300 dpi (the non-H M2 is 203) — that's the ceiling on
// what can actually reach the paper. The export dpi is a *different* number: it
// has to match the density the NIIMBOT Mac app assumes when it drops an imported
// bitmap onto its canvas, or the image lands at the wrong size there and gets
// hand-stretched. Measured from a 40x20mm label: a 480px-wide PNG (the old
// 12px/mm export) came in covering about three quarters of the label, i.e. the
// app laid it out at roughly 16px/mm == 406dpi. Hence the default below;
// settings.labelExportDpi is user-adjustable because that's an observation about
// one version of their app, not a documented constant. See renderLabelCanvas().
const LABEL_HEAD_DPI = 300;
const LABEL_EXPORT_DPI_DEFAULT = Math.round(16 * 25.4); // 406dpi == 16px/mm

let state = loadState();
let editingProtocol = {};     // subjectId -> protocolId being edited, or null
// subjectId -> in-progress state of the whole open add/edit protocol form (all fields,
// not just dose-schedule rows). Kept continuously in sync with the live DOM via an
// input/change listener (see bindProtocolEvents) so that any re-render triggered while
// the form is open — including switchTab's renderAll(), which used to wipe the form
// back to defaults — rebuilds from the latest typed values instead of from scratch.
let protocolFormDraft = {};
let addingProtocol = {};      // subjectId -> true while the "Add protocol" form is open
let protocolsView = { subjectId: 'all' };  // which subject's card(s) to show on the Protocols tab
let labelSelections = {};     // key `${peptideId}|${subjectId||'generic'}` -> { include, qty }
let inventoryExpanded = {};   // peptideId -> true/false once explicitly toggled; unset = auto (expanded only if the peptide has no lots yet)
let editingPeptideId = null;  // peptide id currently showing its edit form, or null
let peptideFormDraft = {};    // key 'new' | peptideId -> { isBlend, components: [{name, mgPerVial}] } in-progress form rows
let serverAvailable = false;  // true once server.py has confirmed it can read/write data.json
let configImportPreview = null; // { result, fileName } — a parsed config awaiting confirm/cancel in Settings

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function defaultState() {
  return {
    subjects: [
      { id: uid(), name: 'Me', color: PALETTE[0] },
      { id: uid(), name: 'Housemate', color: PALETTE[1] },
    ],
    peptides: [],
    inventoryLots: [],
    protocols: [],
    doseLogs: [],
    settings: {
      labelWidthMm: 40,
      labelHeightMm: 20,
      labelExportDpi: LABEL_EXPORT_DPI_DEFAULT,
      labelSaveDir: '~/Desktop/Label Files',
      syringeUnits: 'U100',
      logoDataUrl: '',
    },
  };
}

// Converts data saved before the mcg->mg switch, before doseSchedule
// (titration) replaced a flat doseMg/startDate, before timeOfDay became
// a morning/evening enum, and before peptides could be blends — so old
// localStorage/data.json/backups keep working.
function migrateState(s) {
  for (const pep of s.peptides) {
    if (pep.isBlend === undefined) pep.isBlend = false;
    if (!pep.components) pep.components = [];
  }
  for (const p of s.protocols) {
    if (p.doseMg === undefined && p.doseMcg !== undefined) {
      p.doseMg = Calc.round(p.doseMcg / 1000, 3);
      delete p.doseMcg;
    }
    if (!p.doseSchedule) {
      p.doseSchedule = [{ id: uid(), startDate: p.startDate || todayStr(), doseMg: p.doseMg ?? 0 }];
      delete p.doseMg;
      delete p.startDate;
    }
    if (p.endDate === undefined) p.endDate = '';
    if (p.timeOfDay && /^\d{2}:\d{2}$/.test(p.timeOfDay)) {
      p.timeOfDay = parseInt(p.timeOfDay.slice(0, 2), 10) < 12 ? 'morning' : 'evening';
    }
  }
  return s;
}

// Fills in anything a saved state predates — in particular new `settings` keys,
// which need their own merge: a plain Object.assign(defaults, parsed) replaces
// the whole settings object with the saved one, so every key added after that
// save silently comes back undefined instead of taking its default.
function mergeWithDefaults(parsed) {
  const base = defaultState();
  const merged = Object.assign(base, parsed);
  merged.settings = Object.assign(defaultState().settings, parsed.settings || {});
  return merged;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return migrateState(mergeWithDefaults(parsed));
  } catch (e) {
    console.error('Failed to load saved data, starting fresh.', e);
    return defaultState();
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (serverAvailable) {
    fetch('/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    }).catch(() => { serverAvailable = false; renderStorageStatus(); });
  }
}

// If running via server.py (not a plain file:// double-click), data.json on
// disk is the source of truth. On first connection with no data.json yet,
// seed it from whatever's already in localStorage so nothing is lost.
async function trySyncFromServer() {
  try {
    const res = await fetch('/api/data', { cache: 'no-store' });
    if (!res.ok) return;
    const parsed = await res.json();
    serverAvailable = true;
    if (parsed && parsed.subjects && parsed.peptides) {
      state = migrateState(mergeWithDefaults(parsed));
      renderAll();
    } else {
      saveState();
    }
  } catch (e) {
    serverAvailable = false;
  }
  renderStorageStatus();
}

function renderStorageStatus() {
  const el = document.getElementById('storageStatus');
  if (!el) return;
  el.textContent = serverAvailable ? 'Saving to data.json' : 'Browser storage only';
  el.title = serverAvailable
    ? 'Changes are written to data.json in the app folder — no manual backup needed.'
    : 'Not running via start.command/server.py — data lives only in this browser. Export a backup from Settings.';
  el.classList.toggle('ok', serverAvailable);
}

function uid() {
  return (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
    : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

const getSubject = id => state.subjects.find(s => s.id === id);
const getPeptide = id => state.peptides.find(p => p.id === id);
const lotsForPeptide = id => state.inventoryLots.filter(l => l.peptideId === id);
const logsForPeptide = id => state.doseLogs.filter(l => l.peptideId === id);
const protocolsForPeptide = id => state.protocols.filter(p => p.peptideId === id);
const protocolsForSubject = id => state.protocols.filter(p => p.subjectId === id);

function peptideStats(peptideId) {
  const lots = lotsForPeptide(peptideId);
  const grossMg = Calc.totalMgOnHand(lots);
  const consumedMg = Calc.totalMgConsumed(logsForPeptide(peptideId));
  const totalMg = Math.max(0, grossMg - consumedMg);
  const activeProtocols = protocolsForPeptide(peptideId).filter(p => p.active);
  const weeklyMg = activeProtocols.reduce((sum, p) => sum + Calc.weeklyMgUsage(p), 0);
  const hasUsage = weeklyMg > 0;

  const supply = hasUsage
    ? Calc.projectSupply(totalMg, activeProtocols)
    : { doses: 0, limitedBy: 'none', stockOutDate: null, scheduleEndDate: null, mgLeftover: totalMg };

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let daysRemaining = Infinity;
  if (supply.limitedBy === 'stock' && supply.stockOutDate) {
    daysRemaining = Math.max(0, Math.round((supply.stockOutDate - today) / 86400000));
  } else if (supply.limitedBy === 'schedule' && supply.scheduleEndDate) {
    daysRemaining = Math.max(0, Math.round((supply.scheduleEndDate - today) / 86400000));
  }

  return {
    totalMg, consumedMg, weeklyMg, hasUsage, daysRemaining,
    dosesRemaining: supply.doses,
    limitedBy: supply.limitedBy,
    runOutDate: supply.limitedBy === 'stock' ? supply.stockOutDate : null,
    scheduleEndDate: supply.limitedBy === 'schedule' ? supply.scheduleEndDate : null,
    mgLeftoverAfterSchedule: supply.limitedBy === 'schedule' ? supply.mgLeftover : 0,
  };
}

// ---------------------------------------------------------------------------
// Dose log (on-screen check-off — feeds inventory depletion above)
// ---------------------------------------------------------------------------

function localDateStr(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isDoseTaken(protocolId, dateStr) {
  return state.doseLogs.some(l => l.protocolId === protocolId && l.date === dateStr);
}

function toggleDoseTaken(protocolId, dateStr) {
  const idx = state.doseLogs.findIndex(l => l.protocolId === protocolId && l.date === dateStr);
  if (idx >= 0) {
    state.doseLogs.splice(idx, 1);
  } else {
    const protocol = state.protocols.find(p => p.id === protocolId);
    if (!protocol) return;
    state.doseLogs.push({
      id: uid(),
      protocolId,
      subjectId: protocol.subjectId,
      peptideId: protocol.peptideId,
      doseMg: Calc.doseMgOnDate(protocol, new Date(dateStr + 'T00:00:00')),
      date: dateStr,
      takenAt: new Date().toISOString(),
    });
  }
  saveState(); renderAll();
}

// For asNeeded protocols, which are never "due" on any particular day (see
// Calc.isDueOn) and so have no checkbox to toggle — this just appends a log
// entry for right now, the same way the Inventory tab's manual adjustment does.
function logAdHocDose(protocolId) {
  const protocol = state.protocols.find(p => p.id === protocolId);
  if (!protocol) return;
  const now = new Date();
  state.doseLogs.push({
    id: uid(),
    protocolId,
    subjectId: protocol.subjectId,
    peptideId: protocol.peptideId,
    doseMg: Calc.doseMgOnDate(protocol, now),
    date: localDateStr(now),
    takenAt: now.toISOString(),
  });
  saveState(); renderAll();
}

// interactive: real checkbox input wired to toggleDoseTaken (screen only).
// non-interactive: static square for hand-tracking on paper, pre-filled if already logged.
function doseCheckboxHTML(protocol, dateStr, interactive) {
  const taken = isDoseTaken(protocol.id, dateStr);
  if (interactive) {
    return `<input type="checkbox" class="dose-checkbox" data-action="toggle-dose" data-protocol="${protocol.id}" data-date="${dateStr}" ${taken ? 'checked' : ''}>`;
  }
  return `<span class="sched-checkbox ${taken ? 'checked' : ''}"></span>`;
}

function bindDoseCheckboxes(el) {
  el.querySelectorAll('[data-action="toggle-dose"]').forEach(cb => {
    cb.addEventListener('change', () => toggleDoseTaken(cb.dataset.protocol, cb.dataset.date));
  });
}

// Single source of truth for the urgency color shared by the status pill and the
// doses-left/on-hand pills next to it, so all of a peptide's pills move together.
function stockPillClass(stats) {
  if (!stats.hasUsage) return 'neutral';
  if (stats.totalMg <= 0) return 'danger';
  // Cycle (endDate) will finish before stock runs out — not a restock urgency, so always ok-colored.
  if (stats.limitedBy === 'schedule') return 'ok';
  if (!isFinite(stats.daysRemaining)) return 'ok';
  if (stats.daysRemaining <= 7) return 'danger';
  if (stats.daysRemaining <= 21) return 'warn';
  return 'ok';
}

function stockPill(stats) {
  const cls = stockPillClass(stats);
  if (!stats.hasUsage) return `<span class="pill ${cls}">no active protocol</span>`;
  if (stats.totalMg <= 0) return `<span class="pill ${cls}">out of stock</span>`;
  if (stats.limitedBy === 'schedule') return `<span class="pill ${cls}">cycle ends in ${stats.daysRemaining}d</span>`;
  if (!isFinite(stats.daysRemaining)) return `<span class="pill ${cls}">20y+ left</span>`;
  return `<span class="pill ${cls}">${stats.daysRemaining}d left</span>`;
}

// "8w on / 4w off" — shown only in the Protocols tab's meta line, never in
// frequencyLabel() itself since that also feeds the printed vial label, which
// has no room to spare (see frequencyLabel's abbreviation logic below).
function cycleSuffix(p) {
  return (p.cycleOnWeeks && p.cycleOffWeeks) ? `${p.cycleOnWeeks}w on / ${p.cycleOffWeeks}w off` : '';
}

function frequencyLabel(p) {
  if (p.frequency === 'asNeeded') return 'As needed';
  if (p.frequency === 'daily') return 'Daily';
  if (p.frequency === 'eod') return 'Every other day';
  if (p.frequency === 'weekly') {
    const days = (p.daysOfWeek || []).slice().sort((a, b) => a - b);
    if (days.length === 0) return 'Weekly (no days set)';
    if (days.length === 7) return 'Daily';
    // Single/double-letter abbreviations (Su/M/Tu/W/Th/F/Sa) disambiguate
    // Tue vs Thu and Sat vs Sun while staying as compact as possible — this
    // keeps the printed label (the tightest space it's used in) from
    // getting crowded once several days are checked.
    const abbr = ['Su', 'M', 'Tu', 'W', 'Th', 'F', 'Sa'];
    const isContiguousRun = days.every((d, i) => i === 0 || d === days[i - 1] + 1);
    if (isContiguousRun && days.length >= 3) {
      return `${abbr[days[0]]}-${abbr[days[days.length - 1]]}`;
    }
    return days.map(d => abbr[d]).join('/');
  }
  return p.frequency;
}

// doseMg is explicit (not read off the protocol) because titration means the
// dose in effect varies by date — callers look it up via Calc.doseMgOnDate first.
function doseMathFor(p, doseMg) {
  const conc = Calc.concentrationMgPerMl(p.vialMgAssumed, p.bacWaterMl);
  const vol = Calc.drawVolumeMl(doseMg, conc);
  const units = Calc.syringeUnits(vol, state.settings.syringeUnits);
  return { conc, vol, units };
}

function timeOfDayLabel(t) {
  if (t === 'morning') return 'Morning';
  if (t === 'evening') return 'Evening';
  return '';
}

// fixed recipe (mg per vial) for a blend — doesn't depend on any particular
// dose or protocol, used wherever the vial's contents need identifying
// (Inventory card, printed labels)
function blendCompositionText(peptide) {
  if (!peptide || !peptide.isBlend) return '';
  return (peptide.components || [])
    .map(c => `${escapeHtml(c.name)} ${Calc.round(c.mgPerVial, 2)}mg`)
    .join(' · ');
}

// per-dose split of a blend's components for a specific dose amount — used
// wherever an actual dose is being described (Protocols, Dashboard, Schedule,
// and the consumption report), since titration means the mg drawn varies
function blendBreakdownText(peptide, doseMg) {
  if (!peptide || !peptide.isBlend) return '';
  return Calc.blendComponentDoses(peptide, doseMg)
    .map(c => `${escapeHtml(c.name)} ${Calc.round(c.mg, 2)}mg`)
    .join(' · ');
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
  renderAll();
}

function renderAll() {
  renderDashboard();
  renderInventory();
  renderProtocols();
  renderScheduleControls();
  renderLabelsControls();
  renderReportsControls();
  renderSettings();
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

let dashboardView = { mode: 'day' };  // 'day' | 'week' | 'month' — always anchored on today, not persisted

function datesForDashboardView(today) {
  const n = dashboardView.mode === 'day' ? 1 : dashboardView.mode === 'week' ? 7 : 30;
  return Array.from({ length: n }, (_, i) => { const d = new Date(today); d.setDate(d.getDate() + i); return d; });
}

// ---------------------------------------------------------------------------
// Levels graph — a relative "how much is still in the system" estimate from
// half-life decay alone (Calc.decayAt/levelsOverTime), not a real
// blood-concentration model: no absorption phase, volume of distribution, or
// bioavailability data exists anywhere in this app. History comes from actual
// logged doses (doseLogs.takenAt); the line continues past "now" using the
// active schedule (isDueOn/doseMgOnDate), same as everywhere else forward-
// looking figures are computed in this app.
// ---------------------------------------------------------------------------

let levelsView = { subjectId: '', peptideId: '' };
const LEVELS_COLORS = ['#3f6b52', '#6c4f9c', '#a25b2a', '#2a6c8f', '#8c3a5b'];
const TIME_OF_DAY_HOUR = { morning: 8, evening: 20 };

function levelsWindow() {
  const start = new Date();
  start.setDate(start.getDate() - 14);
  const end = new Date();
  end.setDate(end.getDate() + 14);
  return { start, end };
}

function peptidesWithHalfLifeForSubject(subjectId) {
  const relevantIds = new Set([
    ...protocolsForSubject(subjectId).map(p => p.peptideId),
    ...state.doseLogs.filter(l => l.subjectId === subjectId).map(l => l.peptideId),
  ]);
  return state.peptides.filter(p => relevantIds.has(p.id) &&
    (p.isBlend ? (p.components || []).some(c => c.halfLifeHours) : !!p.halfLifeHours));
}

// Dose events (hours-since-windowStart, mg) for one component of a peptide —
// or the peptide itself, for a non-blend, treated as its own sole "component".
// Combines actually-logged doses in the window with not-yet-taken doses the
// active schedule says are still coming, so the curve keeps going past today.
function doseEventsForComponent(subjectId, peptideId, componentName, windowStart, windowEnd) {
  const peptide = getPeptide(peptideId);
  const isBlend = peptide && peptide.isBlend;
  const componentMg = doseMg => isBlend
    ? (Calc.blendComponentDoses(peptide, doseMg).find(c => c.name === componentName)?.mg || 0)
    : doseMg;
  const events = [];

  for (const log of state.doseLogs) {
    if (log.subjectId !== subjectId || log.peptideId !== peptideId || !log.takenAt) continue;
    const t = new Date(log.takenAt);
    if (t < windowStart || t > windowEnd) continue;
    const mg = componentMg(log.doseMg);
    if (mg) events.push({ atHours: (t - windowStart) / 3600000, doseMg: mg });
  }

  const loopStart = new Date(Math.max(new Date(), windowStart));
  loopStart.setHours(0, 0, 0, 0);
  for (const p of protocolsForSubject(subjectId).filter(p => p.peptideId === peptideId)) {
    for (const d = new Date(loopStart); d <= windowEnd; d.setDate(d.getDate() + 1)) {
      if (!Calc.isDueOn(p, d)) continue;
      if (isDoseTaken(p.id, localDateStr(d))) continue; // already counted above
      const eventTime = new Date(d);
      eventTime.setHours(TIME_OF_DAY_HOUR[p.timeOfDay] ?? 12, 0, 0, 0);
      const mg = componentMg(Calc.doseMgOnDate(p, d));
      if (mg) events.push({ atHours: (eventTime - windowStart) / 3600000, doseMg: mg });
    }
  }
  return events;
}

function levelsSeriesForPeptide(subjectId, peptideId, windowStart, windowEnd) {
  const peptide = getPeptide(peptideId);
  if (!peptide) return [];
  const totalHours = (windowEnd - windowStart) / 3600000;
  const sampleHours = [];
  for (let h = 0; h <= totalHours; h += 3) sampleHours.push(h);

  const components = peptide.isBlend
    ? (peptide.components || [])
    : [{ name: peptide.name, halfLifeHours: peptide.halfLifeHours }];

  return components.filter(c => c.halfLifeHours).map(c => ({
    name: c.name,
    points: Calc.levelsOverTime(doseEventsForComponent(subjectId, peptideId, c.name, windowStart, windowEnd), c.halfLifeHours, sampleHours),
  }));
}

function buildLevelsChartSVG(series, windowStart, windowEnd) {
  const width = 680, height = 220, padL = 34, padR = 12, padT = 12, padB = 26;
  const innerW = width - padL - padR, innerH = height - padT - padB;
  const totalHours = (windowEnd - windowStart) / 3600000;
  const maxLevel = Math.max(1e-6, ...series.flatMap(s => s.points.map(p => p.level)));
  const x = h => padL + (h / totalHours) * innerW;
  const y = v => padT + innerH - (v / maxLevel) * innerH;
  const nowHours = (new Date() - windowStart) / 3600000;

  let gridlines = '';
  for (let h = 0; h <= totalHours; h += 24 * 7) {
    const d = new Date(windowStart.getTime() + h * 3600000);
    gridlines += `<line x1="${x(h).toFixed(1)}" y1="${padT}" x2="${x(h).toFixed(1)}" y2="${padT + innerH}" stroke="var(--line)" stroke-opacity="0.5"/>`;
    gridlines += `<text x="${x(h).toFixed(1)}" y="${padT + innerH + 16}" font-size="9" fill="var(--muted)" text-anchor="middle">${escapeHtml(d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</text>`;
  }

  const lines = series.map((s, i) => {
    if (!s.points.length) return '';
    const d = s.points.map((p, j) => `${j === 0 ? 'M' : 'L'} ${x(p.t).toFixed(1)} ${y(p.level).toFixed(1)}`).join(' ');
    return `<path d="${d}" fill="none" stroke="${LEVELS_COLORS[i % LEVELS_COLORS.length]}" stroke-width="2"/>`;
  }).join('');

  const nowLine = (nowHours >= 0 && nowHours <= totalHours)
    ? `<line x1="${x(nowHours).toFixed(1)}" y1="${padT}" x2="${x(nowHours).toFixed(1)}" y2="${padT + innerH}" stroke="var(--ink)" stroke-dasharray="4,3" stroke-opacity="0.6"/>
       <text x="${x(nowHours).toFixed(1)}" y="${padT - 2}" font-size="9" fill="var(--muted)" text-anchor="middle">now</text>`
    : '';

  return `<svg viewBox="0 0 ${width} ${height}" style="width:100%; height:auto; display:block;">
    ${gridlines}
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + innerH}" stroke="var(--line)"/>
    <line x1="${padL}" y1="${padT + innerH}" x2="${padL + innerW}" y2="${padT + innerH}" stroke="var(--line)"/>
    <text x="${padL - 5}" y="${padT + 4}" font-size="9" fill="var(--muted)" text-anchor="end">${Calc.round(maxLevel, 1)}mg</text>
    <text x="${padL - 5}" y="${padT + innerH}" font-size="9" fill="var(--muted)" text-anchor="end">0</text>
    ${nowLine}
    ${lines}
  </svg>`;
}

function renderLevelsSection() {
  if (state.subjects.length === 0) return '';
  if (!levelsView.subjectId || !getSubject(levelsView.subjectId)) levelsView.subjectId = state.subjects[0].id;
  const options = peptidesWithHalfLifeForSubject(levelsView.subjectId);
  if (!levelsView.peptideId || !options.some(p => p.id === levelsView.peptideId)) {
    levelsView.peptideId = options[0] ? options[0].id : '';
  }

  let html = `<h2>Levels</h2><div class="card">
    <div class="row">
      ${state.subjects.length > 1 ? `<div class="field"><label>Subject</label>
        <select id="levelsSubject">${state.subjects.map(s => `<option value="${s.id}" ${s.id === levelsView.subjectId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}</select>
      </div>` : ''}
      <div class="field"><label>Peptide</label>
        <select id="levelsPeptide" ${options.length ? '' : 'disabled'}>
          ${options.length ? options.map(p => `<option value="${p.id}" ${p.id === levelsView.peptideId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('') : '<option>No half-life data yet</option>'}
        </select>
      </div>
    </div>`;

  if (!levelsView.peptideId) {
    html += `<div class="empty-state">Add a half-life in Inventory → edit peptide (or per blend component) to see an estimated levels graph.</div>`;
  } else {
    const { start, end } = levelsWindow();
    const series = levelsSeriesForPeptide(levelsView.subjectId, levelsView.peptideId, start, end);
    if (series.length === 0 || series.every(s => s.points.every(p => p.level === 0))) {
      html += `<div class="empty-state">No dosing data in this window yet.</div>`;
    } else {
      html += buildLevelsChartSVG(series, start, end);
      html += `<div class="row small muted" style="margin-top:.5rem;">${series.map((s, i) =>
        `<span style="display:inline-flex; align-items:center; gap:.3rem; margin-right:1rem;"><span style="width:10px; height:10px; border-radius:2px; background:${LEVELS_COLORS[i % LEVELS_COLORS.length]}; display:inline-block;"></span>${escapeHtml(s.name)}</span>`
      ).join('')}</div>`;
    }
    html += `<div class="muted small" style="margin-top:.5rem;">Rough estimate from half-life decay alone (dose × 0.5^(hours since dose ÷ half-life), summed across doses) — not a real blood-concentration model. History is from logged doses; past "now" it continues using the active schedule.</div>`;
  }
  html += `</div>`;
  return html;
}

function renderDashboard() {
  const el = document.getElementById('dashboardContent');
  const today = new Date();

  let html = `<h2>Upcoming doses</h2>`;

  if (state.subjects.length === 0) {
    html += `<div class="empty-state">Add a subject in Settings to get started.</div>`;
  } else {
    const dates = datesForDashboardView(today);
    const blocks = doseListBlocksHTML(dates, state.subjects, { interactive: true, showDraw: true });
    html += `<div class="card">
      <div class="seg-control" id="dashViewToggle">
        <button type="button" data-mode="day" class="${dashboardView.mode === 'day' ? 'active' : ''}">Day</button>
        <button type="button" data-mode="week" class="${dashboardView.mode === 'week' ? 'active' : ''}">Week</button>
        <button type="button" data-mode="month" class="${dashboardView.mode === 'month' ? 'active' : ''}">Month</button>
      </div>
      <div style="margin-top:.7rem;">${blocks || '<div class="empty-state">No doses scheduled in this range.</div>'}</div>
    </div>`;
  }

  const asNeeded = state.protocols.filter(p => p.active && p.frequency === 'asNeeded');
  if (asNeeded.length > 0) {
    html += `<h2>As-needed</h2><div class="card"><div class="item-list">`;
    for (const p of asNeeded) {
      const peptide = getPeptide(p.peptideId);
      const subject = getSubject(p.subjectId);
      const doseMg = Calc.doseMgOnDate(p, today);
      const lastLog = state.doseLogs.filter(l => l.protocolId === p.id).sort((a, b) => b.takenAt.localeCompare(a.takenAt))[0];
      html += `<div class="item-row">
        <div>
          <strong>${escapeHtml(peptide ? peptide.name : '(deleted peptide)')}</strong> — ${doseMg} mg
          ${state.subjects.length > 1 ? `<span class="meta">${escapeHtml(subject ? subject.name : '')}</span>` : ''}
          ${lastLog ? `<div class="meta">Last taken ${escapeHtml(Calc.formatDate(new Date(lastLog.takenAt)))}</div>` : `<div class="meta">Not logged yet</div>`}
        </div>
        <div class="actions"><button class="btn" data-action="log-adhoc-dose" data-id="${p.id}">Log dose</button></div>
      </div>`;
    }
    html += `</div></div>`;
  }

  html += renderLevelsSection();

  html += `<h2>Inventory watch</h2>`;
  const peptidesWithSignal = state.peptides.filter(p => lotsForPeptide(p.id).length || protocolsForPeptide(p.id).length);
  if (peptidesWithSignal.length === 0) {
    html += `<div class="empty-state">Add peptides and inventory lots to see run-out projections.</div>`;
  } else {
    html += `<table><thead><tr><th>Peptide</th><th>On hand</th><th>Status</th><th>Doses left</th><th>Run-out / cycle end</th></tr></thead><tbody>`;
    for (const peptide of peptidesWithSignal) {
      const stats = peptideStats(peptide.id);
      const active = stats.hasUsage && stats.totalMg > 0;
      let dateCol = '—';
      if (active) {
        if (stats.limitedBy === 'schedule') dateCol = `Cycle ends ${Calc.formatDate(stats.scheduleEndDate)}`;
        else if (isFinite(stats.daysRemaining)) dateCol = Calc.formatDate(stats.runOutDate);
        else dateCol = '20+ yrs';
      }
      html += `<tr>
        <td>${escapeHtml(peptide.name)}</td>
        <td>${Calc.round(stats.totalMg, 2)} mg</td>
        <td>${stockPill(stats)}</td>
        <td>${active ? stats.dosesRemaining : '—'}</td>
        <td>${dateCol}</td>
      </tr>`;
    }
    html += `</tbody></table>`;
  }

  el.innerHTML = html;
  bindDoseCheckboxes(el);
  el.querySelectorAll('#dashViewToggle button').forEach(btn => {
    btn.addEventListener('click', () => { dashboardView.mode = btn.dataset.mode; renderDashboard(); });
  });
  el.querySelectorAll('[data-action="log-adhoc-dose"]').forEach(btn => {
    btn.addEventListener('click', () => logAdHocDose(btn.dataset.id));
  });
  el.querySelector('#levelsSubject')?.addEventListener('change', e => {
    levelsView.subjectId = e.target.value;
    levelsView.peptideId = '';
    renderDashboard();
  });
  el.querySelector('#levelsPeptide')?.addEventListener('change', e => {
    levelsView.peptideId = e.target.value;
    renderDashboard();
  });
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

// Collapsed by default once a peptide has restock lots; auto-expanded the first time
// (no lots yet) so a newly-added peptide isn't collapsed before you can stock it.
function isPeptideExpanded(peptide) {
  if (peptide.id in inventoryExpanded) return inventoryExpanded[peptide.id];
  return lotsForPeptide(peptide.id).length === 0;
}

// key 'new' for the always-visible add form, or a peptide id for its inline edit form
function renderPeptideForm(key, editingP) {
  if (!peptideFormDraft[key]) {
    peptideFormDraft[key] = editingP
      ? {
          isBlend: !!editingP.isBlend, halfLifeHours: editingP.halfLifeHours || '',
          components: (editingP.components || []).map(c => ({ name: c.name, mgPerVial: c.mgPerVial, halfLifeHours: c.halfLifeHours || '' })),
        }
      : { isBlend: false, halfLifeHours: '', components: [] };
    if (peptideFormDraft[key].components.length === 0) peptideFormDraft[key].components.push({ name: '', mgPerVial: '', halfLifeHours: '' });
  }
  const draft = peptideFormDraft[key];
  const totalMg = draft.components.reduce((sum, c) => sum + (parseFloat(c.mgPerVial) || 0), 0);

  return `<form data-action="save-peptide" data-key="${key}" data-edit-id="${editingP ? editingP.id : ''}">
    <div class="row">
      <div class="field"><label>Peptide name</label><input name="name" required placeholder="e.g. BPC-157 or KLOW" value="${editingP ? escapeHtml(editingP.name) : ''}"></div>
      <div class="field"><label>Notes</label><input name="notes" placeholder="optional" value="${editingP ? escapeHtml(editingP.notes || '') : ''}"></div>
      <div class="field" data-role="peptideHalfLifeField" style="${draft.isBlend ? 'display:none;' : ''}"><label>Half-life (hours, optional)</label><input name="halfLifeHours" type="number" step="0.1" min="0" placeholder="for the levels graph" value="${draft.halfLifeHours || ''}"></div>
    </div>
    <label style="display:flex; align-items:center; gap:.4rem; cursor:pointer; font-size:.85rem; color:var(--ink); margin-bottom:.5rem;">
      <input type="checkbox" name="isBlend" data-role="isBlendToggle" style="width:auto;" ${draft.isBlend ? 'checked' : ''}>
      This is a blend (multiple peptides combined in one vial)
    </label>
    <div data-role="blendComponentsField" style="${draft.isBlend ? '' : 'display:none;'}">
      <label>Components (mg per vial, at the ratio the blend is mixed; half-life is optional, only used for the levels graph)</label>
      <div data-role="blendComponentRows">
        ${draft.components.map((c, i) => `
          <div class="row" style="margin-bottom:.4rem;">
            <div class="field"><input name="compName" placeholder="e.g. GHK-Cu" value="${escapeHtml(c.name)}"></div>
            <div class="field"><input name="compMg" type="number" step="0.01" min="0" placeholder="mg/vial" value="${c.mgPerVial}"></div>
            <div class="field"><input name="compHalfLife" type="number" step="0.1" min="0" placeholder="half-life (hrs)" value="${c.halfLifeHours || ''}"></div>
            <div class="field" style="flex:0 0 auto;"><button class="btn danger" type="button" data-action="remove-component" data-index="${i}" ${draft.components.length <= 1 ? 'disabled' : ''}>Remove</button></div>
          </div>`).join('')}
      </div>
      <div class="row" style="align-items:center;">
        <button class="btn secondary" type="button" data-action="add-component">+ Add peptide to blend</button>
        <span class="muted small" data-role="blendTotal">Total: ${Calc.round(totalMg, 2)} mg/vial</span>
      </div>
    </div>
    <div class="row" style="align-items:center; margin-top:.6rem;">
      <button class="btn" type="submit">${editingP ? 'Save changes' : 'Add peptide'}</button>
      ${editingP ? `<button class="btn secondary" type="button" data-action="cancel-edit-peptide">Cancel</button>` : ''}
    </div>
  </form>`;
}

function syncBlendDraftFromForm(form, key) {
  const names = Array.from(form.querySelectorAll('[name="compName"]')).map(i => i.value);
  const mgs = Array.from(form.querySelectorAll('[name="compMg"]')).map(i => i.value);
  const halfLives = Array.from(form.querySelectorAll('[name="compHalfLife"]')).map(i => i.value);
  const isBlend = form.querySelector('[name="isBlend"]').checked;
  const halfLifeHours = form.querySelector('[name="halfLifeHours"]')?.value || '';
  peptideFormDraft[key] = { isBlend, halfLifeHours, components: names.map((name, i) => ({ name, mgPerVial: mgs[i], halfLifeHours: halfLives[i] })) };
}

function bindPeptideFormEvents(el) {
  el.querySelectorAll('[data-role="isBlendToggle"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const form = cb.closest('form');
      form.querySelector('[data-role="blendComponentsField"]').style.display = cb.checked ? '' : 'none';
      form.querySelector('[data-role="peptideHalfLifeField"]').style.display = cb.checked ? 'none' : '';
    });
  });

  el.querySelectorAll('form[data-action="save-peptide"]').forEach(form => {
    const totalEl = form.querySelector('[data-role="blendTotal"]');
    form.querySelectorAll('[name="compMg"]').forEach(input => {
      input.addEventListener('input', () => {
        const total = Array.from(form.querySelectorAll('[name="compMg"]')).reduce((sum, i) => sum + (parseFloat(i.value) || 0), 0);
        totalEl.textContent = `Total: ${Calc.round(total, 2)} mg/vial`;
      });
    });
  });

  el.querySelectorAll('[data-action="add-component"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const form = btn.closest('form');
      syncBlendDraftFromForm(form, form.dataset.key);
      peptideFormDraft[form.dataset.key].components.push({ name: '', mgPerVial: '' });
      renderInventory();
    });
  });

  el.querySelectorAll('[data-action="remove-component"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const form = btn.closest('form');
      syncBlendDraftFromForm(form, form.dataset.key);
      const rows = peptideFormDraft[form.dataset.key].components;
      if (rows.length > 1) rows.splice(Number(btn.dataset.index), 1);
      renderInventory();
    });
  });

  el.querySelectorAll('form[data-action="save-peptide"]').forEach(form => {
    form.addEventListener('submit', e => {
      e.preventDefault();
      const f = new FormData(form);
      const key = form.dataset.key;
      const editId = form.dataset.editId;
      const isBlend = f.get('isBlend') === 'on';
      const names = f.getAll('compName');
      const mgs = f.getAll('compMg');
      const halfLives = f.getAll('compHalfLife');
      const components = isBlend
        ? names.map((name, i) => {
            const hl = parseFloat(halfLives[i]);
            return { id: uid(), name: name.trim(), mgPerVial: parseFloat(mgs[i]), halfLifeHours: (!isNaN(hl) && hl > 0) ? hl : null };
          }).filter(c => c.name && !isNaN(c.mgPerVial) && c.mgPerVial > 0)
        : [];
      const peptideHalfLife = parseFloat(f.get('halfLifeHours'));
      const payload = {
        name: f.get('name').trim(), notes: f.get('notes').trim(), isBlend, components,
        halfLifeHours: (!isBlend && !isNaN(peptideHalfLife) && peptideHalfLife > 0) ? peptideHalfLife : null,
      };
      if (editId) {
        Object.assign(getPeptide(editId), payload);
        editingPeptideId = null;
      } else {
        state.peptides.push({ id: uid(), ...payload });
      }
      delete peptideFormDraft[key];
      saveState(); renderAll();
    });
  });

  el.querySelectorAll('[data-action="edit-peptide"]').forEach(btn => {
    btn.addEventListener('click', () => {
      editingPeptideId = btn.dataset.id;
      delete peptideFormDraft[btn.dataset.id];
      renderInventory();
    });
  });

  el.querySelectorAll('[data-action="cancel-edit-peptide"]').forEach(btn => {
    btn.addEventListener('click', () => {
      delete peptideFormDraft[editingPeptideId];
      editingPeptideId = null;
      renderInventory();
    });
  });
}

// +/- arrow on a specific lot: pushes a manual doseLogs entry (protocolId:
// null) sized to that lot's own mgPerVial, same mechanism as the manual
// stock-adjustment form below — dir=-1 (one fewer vial) subtracts stock,
// dir=1 (one more vial, a correction) adds it back. Defaults the subject to
// whoever has a protocol for this peptide when that's unambiguous, since this
// is a quick inventory correction, not a per-dose log entry.
function stepLotVial(lotId, dir) {
  const lot = state.inventoryLots.find(l => l.id === lotId);
  if (!lot) return;
  const protocolSubjects = new Set(protocolsForPeptide(lot.peptideId).map(p => p.subjectId));
  const subjectId = protocolSubjects.size === 1 ? Array.from(protocolSubjects)[0] : (state.subjects[0] ? state.subjects[0].id : '');
  state.doseLogs.push({
    id: uid(),
    protocolId: null,
    subjectId,
    peptideId: lot.peptideId,
    doseMg: -dir * lot.mgPerVial,
    date: todayStr(),
    note: `Vial count adjustment (${lot.mgPerVial}mg/vial lot)`,
    takenAt: new Date().toISOString(),
  });
  saveState(); renderAll();
}

function renderInventory() {
  const el = document.getElementById('inventoryContent');
  let html = `<h2>Peptide library</h2>
    <div class="card">
      <h3>Add peptide</h3>
      ${renderPeptideForm('new', null)}
    </div>`;

  if (state.peptides.length === 0) {
    html += `<div class="empty-state">No peptides yet — add one above.</div>`;
  }

  for (const peptide of state.peptides) {
    const lots = lotsForPeptide(peptide.id);
    const stats = peptideStats(peptide.id);
    const manualLogs = logsForPeptide(peptide.id).filter(l => !l.protocolId).sort((a, b) => a.date < b.date ? 1 : -1);
    const canDelete = lots.length === 0 && protocolsForPeptide(peptide.id).length === 0;
    const expanded = isPeptideExpanded(peptide);
    const hasActiveUsage = stats.hasUsage && stats.totalMg > 0;
    const pillClass = stockPillClass(stats);

    html += `<div class="card">
      <div class="row" style="justify-content:space-between; align-items:flex-start; flex-wrap:nowrap;">
        <div class="peptide-card-header" data-action="toggle-peptide" data-id="${peptide.id}" style="flex:1 1 auto; min-width:0;">
          <h3><span class="chevron">${expanded ? '▾' : '▸'}</span>${escapeHtml(peptide.name)}
            ${stockPill(stats)}
            ${hasActiveUsage ? `<span class="pill ${pillClass}">${stats.dosesRemaining} doses left</span>` : ''}
            <span class="pill ${pillClass}">${Calc.round(stats.totalMg, 2)} mg on hand</span>
          </h3>
          ${expanded && peptide.notes ? `<div class="muted">${escapeHtml(peptide.notes)}</div>` : ''}
          ${expanded && peptide.isBlend ? `<div class="muted small">Blend: ${blendCompositionText(peptide)} (${Calc.round(Calc.blendTotalMg(peptide), 2)}mg/vial total)</div>` : ''}
        </div>
        <div class="actions" style="display:flex; gap:.4rem; flex:none;">
          <button class="btn secondary" data-action="edit-peptide" data-id="${peptide.id}">Edit</button>
          <button class="btn danger" data-action="delete-peptide" data-id="${peptide.id}" ${canDelete ? '' : 'disabled title="Remove its lots/protocols first"'}>Delete</button>
        </div>
      </div>`;

    if (editingPeptideId === peptide.id) {
      html += `<div style="margin-top:.7rem;">${renderPeptideForm(peptide.id, peptide)}</div>`;
    }

    if (expanded) {
      html += `
      <div class="row small muted" style="margin-top:.4rem;">
        <div>On hand: <strong>${Calc.round(stats.totalMg, 2)} mg</strong></div>
        <div>Logged taken: <strong>${Calc.round(stats.consumedMg, 2)} mg</strong></div>
        <div>Weekly usage: <strong>${Calc.round(stats.weeklyMg, 2)} mg</strong></div>
        <div>Doses left: <strong>${hasActiveUsage ? stats.dosesRemaining : '—'}</strong></div>
      </div>
      <div class="row small muted" style="margin-top:.2rem;">
        ${hasActiveUsage ? (
          stats.limitedBy === 'schedule'
            ? `<div>Current cycle ends: <strong>${Calc.formatDate(stats.scheduleEndDate)}</strong> — ~${Calc.round(stats.mgLeftoverAfterSchedule, 2)}mg will remain on hand for a future cycle</div>`
            : `<div>Run-out: <strong>${isFinite(stats.daysRemaining) ? Calc.formatDate(stats.runOutDate) : '20+ years'}</strong></div>`
        ) : ''}
      </div>
      <hr class="divider">
      <table><thead><tr><th>mg/vial</th><th>Acquired</th><th>Remaining (approx)</th><th>Date</th><th></th></tr></thead><tbody>
        ${Calc.lotsRemaining(lots, stats.consumedMg).map(({ lot, remainingVials }) => `<tr>
          <td>${lot.mgPerVial}</td>
          <td>${lot.vials}</td>
          <td>
            <div style="display:flex; align-items:center; gap:.4rem;">
              <button class="btn secondary" type="button" data-action="lot-vial-step" data-lot="${lot.id}" data-dir="-1" title="One fewer vial (−${lot.mgPerVial}mg)">−</button>
              <span>${Calc.round(remainingVials, 2)}</span>
              <button class="btn secondary" type="button" data-action="lot-vial-step" data-lot="${lot.id}" data-dir="1" title="One more vial (+${lot.mgPerVial}mg)">+</button>
            </div>
          </td>
          <td>${escapeHtml(lot.dateAcquired)}</td>
          <td><button class="btn danger" data-action="delete-lot" data-id="${lot.id}">Remove</button></td>
        </tr>`).join('') || `<tr><td colspan="5" class="empty-state">No lots yet.</td></tr>`}
      </tbody></table>
      ${lots.length ? `<div class="muted small" style="margin-top:.3rem;">Remaining is approximate (oldest lot assumed used up first). Use +/− to correct a count you forgot to log — it's recorded below as a manual adjustment.</div>` : ''}
      <form class="row" data-action="add-lot" data-peptide="${peptide.id}" style="margin-top:.6rem;">
        <div class="field"><label>mg per vial</label><input name="mgPerVial" type="number" step="0.01" min="0" required></div>
        <div class="field"><label>Vials</label><input name="vials" type="number" step="1" min="0" required></div>
        <div class="field"><label>Date acquired</label><input name="dateAcquired" type="date" value="${todayStr()}" required></div>
        <div class="field" style="flex:0 0 auto; align-self:flex-end;"><button class="btn secondary" type="submit">Add restock lot</button></div>
      </form>
      <hr class="divider">
      <div class="muted small" style="margin-bottom:.4rem;">Manual stock adjustments — for doses taken outside a protocol (e.g. before you started tracking), or to correct a count. Positive mg subtracts from stock (a dose taken), negative mg adds back (a correction).</div>
      ${manualLogs.length ? `<table><thead><tr><th>Date</th>${state.subjects.length > 1 ? '<th>Subject</th>' : ''}<th>mg</th><th>Note</th><th></th></tr></thead><tbody>
        ${manualLogs.map(log => `<tr>
          <td>${escapeHtml(log.date)}</td>
          ${state.subjects.length > 1 ? `<td>${escapeHtml(getSubject(log.subjectId)?.name || '—')}</td>` : ''}
          <td>${log.doseMg > 0 ? '+' : ''}${Calc.round(log.doseMg, 2)}</td>
          <td>${escapeHtml(log.note || '')}</td>
          <td><button class="btn danger" data-action="delete-manual-log" data-id="${log.id}">Remove</button></td>
        </tr>`).join('')}
      </tbody></table>` : ''}
      <form class="row" data-action="add-manual-log" data-peptide="${peptide.id}" style="margin-top:.6rem;">
        ${state.subjects.length > 1 ? `<div class="field"><label>Subject</label>
          <select name="subjectId">${state.subjects.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}</select>
        </div>` : ''}
        <div class="field"><label>Date</label><input name="date" type="date" value="${todayStr()}" required></div>
        <div class="field"><label>mg taken (negative to add back)</label><input name="doseMg" type="number" step="0.01" required></div>
        <div class="field"><label>Note</label><input name="note" placeholder="optional"></div>
        <div class="field" style="flex:0 0 auto; align-self:flex-end;"><button class="btn secondary" type="submit">Log adjustment</button></div>
      </form>`;
    }

    html += `</div>`;
  }

  el.innerHTML = html;

  bindPeptideFormEvents(el);

  el.querySelectorAll('[data-action="toggle-peptide"]').forEach(header => {
    header.addEventListener('click', () => {
      const peptide = getPeptide(header.dataset.id);
      inventoryExpanded[header.dataset.id] = !isPeptideExpanded(peptide);
      renderInventory();
    });
  });

  el.querySelectorAll('form[data-action="add-lot"]').forEach(form => {
    form.addEventListener('submit', e => {
      e.preventDefault();
      const f = new FormData(e.target);
      state.inventoryLots.push({
        id: uid(),
        peptideId: form.dataset.peptide,
        mgPerVial: parseFloat(f.get('mgPerVial')),
        vials: parseInt(f.get('vials'), 10),
        dateAcquired: f.get('dateAcquired'),
      });
      saveState(); renderAll();
    });
  });

  el.querySelectorAll('[data-action="delete-lot"]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.inventoryLots = state.inventoryLots.filter(l => l.id !== btn.dataset.id);
      saveState(); renderAll();
    });
  });

  el.querySelectorAll('[data-action="lot-vial-step"]').forEach(btn => {
    btn.addEventListener('click', () => stepLotVial(btn.dataset.lot, Number(btn.dataset.dir)));
  });

  el.querySelectorAll('form[data-action="add-manual-log"]').forEach(form => {
    form.addEventListener('submit', e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const peptideId = form.dataset.peptide;
      const subjectId = state.subjects.length > 1 ? f.get('subjectId') : (state.subjects[0] ? state.subjects[0].id : '');
      state.doseLogs.push({
        id: uid(),
        protocolId: null,
        subjectId,
        peptideId,
        doseMg: parseFloat(f.get('doseMg')),
        date: f.get('date'),
        note: f.get('note').trim(),
        takenAt: new Date().toISOString(),
      });
      saveState(); renderAll();
    });
  });

  el.querySelectorAll('[data-action="delete-manual-log"]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.doseLogs = state.doseLogs.filter(l => l.id !== btn.dataset.id);
      saveState(); renderAll();
    });
  });

  el.querySelectorAll('[data-action="delete-peptide"]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      state.peptides = state.peptides.filter(p => p.id !== btn.dataset.id);
      saveState(); renderAll();
    });
  });
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Protocols
// ---------------------------------------------------------------------------

function renderProtocols() {
  const el = document.getElementById('protocolsContent');
  let html = '<h2>Protocols</h2>';

  if (state.peptides.length === 0) {
    html += `<div class="empty-state">Add a peptide in Inventory first.</div>`;
  }

  if (state.subjects.length > 1) {
    html += `<div class="card">
      <div class="field"><label>Subject</label>
        <select id="protocolsSubjectFilter">
          <option value="all" ${protocolsView.subjectId === 'all' ? 'selected' : ''}>All subjects</option>
          ${state.subjects.map(s => `<option value="${s.id}" ${protocolsView.subjectId === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
        </select>
      </div>
    </div>`;
  }

  const today = new Date();

  const subjectsToShow = state.subjects.filter(s => protocolsView.subjectId === 'all' || s.id === protocolsView.subjectId);

  for (const subject of subjectsToShow) {
    const protocols = protocolsForSubject(subject.id);
    const editId = editingProtocol[subject.id] || null;
    const editingP = editId ? protocols.find(p => p.id === editId) : null;
    const showForm = editingP || addingProtocol[subject.id];

    html += `<div class="card" style="border-left:3px solid ${subject.color}">
      <div class="subject-tag"><span class="subject-dot" style="background:${subject.color}"></span>${escapeHtml(subject.name)}</div>`;

    html += `<div class="item-list" style="margin:.6rem 0;">`;
    if (protocols.length === 0) {
      html += `<div class="empty-state">No protocols yet.</div>`;
    }
    for (const p of protocols) {
      const peptide = getPeptide(p.peptideId);
      const currentDoseMg = Calc.doseMgOnDate(p, today);
      const m = doseMathFor(p, currentDoseMg);
      const startDate = Calc.protocolStartDate(p);
      // "next phase" is whatever comes after the phase currently in effect —
      // NOT just "any phase in the future", which would also flag a
      // protocol's own not-yet-started first phase as a bogus titration step
      const schedule = p.doseSchedule || [];
      let appliedIdx = 0;
      for (let i = 0; i < schedule.length; i++) {
        if (new Date(schedule[i].startDate + 'T00:00:00') <= today) appliedIdx = i;
      }
      const nextPhase = schedule[appliedIdx + 1];
      const timeLabel = timeOfDayLabel(p.timeOfDay);
      const cycleText = cycleSuffix(p);
      const lastAdHoc = p.frequency === 'asNeeded'
        ? state.doseLogs.filter(l => l.protocolId === p.id).sort((a, b) => b.takenAt.localeCompare(a.takenAt))[0]
        : null;
      html += `<div class="item-row">
        <div>
          <strong>${escapeHtml(peptide ? peptide.name : '(deleted peptide)')}</strong> — ${currentDoseMg} mg, ${frequencyLabel(p)}
          <div class="meta">Draw ${Calc.round(m.vol, 3)} mL (${Calc.round(m.units, 1)} u) from ${p.vialMgAssumed}mg/${p.bacWaterMl}mL vial ${timeLabel ? '· ' + timeLabel : ''} · Since ${escapeHtml(Calc.formatDate(new Date(startDate + 'T00:00:00')))}${p.endDate ? ' until ' + escapeHtml(Calc.formatDate(new Date(p.endDate + 'T00:00:00'))) : ''}${cycleText ? ' · ' + escapeHtml(cycleText) : ''} ${!p.active ? '· <em>paused</em>' : ''}</div>
          ${peptide && peptide.isBlend ? `<div class="meta">→ ${blendBreakdownText(peptide, currentDoseMg)}</div>` : ''}
          ${nextPhase ? `<div class="meta">Titrating to <strong>${nextPhase.doseMg} mg</strong> starting ${escapeHtml(Calc.formatDate(new Date(nextPhase.startDate + 'T00:00:00')))}</div>` : ''}
          ${lastAdHoc ? `<div class="meta">Last taken ${escapeHtml(Calc.formatDate(new Date(lastAdHoc.takenAt)))}</div>` : ''}
        </div>
        <div class="actions">
          ${p.frequency === 'asNeeded' ? `<button class="btn" data-action="log-adhoc-dose" data-id="${p.id}">Log dose</button>` : ''}
          <button class="btn secondary" data-action="toggle-active" data-id="${p.id}" data-subject="${subject.id}">${p.active ? 'Pause' : 'Resume'}</button>
          <button class="btn secondary" data-action="edit-protocol" data-id="${p.id}" data-subject="${subject.id}">Edit</button>
          <button class="btn danger" data-action="delete-protocol" data-id="${p.id}" data-subject="${subject.id}">Delete</button>
        </div>
      </div>`;
    }
    html += `</div>`;

    if (showForm) {
      html += renderProtocolForm(subject, editingP);
    } else if (state.peptides.length > 0) {
      html += `<button class="btn" type="button" data-action="show-add-protocol" data-subject="${subject.id}">+ Add protocol</button>`;
    }
    html += `</div>`;
  }

  el.innerHTML = html;
  bindProtocolEvents(el);
}

function renderProtocolForm(subject, editingP) {
  if (state.peptides.length === 0) return '';

  if (!protocolFormDraft[subject.id]) {
    protocolFormDraft[subject.id] = editingP
      ? {
          peptideId: editingP.peptideId, bacWaterMl: editingP.bacWaterMl, vialMgAssumed: editingP.vialMgAssumed,
          frequency: editingP.frequency, daysOfWeek: (editingP.daysOfWeek || []).slice(),
          timeOfDay: editingP.timeOfDay, endDate: editingP.endDate || '', active: editingP.active,
          cycleLengthWeeks: editingP.cycleOnWeeks || '', cycleOffWeeks: editingP.cycleOffWeeks || '',
          doseRows: editingP.doseSchedule.map(ph => ({ startDate: ph.startDate, doseMg: ph.doseMg })),
        }
      : {
          peptideId: state.peptides[0].id, bacWaterMl: '', vialMgAssumed: '',
          frequency: 'daily', daysOfWeek: [], timeOfDay: '', endDate: '', active: true,
          cycleLengthWeeks: '', cycleOffWeeks: '',
          doseRows: [{ startDate: todayStr(), doseMg: '' }],
        };
  }
  const p = protocolFormDraft[subject.id];
  const doseRows = p.doseRows;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // lets each dose row show/accept a syringe-units equivalent alongside mg — purely a
  // display + input convenience computed from the vial/bac-water fields already in this
  // same form; mg remains the one persisted field (see bindProtocolEvents for the live
  // unit<->mg conversion wiring)
  const concMgPerMl = Calc.concentrationMgPerMl(parseFloat(p.vialMgAssumed) || 0, parseFloat(p.bacWaterMl) || 0);
  const unitsLabel = state.settings.syringeUnits === 'U40' ? 'U-40' : 'U-100';

  return `<form data-action="save-protocol" data-subject="${subject.id}" data-edit-id="${editingP ? editingP.id : ''}">
    <h3>${editingP ? 'Edit protocol' : 'Add protocol'}</h3>
    <div class="row">
      <div class="field"><label>Peptide</label>
        <select name="peptideId">${state.peptides.map(pep => `<option value="${pep.id}" ${pep.id === p.peptideId ? 'selected' : ''}>${escapeHtml(pep.name)}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Time of day</label>
        <select name="timeOfDay">
          <option value="" ${!p.timeOfDay ? 'selected' : ''}>Unspecified</option>
          <option value="morning" ${p.timeOfDay === 'morning' ? 'selected' : ''}>Morning</option>
          <option value="evening" ${p.timeOfDay === 'evening' ? 'selected' : ''}>Evening</option>
        </select>
      </div>
      <div class="field"><label>End date (optional)</label><input name="endDate" type="date" value="${p.endDate || ''}"></div>
    </div>
    <div class="row">
      <div class="field"><label>Vial size assumed (mg)</label><input name="vialMgAssumed" type="number" step="0.01" min="0" value="${p.vialMgAssumed}" required></div>
      <div class="field"><label>Bac water added (mL)</label><input name="bacWaterMl" type="number" step="0.01" min="0" value="${p.bacWaterMl}" required></div>
    </div>
    <div class="row">
      <div class="field"><label>Frequency</label>
        <select name="frequency" data-role="frequency">
          <option value="daily" ${p.frequency === 'daily' ? 'selected' : ''}>Daily</option>
          <option value="eod" ${p.frequency === 'eod' ? 'selected' : ''}>Every other day</option>
          <option value="weekly" ${p.frequency === 'weekly' ? 'selected' : ''}>Specific days of the week</option>
          <option value="asNeeded" ${p.frequency === 'asNeeded' ? 'selected' : ''}>As needed (no fixed schedule)</option>
        </select>
      </div>
      <div class="field" data-role="daysOfWeekField" style="${p.frequency === 'weekly' ? '' : 'display:none;'}">
        <label>Days</label>
        <div class="checkbox-grid">
          ${days.map((d, i) => `<label><input type="checkbox" name="daysOfWeek" value="${i}" ${(p.daysOfWeek || []).includes(i) ? 'checked' : ''}> ${d}</label>`).join('')}
        </div>
      </div>
    </div>
    <div class="row" data-role="cycleFields" style="${p.frequency === 'asNeeded' ? 'display:none;' : ''}">
      <div class="field"><label>Cycle length (weeks, optional)</label><input name="cycleLengthWeeks" type="number" min="1" step="1" placeholder="e.g. 8" value="${p.cycleLengthWeeks || ''}"></div>
      <div class="field"><label>Off before it resumes (weeks, optional)</label><input name="cycleOffWeeks" type="number" min="1" step="1" placeholder="repeats forever if set" value="${p.cycleOffWeeks || ''}"></div>
      <div class="muted small" style="flex:1 1 100%; margin-top:-.3rem;">Cycle length alone just sets the end date above. Add an off-period too and it'll automatically resume — and keep repeating — after that many weeks off; set End date as well if you want the whole pattern to stop for good on a specific date.</div>
    </div>
    <div class="field" style="margin-top:.2rem;">
      <label>Dose schedule${doseRows.length > 1 ? ' (titration)' : ''}</label>
      <div data-role="doseScheduleRows">
        ${doseRows.map((row, i) => {
          const mgNum = parseFloat(row.doseMg);
          const unitsVal = concMgPerMl && !isNaN(mgNum)
            ? Calc.round(Calc.syringeUnits(Calc.drawVolumeMl(mgNum, concMgPerMl), state.settings.syringeUnits), 2)
            : '';
          return `
          <div class="row" style="margin-bottom:.4rem;">
            <div class="field"><label>${i === 0 ? 'Starting' : 'Change to on'}</label><input name="phaseDate" type="date" value="${row.startDate}" required></div>
            <div class="field"><label>Dose (mg)</label><input name="phaseDoseMg" type="number" step="0.001" min="0" value="${row.doseMg}" required></div>
            <div class="field"><label>or dose (${unitsLabel} units)</label><input name="phaseDoseUnits" type="number" step="0.1" min="0" placeholder="u" value="${unitsVal}" ${concMgPerMl ? '' : 'disabled title="Enter vial size and bac water first"'}></div>
            <div class="field" style="flex:0 0 auto; align-self:flex-end;"><button class="btn danger" type="button" data-action="remove-phase" data-index="${i}" ${doseRows.length <= 1 ? 'disabled' : ''}>Remove</button></div>
          </div>`;
        }).join('')}
      </div>
      <button class="btn secondary" type="button" data-action="add-phase">+ Add dose change</button>
    </div>
    <div class="row" style="align-items:center; margin-top:.6rem;">
      <button class="btn" type="submit">${editingP ? 'Save changes' : 'Add protocol'}</button>
      <button class="btn secondary" type="button" data-action="cancel-edit" data-subject="${subject.id}">Cancel</button>
    </div>
  </form>`;
}

// captures whatever's currently typed/selected across the whole form into
// protocolFormDraft, so any re-render while the form is open (row add/remove,
// switching tabs, etc.) rebuilds from the latest values instead of resetting
function syncProtocolFormDraft(form, subjectId) {
  const draft = protocolFormDraft[subjectId];
  if (!draft) return;
  const f = new FormData(form);
  draft.peptideId = f.get('peptideId');
  draft.timeOfDay = f.get('timeOfDay');
  draft.endDate = f.get('endDate') || '';
  draft.vialMgAssumed = f.get('vialMgAssumed');
  draft.bacWaterMl = f.get('bacWaterMl');
  draft.frequency = f.get('frequency');
  draft.daysOfWeek = f.getAll('daysOfWeek').map(Number);
  draft.cycleLengthWeeks = f.get('cycleLengthWeeks') || '';
  draft.cycleOffWeeks = f.get('cycleOffWeeks') || '';
  const dates = f.getAll('phaseDate');
  const doses = f.getAll('phaseDoseMg');
  draft.doseRows = dates.map((startDate, i) => ({ startDate, doseMg: doses[i] }));
}

// concentration implied by whatever's currently typed into this form's own vial-size/
// bac-water fields (not the draft — reads live DOM so it reflects the field the user
// just changed before the draft-sync listener runs)
function protocolFormConcentration(form) {
  const vialMg = parseFloat(form.querySelector('[name="vialMgAssumed"]').value);
  const bacMl = parseFloat(form.querySelector('[name="bacWaterMl"]').value);
  return Calc.concentrationMgPerMl(vialMg || 0, bacMl || 0);
}

// redisplays a dose row's units field from its current mg value + concentration;
// never writes to the mg field, since mg is always the source of truth here
function refreshRowUnits(row, concMgPerMl) {
  const mgInput = row.querySelector('[name="phaseDoseMg"]');
  const unitsInput = row.querySelector('[name="phaseDoseUnits"]');
  const mg = parseFloat(mgInput.value);
  unitsInput.disabled = !concMgPerMl;
  unitsInput.value = (!concMgPerMl || isNaN(mg)) ? '' : Calc.round(Calc.syringeUnits(Calc.drawVolumeMl(mg, concMgPerMl), state.settings.syringeUnits), 2);
}

function bindProtocolEvents(el) {
  const subjectFilter = document.getElementById('protocolsSubjectFilter');
  if (subjectFilter) {
    subjectFilter.addEventListener('change', () => {
      protocolsView.subjectId = subjectFilter.value;
      renderProtocols();
    });
  }

  el.querySelectorAll('[data-action="show-add-protocol"]').forEach(btn => {
    btn.addEventListener('click', () => {
      addingProtocol[btn.dataset.subject] = true;
      renderProtocols();
    });
  });

  el.querySelectorAll('select[data-role="frequency"]').forEach(sel => {
    sel.addEventListener('change', () => {
      const form = sel.closest('form');
      form.querySelector('[data-role="daysOfWeekField"]').style.display = sel.value === 'weekly' ? '' : 'none';
      form.querySelector('[data-role="cycleFields"]').style.display = sel.value === 'asNeeded' ? 'none' : '';
    });
  });

  // keep protocolFormDraft continuously up to date with whatever's live in the
  // DOM, so a re-render triggered by something other than this form's own
  // buttons (most importantly switchTab's renderAll()) never rolls the form
  // back to stale/default values
  el.querySelectorAll('form[data-action="save-protocol"]').forEach(form => {
    form.addEventListener('input', () => syncProtocolFormDraft(form, form.dataset.subject));
    form.addEventListener('change', () => syncProtocolFormDraft(form, form.dataset.subject));
  });

  // live mg <-> syringe-units conversion on the dose-schedule rows. mg is always the
  // one persisted field; the units field is a one-way input convenience (typing units
  // computes and overwrites mg) plus a live read-out (typing mg, or changing vial
  // size/bac water, just redisplays the equivalent units — it never overwrites mg).
  el.querySelectorAll('[name="phaseDoseUnits"]').forEach(input => {
    input.addEventListener('input', () => {
      const form = input.closest('form');
      const conc = protocolFormConcentration(form);
      const units = parseFloat(input.value);
      if (!conc || isNaN(units)) return;
      input.closest('.row').querySelector('[name="phaseDoseMg"]').value = Calc.round(Calc.doseMgFromUnits(units, conc, state.settings.syringeUnits), 3);
    });
  });

  el.querySelectorAll('[name="phaseDoseMg"]').forEach(input => {
    input.addEventListener('input', () => {
      const form = input.closest('form');
      refreshRowUnits(input.closest('.row'), protocolFormConcentration(form));
    });
  });

  el.querySelectorAll('[name="vialMgAssumed"], [name="bacWaterMl"]').forEach(input => {
    input.addEventListener('input', () => {
      const form = input.closest('form');
      const conc = protocolFormConcentration(form);
      form.querySelectorAll('[data-role="doseScheduleRows"] .row').forEach(row => refreshRowUnits(row, conc));
    });
  });

  el.querySelectorAll('[data-action="add-phase"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const form = btn.closest('form');
      syncProtocolFormDraft(form, form.dataset.subject);
      protocolFormDraft[form.dataset.subject].doseRows.push({ startDate: '', doseMg: '' });
      renderProtocols();
    });
  });

  el.querySelectorAll('[data-action="remove-phase"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const form = btn.closest('form');
      syncProtocolFormDraft(form, form.dataset.subject);
      const rows = protocolFormDraft[form.dataset.subject].doseRows;
      if (rows.length > 1) rows.splice(Number(btn.dataset.index), 1);
      renderProtocols();
    });
  });

  el.querySelectorAll('form[data-action="save-protocol"]').forEach(form => {
    form.addEventListener('submit', e => {
      e.preventDefault();
      const f = new FormData(form);
      const editId = form.dataset.editId;
      const daysOfWeek = f.getAll('daysOfWeek').map(Number);
      const doseSchedule = f.getAll('phaseDate')
        .map((startDate, i) => ({ id: uid(), startDate, doseMg: parseFloat(f.getAll('phaseDoseMg')[i]) }))
        .filter(ph => ph.startDate && !isNaN(ph.doseMg))
        .sort((a, b) => a.startDate.localeCompare(b.startDate));

      // Cycle length alone is a convenience for endDate (one-time cycle). Add
      // an off-weeks value too and it becomes a repeating on/off pattern
      // instead — see Calc.isDueOn — and the cycle-length field no longer
      // touches endDate, which is then free to act as an optional hard stop
      // on the whole repeating pattern.
      const cycleLengthWeeks = parseInt(f.get('cycleLengthWeeks'), 10);
      const cycleOffWeeksVal = parseInt(f.get('cycleOffWeeks'), 10);
      let endDate = f.get('endDate') || '';
      let cycleOnWeeks = null, cycleOffWeeks = null;
      if (cycleLengthWeeks > 0 && cycleOffWeeksVal > 0) {
        cycleOnWeeks = cycleLengthWeeks;
        cycleOffWeeks = cycleOffWeeksVal;
      } else if (cycleLengthWeeks > 0 && !endDate && doseSchedule.length) {
        const end = new Date(doseSchedule[0].startDate + 'T00:00:00');
        end.setDate(end.getDate() + cycleLengthWeeks * 7 - 1);
        endDate = localDateStr(end);
      }

      const payload = {
        subjectId: form.dataset.subject,
        peptideId: f.get('peptideId'),
        vialMgAssumed: parseFloat(f.get('vialMgAssumed')),
        bacWaterMl: parseFloat(f.get('bacWaterMl')),
        frequency: f.get('frequency'),
        daysOfWeek,
        timeOfDay: f.get('timeOfDay'),
        endDate,
        cycleOnWeeks,
        cycleOffWeeks,
        doseSchedule,
      };
      if (editId) {
        const existing = state.protocols.find(p => p.id === editId);
        Object.assign(existing, payload);
        editingProtocol[form.dataset.subject] = null;
      } else {
        state.protocols.push({ id: uid(), active: true, ...payload });
      }
      delete protocolFormDraft[form.dataset.subject];
      addingProtocol[form.dataset.subject] = false;
      saveState(); renderAll();
    });
  });

  el.querySelectorAll('[data-action="edit-protocol"]').forEach(btn => {
    btn.addEventListener('click', () => {
      editingProtocol[btn.dataset.subject] = btn.dataset.id;
      delete protocolFormDraft[btn.dataset.subject];
      renderProtocols();
    });
  });

  el.querySelectorAll('[data-action="cancel-edit"]').forEach(btn => {
    btn.addEventListener('click', () => {
      editingProtocol[btn.dataset.subject] = null;
      addingProtocol[btn.dataset.subject] = false;
      delete protocolFormDraft[btn.dataset.subject];
      renderProtocols();
    });
  });

  el.querySelectorAll('[data-action="delete-protocol"]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.protocols = state.protocols.filter(p => p.id !== btn.dataset.id);
      saveState(); renderAll();
    });
  });

  el.querySelectorAll('[data-action="toggle-active"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = state.protocols.find(p => p.id === btn.dataset.id);
      p.active = !p.active;
      saveState(); renderAll();
    });
  });

  el.querySelectorAll('[data-action="log-adhoc-dose"]').forEach(btn => {
    btn.addEventListener('click', () => logAdHocDose(btn.dataset.id));
  });
}

// ---------------------------------------------------------------------------
// Print Schedule (calendar)
// ---------------------------------------------------------------------------

let scheduleView = { subjectId: 'all', mode: 'monthly', anchor: todayStr() };

function renderScheduleControls() {
  const el = document.getElementById('scheduleControls');
  el.innerHTML = `<div class="card">
    <div class="row">
      <div class="field"><label>Subject</label>
        <select id="schedSubject">
          <option value="all" ${scheduleView.subjectId === 'all' ? 'selected' : ''}>All subjects</option>
          ${state.subjects.map(s => `<option value="${s.id}" ${scheduleView.subjectId === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>View</label>
        <select id="schedMode">
          <option value="monthly" ${scheduleView.mode === 'monthly' ? 'selected' : ''}>Monthly</option>
          <option value="weekly" ${scheduleView.mode === 'weekly' ? 'selected' : ''}>Weekly</option>
          <option value="daily" ${scheduleView.mode === 'daily' ? 'selected' : ''}>Daily</option>
        </select>
      </div>
      <div class="field"><label>Anchor date</label><input id="schedAnchor" type="date" value="${scheduleView.anchor}"></div>
      <div class="field" style="flex:0 0 auto; align-self:flex-end;"><button class="btn" id="schedPrintBtn">Print</button></div>
    </div>
  </div>`;

  const rerender = () => {
    scheduleView.subjectId = document.getElementById('schedSubject').value;
    scheduleView.mode = document.getElementById('schedMode').value;
    scheduleView.anchor = document.getElementById('schedAnchor').value;
    renderScheduleContent();
  };
  el.querySelector('#schedSubject').addEventListener('change', rerender);
  el.querySelector('#schedMode').addEventListener('change', rerender);
  el.querySelector('#schedAnchor').addEventListener('change', rerender);
  el.querySelector('#schedPrintBtn').addEventListener('click', printSchedule);

  renderScheduleContent();
}

function subjectsForView() {
  return scheduleView.subjectId === 'all' ? state.subjects : state.subjects.filter(s => s.id === scheduleView.subjectId);
}

function dueEntriesFor(date, subjects) {
  const entries = [];
  for (const subject of subjects) {
    for (const p of protocolsForSubject(subject.id)) {
      if (Calc.isDueOn(p, date)) {
        const peptide = getPeptide(p.peptideId);
        entries.push({ subject, peptide, protocol: p });
      }
    }
  }
  return entries;
}

// dates covered by the current view — a single day, a Sun-Sat week, or every day in the month
function datesForView(anchor) {
  if (scheduleView.mode === 'daily') return [anchor];
  if (scheduleView.mode === 'weekly') {
    const start = new Date(anchor);
    start.setDate(start.getDate() - start.getDay());
    return Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d; });
  }
  const year = anchor.getFullYear(), month = anchor.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  return Array.from({ length: daysInMonth }, (_, i) => new Date(year, month, i + 1));
}

// "Today" alone is meaningless the moment a page is printed and stuck on the
// fridge, so the real date is always there and today is just flagged.
function dayLabel(d) {
  const text = d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  return localDateStr(d) === localDateStr(new Date()) ? `Today · ${text}` : text;
}

// Morning first, evening last, unspecified in between — a checklist is worked
// through in clock order, so that's the order the rows are in.
const TIME_ORDER = { morning: 0, evening: 2 };
function sortedDoseEntries(entries) {
  return entries.slice().sort((a, b) =>
    (TIME_ORDER[a.protocol.timeOfDay] ?? 1) - (TIME_ORDER[b.protocol.timeOfDay] ?? 1) ||
    (a.peptide ? a.peptide.name : '').localeCompare(b.peptide ? b.peptide.name : ''));
}

function doseRowHTML(entry, date, interactive, showDraw) {
  const dateKey = localDateStr(date);
  const doseMg = Calc.doseMgOnDate(entry.protocol, date);
  const m = showDraw ? doseMathFor(entry.protocol, doseMg) : null;
  const timeLabel = timeOfDayLabel(entry.protocol.timeOfDay);
  const blend = entry.peptide && entry.peptide.isBlend ? blendBreakdownText(entry.peptide, doseMg) : '';
  return `<div class="sched-day-row">
    ${doseCheckboxHTML(entry.protocol, dateKey, interactive)}
    <span class="sched-time">${escapeHtml(timeLabel)}</span>
    <span class="sched-name">${escapeHtml(entry.peptide ? entry.peptide.name : '(deleted)')}${blend ? `<span class="sched-blend-inline">${blend}</span>` : ''}</span>
    <span class="sched-dose">${doseMg} mg${m ? `<span class="sched-draw">${Calc.round(m.vol, 3)}mL · ${Calc.round(m.units, 1)}u</span>` : ''}</span>
  </div>`;
}

// Shared by Dashboard ("what's ahead") and the printable Schedule — list
// format (not a grid) so a day with 5-6+ peptides never gets cramped, each
// dose is its own full-width row. interactive=true renders real checkbox
// inputs wired to the dose log; false renders static squares for
// hand-tracking on the printed page. showDraw adds the mL/units column,
// useful on the Dashboard for prepping a syringe but noise on a printout.
//
// Rows are fixed columns (check | time | peptide | dose) rather than one run-on
// sentence, so doses line up in a scannable column instead of being buried
// mid-line. Whose dose it is comes from grouping rather than from repeating
// "Amanda —" on all five of her rows, which was eating most of the line width:
// a day involving one person names them once in the day heading, and only a day
// that actually mixes both splits into subject sub-headings.
// asTableRows wraps each day in its own <tr>/<td> instead of a <div>, for the
// Schedule's table layout (see buildScheduleHTML) — a page break then falls
// between days rather than through one, and the browser repeats the table's
// <thead>. The Dashboard has no such need and takes the plain divs.
function doseListBlocksHTML(dates, subjects, { interactive, showDraw, asTableRows } = {}) {
  return dates.map(d => {
    const entries = dueEntriesFor(d, subjects);
    if (entries.length === 0) return '';
    const present = subjects
      .map(s => ({ subject: s, rows: sortedDoseEntries(entries.filter(e => e.subject.id === s.id)) }))
      .filter(g => g.rows.length);
    const soleSubject = present.length === 1 && subjects.length > 1 ? present[0].subject : null;
    const groups = present.length > 1 ? present : [{ subject: null, rows: present[0].rows }];
    const inner = `<div class="sched-day-header">${escapeHtml(dayLabel(d))}${soleSubject ? ` <span class="sched-day-subject">${escapeHtml(soleSubject.name)}</span>` : ''}</div>
      ${groups.map(g => `${g.subject ? `<div class="sched-subject-header">${escapeHtml(g.subject.name)}</div>` : ''}${g.rows.map(e => doseRowHTML(e, d, interactive, showDraw)).join('')}`).join('')}`;
    return asTableRows
      ? `<tr class="sched-day-block"><td>${inner}</td></tr>`
      : `<div class="sched-day-block">${inner}</div>`;
  }).filter(Boolean).join('');
}

// Every day in the calendar months spanned by a trailing `months`-long window
// ending with `anchor`'s month.
function monthWindowDates(anchor, months) {
  const start = new Date(anchor.getFullYear(), anchor.getMonth() - (months - 1), 1);
  const end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const dates = [];
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) dates.push(new Date(d));
  return dates;
}

// What the *protocols* say will be drawn over a set of days, bucketed by
// substance name exactly the way consumptionReport() buckets logged doses —
// blends split into components, so "GHK-Cu via KLOW" lands in the GHK-Cu
// bucket. Deliberately schedule-derived rather than log-derived: this hangs off
// a forward-looking printed schedule, where the useful number is what you're
// about to need, not what's already been ticked off.
function scheduledSubstanceTotals(dates, subjects) {
  const bySubstance = new Map();
  for (const d of dates) {
    for (const entry of dueEntriesFor(d, subjects)) {
      const doseMg = Calc.doseMgOnDate(entry.protocol, d);
      if (!doseMg) continue;
      const parts = (entry.peptide && entry.peptide.isBlend)
        ? Calc.blendComponentDoses(entry.peptide, doseMg)
        : [{ name: entry.peptide ? entry.peptide.name : '(deleted peptide)', mg: doseMg }];
      for (const part of parts) {
        const displayName = part.name.trim();
        const key = displayName.toLowerCase();
        if (!bySubstance.has(key)) bySubstance.set(key, { displayName, mg: 0, doses: 0 });
        const bucket = bySubstance.get(key);
        bucket.mg += part.mg;
        bucket.doses += 1;
      }
    }
  }
  return bySubstance;
}

// Appendix printed under a month's schedule: what that month needs per
// substance, next to the trailing 3-month figure (this month plus the two
// before it) for spotting a reorder before it's urgent.
function scheduleTotalsHTML(anchor, subjects) {
  const monthTotals = scheduledSubstanceTotals(datesForView(anchor), subjects);
  const windowMonths = 3;
  const windowDates = monthWindowDates(anchor, windowMonths);
  const windowTotals = scheduledSubstanceTotals(windowDates, subjects);
  if (windowTotals.size === 0) return '';

  const rows = Array.from(windowTotals.entries())
    .map(([key, w]) => ({ key, displayName: w.displayName, window: w, month: monthTotals.get(key) }))
    .sort((a, b) => (b.month ? b.month.mg : 0) - (a.month ? a.month.mg : 0) || b.window.mg - a.window.mg);

  const windowLabel = `${windowDates[0].toLocaleDateString(undefined, { month: 'short', year: 'numeric' })} – ${anchor.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`;
  const cell = t => (t ? `${Calc.round(t.mg, 2)} <span class="sched-total-doses">(${t.doses})</span>` : '<span class="sched-total-none">—</span>');

  return `<section class="sched-totals">
    <h3 class="sched-totals-title">Scheduled totals</h3>
    <div class="sched-totals-note">Planned from active protocols — not logged doses. Blends are split into their components, so a substance taken both on its own and in a blend adds up here. Bracketed figure is the number of doses.</div>
    <table class="sched-totals-table"><thead><tr>
      <th>Substance</th>
      <th class="num">${escapeHtml(anchor.toLocaleDateString(undefined, { month: 'long' }))} (mg)</th>
      <th class="num">${escapeHtml(windowLabel)} (mg)</th>
    </tr></thead><tbody>
      ${rows.map(r => `<tr>
        <td>${escapeHtml(r.displayName)}</td>
        <td class="num">${cell(r.month)}</td>
        <td class="num">${cell(r.window)}</td>
      </tr>`).join('')}
    </tbody></table>
  </section>`;
}

function buildScheduleHTML(interactive) {
  const subjects = subjectsForView();
  const anchor = new Date(scheduleView.anchor + 'T00:00:00');
  const subjectLabel = scheduleView.subjectId === 'all' ? 'All subjects' : getSubject(scheduleView.subjectId)?.name || '';
  const dates = datesForView(anchor);

  let title;
  if (scheduleView.mode === 'daily') title = Calc.formatDate(anchor);
  else if (scheduleView.mode === 'weekly') title = `Week of ${Calc.formatDate(dates[0])}`;
  else title = anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const blocks = doseListBlocksHTML(dates, subjects, { interactive, showDraw: false, asTableRows: true });
  // A printout is read away from the app, so it has to say what it covers and
  // how current it is; the on-screen preview needs neither.
  const doseCount = dates.reduce((n, d) => n + dueEntriesFor(d, subjects).length, 0);
  const sub = interactive
    ? subjectLabel
    : `${subjectLabel} · ${doseCount} dose${doseCount === 1 ? '' : 's'} · printed ${Calc.formatDate(new Date())}`;

  // The title/subtitle live in a <thead>, which browsers repeat at the top of
  // every printed page — a month spans several sheets, and page 3 landing on
  // the floor with no idea which month or whose it is was the failure mode.
  const head = `<thead><tr><th>
      <div class="sched-print-title">${escapeHtml(title)}</div>
      <div class="sched-print-sub">${escapeHtml(sub)}</div>
    </th></tr></thead>`;
  const body = blocks
    ? `<tbody>${blocks}</tbody>`
    : `<tbody><tr><td><div class="empty-state">No doses scheduled.</div></td></tr></tbody>`;
  const totals = scheduleView.mode === 'monthly' ? scheduleTotalsHTML(anchor, subjects) : '';
  return `<table class="sched-table">${head}${body}</table>${totals}`;
}

function renderScheduleContent() {
  const el = document.getElementById('scheduleContent');
  el.innerHTML = `<div class="card">${buildScheduleHTML(true)}</div>`;
  bindDoseCheckboxes(el);
}

function printSchedule() {
  document.getElementById('printScheduleArea').innerHTML = buildScheduleHTML(false);
  document.getElementById('labelPageStyle').textContent = '';
  document.body.dataset.printMode = 'schedule';
  window.print();
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

function labelCandidates() {
  // one candidate per (peptide, subject) pair that has a protocol, plus one
  // generic peptide-only candidate for peptides with no protocol yet.
  const candidates = [];
  for (const peptide of state.peptides) {
    const protocols = protocolsForPeptide(peptide.id);
    if (protocols.length === 0) {
      candidates.push({ key: `${peptide.id}|generic`, peptide, subject: null, protocol: null });
    } else {
      const seenSubjects = new Set();
      for (const p of protocols) {
        if (seenSubjects.has(p.subjectId)) continue;
        seenSubjects.add(p.subjectId);
        candidates.push({ key: `${peptide.id}|${p.subjectId}`, peptide, subject: getSubject(p.subjectId), protocol: p });
      }
    }
  }
  return candidates;
}

function renderLabelsControls() {
  const el = document.getElementById('labelsControls');
  const candidates = labelCandidates();

  if (candidates.length === 0) {
    el.innerHTML = `<div class="empty-state">Add a peptide (Inventory) to generate vial labels.</div>`;
    document.getElementById('labelsContent').innerHTML = '';
    return;
  }

  el.innerHTML = `<div class="card">
    <h3>Select labels to print</h3>
    <div class="item-list">
      ${candidates.map(c => {
        const sel = labelSelections[c.key] || { include: false, qty: 1 };
        labelSelections[c.key] = sel;
        return `<div class="item-row">
          <label style="display:flex; align-items:center; gap:.5rem; flex:1;">
            <input type="checkbox" data-action="label-include" data-key="${c.key}" ${sel.include ? 'checked' : ''} style="width:auto;">
            <span>${escapeHtml(c.peptide.name)}${c.subject ? ' — ' + escapeHtml(c.subject.name) : ' (general stock)'}</span>
          </label>
          <div style="display:flex; align-items:center; gap:.4rem;">
            <label class="muted" style="margin:0;">Qty</label>
            <input type="number" min="1" value="${sel.qty}" data-action="label-qty" data-key="${c.key}" style="width:4rem;">
          </div>
        </div>`;
      }).join('')}
    </div>
    <div class="row" style="margin-top:.7rem; align-items:center;">
      <button class="btn" id="labelPrintBtn">Print selected labels</button>
      <button class="btn secondary" id="labelDownloadAllBtn" style="flex:0 0 auto;">${labelSaveMode() === 'download' ? 'Download PNGs (for NIIMBOT app)' : 'Save PNGs to folder…'}</button>
      ${labelSaveMode() === 'server' ? `<span class="muted small" style="flex:0 0 auto;">→ ${escapeHtml(state.settings.labelSaveDir)}</span>` : ''}
      ${labelSaveMode() === 'picker' && labelSaveDir ? `<div style="flex:0 0 auto; display:flex; align-items:center; gap:.4rem;">
          <span class="muted small">→ ${escapeHtml(labelSaveDir.name)}</span>
          <button class="btn secondary" id="labelChangeDirBtn" style="flex:0 0 auto; font-size:.75rem; padding:.25rem .5rem;">Change folder…</button>
        </div>` : ''}
    </div>
    <div class="muted small" id="labelSaveStatus" style="margin-top:.4rem; min-height:1em;">${escapeHtml(labelSaveMessage)}</div>
    <div class="muted small" style="margin-top:.3rem;">PNGs export at ${labelExportPxSize().width}×${labelExportPxSize().height}px for your ${state.settings.labelWidthMm}×${state.settings.labelHeightMm}mm stock — import them into the NIIMBOT app at 100% and don't resize by hand (Settings → Label design if they land at the wrong size).${{
      server: ' server.py writes them straight into that folder, overwriting any earlier copy of the same label — change the path in Settings → Label design.',
      picker: " You pick the destination folder once per session; re-exporting overwrites the files already in it.",
      download: " This browser has no folder picker and server.py isn't running, so PNGs go to your normal downloads folder.",
    }[labelSaveMode()]}</div>
  </div>`;

  el.querySelectorAll('[data-action="label-include"]').forEach(cb => {
    cb.addEventListener('change', () => { labelSelections[cb.dataset.key].include = cb.checked; renderLabelsContent(); });
  });
  el.querySelectorAll('[data-action="label-qty"]').forEach(input => {
    input.addEventListener('change', () => { labelSelections[input.dataset.key].qty = Math.max(1, parseInt(input.value, 10) || 1); renderLabelsContent(); });
  });
  el.querySelector('#labelPrintBtn').addEventListener('click', printLabels);
  el.querySelector('#labelDownloadAllBtn').addEventListener('click', downloadAllLabelPNGs);
  el.querySelector('#labelChangeDirBtn')?.addEventListener('click', async () => {
    try {
      const dir = await labelSaveDirHandle(true);
      setLabelSaveMessage(`Exports will go to ${dir.name}.`);
      renderLabelsControls();
    } catch (e) {
      if (e.name !== 'AbortError') setLabelSaveMessage(`Couldn't switch folder: ${e.message}`);
    }
  });

  renderLabelsContent();
}

function selectedLabelInstances() {
  const candidates = labelCandidates();
  const instances = [];
  for (const c of candidates) {
    const sel = labelSelections[c.key];
    if (sel && sel.include) {
      for (let i = 0; i < sel.qty; i++) instances.push(c);
    }
  }
  return instances;
}

function labelBoxHTML(c) {
  const w = state.settings.labelWidthMm, h = state.settings.labelHeightMm;
  const logo = state.settings.logoDataUrl;
  const accentColor = c.subject ? c.subject.color : 'var(--muted)';
  let conc = '', dose = '', vialBadge = '';
  if (c.protocol) {
    const doseMg = Calc.doseMgOnDate(c.protocol, new Date());
    const m = doseMathFor(c.protocol, doseMg);
    conc = `${Calc.round(m.conc, 2)} mg/mL`;
    dose = `${doseMg}mg = ${Calc.round(m.vol, 3)}mL / ${Calc.round(m.units, 1)}u`;
    vialBadge = `${Calc.round(c.protocol.vialMgAssumed, 2)}MG`;
  }
  return `<div class="label-box" style="width:${w}mm; height:${h}mm;">
    <div class="label-accent" style="background:${accentColor};">
      ${c.subject ? `<span class="label-accent-text">${escapeHtml(c.subject.name)}</span>` : ''}
    </div>
    <div class="label-body">
      ${vialBadge ? `<div class="label-badge">${vialBadge}</div>` : ''}
      <div class="label-head">
        ${logo ? `<img class="label-logo" src="${logo}" alt="">` : ''}
        <div class="label-peptide">${escapeHtml(c.peptide.name)}</div>
      </div>
      ${(conc || dose) ? `<div class="label-details">
        ${conc ? `<span class="label-conc">${conc}</span>` : ''}
        ${dose ? `<span class="label-dose">${dose}</span>` : ''}
      </div>` : ''}
    </div>
  </div>`;
}

function renderLabelsContent() {
  const instances = selectedLabelInstances();
  const el = document.getElementById('labelsContent');
  if (instances.length === 0) {
    el.innerHTML = `<div class="empty-state">Check items above to preview labels.</div>`;
    return;
  }
  const seen = new Set();
  const unique = instances.filter(c => {
    if (seen.has(c.key)) return false;
    seen.add(c.key);
    return true;
  });
  el.innerHTML = `<div class="card"><h3>Preview (${instances.length} label${instances.length === 1 ? '' : 's'})</h3>
    <div class="label-sheet" style="gap:1.2rem;">${unique.map(c => {
      const qty = labelSelections[c.key]?.qty || 1;
      return `<div style="display:flex; flex-direction:column; gap:.3rem; align-items:flex-start;">
        <img class="label-png-preview" data-key="${c.key}" style="width:280px; max-width:100%; border:1px solid var(--border, #444); border-radius:4px; background:#fff;">
        <div style="display:flex; align-items:center; gap:.5rem;">
          <button class="btn secondary" data-action="label-download-one" data-key="${c.key}" style="font-size:.75rem; padding:.25rem .5rem;">Download PNG</button>
          ${qty > 1 ? `<span class="muted small">×${qty}</span>` : ''}
        </div>
      </div>`;
    }).join('')}</div></div>`;

  el.querySelectorAll('[data-action="label-download-one"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const c = instances.find(i => i.key === btn.dataset.key);
      if (c) downloadLabelPNG(c);
    });
  });

  el.querySelectorAll('img.label-png-preview').forEach(async imgEl => {
    const c = instances.find(i => i.key === imgEl.dataset.key);
    if (!c) return;
    const canvas = await renderLabelCanvas(c);
    imgEl.src = canvas.toDataURL('image/png');
  });
}

function printLabels() {
  const instances = selectedLabelInstances();
  if (instances.length === 0) return;
  document.getElementById('printLabelsArea').innerHTML = `<div class="label-sheet">${instances.map(labelBoxHTML).join('')}</div>`;
  document.getElementById('labelPageStyle').textContent =
    `@page { size: ${state.settings.labelWidthMm}mm ${state.settings.labelHeightMm}mm; margin: 0; }`;
  document.body.dataset.printMode = 'labels';
  window.print();
}

window.addEventListener('afterprint', () => {
  delete document.body.dataset.printMode;
});

// ---------------------------------------------------------------------------
// Label PNG export — the NIIMBOT M2 has no macOS print driver, so labels are
// rasterized to an image here and imported into the NIIMBOT app instead of
// going through window.print(). Rendered on canvas (not DOM-to-image) so
// resolution is independent of screen zoom/DPI.
//
// Three things have to be right for an exported PNG to land at true size, and
// stay crisp, in the NIIMBOT app:
//   1. the pixel dimensions must match the label's real mm at the dpi the app
//      lays imports out at (settings.labelExportDpi, default 406 — see
//      LABEL_EXPORT_DPI_DEFAULT), otherwise it lands undersized and stretching
//      it back up past the 300dpi head is what costs the resolution;
//   2. the file must *say* what size it is — a bare canvas.toBlob() PNG carries
//      no physical size at all, so any importer has to fall back to an assumed
//      dpi. pngWithDensity() below adds the pHYs chunk that states it, so a
//      dpi-aware importer sizes it correctly regardless of (1); and
//   3. nothing may be drawn in a mid-tone. The M2 is a 1-bit thermal printer,
//      so every grey — muted text, a coloured subject bar — gets dithered into
//      speckle. The export is therefore drawn pure black on white (LABEL_INK),
//      even though the on-screen/browser-print label keeps its subject colour.
// ---------------------------------------------------------------------------

const LABEL_INK = '#000000';

function labelExportDpi() {
  const dpi = parseFloat(state.settings.labelExportDpi);
  return Number.isFinite(dpi) && dpi > 0 ? dpi : LABEL_EXPORT_DPI_DEFAULT;
}

function labelExportPxSize() {
  const pxPerMm = labelExportDpi() / 25.4;
  return {
    pxPerMm,
    width: Math.round(state.settings.labelWidthMm * pxPerMm),
    height: Math.round(state.settings.labelHeightMm * pxPerMm),
  };
}

function loadImageAsync(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

async function renderLabelCanvas(c) {
  const size = labelExportPxSize();
  const pxPerMm = size.pxPerMm;
  const mm = v => v * pxPerMm;
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  const font = (weight, sizeMm) => `${weight} ${mm(sizeMm)}px -apple-system, Helvetica, Arial, sans-serif`;

  // Everything is pure black: mid-tones (the old #6b6f76 muted grey, the
  // subject's accent colour, the pale border) survive on screen but get
  // error-diffusion dithered into speckle by the M2's 1-bit thermal head.
  // Size and weight still carry the hierarchy on a 40mm label.
  const ink = LABEL_INK, muted = LABEL_INK, line = LABEL_INK;
  const accentColor = LABEL_INK;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.lineWidth = Math.max(1, mm(0.3));
  ctx.strokeStyle = line;
  ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, canvas.width - ctx.lineWidth, canvas.height - ctx.lineWidth);

  const barW = mm(5);
  ctx.fillStyle = accentColor;
  ctx.fillRect(0, 0, barW, canvas.height);

  // Subject name lives rotated inside the accent bar (mirrors the
  // "50mg"-in-a-black-bar look of the vendor labels this was patterned
  // after), freeing the header row for a larger peptide name.
  if (c.subject) {
    ctx.save();
    ctx.font = font(700, 2.2);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.translate(barW / 2, canvas.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(c.subject.name.toUpperCase(), 0, 0, canvas.height - mm(2));
    ctx.restore();
  }

  const bodyX = barW + mm(2);
  const topPad = mm(1.3);
  const headH = mm(4.2);
  let headX = bodyX;

  // Logo lives bottom-left (with the vendor wordmark baked into the
  // uploaded image itself), drawn as its own row below the dose line.
  const logo = state.settings.logoDataUrl;
  const footerRowH = mm(10);
  const logoGap = mm(0.6);
  const doseGap = mm(0.8);
  const doseLineH = mm(2.6) * 1.2;
  const footerReserve = doseGap + doseLineH + (logo ? (logoGap + footerRowH) : mm(0.5));
  let doseText = '';

  // Frequency summary ("Daily", "Every other day", "M-F", "M/W/F", ...) goes
  // in the top-right corner. Reuses frequencyLabel() — the same function
  // the Protocols tab uses — so the label never drifts out of sync with
  // how the protocol's schedule is described elsewhere in the app.
  const freqText = c.protocol ? frequencyLabel(c.protocol) : '';
  let freqW = 0;
  if (freqText) {
    ctx.font = font(600, 2);
    freqW = ctx.measureText(freqText).width;
  }

  ctx.fillStyle = ink;
  ctx.font = font(700, 3.6);
  ctx.textBaseline = 'middle';
  const nameMaxW = canvas.width - mm(1) - headX - (freqText ? freqW + mm(1.5) : 0);
  ctx.fillText(c.peptide.name, headX, topPad + headH / 2, Math.max(mm(4), nameMaxW));

  if (freqText) {
    ctx.font = font(600, 2);
    ctx.fillStyle = muted;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(freqText, canvas.width - mm(1), topPad + mm(0.3));
    ctx.textAlign = 'left';
  }

  if (c.protocol) {
    const doseMg = Calc.doseMgOnDate(c.protocol, new Date());
    const m = doseMathFor(c.protocol, doseMg);
    const leftText = `${Calc.round(c.protocol.vialMgAssumed, 2)}mg`;
    const rightText = `${Calc.round(c.protocol.bacWaterMl, 2)}mL`;
    doseText = `${Calc.round(m.units, 1)}u = ${doseMg}mg`;

    // Box spans the label width with a fixed 3mm margin each side, and is
    // vertically boxed in between the header text above and the footer
    // (dose line, and logo if present) so it can never run into either.
    // The separator is a drawn rule (not a "|" glyph) so it can't be
    // misread as a digit at large font sizes.
    const headerBottom = topPad + headH;
    const availTop = headerBottom + mm(0.8);
    const availBottom = canvas.height - topPad - footerReserve;
    const availH = Math.max(mm(4), availBottom - availTop);

    const padX = mm(2.4), padY = mm(1.1);
    const dividerGap = mm(1.8);
    const safeLeft = bodyX;
    const maxBoxW = canvas.width - bodyX - mm(3);
    const maxTextW = maxBoxW - padX * 2 - dividerGap * 2;

    let strengthSizeMm = 5.6;
    ctx.font = font(700, strengthSizeMm);
    const combinedTextW = () => ctx.measureText(leftText).width + ctx.measureText(rightText).width;
    const fitsBox = () => combinedTextW() <= maxTextW && (mm(strengthSizeMm) * 1.2 + padY * 2) <= availH;
    while (strengthSizeMm > 2.4 && !fitsBox()) {
      strengthSizeMm -= 0.1;
      ctx.font = font(700, strengthSizeMm);
    }
    const leftW = ctx.measureText(leftText).width;
    const rightW = ctx.measureText(rightText).width;
    const contentW = leftW + dividerGap * 2 + rightW;
    const boxH = Math.min(mm(strengthSizeMm) * 1.2 + padY * 2, availH);
    const boxW = maxBoxW;
    const boxX = safeLeft;
    const boxY = availTop + (availH - boxH) / 2;
    ctx.lineWidth = Math.max(1, mm(0.3));
    ctx.strokeStyle = ink;
    roundRectPath(ctx, boxX, boxY, boxW, boxH, mm(1.2));
    ctx.stroke();

    const contentStartX = boxX + (boxW - contentW) / 2;
    const midY = boxY + boxH / 2;
    ctx.fillStyle = ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(leftText, contentStartX, midY);

    const dividerX = contentStartX + leftW + dividerGap;
    const dividerH = mm(strengthSizeMm) * 0.85;
    ctx.strokeStyle = ink;
    ctx.lineWidth = Math.max(1, mm(0.4));
    ctx.beginPath();
    ctx.moveTo(dividerX, midY - dividerH / 2);
    ctx.lineTo(dividerX, midY + dividerH / 2);
    ctx.stroke();

    ctx.fillText(rightText, dividerX + dividerGap, midY);
    ctx.textAlign = 'left';

    // Dose line stays centered under the box, close beneath it.
    ctx.font = font(500, 2.6);
    ctx.fillStyle = muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(doseText, canvas.width / 2, boxY + boxH + doseGap);
    ctx.textAlign = 'left';

    // Time of day, if the protocol has one, sits in the bottom-right
    // corner — free space regardless of whether a logo is present, since
    // the logo only ever occupies the bottom-left.
    const timeText = timeOfDayLabel(c.protocol.timeOfDay);
    if (timeText) {
      ctx.font = font(600, 2.4);
      ctx.fillStyle = muted;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(timeText, canvas.width - mm(1.5), canvas.height - topPad);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }
  }

  if (logo) {
    try {
      const img = await loadImageAsync(logo);
      const maxW = canvas.width - bodyX - mm(1.5), maxH = footerRowH;
      const scale = Math.min(maxW / img.width, maxH / img.height);
      const dw = img.width * scale, dh = img.height * scale;
      const rowTop = canvas.height - topPad - footerRowH;
      ctx.drawImage(img, bodyX, rowTop + (footerRowH - dh) / 2, dw, dh);
    } catch (e) {
      // logo failed to load (e.g. corrupt stored data URL) — skip it, rest of label still renders
    }
  }

  return canvas;
}

function sanitizeFilenamePart(s) {
  return s.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// canvas.toBlob() writes a PNG with no pHYs chunk, i.e. the file declares no
// physical size — so an importer like the NIIMBOT app has to guess a dpi, and
// whatever it guesses is what makes the image land at the wrong size on the
// label canvas. This rewrites the blob with a pHYs chunk stating the real
// density (320x160px at 203dpi == exactly 40x20mm), so a dpi-aware importer
// places it 1:1 with no manual stretching.
async function pngWithDensity(blob, dpi) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const ppm = Math.round(dpi / 0.0254); // pHYs is specified in pixels per metre
  const phys = new Uint8Array(21);      // 4 length + 4 type + 9 data + 4 crc
  const dv = new DataView(phys.buffer);
  dv.setUint32(0, 9);
  phys.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  dv.setUint32(8, ppm);
  dv.setUint32(12, ppm);
  phys[16] = 1;                          // unit specifier: 1 = metre
  dv.setUint32(17, crc32(phys.subarray(4, 17)));

  // Walk the chunk list so an existing pHYs (from some other encoder) is
  // replaced rather than duplicated; ours has to sit before the image data,
  // so it goes immediately after IHDR.
  const parts = [buf.subarray(0, 8)];
  let pos = 8, inserted = false;
  while (pos + 8 <= buf.length) {
    const len = new DataView(buf.buffer, buf.byteOffset + pos, 4).getUint32(0);
    const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
    const end = pos + 12 + len;
    if (type !== 'pHYs') parts.push(buf.subarray(pos, end));
    if (type === 'IHDR' && !inserted) { parts.push(phys); inserted = true; }
    pos = end;
  }
  if (!inserted) return blob; // not a PNG we recognise — ship it unmodified
  return new Blob(parts, { type: 'image/png' });
}

// Where exported PNGs go. Chromium/Safari expose the File System Access API on
// a secure context (localhost counts, so start.command is fine; a file:// double
// -click is not), which is what lets the app ask for a real folder — e.g. a
// "Label Files" folder — instead of dropping everything in ~/Downloads. Firefox
// and file:// fall back to the plain <a download> path below.
//
// The chosen directory handle can't live in `state`: it isn't JSON-serialisable,
// so it's session-scoped only, and picking a folder once covers every export
// until the page is reloaded. Chromium separately remembers the last folder used
// under the picker's `id`, so even after a reload the dialog opens there.
let labelSaveDir = null;
let labelSaveMessage = '';

function supportsSavePicker() {
  return typeof window.showDirectoryPicker === 'function' && typeof window.showSaveFilePicker === 'function';
}

// Three ways an export can reach disk, in preference order. The server route
// wins when it's available because it's the only one that works in every
// browser (Safari and Firefox have no directory picker at all) and the only one
// that needs no dialog — the folder is a path in Settings, so repeat exports are
// a single click. The picker is for running without server.py, and the plain
// download is the last resort.
function labelSaveMode() {
  if (serverAvailable && (state.settings.labelSaveDir || '').trim()) return 'server';
  if (supportsSavePicker()) return 'picker';
  return 'download';
}

// "retatrutide-3mg.png" — peptide plus the dose actually on the label, which is
// what you're matching against when picking a file out of the folder in the
// NIIMBOT app. Candidates with no protocol (bulk/shared stock) have no dose, so
// they're just "<peptide>.png". The subject is only appended to break a tie; see
// resolveLabelFileNames().
function labelFileName(c, withSubject) {
  const parts = [sanitizeFilenamePart(c.peptide.name)];
  if (c.protocol) parts.push(`${Calc.round(Calc.doseMgOnDate(c.protocol, new Date()), 3)}mg`);
  if (withSubject && c.subject) parts.push(sanitizeFilenamePart(c.subject.name));
  return parts.join('-') + '.png';
}

// Two selected labels can legitimately reduce to the same peptide+dose (both
// subjects on the same protocol dose). Since a same-named export overwrites in
// place, that would silently save one label instead of two — so qualify only the
// colliding names, leaving every unique one clean.
function resolveLabelFileNames(list) {
  const counts = new Map();
  for (const c of list) {
    const n = labelFileName(c);
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  const seen = new Map();
  return list.map(c => {
    const base = labelFileName(c);
    if (counts.get(base) === 1) return base;
    const nth = (seen.get(base) || 0) + 1;
    seen.set(base, nth);
    const qualified = labelFileName(c, true);
    return qualified === base ? base.replace(/\.png$/, `-${nth}.png`) : qualified;
  });
}

function setLabelSaveMessage(msg) {
  labelSaveMessage = msg;
  const el = document.getElementById('labelSaveStatus');
  if (el) el.textContent = msg;
}

async function labelPNGBlob(c) {
  const canvas = await renderLabelCanvas(c);
  const raw = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  return pngWithDensity(raw, labelExportDpi());
}

function saveBlobViaDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function writeBlobToHandle(handle, blob) {
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Hands the PNGs to server.py, which writes them into settings.labelSaveDir.
// Throws with the server's own message so callers can report it and fall back.
async function saveLabelsToServer(files) {
  const res = await fetch('/api/labels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir: state.settings.labelSaveDir, files }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `server returned ${res.status}`);
  return body;
}

// Re-uses this session's folder if it's still writable, otherwise opens the
// picker. Must be called before any `await` in the click handler — the picker
// needs the click's transient activation, which an earlier await would spend.
async function labelSaveDirHandle(forcePick) {
  if (!forcePick && labelSaveDir) {
    const perm = await labelSaveDir.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') return labelSaveDir;
    if (await labelSaveDir.requestPermission({ mode: 'readwrite' }) === 'granted') return labelSaveDir;
  }
  labelSaveDir = await window.showDirectoryPicker({
    id: 'peptide-labels',   // Chromium reopens the picker here next time
    mode: 'readwrite',
    startIn: 'desktop',
  });
  return labelSaveDir;
}

async function downloadLabelPNG(c) {
  const name = labelFileName(c);
  const mode = labelSaveMode();

  if (mode === 'server') {
    try {
      const out = await saveLabelsToServer([{ name, data: await blobToBase64(await labelPNGBlob(c)) }]);
      setLabelSaveMessage(`Saved ${name} to ${out.dir}.`);
    } catch (e) {
      setLabelSaveMessage(`Couldn't save to ${state.settings.labelSaveDir} (${e.message}) — downloaded instead.`);
      saveBlobViaDownload(await labelPNGBlob(c), name);
    }
    return;
  }

  if (mode === 'download') {
    saveBlobViaDownload(await labelPNGBlob(c), name);
    return;
  }

  let handle;
  try {
    handle = await window.showSaveFilePicker({
      id: 'peptide-labels',
      suggestedName: name,
      startIn: labelSaveDir || 'desktop',
      types: [{ description: 'PNG image', accept: { 'image/png': ['.png'] } }],
    });
  } catch (e) {
    if (e.name === 'AbortError') return;  // user cancelled — not an error
    saveBlobViaDownload(await labelPNGBlob(c), name);
    return;
  }
  await writeBlobToHandle(handle, await labelPNGBlob(c));
  setLabelSaveMessage(`Saved ${handle.name}.`);
}

async function downloadAllLabelPNGs() {
  const seen = new Set();
  const unique = selectedLabelInstances().filter(c => (seen.has(c.key) ? false : seen.add(c.key)));
  if (unique.length === 0) {
    setLabelSaveMessage('Nothing selected to export.');
    return;
  }

  const names = resolveLabelFileNames(unique);
  const mode = labelSaveMode();

  const downloadAll = async () => {
    for (const [i, c] of unique.entries()) {
      saveBlobViaDownload(await labelPNGBlob(c), names[i]);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  };

  if (mode === 'server') {
    setLabelSaveMessage(`Saving ${unique.length} PNG${unique.length === 1 ? '' : 's'}…`);
    const files = [];
    for (const [i, c] of unique.entries()) {
      files.push({ name: names[i], data: await blobToBase64(await labelPNGBlob(c)) });
    }
    try {
      const out = await saveLabelsToServer(files);
      setLabelSaveMessage(`Saved ${out.saved} PNG${out.saved === 1 ? '' : 's'} to ${out.dir}.`);
    } catch (e) {
      setLabelSaveMessage(`Couldn't save to ${state.settings.labelSaveDir} (${e.message}) — downloaded instead.`);
      await downloadAll();
    }
    return;
  }

  if (mode === 'download') {
    await downloadAll();
    setLabelSaveMessage(`Downloaded ${unique.length} PNG${unique.length === 1 ? '' : 's'}.`);
    return;
  }

  let dir;
  try {
    dir = await labelSaveDirHandle(false);
  } catch (e) {
    if (e.name === 'AbortError') return;
    setLabelSaveMessage(`Couldn't open that folder (${e.message}) — falling back to your Downloads folder.`);
    for (const [i, c] of unique.entries()) {
      saveBlobViaDownload(await labelPNGBlob(c), names[i]);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return;
  }

  setLabelSaveMessage(`Saving ${unique.length} PNG${unique.length === 1 ? '' : 's'} to ${dir.name}…`);
  let written = 0;
  for (const [i, c] of unique.entries()) {
    const name = names[i];
    try {
      const fileHandle = await dir.getFileHandle(name, { create: true });
      await writeBlobToHandle(fileHandle, await labelPNGBlob(c));
      written++;
    } catch (e) {
      setLabelSaveMessage(`Saved ${written} of ${unique.length} — ${name} failed (${e.message}).`);
      return;
    }
  }
  // Same filename is overwritten in place, deliberately: re-exporting after a
  // dose change should replace that label, not leave a "label-x (1).png" beside it.
  setLabelSaveMessage(`Saved ${written} PNG${written === 1 ? '' : 's'} to ${dir.name}.`);
  renderLabelsControls();
}

// downscales the uploaded image (max 300px on the long edge) before storing
// as a data URL, so a phone photo doesn't bloat localStorage/data.json
function handleLogoUpload(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const maxDim = 300;
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      state.settings.logoDataUrl = canvas.toDataURL('image/png');
      saveState(); renderAll();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

// ---------------------------------------------------------------------------
// Reports (consumption over a date range)
// ---------------------------------------------------------------------------

let reportView = { subjectId: 'all', from: daysAgoStr(30), to: todayStr() };

function daysAgoStr(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDateStr(d);
}

// Groups doseLogs in [fromDateStr, toDateStr] by substance name, splitting any
// blend's logged dose into its components (via Calc.blendComponentDoses) so a
// blend's ingredients land in the same bucket as a standalone peptide of the
// same name — grouping is by name, not peptideId, precisely so "GHK-Cu taken
// via KLOW" and "GHK-Cu taken on its own" add up to one true total.
function consumptionReport(fromDateStr, toDateStr, subjectIds) {
  const logs = state.doseLogs.filter(l =>
    l.date >= fromDateStr && l.date <= toDateStr && subjectIds.includes(l.subjectId));

  // `sources` records which blends (or the standalone peptide) a substance's mg
  // came through. Without it a row like "KPV 36mg" is unexplainable when you
  // never bought KPV — it arrived inside KLOW, and the report should say so.
  const bySubstance = new Map(); // normalized name -> { displayName, bySubject: Map, total, doses, sources }
  for (const log of logs) {
    const peptide = getPeptide(log.peptideId);
    const isBlend = peptide && peptide.isBlend;
    const parts = isBlend
      ? Calc.blendComponentDoses(peptide, log.doseMg)
      : [{ name: peptide ? peptide.name : '(deleted peptide)', mg: log.doseMg }];

    for (const part of parts) {
      const displayName = part.name.trim();
      const key = displayName.toLowerCase();
      if (!bySubstance.has(key)) {
        bySubstance.set(key, { displayName, bySubject: new Map(), total: 0, doses: 0, sources: new Set() });
      }
      const entry = bySubstance.get(key);
      entry.total += part.mg;
      entry.doses += 1;
      if (isBlend) entry.sources.add(peptide.name);
      entry.bySubject.set(log.subjectId, (entry.bySubject.get(log.subjectId) || 0) + part.mg);
    }
  }
  return Array.from(bySubstance.values()).sort((a, b) => b.total - a.total);
}

// The Reports tab is read in the browser far more often than it's printed, and
// the ranges wanted there are nearly always one of these — typing two dates by
// hand every time was the slow part.
function reportRangePresets() {
  const today = new Date();
  const monthStart = (offset) => localDateStr(new Date(today.getFullYear(), today.getMonth() + offset, 1));
  const monthEnd = (offset) => localDateStr(new Date(today.getFullYear(), today.getMonth() + offset + 1, 0));
  return [
    { label: '30 days', from: daysAgoStr(30), to: todayStr() },
    { label: '90 days', from: daysAgoStr(90), to: todayStr() },
    { label: 'This month', from: monthStart(0), to: todayStr() },
    { label: 'Last month', from: monthStart(-1), to: monthEnd(-1) },
    { label: 'This year', from: localDateStr(new Date(today.getFullYear(), 0, 1)), to: todayStr() },
  ];
}

function renderReportsControls() {
  const el = document.getElementById('reportsControls');
  el.innerHTML = `<div class="card">
    <div class="row">
      <div class="field"><label>Subject</label>
        <select id="reportSubject">
          <option value="all" ${reportView.subjectId === 'all' ? 'selected' : ''}>All subjects</option>
          ${state.subjects.map(s => `<option value="${s.id}" ${reportView.subjectId === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>From</label><input id="reportFrom" type="date" value="${reportView.from}"></div>
      <div class="field"><label>To</label><input id="reportTo" type="date" value="${reportView.to}"></div>
      <div class="field" style="flex:0 0 auto; align-self:flex-end;"><button class="btn" id="reportPrintBtn">Print</button></div>
    </div>
    <div class="row" style="margin-top:.5rem; align-items:center;">
      <span class="muted small" style="flex:0 0 auto;">Range</span>
      ${reportRangePresets().map(p => `<button type="button" class="btn secondary report-preset${reportView.from === p.from && reportView.to === p.to ? ' active' : ''}" data-from="${p.from}" data-to="${p.to}">${escapeHtml(p.label)}</button>`).join('')}
    </div>
  </div>`;

  const rerender = () => {
    reportView.subjectId = document.getElementById('reportSubject').value;
    reportView.from = document.getElementById('reportFrom').value;
    reportView.to = document.getElementById('reportTo').value;
    renderReportsContent();
  };
  el.querySelector('#reportSubject').addEventListener('change', rerender);
  el.querySelector('#reportFrom').addEventListener('change', rerender);
  el.querySelector('#reportTo').addEventListener('change', rerender);
  el.querySelector('#reportPrintBtn').addEventListener('click', printReport);
  el.querySelectorAll('.report-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      reportView.from = btn.dataset.from;
      reportView.to = btn.dataset.to;
      renderReportsControls();
    });
  });

  renderReportsContent();
}

function reportSubjectIds() {
  return reportView.subjectId === 'all' ? state.subjects.map(s => s.id) : [reportView.subjectId];
}

function buildReportHTML(forPrint) {
  const subjectIds = reportSubjectIds();
  const subjects = state.subjects.filter(s => subjectIds.includes(s.id));
  const subjectLabel = reportView.subjectId === 'all' ? 'All subjects' : (getSubject(reportView.subjectId)?.name || '');
  const showSubjectCols = reportView.subjectId === 'all' && subjects.length > 1;
  const rows = consumptionReport(reportView.from, reportView.to, subjectIds);
  const rangeLabel = `${Calc.formatDate(new Date(reportView.from + 'T00:00:00'))} – ${Calc.formatDate(new Date(reportView.to + 'T00:00:00'))}`;

  let body;
  if (rows.length === 0) {
    body = `<div class="empty-state">No doses logged in this range.</div>`;
  } else {
    // A subject who took none of something gets an em dash, not a 0 — a column
    // of zeroes is what you have to read past to find the actual figures.
    const mgCell = mg => (mg ? Calc.round(mg, 2) : '<span class="report-none">—</span>');
    const grandTotal = rows.reduce((n, r) => n + r.total, 0);
    body = `<table class="report-table"><thead><tr>
        <th>Substance</th>
        <th class="num">Doses</th>
        ${showSubjectCols ? subjects.map(s => `<th class="num">${escapeHtml(s.name)} (mg)</th>`).join('') : ''}
        <th class="num">Total (mg)</th>
      </tr></thead><tbody>
      ${rows.map(r => `<tr>
        <td>${escapeHtml(r.displayName)}${r.sources.size ? `<span class="report-source">via ${escapeHtml(Array.from(r.sources).join(', '))}</span>` : ''}</td>
        <td class="num report-dim">${r.doses}</td>
        ${showSubjectCols ? subjects.map(s => `<td class="num">${mgCell(r.bySubject.get(s.id) || 0)}</td>`).join('') : ''}
        <td class="num report-total">${Calc.round(r.total, 2)}</td>
      </tr>`).join('')}
    </tbody><tfoot><tr>
      <td>${rows.length} substance${rows.length === 1 ? '' : 's'}</td>
      <td class="num report-dim"></td>
      ${showSubjectCols ? subjects.map(s => `<td class="num">${mgCell(rows.reduce((n, r) => n + (r.bySubject.get(s.id) || 0), 0))}</td>`).join('') : ''}
      <td class="num report-total">${Calc.round(grandTotal, 2)}</td>
    </tr></tfoot></table>`;
  }

  // The per-row "Doses" column counts doses *containing* that substance, so a
  // blend dose is counted once per component and the column deliberately
  // doesn't sum to this. The honest total belongs here, labelled, rather than
  // in a footer cell that would look like a broken sum.
  const loggedDoses = state.doseLogs.filter(l =>
    l.date >= reportView.from && l.date <= reportView.to && subjectIds.includes(l.subjectId)).length;
  const sub = `${subjectLabel} · ${rangeLabel} · ${loggedDoses} dose${loggedDoses === 1 ? '' : 's'} logged${forPrint ? ` · printed ${Calc.formatDate(new Date())}` : ''}`;
  return `<div class="sched-print-title">Consumption report</div><div class="sched-print-sub">${escapeHtml(sub)}</div>${body}`;
}

function renderReportsContent() {
  const el = document.getElementById('reportsContent');
  el.innerHTML = `<div class="card">${buildReportHTML()}</div>`;
}

function printReport() {
  document.getElementById('printReportArea').innerHTML = buildReportHTML(true);
  document.getElementById('labelPageStyle').textContent = '';
  document.body.dataset.printMode = 'report';
  window.print();
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Config-upload onboarding — an alternative to clicking through the Inventory/
// Protocols forms one at a time: a friendly JSON format that references
// subjects/peptides by name instead of internal ids, translated here into the
// same full state shape Backup import already restores. Validation is
// deliberately strict (name required, references must resolve, numeric fields
// must be positive) rather than silently defaulting a bad row, since a wrong
// guess baked into a whole peptide library is much harder to notice than an
// import that stops and says exactly which row is wrong.
// ---------------------------------------------------------------------------

const CONFIG_DAY_NAMES = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6,
};

function parseConfigDayOfWeek(v) {
  if (typeof v === 'number') return v;
  return CONFIG_DAY_NAMES[String(v).trim().toLowerCase()];
}

function translateConfig(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['Not a valid JSON object.'] };

  const subjectsIn = Array.isArray(raw.subjects) ? raw.subjects : [];
  const peptidesIn = Array.isArray(raw.peptides) ? raw.peptides : [];
  const lotsIn = Array.isArray(raw.inventoryLots) ? raw.inventoryLots : [];
  const protocolsIn = Array.isArray(raw.protocols) ? raw.protocols : [];
  if (subjectsIn.length === 0) errors.push('At least one subject is required.');
  if (peptidesIn.length === 0) errors.push('At least one peptide is required.');

  const subjects = [];
  const subjectIdByName = new Map();
  subjectsIn.forEach((s, i) => {
    const name = String(s?.name || '').trim();
    if (!name) { errors.push(`Subject #${i + 1} is missing a name.`); return; }
    if (subjectIdByName.has(name.toLowerCase())) { errors.push(`Duplicate subject name "${name}".`); return; }
    const id = uid();
    subjectIdByName.set(name.toLowerCase(), id);
    subjects.push({ id, name, color: s.color || PALETTE[subjects.length % PALETTE.length] });
  });

  const peptides = [];
  const peptideIdByName = new Map();
  peptidesIn.forEach((p, i) => {
    const name = String(p?.name || '').trim();
    if (!name) { errors.push(`Peptide #${i + 1} is missing a name.`); return; }
    if (peptideIdByName.has(name.toLowerCase())) { errors.push(`Duplicate peptide name "${name}".`); return; }
    const isBlend = !!p.isBlend;
    let components = [];
    if (isBlend) {
      if (!Array.isArray(p.components) || p.components.length === 0) {
        errors.push(`Blend "${name}" needs a components list.`); return;
      }
      let bad = false;
      components = p.components.map((c, ci) => {
        const cname = String(c?.name || '').trim();
        const mg = parseFloat(c?.mgPerVial);
        if (!cname || isNaN(mg) || mg <= 0) { errors.push(`"${name}" component #${ci + 1} needs a name and a positive mgPerVial.`); bad = true; return null; }
        const hl = parseFloat(c?.halfLifeHours);
        return { id: uid(), name: cname, mgPerVial: mg, halfLifeHours: (!isNaN(hl) && hl > 0) ? hl : null };
      });
      if (bad) return;
    }
    const id = uid();
    peptideIdByName.set(name.toLowerCase(), id);
    const hl = parseFloat(p.halfLifeHours);
    peptides.push({
      id, name, notes: String(p.notes || '').trim(), isBlend, components,
      halfLifeHours: (!isBlend && !isNaN(hl) && hl > 0) ? hl : null,
    });
  });

  const inventoryLots = [];
  lotsIn.forEach((l, i) => {
    const peptideId = peptideIdByName.get(String(l?.peptide || '').trim().toLowerCase());
    if (!peptideId) { errors.push(`Inventory lot #${i + 1} references unknown peptide "${l?.peptide}".`); return; }
    const mgPerVial = parseFloat(l.mgPerVial);
    const vials = parseInt(l.vials, 10);
    if (isNaN(mgPerVial) || mgPerVial <= 0 || isNaN(vials) || vials < 0 || !l.dateAcquired) {
      errors.push(`Inventory lot #${i + 1} for "${l.peptide}" needs a positive mgPerVial, a vials count, and dateAcquired.`); return;
    }
    inventoryLots.push({ id: uid(), peptideId, mgPerVial, vials, dateAcquired: l.dateAcquired });
  });

  const CONFIG_FREQUENCIES = ['daily', 'eod', 'weekly', 'asNeeded'];
  const protocols = [];
  protocolsIn.forEach((p, i) => {
    const subjectId = subjectIdByName.get(String(p?.subject || '').trim().toLowerCase());
    const peptideId = peptideIdByName.get(String(p?.peptide || '').trim().toLowerCase());
    if (!subjectId) { errors.push(`Protocol #${i + 1} references unknown subject "${p?.subject}".`); return; }
    if (!peptideId) { errors.push(`Protocol #${i + 1} references unknown peptide "${p?.peptide}".`); return; }
    const frequency = CONFIG_FREQUENCIES.includes(p.frequency) ? p.frequency : null;
    if (!frequency) { errors.push(`Protocol #${i + 1} (${p.peptide}) needs a frequency: daily, eod, weekly, or asNeeded.`); return; }
    const vialMgAssumed = parseFloat(p.vialMgAssumed);
    const bacWaterMl = parseFloat(p.bacWaterMl);
    if (isNaN(vialMgAssumed) || vialMgAssumed <= 0 || isNaN(bacWaterMl) || bacWaterMl <= 0) {
      errors.push(`Protocol #${i + 1} (${p.peptide}) needs a positive vialMgAssumed and bacWaterMl.`); return;
    }
    let daysOfWeek = [];
    if (frequency === 'weekly') {
      daysOfWeek = (Array.isArray(p.daysOfWeek) ? p.daysOfWeek : []).map(parseConfigDayOfWeek).filter(d => d >= 0 && d <= 6);
      if (daysOfWeek.length === 0) { errors.push(`Protocol #${i + 1} (${p.peptide}) is weekly but has no valid daysOfWeek.`); return; }
    }
    const doseSchedule = (Array.isArray(p.doseSchedule) ? p.doseSchedule : [])
      .map(ph => ({ id: uid(), startDate: ph?.startDate, doseMg: parseFloat(ph?.doseMg) }))
      .filter(ph => ph.startDate && !isNaN(ph.doseMg))
      .sort((a, b) => a.startDate.localeCompare(b.startDate));
    if (doseSchedule.length === 0) { errors.push(`Protocol #${i + 1} (${p.peptide}) needs at least one doseSchedule entry with startDate and doseMg.`); return; }
    const cycleOnWeeks = parseInt(p.cycleOnWeeks, 10);
    const cycleOffWeeks = parseInt(p.cycleOffWeeks, 10);
    protocols.push({
      id: uid(), subjectId, peptideId, vialMgAssumed, bacWaterMl, frequency, daysOfWeek,
      timeOfDay: ['morning', 'evening'].includes(p.timeOfDay) ? p.timeOfDay : '',
      endDate: p.endDate || '',
      cycleOnWeeks: (cycleOnWeeks > 0) ? cycleOnWeeks : null,
      cycleOffWeeks: (cycleOffWeeks > 0) ? cycleOffWeeks : null,
      doseSchedule,
      active: p.active !== false,
    });
  });

  if (errors.length > 0) return { ok: false, errors };

  const newState = defaultState();
  newState.subjects = subjects;
  newState.peptides = peptides;
  newState.inventoryLots = inventoryLots;
  newState.protocols = protocols;
  newState.doseLogs = [];

  return {
    ok: true,
    state: newState,
    summary: { subjects: subjects.length, peptides: peptides.length, inventoryLots: inventoryLots.length, protocols: protocols.length },
  };
}

function sampleConfigJSON() {
  return JSON.stringify({
    _readme: 'Fill this in with your own subjects/peptides/protocols, then Settings -> Import config. This key is ignored.',
    subjects: [{ name: 'Alex' }],
    peptides: [
      { name: 'BPC-157', notes: 'optional', halfLifeHours: 4 },
      { name: 'KLOW', isBlend: true, components: [
        { name: 'GHK-Cu', mgPerVial: 50 },
        { name: 'KPV', mgPerVial: 10 },
        { name: 'BPC-157', mgPerVial: 10 },
        { name: 'TB-500', mgPerVial: 10 },
      ] },
    ],
    inventoryLots: [
      { peptide: 'BPC-157', mgPerVial: 5, vials: 10, dateAcquired: todayStr() },
    ],
    protocols: [
      {
        subject: 'Alex', peptide: 'BPC-157', vialMgAssumed: 5, bacWaterMl: 2,
        frequency: 'daily', timeOfDay: 'morning',
        doseSchedule: [{ startDate: todayStr(), doseMg: 0.25 }],
      },
      {
        subject: 'Alex', peptide: 'KLOW', vialMgAssumed: 80, bacWaterMl: 3,
        frequency: 'weekly', daysOfWeek: ['Mon', 'Wed', 'Fri'],
        doseSchedule: [{ startDate: todayStr(), doseMg: 3.2 }],
      },
    ],
  }, null, 2);
}

function renderConfigImportPreview() {
  if (!configImportPreview) return '';
  const { result, fileName } = configImportPreview;
  if (!result.ok) {
    return `<div class="card" style="margin-top:.6rem; border-left:3px solid var(--danger, #b23b3b);">
      <h3>Couldn't import ${escapeHtml(fileName)}</h3>
      <ul>${result.errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul>
      <button class="btn secondary" data-action="dismiss-config-preview" type="button">Dismiss</button>
    </div>`;
  }
  const s = result.summary;
  return `<div class="card" style="margin-top:.6rem; border-left:3px solid var(--ok, #3f6b52);">
    <h3>Ready to import ${escapeHtml(fileName)}</h3>
    <p class="muted small">${s.subjects} subject${s.subjects === 1 ? '' : 's'}, ${s.peptides} peptide${s.peptides === 1 ? '' : 's'}, ${s.protocols} protocol${s.protocols === 1 ? '' : 's'}, ${s.inventoryLots} inventory lot${s.inventoryLots === 1 ? '' : 's'}.</p>
    <p class="muted small">This replaces all current data in the app, same as restoring a backup.</p>
    <div class="row" style="align-items:center;">
      <button class="btn" data-action="confirm-config-import" type="button">Import and replace</button>
      <button class="btn secondary" data-action="dismiss-config-preview" type="button">Cancel</button>
    </div>
  </div>`;
}

function renderSettings() {
  const el = document.getElementById('settingsContent');
  html_settings: {
    el.innerHTML = `
      <h2>Label design</h2>
      <div class="card">
        <div class="row">
          <div class="field"><label>Width (mm)</label><input id="setLabelW" type="number" min="1" step="0.5" value="${state.settings.labelWidthMm}"></div>
          <div class="field"><label>Height (mm)</label><input id="setLabelH" type="number" min="1" step="0.5" value="${state.settings.labelHeightMm}"></div>
        </div>
        <div class="muted small">Match this to the NIIMBOT label stock you have loaded (M2 supports 20–50mm wide rolls).</div>
        <hr class="divider">
        <div class="row" style="align-items:flex-end;">
          <div class="field" style="max-width:200px;"><label>PNG export dpi</label>
            <input id="setLabelDpi" type="number" min="72" max="1200" step="1" value="${Math.round(labelExportDpi())}">
          </div>
          <div class="muted small" style="flex:1 1 260px;">Exports come out <strong>${labelExportPxSize().width}×${labelExportPxSize().height}px</strong>, tagged as ${state.settings.labelWidthMm}×${state.settings.labelHeightMm}mm, so the NIIMBOT app should place them at true size — import at 100% and don't drag the corners.
          <br>If one still lands the wrong size, calibrate: <em>new dpi = ${Math.round(labelExportDpi())} × (width it landed at ÷ ${state.settings.labelWidthMm}mm)</em>. Above ${LABEL_HEAD_DPI} dpi the extra pixels only guard against the app rescaling — the M2_H head itself prints ${LABEL_HEAD_DPI} dpi.</div>
        </div>
        <hr class="divider">
        <div class="row" style="align-items:flex-end;">
          <div class="field" style="flex:1 1 260px;"><label>Save exported PNGs to</label>
            <input id="setLabelSaveDir" type="text" value="${escapeHtml(state.settings.labelSaveDir || '')}" placeholder="~/Desktop/Label Files" ${serverAvailable ? '' : 'disabled'}>
          </div>
          <div class="muted small" style="flex:1 1 240px;">${serverAvailable
            ? 'server.py writes label exports here (creating the folder if needed), so they never land in ~/Downloads. Leave it blank to fall back to the browser.'
            : "Only available when running via start.command. Opened directly, the browser decides where downloads go — Chrome and Edge will offer a folder picker, Safari and Firefox won't."}</div>
        </div>
        <hr class="divider">
        <div class="row" style="align-items:center;">
          <div class="field" style="flex:0 0 auto;">
            <label>Logo / design (optional)</label>
            <input type="file" id="setLogoFile" accept="image/*">
          </div>
          ${state.settings.logoDataUrl ? `
            <div style="flex:0 0 auto; display:flex; align-items:center; gap:.6rem;">
              <img src="${state.settings.logoDataUrl}" alt="Logo preview" style="max-height:14mm; max-width:24mm; border:1px solid var(--line); border-radius:4px; background:#fff; padding:2px;">
              <button class="btn danger" id="removeLogoBtn" type="button">Remove</button>
            </div>` : `<div class="muted small" style="flex:1 1 200px;">Prints in black on every label. The M2 is a 1-bit thermal printer, so flat high-contrast artwork reproduces best — greys and gradients come out as dither speckle. PNGs with transparency work best.</div>`}
        </div>
      </div>

      <h2>Syringe</h2>
      <div class="card">
        <div class="field" style="max-width:220px;"><label>Syringe type</label>
          <select id="setSyringe">
            <option value="U100" ${state.settings.syringeUnits === 'U100' ? 'selected' : ''}>U-100 (100 units/mL)</option>
            <option value="U40" ${state.settings.syringeUnits === 'U40' ? 'selected' : ''}>U-40 (40 units/mL)</option>
          </select>
        </div>
      </div>

      <h2>Subjects</h2>
      <div class="card">
        <div class="item-list">
          ${state.subjects.map(s => `<div class="item-row">
            <input data-action="rename-subject" data-id="${s.id}" value="${escapeHtml(s.name)}" style="max-width:220px;">
            <div class="actions">
              <button class="btn danger" data-action="delete-subject" data-id="${s.id}" ${protocolsForSubject(s.id).length ? 'disabled title="Remove their protocols first"' : ''}>Remove</button>
            </div>
          </div>`).join('')}
        </div>
        <form id="addSubjectForm" class="row" style="margin-top:.6rem;">
          <div class="field"><label>New subject name</label><input name="name" required></div>
          <div class="field" style="flex:0 0 auto; align-self:flex-end;"><button class="btn secondary" type="submit">Add subject</button></div>
        </form>
      </div>

      <h2>Backup</h2>
      <div class="card">
        <p class="muted small">${serverAvailable
          ? 'Running via server.py — every change is written straight to <code>data.json</code> in the app folder. That file is your real backup; copy it or put the whole folder in iCloud Drive/Dropbox for off-machine safety. Export below still works for one-off snapshots.'
          : "Opened directly (not via start.command), so data lives only in this browser's local storage. Export a backup regularly, especially before clearing browser data or switching devices."}</p>
        <div class="row" style="align-items:center;">
          <button class="btn" id="exportBtn" type="button">Export backup (.json)</button>
          <button class="btn secondary" id="importBtn" type="button">Import backup</button>
          <input type="file" id="importFile" accept="application/json" style="display:none;">
        </div>
      </div>

      <h2>Set up from a config file</h2>
      <div class="card">
        <p class="muted small">For a new install — describe subjects, peptides, protocols, and starting inventory in one file instead of clicking through the forms above. Replaces all current data, same as a backup restore.</p>
        <div class="row" style="align-items:center;">
          <button class="btn secondary" id="importConfigBtn" type="button">Import config</button>
          <button class="btn secondary" id="downloadSampleConfigBtn" type="button">Download example file</button>
          <input type="file" id="importConfigFile" accept="application/json" style="display:none;">
        </div>
        ${renderConfigImportPreview()}
      </div>
    `;
  }

  el.querySelector('#setLabelW').addEventListener('change', e => { state.settings.labelWidthMm = parseFloat(e.target.value) || 40; saveState(); renderAll(); });
  el.querySelector('#setLabelH').addEventListener('change', e => { state.settings.labelHeightMm = parseFloat(e.target.value) || 20; saveState(); });
  el.querySelector('#setLabelSaveDir').addEventListener('change', e => {
    state.settings.labelSaveDir = e.target.value.trim();
    saveState(); renderAll();
  });
  el.querySelector('#setLabelDpi').addEventListener('change', e => {
    const dpi = parseFloat(e.target.value);
    state.settings.labelExportDpi = (Number.isFinite(dpi) && dpi >= 72) ? dpi : LABEL_EXPORT_DPI_DEFAULT;
    saveState(); renderAll();
  });
  el.querySelector('#setSyringe').addEventListener('change', e => { state.settings.syringeUnits = e.target.value; saveState(); renderAll(); });

  el.querySelector('#setLogoFile').addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) handleLogoUpload(file);
  });
  el.querySelector('#removeLogoBtn')?.addEventListener('click', () => {
    state.settings.logoDataUrl = '';
    saveState(); renderAll();
  });

  el.querySelectorAll('[data-action="rename-subject"]').forEach(input => {
    input.addEventListener('change', () => {
      const s = getSubject(input.dataset.id);
      s.name = input.value.trim() || s.name;
      saveState(); renderAll();
    });
  });
  el.querySelectorAll('[data-action="delete-subject"]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      state.subjects = state.subjects.filter(s => s.id !== btn.dataset.id);
      saveState(); renderAll();
    });
  });
  el.querySelector('#addSubjectForm').addEventListener('submit', e => {
    e.preventDefault();
    const name = new FormData(e.target).get('name').trim();
    if (!name) return;
    const color = PALETTE[state.subjects.length % PALETTE.length];
    state.subjects.push({ id: uid(), name, color });
    saveState(); renderAll();
  });

  el.querySelector('#exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `peptide-tracker-backup-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
  el.querySelector('#importBtn').addEventListener('click', () => el.querySelector('#importFile').click());
  el.querySelector('#importFile').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed.subjects || !parsed.peptides) throw new Error('Not a valid backup file.');
        state = migrateState(mergeWithDefaults(parsed));
        saveState(); renderAll();
        alert('Backup imported.');
      } catch (err) {
        alert('Could not import that file: ' + err.message);
      }
    };
    reader.readAsText(file);
  });

  el.querySelector('#downloadSampleConfigBtn').addEventListener('click', () => {
    const blob = new Blob([sampleConfigJSON()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'peptide-tracker-config-example.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  el.querySelector('#importConfigBtn').addEventListener('click', () => el.querySelector('#importConfigFile').click());
  el.querySelector('#importConfigFile').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let raw;
      try {
        raw = JSON.parse(reader.result);
      } catch (err) {
        configImportPreview = { result: { ok: false, errors: [`Not valid JSON: ${err.message}`] }, fileName: file.name };
        renderSettings();
        return;
      }
      configImportPreview = { result: translateConfig(raw), fileName: file.name };
      renderSettings();
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  el.querySelectorAll('[data-action="dismiss-config-preview"]').forEach(btn => {
    btn.addEventListener('click', () => { configImportPreview = null; renderSettings(); });
  });

  el.querySelectorAll('[data-action="confirm-config-import"]').forEach(btn => {
    btn.addEventListener('click', () => {
      state = migrateState(mergeWithDefaults(configImportPreview.result.state));
      configImportPreview = null;
      saveState(); renderAll();
      alert('Config imported.');
    });
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

initTabs();
renderAll();
trySyncFromServer();

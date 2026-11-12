'use strict';
/* AetherMacro main window. Plain JS, no build step. */
const T = window.__TAURI__;
const invoke = T.core.invoke;
const listen = T.event.listen;
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const COLOR = { rect: 'var(--rect)', circle: 'var(--circ)', poly: 'var(--poly)', point: 'var(--brass)' };
const THUMB = {
  rect: '<rect x="8" y="8" width="42" height="18" rx="2"/>',
  circle: '<circle cx="29" cy="17" r="12"/>',
  poly: '<path d="M10 26L22 6l28 4-6 16z"/>',
  point: '<path d="M29 7v20M19 17h20"/>',
  path: '<path d="M8 24c8-16 14 4 22-8s12-6 20-10" fill="none"/>',
  key: '<rect x="18" y="8" width="22" height="18" rx="3"/><path d="M24 20h10" />',
  wait: '<circle cx="29" cy="17" r="10" fill="none"/><path d="M29 11v6l4 3" fill="none"/>'
};
const ACTIONS = [
  ['left', 'Left click'], ['right', 'Right click'], ['middle', 'Middle click'], ['double', 'Double click'],
  ['hold', 'Hold'], ['drag', 'Drag and drop'], ['scroll', 'Scroll'], ['key', 'Key tap or combo'],
  ['text', 'Type text'], ['move', 'Move only'], ['wait', 'Wait'], ['path', 'Recorded path']
];
const HOTKEYS = [
  ['start', 'Start or resume', 'F5'], ['pause', 'Pause or resume', 'F6'], ['step', 'Step through', 'F11'],
  ['quick', 'Quick capture, silent', 'F7'], ['capture', 'Capture overlay', 'F8'], ['record', 'Record path', 'Ctrl+Shift+R'],
  ['hud', 'Toggle telemetry', 'F9'], ['pill', 'Toggle status pill', 'F10'],
  ['stop', 'Emergency stop', 'Esc'], ['stop2', 'Emergency stop, second key', 'F12']
];
const CONFLICTS = {
  F1: 'Help in many apps', F5: 'Quick save in many RPGs, refresh in browsers', F9: 'Quick load in many RPGs',
  F10: 'Menu bar in Windows apps', F11: 'Fullscreen in browsers and some games', F12: 'Steam screenshot',
  'Alt+F4': 'Closes the window', 'Alt+Tab': 'Switches windows', 'Ctrl+Shift+Esc': 'Task Manager',
  'Ctrl+Shift+R': 'Hard refresh in browsers', Tab: 'Scoreboard in many shooters', 'Ctrl+C': 'Copy', 'Ctrl+V': 'Paste',
  Space: 'Jump in most games', W: 'Movement in most games', A: 'Movement in most games', S: 'Movement in most games', D: 'Movement in most games'
};

/* ---------------------------------------------------------------- utils */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = ms => { ms = Math.max(0, Math.round(ms)); return ms >= 60000 ? (ms / 60000).toFixed(1) + ' min' : ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : ms + ' ms'; };
const clock = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return [s / 3600 | 0, (s / 60 | 0) % 60, s % 60].map(n => String(n).padStart(2, '0')).join(':'); };
const pl = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
const avg = r => ((+r.min || 0) + (+r.max || 0)) / 2;
const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const round = (v, p = 0) => { const k = 10 ** p; return Math.round(v * k) / k; };
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clone = o => JSON.parse(JSON.stringify(o));
const ago = t => {
  if (!t) return 'Never run';
  const s = (Date.now() - t) / 1e3;
  return 'Ran ' + (s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : pl(Math.round(s / 86400), 'day') + ' ago');
};
const when = t => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function toast(t) {
  const e = $('#toast');
  e.textContent = t;
  e.classList.add('on');
  clearTimeout(e.t);
  e.t = setTimeout(() => e.classList.remove('on'), 1800 + Math.min(2400, t.length * 25));
}

/* ---------------------------------------------------------------- state */
let DB = { macros: [], active: null };
let PREFS = { hotkeys: {}, volume: 0.5, muted: false, record_hz: 60 };
let DATA_DIR = '', DEFAULT_DIR = '';
let hist = [], redo = [];
let view = 'seq', sel = -1, ins = -1, firstSeq = true;
let RUN = { state: 'idle' };
let REC = { recording: false, started: 0, pending: null, a: 0, b: 100, smooth: 30 };
let RUNS = [];
let HK_RESULTS = {};
let listening = null;
let replaceZoneFor = null;
let UPDATE = null;
let APPINFO = { version: '', os: '' };
let winCache = { key: '', info: null, at: 0 };

const cur = () => DB.macros.find(m => m.id === DB.active) || DB.macros[0];
const snap = () => JSON.stringify({ macros: DB.macros, active: DB.active });

let SAVED_AT = 0;
function writeNow() {
  clearTimeout(persist.t);
  return invoke('save_library', { macros: DB.macros, index: { active: DB.active, order: DB.macros.map(m => m.id) } })
    .then(() => { SAVED_AT = Date.now(); savedLabel(); return true; })
    .catch(e => { toast('Could not save: ' + e); return false; });
}
function persist() {
  clearTimeout(persist.t);
  persist.t = setTimeout(writeNow, 120);
}
function savedLabel() {
  const m = cur(); if (!m) return;
  const t = SAVED_AT ? new Date(SAVED_AT).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
  $('#ps').textContent = pl(m.steps.length, 'step') + (t ? ', saved ' + t : ', autosaved');
}
const portable = m => JSON.stringify(Object.assign(clone(m), { file: '' }), null, 2);
const dirOf = p => p.replace(/[\\/][^\\/]*$/, '');
const baseOf = p => p.split(/[\\/]/).pop();
/** Ctrl+S: write to the macro's own file, or ask where on first save. */
async function saveNow(m = cur()) {
  if (!m.file) return saveAs(m);
  await writeNow();
  try { await invoke('write_file', { path: m.file, content: portable(m) }); toast('Saved to ' + m.file); }
  catch (e) { toast(`Could not save to ${m.file}. ${e}`); saveAs(m); }
}
/** Save as: native dialog with a chosen name and folder. */
async function saveAs(m = cur()) {
  const dir = m.file ? dirOf(m.file) : (PREFS.save_dir || DEFAULT_DIR);
  const name = m.file ? baseOf(m.file) : m.name;
  try {
    const p = await invoke('save_file_as', { content: portable(m), name, dir });
    if (!p) return;
    m.file = p;
    await writeNow();
    renderAll();
    toast('Saved to ' + p);
  } catch (e) { toast('Could not save: ' + e); }
}
function savePrefs() {
  invoke('save_prefs', { prefs: PREFS }).catch(e => toast('Could not save settings: ' + e));
}

/** Every change goes through here: undo snapshot, autosave, re-render. */
function mut(f, msg) {
  hist.push(snap());
  if (hist.length > 50) hist.shift();
  redo = [];
  f();
  const m = cur();
  if (m) m.updated = Date.now();
  persist();
  renderAll();
  if (msg) toast(msg);
}
function restore(s) {
  const o = JSON.parse(s);
  DB.macros = o.macros;
  DB.active = o.active;
  if (!DB.macros.find(m => m.id === DB.active)) DB.active = DB.macros[0]?.id;
  persist();
  syncTarget();
  renderAll();
}
function undo() { if (!hist.length) return toast('Nothing to undo'); redo.push(snap()); restore(hist.pop()); toast('Undone'); }
function redoIt() { if (!redo.length) return toast('Nothing to redo'); hist.push(snap()); restore(redo.pop()); toast('Redone'); }

function newMacro(name) {
  return {
    id: uid('m'), name, version: '2.0', created: Date.now(), updated: Date.now(), last_run: null, authored: null, file: '',
    target: { process: '', title: '', require_focus: true, on_resize: 'scale' },
    settings: {
      loop_mode: 'infinite', loop_count: 10, duration_min: 30,
      breaks: { enabled: false, every_min: 8, every_max: 15, pause_min: 2000, pause_max: 6000 },
      trajectory: 'bezier', speed: 1, overshoot: true, curvature: 0.25, user_override: true
    },
    steps: []
  };
}
function newStep(over = {}) {
  return Object.assign({
    id: uid('s'), enabled: true, name: 'New step', action: { kind: 'click', button: 'left', count: 1 }, zone: null,
    hold: { min: 45, max: 80 }, delay: { dist: 'gaussian', mean: 600, spread: 80 }, guard: null
  }, over);
}
function untitled() { let n = 1; while (DB.macros.some(m => m.name === 'Untitled macro ' + n)) n++; return 'Untitled macro ' + n; }

/* ------------------------------------------------------------- step text */
function shapeOf(s) {
  if (s.action.kind === 'path') return 'path';
  if (s.zone) return s.zone.shape;
  if (s.action.kind === 'key' || s.action.kind === 'text') return 'key';
  if (s.action.kind === 'wait') return 'wait';
  return 'point';
}
const colorOf = s => COLOR[s.zone?.shape] || COLOR.point;
function actionId(a) {
  if (a.kind === 'click') return a.count > 1 ? 'double' : (a.button || 'left');
  return a.kind;
}
function actLabel(s) {
  const a = s.action;
  switch (a.kind) {
    case 'click': return a.count > 1 ? 'Double click' : cap(a.button || 'left') + ' click';
    case 'hold': return `Hold ${a.button || 'left'} ${fmt(avg(s.hold))}`;
    case 'drag': return 'Drag and drop';
    case 'scroll': return `Scroll ${a.horizontal ? (a.amount < 0 ? 'left' : 'right') : (a.amount < 0 ? 'down' : 'up')} ${pl(Math.abs(a.amount || 0), 'tick')}`;
    case 'key': return 'Key tap, ' + (a.keys || 'not set');
    case 'text': return `Type ${a.text ? '“' + (a.text.length > 24 ? a.text.slice(0, 24) + '…' : a.text) + '”' : 'nothing yet'}`;
    case 'move': return 'Move only';
    case 'wait': return 'Wait';
    case 'path': return 'Recorded path, ' + pl((a.points || []).length, 'point');
  }
  return a.kind;
}
function zoneLabel(z) {
  if (!z) return 'No zone';
  const r = Math.round;
  return { point: 'Exact pixel', rect: `Box ${r(z.w)}×${r(z.h)}`, circle: `Circle radius ${r(z.r)}`, poly: `Polygon, ${pl(z.points.length, 'vertex').replace('vertexs', 'vertices')}` }[z.shape] || '';
}
function stepSub(s) {
  const parts = [actLabel(s)];
  if (s.zone && s.action.kind !== 'path') parts.push(zoneLabel(s.zone));
  if (s.guard?.samples?.length) parts.push('guarded');
  if (!s.enabled) parts.push('disabled');
  return parts.join(', ');
}
function est(s) {
  const a = s.action;
  let t = num(s.delay.mean);
  if (s.zone && a.kind !== 'wait') t += 260;
  if (['click', 'hold', 'key'].includes(a.kind)) t += avg(s.hold) * (a.count > 1 ? 2 : 1);
  if (a.kind === 'drag') t += 600;
  if (a.kind === 'scroll') t += Math.abs(a.amount || 1) * 60;
  if (a.kind === 'text') t += (a.text || '').length * (avg(s.hold) + 40);
  if (a.kind === 'path' && a.points?.length) t += a.points[a.points.length - 1][2] - a.points[0][2];
  return Math.max(30, t);
}
const thumb = s => {
  const k = shapeOf(s), c = colorOf(s);
  return `<svg class="thumb" viewBox="0 0 58 34" fill="${c}" fill-opacity=".13" stroke="${c}" stroke-width="1.5" aria-hidden="true">${THUMB[k]}</svg>`;
};

/* ---------------------------------------------------------------- nav */
function go(v) {
  view = v;
  $$('.view').forEach(x => x.classList.toggle('on', x.id === 'v-' + v));
  $$('#nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  moveInd();
  $('#main').scrollTo(0, 0);
  renderView();
}
function moveInd() {
  const b = $(`#nav button[data-v="${view}"]`), ind = $('.ind');
  if (!b) return;
  ind.style.transform = `translateY(${b.offsetTop}px)`;
  ind.style.height = b.offsetHeight + 'px';
}
$('#nav').addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if (b) go(b.dataset.v); });
$('#prof').onclick = () => go('lib');
addEventListener('resize', moveInd);

function renderAll() {
  const m = cur();
  if (!m) return;
  $('#pn').textContent = m.name;
  savedLabel();
  renderView();
}
function renderView() {
  ({ lib: renderLib, seq: renderSeq, ins: renderIns, rec: renderRec, log: renderLog, set: renderSet, key: renderKeys, app: renderApp }[view] || (() => {}))();
}

/* ---------------------------------------------------------------- library */
function renderLib() {
  const q = ($('#q').value || '').toLowerCase();
  const L = DB.macros.filter(m => m.name.toLowerCase().includes(q) || (m.target.process || '').toLowerCase().includes(q));
  const anim = !renderLib.done; renderLib.done = true;
  $('#mlist').classList.toggle('anim', anim);
  $('#mlist').innerHTML = L.length ? L.map((m, i) => {
    const on = m.steps.filter(s => s.enabled), tot = on.reduce((a, s) => a + est(s), 0);
    const running = RUN.state !== 'idle' && RUN.macro_id === m.id;
    return `<li class="${m.id === DB.active ? 'cur' : ''}" style="--i:${i}">
      <div class="st"><b>${esc(m.name)}</b><span>${esc(m.target.process || 'Whole screen')}, ${pl(m.steps.length, 'step')}. ${running ? 'Running now' : ago(m.last_run)}${m.file ? '. ' + esc(baseOf(m.file)) : ''}</span></div>
      <div class="mini" aria-hidden="true">${on.map(s => `<i style="flex:${est(s)};background:${colorOf(s)}"></i>`).join('') || '<i style="flex:1;background:var(--deep)"></i>'}</div>
      <span class="m time">${tot ? fmt(tot) : 'Empty'}</span>
      <div class="row" style="flex-wrap:nowrap;gap:6px"><button class="btn sm" data-a="open" data-id="${m.id}">${m.id === DB.active ? 'Open now' : 'Open'}</button>
      <div class="rowact"><button data-a="dup" data-id="${m.id}">Duplicate</button><button data-a="export" data-id="${m.id}">Save as</button><button class="del" data-a="del" data-id="${m.id}">Delete</button></div></div></li>`;
  }).join('') : `<li class="empty"><span>No macros match that search.</span></li>`;
}
$('#q').oninput = renderLib;
$('#mlist').onclick = e => {
  const b = e.target.closest('button[data-a]');
  if (!b) return;
  const id = b.dataset.id, a = b.dataset.a, m = DB.macros.find(x => x.id === id);
  if (!m) return;
  if (a === 'open') { openMacro(id); go('seq'); }
  if (a === 'dup') mut(() => { const c = clone(m); c.id = uid('m'); c.name = m.name + ' copy'; c.last_run = null; c.file = ''; c.created = Date.now(); c.steps.forEach(s => s.id = uid('s')); DB.macros.splice(DB.macros.indexOf(m) + 1, 0, c); }, 'Macro duplicated');
  if (a === 'export') saveAs(m);
  if (a === 'del') {
    if (DB.macros.length < 2) return toast('Keep at least one macro');
    if (RUN.state !== 'idle' && RUN.macro_id === id) return toast('Stop this macro before deleting it');
    mut(() => { DB.macros = DB.macros.filter(x => x.id !== id); if (DB.active === id) { DB.active = DB.macros[0].id; syncTarget(); } }, 'Macro deleted, Ctrl+Z to undo');
  }
};
function openMacro(id) {
  if (DB.active === id) return;
  DB.active = id; sel = -1; ins = -1; firstSeq = true;
  persist(); syncTarget(); renderAll();
}
$('#newm').onclick = () => {
  mut(() => { const m = newMacro(untitled()); DB.macros.push(m); DB.active = m.id; sel = -1; ins = -1; });
  syncTarget();
  go('seq');
  const t = $('#mt'); t.focus(); getSelection().selectAllChildren(t);
};
async function exportJson(name, data) {
  try { const p = await invoke('save_file_as', { name, content: JSON.stringify(data, null, 2), dir: PREFS.save_dir || DEFAULT_DIR }); if (p) toast('Saved to ' + p); }
  catch (e) { toast('Could not save: ' + e); }
}
$('#exportall').onclick = () => exportJson('AetherMacro library.json', { format: 'aethermacro-bundle', version: '2.0', macros: DB.macros.map(m => Object.assign(clone(m), { file: '' })) });
$('#importbtn').onclick = openFiles;
async function openFiles() {
  let files = [];
  try { files = await invoke('open_files', { dir: PREFS.save_dir || DEFAULT_DIR }); } catch (e) { return toast(String(e)); }
  if (!files.length) return;
  const ok = [];
  for (const f of files) {
    let data;
    try { data = JSON.parse(f.content); } catch { toast(`${baseOf(f.path)} is not valid JSON.`); continue; }
    const single = !Array.isArray(data) && !Array.isArray(data.macros);
    const list = Array.isArray(data) ? data : Array.isArray(data.macros) ? data.macros : [data];
    list.filter(m => m && typeof m.name === 'string' && Array.isArray(m.steps)).forEach(m => ok.push([m, single ? f.path : '']));
  }
  if (!ok.length) return toast('No macros found in that file.');
  let last = null;
  mut(() => {
    for (const [raw, path] of ok) {
      const m = Object.assign(newMacro(raw.name), clone(raw));
      m.target = Object.assign(newMacro('').target, raw.target || {});
      m.settings = Object.assign(newMacro('').settings, raw.settings || {});
      m.settings.breaks = Object.assign(newMacro('').settings.breaks, raw.settings?.breaks || {});
      m.id = uid('m');
      m.steps = m.steps.map(s => newStep(Object.assign(clone(s), { id: uid('s') })));
      m.file = path && !DB.macros.some(x => x.file === path) ? path : '';
      while (DB.macros.some(x => x.name === m.name)) m.name += ' copy';
      DB.macros.push(m);
      last = m;
    }
    if (ok.length === 1 && last) DB.active = last.id;
  }, `Opened ${pl(ok.length, 'macro')}`);
  syncTarget();
}

/* ---------------------------------------------------------------- sequence */
const isRunningHere = () => RUN.state !== 'idle' && RUN.macro_id === cur()?.id;
function enabledIdx(m) { return m.steps.map((s, i) => s.enabled ? i : -1).filter(i => i >= 0); }

function renderSeq() {
  const m = cur(); if (!m) return;
  const S = m.steps, on = S.filter(s => s.enabled), tot = on.reduce((a, s) => a + est(s), 0);
  if (document.activeElement !== $('#mt')) $('#mt').textContent = m.name;
  $('#ml').textContent = S.length
    ? `${pl(S.length, 'step')}, about ${(tot / 1000).toFixed(1)} seconds per pass. ${m.target.process ? 'Zones follow the window if you move it.' : 'Zones are placed on the whole screen.'}`
    : 'Nothing here yet. Hover the app you want to automate and press F8 to capture the first step.';
  if (m.file) $('#ml').textContent += ` Saved as ${baseOf(m.file)}.`;
  const here = isRunningHere(), other = RUN.state !== 'idle' && !here;
  const k = id => esc(PREFS.hotkeys[id] || '');
  $('#seqactions').innerHTML = here
    ? `<button class="btn mad" data-act="stop">Stop <kbd>${k('stop')}</kbd></button>${RUN.state === 'paused'
      ? `<button class="btn" data-act="step">Next step <kbd>${k('step')}</kbd></button><button class="btn pri" data-act="resume">Resume <kbd>${k('start')}</kbd></button>`
      : `<button class="btn pri" data-act="pause">Pause <kbd>${k('pause')}</kbd></button>`}`
    : `<button class="btn" data-act="save" title="${m.file ? 'Save to ' + esc(m.file) : 'Choose a file name and folder'}">Save <kbd>Ctrl+S</kbd></button><button class="btn" data-act="saveas">Save as</button><button class="btn" data-act="capture">Capture step <kbd>${k('capture')}</kbd></button><button class="btn" data-act="dry">Dry run</button><button class="btn" data-act="stepmode">Step through <kbd>${k('step')}</kbd></button><button class="btn pri" data-act="run" ${other ? 'disabled title="Another macro is running"' : ''}>Run <kbd>${k('start')}</kbd></button>`;
  renderRunbar();
  renderFacts(m);
  const pass = $('#pass');
  if (on.length) {
    pass.className = 'pass' + (here ? '' : ' idle');
    pass.innerHTML = on.map(s => `<i style="flex:${est(s)}" title="${esc(s.name)}, ${fmt(est(s))}"><b style="background:${colorOf(s)}"></b></i>`).join('');
  } else { pass.className = 'pass-empty'; pass.innerHTML = ''; }
  const led = $('#ledger');
  led.classList.toggle('anim', firstSeq && S.length > 0);
  firstSeq = false;
  led.innerHTML = S.length ? S.map((s, i) => `<li tabindex="0" draggable="true" data-i="${i}" class="${i === sel ? 'sel' : ''} ${s.enabled ? '' : 'off'}" style="--i:${i};--c:${colorOf(s)}">
      <span class="node" aria-hidden="true">${i + 1}</span>
      <div class="st"><b>${esc(s.name)}</b><span>${esc(stepSub(s))}</span></div>
      ${thumb(s)}
      <div class="row" style="flex-wrap:nowrap;gap:12px"><span class="m time">${fmt(est(s))}</span>
      <div class="rowact"><button data-a="edit">Edit</button><button data-a="here">Run from here</button><button data-a="dup">Duplicate</button><button data-a="toggle">${s.enabled ? 'Disable' : 'Enable'}</button><button class="del" data-a="del">Delete</button></div></div></li>`).join('')
    : `<li class="empty"><span>No steps yet. Press ${k('capture')} over the app to capture the first one, or ${k('quick')} to drop a click where the pointer is.</span><button class="btn pri" data-act="capture">Capture step</button></li>`;
  markRunning();
}
function renderRunbar() {
  const rb = $('#runbar');
  if (!isRunningHere()) { rb.hidden = true; return; }
  rb.hidden = false;
  const st = RUN.state, paused = st === 'paused' || st === 'waiting';
  const total = RUN.total_passes ? ` of ${RUN.total_passes}` : '';
  rb.innerHTML = `<span class="beacon ${paused ? 'paused' : ''}"></span><b>${RUN.dry ? 'Dry run' : { running: 'Running', paused: 'Paused', waiting: 'Waiting', break: 'On a break' }[st] || 'Running'}</b>
    <span>pass <span class="m">${RUN.pass}</span>${total}</span><span class="m" id="elapsed">${clock(Date.now() - RUN.started)}</span>${RUN.reason ? `<span>${esc(RUN.reason)}</span>` : ''}`;
}
function markRunning() {
  const m = cur(); if (!m) return;
  const here = isRunningHere();
  const idx = enabledIdx(m);
  const active = here ? idx[RUN.step] : -1;
  $$('#ledger li[data-i]').forEach(li => li.classList.toggle('on', +li.dataset.i === active));
  $$('#pass i').forEach((seg, i) => {
    const want = here && i === RUN.step && RUN.state === 'running';
    seg.classList.toggle('done', here && i < RUN.step);
    if (want && !seg.classList.contains('on')) {
      seg.style.setProperty('--t', Math.max(80, m.steps[idx[i]] ? est(m.steps[idx[i]]) : 0) + 'ms');
    }
    seg.classList.toggle('on', want);
  });
}
function renderFacts(m) {
  const t = m.target, s = m.settings;
  const loop = { infinite: 'Continuous, restart on finish', count: `${pl(s.loop_count, 'pass')}, then stop`, duration: `For ${s.duration_min} min, then stop` }[s.loop_mode] || '';
  const hum = s.trajectory === 'teleport' ? 'Teleport, no path' : `Bézier paths${s.overshoot ? ' with overshoot' : ''}, speed ${s.speed}×`;
  const focus = t.process ? (t.require_focus ? 'Only while in front, pause if minimized' : 'Act even when not in front') : 'No focus check on whole screen';
  let chip = '';
  const w = winCache.info;
  if (t.process && winCache.key === t.process) {
    if (!w) chip = `<span class="chip">Not open right now</span>`;
    else if (m.authored && (Math.abs(w.w - m.authored.w) > 1 || Math.abs(w.h - m.authored.h) > 1)) chip = `<span class="chip">${w.w}×${w.h} now, authored at ${m.authored.w}×${m.authored.h}</span>`;
  }
  $('#facts').innerHTML = `<button data-go="set"><dt>Target window</dt><dd>${esc(t.process || 'Whole screen')}</dd>${chip}</button>
    <button data-go="set"><dt>Loop policy</dt><dd>${esc(loop)}</dd></button>
    <button data-go="set"><dt>Humanization</dt><dd>${esc(hum)}</dd></button>
    <button data-go="set"><dt>Focus policy</dt><dd>${esc(focus)}</dd></button>`;
}
$('#facts').onclick = e => { if (e.target.closest('[data-go]')) go('set'); };
async function refreshWin() {
  const m = cur(); if (!m || !m.target.process) return;
  if (winCache.key === m.target.process && Date.now() - winCache.at < 3000) return;
  try { winCache = { key: m.target.process, info: await invoke('target_info', { process: m.target.process, title: m.target.title || '' }), at: Date.now() }; }
  catch { winCache = { key: m.target.process, info: null, at: Date.now() }; }
  if (view === 'seq') renderFacts(m);
}
function syncTarget() {
  const m = cur(); if (!m) return;
  invoke('set_active_target', { process: m.target.process || '', title: m.target.title || '' }).catch(() => {});
  refreshWin();
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const a = b.dataset.act;
  if (a === 'run') runMacro();
  if (a === 'dry') runMacro({ dry: true });
  if (a === 'stepmode') runMacro({ stepMode: true });
  if (a === 'stop') invoke('run_stop');
  if (a === 'pause') invoke('run_pause');
  if (a === 'resume') invoke('run_resume');
  if (a === 'step') invoke('run_step');
  if (a === 'capture') capture();
  if (a === 'save') saveNow();
  if (a === 'saveas') saveAs();
});
function capture() {
  if (RUN.state !== 'idle') return toast('Stop the running macro before capturing a step.');
  const m = cur();
  if (!m.target.process && APPINFO.os === 'windows') {
    return toast(`Switch to the app you want to automate and press ${PREFS.hotkeys.capture || 'F8'} over it.`);
  }
  invoke('begin_capture');
}

$('#ledger').addEventListener('click', e => {
  const li = e.target.closest('li[data-i]'); if (!li) return;
  const i = +li.dataset.i, b = e.target.closest('button[data-a]');
  if (!b) { sel = i; $$('#ledger li[data-i]').forEach(x => x.classList.toggle('sel', +x.dataset.i === i)); return; }
  stepAction(b.dataset.a, i);
});
$('#ledger').addEventListener('dblclick', e => { const li = e.target.closest('li[data-i]'); if (li && !e.target.closest('button')) stepAction('edit', +li.dataset.i); });
$('#ledger').addEventListener('keydown', e => {
  const li = e.target.closest('li[data-i]'); if (!li || e.target !== li) return;
  const i = +li.dataset.i, m = cur();
  if (e.key === 'Enter') { e.preventDefault(); stepAction('edit', i); }
  if (e.key === 'Delete') { e.preventDefault(); stepAction('del', i); }
  if (e.key === ' ') { e.preventDefault(); stepAction('toggle', i); }
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    const j = e.key === 'ArrowUp' ? i - 1 : i + 1;
    if (j < 0 || j >= m.steps.length) return;
    mut(() => { const [s] = m.steps.splice(i, 1); m.steps.splice(j, 0, s); sel = j; });
    $(`#ledger li[data-i="${j}"]`)?.focus();
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    $(`#ledger li[data-i="${e.key === 'ArrowUp' ? i - 1 : i + 1}"]`)?.focus();
  }
});
$('#ledger').addEventListener('focusin', e => { const li = e.target.closest('li[data-i]'); if (li) { sel = +li.dataset.i; $$('#ledger li[data-i]').forEach(x => x.classList.toggle('sel', x === li)); } });
let dragFrom = -1;
$('#ledger').addEventListener('dragstart', e => { const li = e.target.closest('li[data-i]'); if (!li) return; dragFrom = +li.dataset.i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(dragFrom)); });
$('#ledger').addEventListener('dragover', e => {
  const li = e.target.closest('li[data-i]'); if (!li || dragFrom < 0) return;
  e.preventDefault();
  const r = li.getBoundingClientRect(), below = e.clientY > r.top + r.height / 2;
  $$('#ledger li').forEach(x => x.classList.remove('drop-above', 'drop-below'));
  li.classList.add(below ? 'drop-below' : 'drop-above');
});
$('#ledger').addEventListener('dragend', () => { dragFrom = -1; $$('#ledger li').forEach(x => x.classList.remove('drop-above', 'drop-below')); });
$('#ledger').addEventListener('drop', e => {
  const li = e.target.closest('li[data-i]'); if (!li || dragFrom < 0) return;
  e.preventDefault();
  const r = li.getBoundingClientRect(), below = e.clientY > r.top + r.height / 2;
  let to = +li.dataset.i + (below ? 1 : 0);
  const from = dragFrom; dragFrom = -1;
  if (to > from) to--;
  if (to === from) return renderSeq();
  const m = cur();
  mut(() => { const [s] = m.steps.splice(from, 1); m.steps.splice(to, 0, s); sel = to; }, `Moved to position ${to + 1}`);
});

function stepAction(a, i) {
  const m = cur(), s = m.steps[i]; if (!s) return;
  if (a === 'edit') { ins = i; sel = i; go('ins'); }
  if (a === 'here') runMacro({ start: i });
  if (a === 'dup') mut(() => { const c = clone(s); c.id = uid('s'); c.name = s.name + ' copy'; m.steps.splice(i + 1, 0, c); sel = i + 1; }, 'Step duplicated');
  if (a === 'toggle') mut(() => { s.enabled = !s.enabled; }, s.enabled ? `Step ${i + 1} disabled` : `Step ${i + 1} enabled`);
  if (a === 'del') {
    if (isRunningHere()) return toast('Stop the run before deleting steps');
    mut(() => { m.steps.splice(i, 1); sel = Math.min(sel, m.steps.length - 1); if (ins >= m.steps.length) ins = m.steps.length - 1; }, 'Step deleted, Ctrl+Z to undo');
  }
}

$('#mt').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } if (e.key === 'Escape') { e.target.textContent = cur().name; e.target.blur(); } });
$('#mt').addEventListener('blur', e => {
  const v = e.target.textContent.replace(/\s+/g, ' ').trim();
  if (v && v !== cur().name) mut(() => { cur().name = v.slice(0, 80); }, 'Renamed');
  else e.target.textContent = cur().name;
});

/* ---------------------------------------------------------------- running */
async function runMacro(o = {}) {
  const m = cur();
  if (RUN.state !== 'idle') {
    if (RUN.macro_id !== m.id) toast(`${RUN.macro_name} is running. Stop it before starting another macro.`);
    return;
  }
  if (!m.steps.some(s => s.enabled)) return toast('Add or enable a step first');
  if (!o.dry && !o.checked) {
    const issues = await validate(m);
    if (issues.length) {
      if (o.fromHotkey) toast(`${pl(issues.length, 'advisory')} for ${m.name}. Open the Sequence screen to review them.`);
      else return showIssues(m, issues, o);
    }
  }
  try {
    await invoke('run_start', { req: { macro: m, start: o.start || 0, only: !!o.only, dry: !!o.dry, step_mode: !!o.stepMode } });
    if (!o.dry) { m.last_run = Date.now(); persist(); }
    if (!m.target.process && !o.fromHotkey && !o.dry) {
      try { await T.window.getCurrentWindow().minimize(); } catch { /* not fatal */ }
    }
  } catch (e) { toast(String(e)); }
}

/* Pre-flight validator. Each issue may carry a one-click fix. */
async function validate(m) {
  const out = [];
  const on = m.steps.map((s, i) => [s, i]).filter(([s]) => s.enabled);
  const loops = !(m.settings.loop_mode === 'count' && m.settings.loop_count <= 1);
  const fast = on.filter(([s]) => num(s.delay.mean) < 10 || (s.delay.dist === 'fixed' && loops) || (s.delay.dist !== 'fixed' && num(s.delay.spread) <= 0 && loops));
  if (fast.length) out.push({
    title: 'Timing looks robotic', text: `${listSteps(fast)} ${fast.length === 1 ? 'fires' : 'fire'} with the same delay every time${fast.some(([s]) => num(s.delay.mean) < 10) ? ', some under 10 ms apart' : ''}. Many games flag that pattern.`,
    fix: 'Add natural delays, ±60 ms', apply: () => fast.forEach(([s]) => { s.delay.dist = 'gaussian'; s.delay.mean = Math.max(num(s.delay.mean), 140); s.delay.spread = Math.max(num(s.delay.spread), 60); })
  });
  const pts = loops ? on.filter(([s]) => s.zone?.shape === 'point' && ['click', 'hold', 'drag'].includes(s.action.kind)) : [];
  if (pts.length) out.push({
    title: 'Clicks land on the exact same pixel', text: `${listSteps(pts)} ${pts.length === 1 ? 'has' : 'have'} zero position spread, so every pass hits one pixel.`,
    fix: 'Spread over a 4 px circle', apply: () => pts.forEach(([s]) => { s.zone = Object.assign(s.zone, { shape: 'circle', r: 4, dist: 'gaussian', pad: 0 }); })
  });
  if (m.authored) {
    const out_ = on.filter(([s]) => s.zone && !zoneInside(s.zone, m.authored));
    if (out_.length) out.push({
      title: 'Zones outside the window', text: `${listSteps(out_)} ${out_.length === 1 ? 'reaches' : 'reach'} past the ${m.authored.w}×${m.authored.h} window the macro was captured in.`,
      fix: 'Move them inside', apply: () => out_.forEach(([s]) => clampZone(s.zone, m.authored))
    });
  }
  const keys = Object.entries(PREFS.hotkeys).filter(([, v]) => v);
  const clash = on.filter(([s]) => s.action.kind === 'key' && keys.some(([, v]) => v.toLowerCase() === (s.action.keys || '').toLowerCase()));
  if (clash.length) out.push({
    title: 'A step presses one of your hotkeys', text: `${listSteps(clash)} ${clash.length === 1 ? 'presses' : 'press'} a key that AetherMacro also listens for, which would ${clash.some(([s]) => /^(esc|f12)$/i.test(s.action.keys)) ? 'stop the run' : 'trigger it'}.`,
    fixLabel: 'Open hotkeys', go: 'key'
  });
  const noTo = on.filter(([s]) => s.guard?.samples?.length && !(num(s.guard.timeout_ms) > 0));
  if (noTo.length) out.push({
    title: 'Guard with no timeout', text: `${listSteps(noTo)} could wait forever for a colour that never shows.`,
    fix: 'Give up after 2.5 s, retry 3 times', apply: () => noTo.forEach(([s]) => Object.assign(s.guard, { timeout_ms: 2500, on_timeout: 'retry', retries: 3 }))
  });
  if (m.target.process) {
    let w = null;
    try { w = await invoke('target_info', { process: m.target.process, title: m.target.title || '' }); } catch { /* treat as not open */ }
    winCache = { key: m.target.process, info: w, at: Date.now() };
    if (!w) out.push({ title: `${m.target.process} is not open`, text: 'The run will wait for it to open, then start.', fixLabel: 'Choose another window', go: 'set' });
    else if (m.authored && (Math.abs(w.w - m.authored.w) > 1 || Math.abs(w.h - m.authored.h) > 1)) {
      const ratio = Math.abs(w.w / w.h - m.authored.w / m.authored.h) > 0.02;
      if (m.target.on_resize !== 'scale' || ratio) out.push({
        title: 'Window size changed', text: `The window is ${w.w}×${w.h} now but the steps were captured at ${m.authored.w}×${m.authored.h}.${ratio ? ' The shape changed too, so zones may stretch.' : ''}`,
        fix: m.target.on_resize !== 'scale' ? 'Scale zones to fit' : null, apply: m.target.on_resize !== 'scale' ? () => { m.target.on_resize = 'scale'; } : null
      });
    }
  }
  return out;
}
function listSteps(arr) {
  const n = arr.map(([, i]) => i + 1);
  if (n.length === 1) return `Step ${n[0]}`;
  if (n.length > 4) return `${n.length} steps`;
  return 'Steps ' + n.slice(0, -1).join(', ') + ' and ' + n[n.length - 1];
}
function zoneBounds(z) {
  if (z.shape === 'circle') return [z.x - z.r, z.y - z.r, z.x + z.r, z.y + z.r];
  if (z.shape === 'rect') return [z.x, z.y, z.x + z.w, z.y + z.h];
  if (z.shape === 'poly' && z.points.length) { const xs = z.points.map(p => p[0]), ys = z.points.map(p => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; }
  return [z.x, z.y, z.x, z.y];
}
function zoneInside(z, a) { const b = zoneBounds(z); return b[0] >= -0.5 && b[1] >= -0.5 && b[2] <= a.w + 0.5 && b[3] <= a.h + 0.5; }
function clampZone(z, a) {
  const b = zoneBounds(z);
  const dx = b[0] < 0 ? -b[0] : b[2] > a.w ? a.w - b[2] : 0, dy = b[1] < 0 ? -b[1] : b[3] > a.h ? a.h - b[3] : 0;
  z.x += dx; z.y += dy;
  if (z.points) z.points = z.points.map(p => [p[0] + dx, p[1] + dy]);
  if (z.shape === 'rect') { z.x = Math.max(0, z.x); z.y = Math.max(0, z.y); z.w = Math.min(z.w, a.w - z.x); z.h = Math.min(z.h, a.h - z.y); }
}
function showIssues(m, issues, o) {
  const dlg = $('#dlg');
  dlg.className = 'dlg adv';
  const allFix = issues.filter(i => i.apply);
  dlg.innerHTML = `<h2>${issues.length === 1 ? esc(issues[0].title) : 'Check these before running'}</h2>
    <p>${issues.length === 1 ? esc(issues[0].text) : `${pl(issues.length, 'thing')} in ${esc(m.name)} could cause trouble. Fix them in one click or run as is.`}</p>
    ${issues.length > 1 ? `<ul class="issues">${issues.map((x, i) => `<li><div><b>${esc(x.title)}</b><span>${esc(x.text)}</span></div>${x.apply ? `<button class="btn sm" data-fix="${i}">${esc(x.fix)}</button>` : x.go ? `<button class="btn sm" data-goto="${x.go}">${esc(x.fixLabel)}</button>` : ''}</li>`).join('')}</ul>` : ''}
    <div class="row end"><button class="btn" id="d-anyway">Run as is</button>${allFix.length ? `<button class="btn pri" id="d-fixrun">${issues.length === 1 ? esc(issues[0].fix) : 'Fix all and run'}</button>` : issues[0].go && issues.length === 1 ? `<button class="btn pri" data-goto="${issues[0].go}">${esc(issues[0].fixLabel)}</button>` : ''}</div>`;
  openDlg();
  dlg.onclick = e => {
    const f = e.target.closest('[data-fix]'), g = e.target.closest('[data-goto]');
    if (f) { const x = issues[+f.dataset.fix]; mut(x.apply, 'Fixed: ' + x.title.toLowerCase()); f.textContent = 'Fixed'; f.disabled = true; x.apply = null; }
    if (g) { closeDlg(); go(g.dataset.goto); }
    if (e.target.id === 'd-anyway') { closeDlg(); runMacro(Object.assign({}, o, { checked: true })); }
    if (e.target.id === 'd-fixrun') { const fx = issues.filter(i => i.apply); if (fx.length) mut(() => fx.forEach(i => i.apply()), 'Fixed ' + pl(fx.length, 'issue')); closeDlg(); runMacro(Object.assign({}, o, { checked: true })); }
  };
}
function openDlg() { $('#scrim').classList.add('on'); setTimeout(() => $('#dlg .btn.pri, #dlg .btn')?.focus(), 30); }
function closeDlg() { $('#scrim').classList.remove('on'); $('#dlg').onclick = null; }
$('#scrim').addEventListener('mousedown', e => { if (e.target.id === 'scrim') closeDlg(); });

function showStopped(s) {
  const dlg = $('#dlg');
  dlg.className = 'dlg dng';
  const why = { user: 'You pressed the emergency stop key.', corner: 'The pointer hit a screen corner, which is the failsafe.', guard: s.message }[s.reason] || s.message;
  const list = a => a.length ? a.join(' and ') + ' released' : 'Nothing was held';
  dlg.innerHTML = `<h2>Macro stopped</h2><p>${esc(why)} Nothing is still held down.</p>
    <dl class="tele"><dt>Abort latency</dt><dd class="m">${s.latency_ms != null ? s.latency_ms.toFixed(1) + ' ms' : 'n/a'}</dd>
    <dt>Mouse buttons</dt><dd>${esc(list(s.released_buttons))}</dd><dt>Keys</dt><dd>${esc(list(s.released_keys))}</dd>
    <dt>Stopped at</dt><dd>Pass ${s.pass}, step ${s.step}</dd><dt>Ran for</dt><dd class="m">${clock(s.elapsed_ms)}</dd></dl>
    <div class="row end"><button class="btn" id="d-log">Open run log</button><button class="btn pri" id="d-back">Back to sequence</button></div>`;
  openDlg();
  dlg.onclick = e => { if (e.target.id === 'd-log') { closeDlg(); go('log'); } if (e.target.id === 'd-back') { closeDlg(); go('seq'); } };
}

/* ---------------------------------------------------------------- inspector */
const DIST = [['fixed', 'Fixed'], ['uniform', 'Uniform'], ['gaussian', 'Gaussian']];
const SHAPES = [['none', 'None'], ['point', 'Point'], ['circle', 'Circle'], ['rect', 'Rectangle'], ['poly', 'Polygon']];
function seg(name, opts, val) { return `<div class="seg" data-seg="${name}" role="group">${opts.map(([v, l]) => `<button type="button" data-v="${v}" class="${v === val ? 'on' : ''}" aria-pressed="${v === val}">${l}</button>`).join('')}</div>`; }
function nfield(id, label, val, attrs = '') { return `<div class="field"><label for="${id}">${label}</label><input type="number" id="${id}" value="${round(num(val), 2)}" ${attrs}></div>`; }

function renderIns() {
  const m = cur(), body = $('#ins-body');
  if (ins < 0 || !m.steps[ins]) {
    if (sel >= 0 && m.steps[sel]) ins = sel;
    else if (m.steps.length) ins = 0;
    else { $('#ins-title').textContent = 'Step inspector'; body.innerHTML = `<p class="empty-note">This macro has no steps yet. Capture one first, then edit it here.</p><button class="btn pri" data-act="capture">Capture step</button>`; return; }
  }
  const s = m.steps[ins], a = s.action, z = s.zone, g = s.guard;
  $('#ins-title').textContent = `Step ${ins + 1}`;
  $('#ins-prev').disabled = ins === 0; $('#ins-next').disabled = ins >= m.steps.length - 1;
  const aid = actionId(a);
  const actOpts = ACTIONS.filter(([v]) => v !== 'path' || aid === 'path').map(([v, l]) => `<option value="${v}" ${v === aid ? 'selected' : ''}>${l}</option>`).join('');
  const holdLabel = a.kind === 'text' ? 'Pause between characters' : a.kind === 'hold' ? 'Hold for' : 'Press length';
  const showHold = ['click', 'hold', 'key', 'text'].includes(a.kind);
  let extra = '';
  if (a.kind === 'hold') extra = `<div class="field"><label for="i-btn">Button</label><select id="i-btn">${['left', 'right', 'middle', 'x1', 'x2'].map(b => `<option ${b === a.button ? 'selected' : ''} value="${b}">${cap(b)}</option>`).join('')}</select></div>`;
  if (a.kind === 'key') extra = `<div class="field"><label for="i-keys">Keys <span class="hint">e.g. E, Space, Ctrl+Shift+S</span></label><div class="inline"><input type="text" id="i-keys" value="${esc(a.keys)}" spellcheck="false"><button class="btn" id="i-reckeys" type="button">Press keys</button></div></div>`;
  if (a.kind === 'text') extra = `<div class="field"><label for="i-text">Text to type</label><textarea id="i-text" spellcheck="false">${esc(a.text)}</textarea></div>`;
  if (a.kind === 'scroll') extra = `<div class="field"><label>Direction and amount</label><div class="inline"><input type="number" id="i-amount" value="${a.amount}" aria-label="Ticks, negative scrolls down"><label class="check"><input type="checkbox" id="i-horiz" ${a.horizontal ? 'checked' : ''}> Horizontal</label></div><span class="hint">Positive scrolls up or right, negative scrolls down or left.</span></div>`;
  if (a.kind === 'drag') {
    const t = a.to || { shape: 'point', x: 0, y: 0 };
    extra = `<div class="field"><span class="lab">Drop at</span><div class="inline"><input type="number" id="i-tox" value="${round(t.x)}" aria-label="Drop x"><input type="number" id="i-toy" value="${round(t.y)}" aria-label="Drop y"><input type="number" id="i-tor" value="${round(t.r || 0)}" aria-label="Drop radius"></div><span class="hint">x, y and a spread radius in window pixels.</span></div>`;
  }
  const shape = z ? z.shape : 'none';
  let zf = '';
  if (z) {
    zf += `<div class="inline">${nfield('z-x', z.shape === 'rect' ? 'Left' : 'Centre x', z.x)}${nfield('z-y', z.shape === 'rect' ? 'Top' : 'Centre y', z.y)}`;
    if (z.shape === 'rect') zf += nfield('z-w', 'Width', z.w, 'min="1"') + nfield('z-h', 'Height', z.h, 'min="1"');
    if (z.shape === 'circle') zf += nfield('z-r', 'Radius', z.r, 'min="1"');
    zf += `</div>`;
    if (z.shape === 'poly') zf += `<p class="sub" style="margin:-6px 0 14px">${pl(z.points.length, 'vertex').replace('vertexs', 'vertices')}. Redraw it over the app to change the outline; x and y move the whole shape.</p>`;
    if (z.shape !== 'point') zf += `<div class="field"><span class="lab">Distribution</span>${seg('zdist', [['gaussian', 'Gaussian'], ['uniform', 'Uniform']], z.dist)}</div>
      <div class="inline">${nfield('z-pad', 'Edge margin, px', z.pad, 'min="0"')}${nfield('z-anti', 'Anti-repeat, px', z.anti_repeat, 'min="0"')}</div>`;
  }
  const guardOn = !!(g && g.samples?.length);
  const gf = guardOn ? `<div class="field"><label>Expected colour <span class="m" id="g-hexv">${esc(g.hex)}</span></label>
      <div class="inline"><input type="text" id="g-hex" value="${esc(g.hex)}" spellcheck="false" style="font-family:var(--m)"><button class="btn" id="g-pick" type="button">Pick from the app</button></div>
      <div class="sw" style="margin-top:6px"><i id="g-sw1" style="background:${esc(g.hex)}"></i><i id="g-sw2"></i></div></div>
    <div class="inline">${nfield('g-x', 'Sample x', g.samples[0][0])}${nfield('g-y', 'Sample y', g.samples[0][1])}</div>
    <label class="check" style="margin:-8px 0 14px"><input type="checkbox" id="g-multi" ${g.samples.length >= 3 ? 'checked' : ''}> Sample 3 points, majority wins</label>
    <div class="field"><label for="g-tol">Tolerance <span class="m" id="g-tolv">ΔE ${round(g.tolerance)}</span></label><input type="range" id="g-tol" min="1" max="60" value="${g.tolerance}"></div>
    <div class="inline">${nfield('g-to', 'Timeout, ms', g.timeout_ms, 'min="0" step="100"')}<div class="field"><label for="g-on">If it times out</label><select id="g-on">${[['retry', 'Retry, then pause'], ['skip', 'Skip the step'], ['pause', 'Pause the run'], ['halt', 'Play alert and stop']].map(([v, l]) => `<option value="${v}" ${v === g.on_timeout ? 'selected' : ''}>${l}</option>`).join('')}</select></div>${g.on_timeout === 'retry' ? nfield('g-ret', 'Retries', g.retries, 'min="0" max="20"') : ''}</div>` : '';

  body.innerHTML = `<div class="panel two">
    <div>
      <div class="field"><label for="i-name">Name</label><input type="text" id="i-name" value="${esc(s.name)}"></div>
      <div class="field"><label for="i-act">Action</label><select id="i-act">${actOpts}</select></div>
      ${extra}
      ${showHold ? `<div class="field"><span class="lab">${holdLabel} <span class="m" id="i-holdv">${round(s.hold.min)} to ${round(s.hold.max)} ms</span></span><div class="inline"><input type="number" id="i-hmin" value="${round(s.hold.min)}" min="0" aria-label="Minimum ms"><input type="number" id="i-hmax" value="${round(s.hold.max)}" min="0" aria-label="Maximum ms"></div></div>` : ''}
      <hr class="rule">
      <h3 class="section-title">Delay after the step</h3>
      <div class="field">${seg('ddist', DIST, s.delay.dist)}</div>
      <div class="field"><label for="d-mean">Mean <span class="m" id="d-meanv">${round(s.delay.mean)} ms</span></label><input type="range" id="d-mean" min="0" max="5000" step="10" value="${s.delay.mean}"></div>
      ${s.delay.dist !== 'fixed' ? `<div class="field"><label for="d-spread">${s.delay.dist === 'gaussian' ? 'Spread, σ' : 'Spread, ±'} <span class="m" id="d-spreadv">${round(s.delay.spread)} ms</span></label><input type="range" id="d-spread" min="0" max="1000" step="5" value="${s.delay.spread}"></div>` : ''}
      <hr class="rule">
      <h3 class="section-title">Zone</h3>
      <div class="field">${seg('shape', SHAPES, shape)}</div>
      ${zf}
      ${a.kind !== 'wait' ? `<button class="btn" id="z-redraw" type="button" style="margin-bottom:18px">Redraw over the app</button>` : ''}
      <hr class="rule">
      <h3 class="section-title">Visual guard</h3>
      <label class="check" style="margin-bottom:14px"><input type="checkbox" id="g-on-off" ${guardOn ? 'checked' : ''}> Wait for a colour before acting</label>
      ${gf}
    </div>
    <div class="preview">
      <div class="zonebox"><svg viewBox="0 0 400 240" id="zprev" aria-label="Zone preview"></svg></div>
      <div class="row" style="margin:10px 0 24px"><span class="sub" id="zinfo"></span><button class="btn sm" id="z-test" type="button" ${z && z.shape !== 'point' ? '' : 'disabled'}>Test hits</button></div>
      <svg viewBox="0 0 400 170" id="dprev" aria-label="Delay distribution"><path id="d-area" fill="#d9775726"/><path id="d-curve" fill="none" stroke="#d97757" stroke-width="2"/><path d="M0 140H400" stroke="rgba(250,249,245,.22)"/><g id="d-clamp" stroke="#6f6d66" stroke-dasharray="3 4"></g><text id="d-tmin" x="8" y="162" fill="#a8a69c" font-size="11" font-family="JetBrains Mono"></text><text id="d-tmax" x="392" y="162" fill="#a8a69c" font-size="11" text-anchor="end" font-family="JetBrains Mono"></text></svg>
      <p class="sub" id="d-note"></p>
      <div class="row end" style="margin-top:26px"><button class="btn" id="i-test" type="button">Run only this step</button></div>
    </div></div>`;
  drawZonePreview(); drawDist();
}
function insStep() { return cur().steps[ins]; }
/** Live-edit binding: input applies and saves, change commits one undo entry. */
function liveEdit(e) {
  const el = e.target;
  if (!el.id || !$('#ins-body').contains(el)) return;
  const s = insStep(); if (!s) return;
  if (e.type === 'focusin') { el._pre = snap(); return; }
  const v = el.type === 'checkbox' ? el.checked : el.value;
  const n = num(v);
  const z = s.zone, a = s.action;
  let structural = false;
  switch (el.id) {
    case 'i-name': s.name = v.slice(0, 80) || 'Step'; break;
    case 'i-act': if (e.type !== 'change') return; setAction(s, v); structural = true; break;
    case 'i-btn': a.button = v; break;
    case 'i-keys': a.keys = v.trim(); break;
    case 'i-text': a.text = v; break;
    case 'i-amount': a.amount = Math.round(n); break;
    case 'i-horiz': a.horizontal = v; break;
    case 'i-tox': a.to.x = n; break;
    case 'i-toy': a.to.y = n; break;
    case 'i-tor': a.to.r = Math.max(0, n); a.to.shape = a.to.r > 0 ? 'circle' : 'point'; break;
    case 'i-hmin': s.hold.min = Math.max(0, n); break;
    case 'i-hmax': s.hold.max = Math.max(0, n); break;
    case 'd-mean': s.delay.mean = Math.max(0, n); break;
    case 'd-spread': s.delay.spread = Math.max(0, n); break;
    case 'z-x': { const dx = n - z.x; z.x = n; if (z.points) z.points = z.points.map(p => [p[0] + dx, p[1]]); break; }
    case 'z-y': { const dy = n - z.y; z.y = n; if (z.points) z.points = z.points.map(p => [p[0], p[1] + dy]); break; }
    case 'z-w': z.w = Math.max(1, n); break;
    case 'z-h': z.h = Math.max(1, n); break;
    case 'z-r': z.r = Math.max(1, n); break;
    case 'z-pad': z.pad = Math.max(0, n); break;
    case 'z-anti': z.anti_repeat = Math.max(0, n); break;
    case 'g-on-off': if (e.type !== 'change') return; s.guard = v ? guardFor(s) : null; structural = true; break;
    case 'g-hex': if (/^#?[0-9a-f]{6}$/i.test(v.trim())) s.guard.hex = '#' + v.trim().replace('#', '').toUpperCase(); break;
    case 'g-x': s.guard.samples = samplesAt(n, s.guard.samples[0][1], s.guard.samples.length >= 3); break;
    case 'g-y': s.guard.samples = samplesAt(s.guard.samples[0][0], n, s.guard.samples.length >= 3); break;
    case 'g-multi': s.guard.samples = samplesAt(s.guard.samples[0][0], s.guard.samples[0][1], v); break;
    case 'g-tol': s.guard.tolerance = n; break;
    case 'g-to': s.guard.timeout_ms = Math.max(0, n); break;
    case 'g-on': if (e.type !== 'change') return; s.guard.on_timeout = v; structural = true; break;
    case 'g-ret': s.guard.retries = Math.max(0, Math.round(n)); break;
    default: return;
  }
  cur().updated = Date.now();
  persist();
  if (e.type === 'change' && el._pre) { hist.push(el._pre); if (hist.length > 50) hist.shift(); redo = []; el._pre = snap(); }
  if (structural) { if (!el._pre) { /* select without focus */ } renderIns(); return; }
  if (el.id === 'i-hmin' || el.id === 'i-hmax') $('#i-holdv').textContent = `${round(s.hold.min)} to ${round(s.hold.max)} ms`;
  if (el.id === 'd-mean') $('#d-meanv').textContent = round(s.delay.mean) + ' ms';
  if (el.id === 'd-spread') $('#d-spreadv').textContent = round(s.delay.spread) + ' ms';
  if (el.id === 'g-tol') $('#g-tolv').textContent = 'ΔE ' + round(n);
  if (el.id === 'g-hex' && s.guard) { $('#g-hexv').textContent = s.guard.hex; $('#g-sw1').style.background = s.guard.hex; }
  if (s.guard) $('#g-sw2') && ($('#g-sw2').style.background = `color-mix(in srgb, ${s.guard.hex} ${Math.max(0, 100 - s.guard.tolerance * 1.4)}%, #fff)`);
  drawZonePreview(); drawDist();
}
['focusin', 'input', 'change'].forEach(t => $('#ins-body').addEventListener(t, liveEdit));
function samplesAt(x, y, multi) { return multi ? [[x, y], [x - 2, y - 2], [x + 2, y + 2]] : [[x, y]]; }
function guardFor(s) {
  const z = s.zone, b = z ? zoneBounds(z) : [0, 0, 0, 0];
  return { samples: [[round((b[0] + b[2]) / 2), round((b[1] + b[3]) / 2)]], hex: '#4A90E2', tolerance: 12, timeout_ms: 2500, on_timeout: 'retry', retries: 3 };
}
function setAction(s, v) {
  const keepBtn = ['left', 'right', 'middle'].includes(v) ? v : 'left';
  const a = {
    left: { kind: 'click', button: 'left', count: 1 }, right: { kind: 'click', button: 'right', count: 1 }, middle: { kind: 'click', button: 'middle', count: 1 },
    double: { kind: 'click', button: 'left', count: 2 }, hold: { kind: 'hold', button: keepBtn }, drag: { kind: 'drag', button: 'left', to: { shape: 'point', x: (s.zone?.x || 0) + 80, y: s.zone?.y || 0, r: 0, w: 0, h: 0, points: [], dist: 'gaussian', pad: 0, anti_repeat: 0 } },
    scroll: { kind: 'scroll', amount: -3, horizontal: false }, key: { kind: 'key', keys: 'E' }, text: { kind: 'text', text: '' },
    move: { kind: 'move' }, wait: { kind: 'wait' }, path: s.action
  }[v];
  if (!a) return;
  s.action = a;
  if (v === 'hold' && avg(s.hold) < 300) s.hold = { min: 900, max: 1300 };
  if (v === 'text' && avg(s.hold) > 200) s.hold = { min: 40, max: 110 };
  if (['left', 'right', 'middle', 'double', 'key'].includes(v) && avg(s.hold) > 400) s.hold = { min: 45, max: 80 };
}
$('#ins-body').addEventListener('click', async e => {
  const s = insStep(); if (!s) return;
  const sg = e.target.closest('[data-seg] button');
  if (sg) {
    const which = sg.parentElement.dataset.seg, v = sg.dataset.v;
    mut(() => {
      if (which === 'ddist') s.delay.dist = v;
      if (which === 'zdist') s.zone.dist = v;
      if (which === 'shape') s.zone = reshape(s.zone, v);
    });
    return;
  }
  const id = e.target.closest('button')?.id;
  if (id === 'z-test') testHits();
  if (id === 'z-redraw') { replaceZoneFor = s.id; capture(); }
  if (id === 'i-test') runMacro({ start: ins, only: true });
  if (id === 'i-reckeys') { const b = e.target.closest('button'); b.textContent = 'Press now'; b.classList.add('pri'); listening = { kind: 'step', done: k => { mut(() => { s.action.keys = k; }, 'Keys set to ' + k); } }; }
  if (id === 'g-pick') {
    const m = cur(), [x, y] = s.guard.samples[0];
    if (!m.target.process && APPINFO.os === 'windows') return toast('Pick a target window in Macro settings first.');
    try {
      const hex = await invoke('read_client_pixel', { process: m.target.process, title: m.target.title || '', x, y, aw: m.authored?.w || 0, ah: m.authored?.h || 0 });
      if (!hex) return toast('Could not read the screen there. Is the app open and visible?');
      mut(() => { s.guard.hex = hex; }, 'Colour picked: ' + hex);
    } catch (err) { toast(String(err)); }
  }
});
function reshape(z, v) {
  if (v === 'none') return null;
  const b = z ? zoneBounds(z) : [100, 100, 100, 100], cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, w = Math.max(20, b[2] - b[0]), h = Math.max(20, b[3] - b[1]);
  const base = { shape: v, x: cx, y: cy, w: 0, h: 0, r: 0, points: [], dist: z?.dist || 'gaussian', pad: z?.pad ?? 2, anti_repeat: z?.anti_repeat ?? 0 };
  if (v === 'rect') Object.assign(base, { x: cx - w / 2, y: cy - h / 2, w, h });
  if (v === 'circle') base.r = Math.max(6, Math.min(w, h) / 2);
  if (v === 'poly') base.points = z?.shape === 'poly' ? z.points : [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]];
  return base;
}
$('#ins-prev').onclick = () => { if (ins > 0) { ins--; sel = ins; renderIns(); } };
$('#ins-next').onclick = () => { if (ins < cur().steps.length - 1) { ins++; sel = ins; renderIns(); } };
$('#ins-done').onclick = () => go('seq');

/* zone preview + sampler (mirror of the Rust sampler) */
const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
const inPoly = (p, x, y) => { let r = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) if ((p[i][1] > y) !== (p[j][1] > y) && x < (p[j][0] - p[i][0]) * (y - p[i][1]) / (p[j][1] - p[i][1]) + p[i][0]) r = !r; return r; };
const segDist = (px, py, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy; const t = l ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l)) : 0; return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy); };
function insideZone(z, x, y) {
  const pad = Math.max(0, z.pad || 0);
  if (z.shape === 'circle') return Math.hypot(x - z.x, y - z.y) <= Math.max(0, z.r - pad);
  if (z.shape === 'rect') return x >= z.x + pad && x <= z.x + z.w - pad && y >= z.y + pad && y <= z.y + z.h - pad;
  if (z.shape === 'poly') return inPoly(z.points, x, y) && Math.min(...z.points.map((p, i) => segDist(x, y, p, z.points[(i + 1) % z.points.length]))) >= pad;
  return true;
}
function sampleZone(z) {
  if (z.shape === 'point') return [z.x, z.y];
  const b = zoneBounds(z), w = Math.max(1, b[2] - b[0]), h = Math.max(1, b[3] - b[1]);
  let c = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  if (z.shape === 'poly') c = [z.points.reduce((a, p) => a + p[0], 0) / z.points.length, z.points.reduce((a, p) => a + p[1], 0) / z.points.length];
  if (z.shape === 'circle') c = [z.x, z.y];
  for (let n = 0; n < 400; n++) {
    let x, y;
    if (z.dist !== 'uniform') { x = c[0] + gauss() * w / 5; y = c[1] + gauss() * h / 5; }
    else if (z.shape === 'circle') { const r = z.r * Math.sqrt(Math.random()), a = Math.random() * 2 * Math.PI; x = z.x + r * Math.cos(a); y = z.y + r * Math.sin(a); }
    else { x = b[0] + Math.random() * w; y = b[1] + Math.random() * h; }
    if (insideZone(z, x, y)) return [x, y];
  }
  return c;
}
let zview = null;
function drawZonePreview() {
  const svg = $('#zprev'); if (!svg) return;
  const s = insStep(), z = s?.zone, info = $('#zinfo');
  if (!z) { svg.innerHTML = `<text x="200" y="124" fill="#6f6d66" font-size="13" text-anchor="middle">${s?.action.kind === 'path' ? 'Recorded path, replayed as captured' : 'No zone. The pointer stays where it is.'}</text>`; info.textContent = ''; zview = null; if (s?.action.kind === 'path') drawPathPreview(svg, s.action.points); return; }
  const b = zoneBounds(z), pad = Math.max(24, Math.max(b[2] - b[0], b[3] - b[1]) * 0.35);
  let [x0, y0, x1, y1] = [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
  const k = Math.min(400 / (x1 - x0), 240 / (y1 - y0), 6);
  const ox = 200 - k * (x0 + x1) / 2, oy = 120 - k * (y0 + y1) / 2;
  zview = { k, ox, oy };
  const P = (x, y) => [ox + x * k, oy + y * k];
  const c = COLOR[z.shape];
  let shp = '';
  if (z.shape === 'rect') { const [a, bb] = P(z.x, z.y); shp = `<rect x="${a}" y="${bb}" width="${z.w * k}" height="${z.h * k}" rx="3"/>`; }
  if (z.shape === 'circle') { const [a, bb] = P(z.x, z.y); shp = `<circle cx="${a}" cy="${bb}" r="${z.r * k}"/>`; }
  if (z.shape === 'poly') shp = `<polygon points="${z.points.map(p => P(p[0], p[1]).join(',')).join(' ')}"/>`;
  if (z.shape === 'point') { const [a, bb] = P(z.x, z.y); shp = `<path d="M${a - 14} ${bb}h28M${a} ${bb - 14}v28"/>`; }
  let grid = '';
  for (let gx = 0; gx <= 400; gx += 40) grid += `M${gx} 0V240`;
  for (let gy = 0; gy <= 240; gy += 40) grid += `M0 ${gy}H400`;
  svg.innerHTML = `<path d="${grid}" stroke="rgba(250,249,245,.05)"/><g fill="${c}" fill-opacity=".14" stroke="${c}" stroke-width="1.8" stroke-dasharray="${z.shape === 'point' ? 0 : '6 5'}">${shp}</g><g id="zhits"></g>`;
  info.textContent = `${zoneLabel(z)}${z.shape !== 'point' ? ', ' + (z.dist === 'uniform' ? 'uniform' : 'gaussian') : ''}`;
}
function drawPathPreview(svg, pts) {
  if (!pts?.length) return;
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const k = Math.min(360 / Math.max(1, x1 - x0), 200 / Math.max(1, y1 - y0));
  const ox = 200 - k * (x0 + x1) / 2, oy = 120 - k * (y0 + y1) / 2;
  svg.innerHTML = `<path d="M${pts.map(p => (ox + p[0] * k).toFixed(1) + ' ' + (oy + p[1] * k).toFixed(1)).join('L')}" fill="none" stroke="#d97757" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
}
function testHits() {
  const s = insStep(), z = s?.zone; if (!z || !zview) return;
  const { k, ox, oy } = zview;
  $('#zhits').innerHTML = Array.from({ length: 35 }, () => { const [x, y] = sampleZone(z); return `<circle class="hit" cx="${ox + x * k}" cy="${oy + y * k}" r="2.2" style="--d:${(Math.random() * 0.9).toFixed(2)}s"/>`; }).join('');
}
function drawDist() {
  const s = insStep(); if (!s || !$('#d-curve')) return;
  const { dist, mean } = s.delay, sp = Math.max(0, num(s.delay.spread));
  const lo = dist === 'fixed' ? mean : dist === 'uniform' ? Math.max(0, mean - sp) : Math.max(0, mean - 2 * sp);
  const hi = dist === 'fixed' ? mean : mean + (dist === 'uniform' ? sp : 2 * sp);
  const span = Math.max(40, (dist === 'gaussian' ? 3 * sp : sp * 1.6) || 40);
  const X = v => 200 + (v - mean) / span * 190;
  let d = '', f = '';
  if (dist === 'fixed' || sp === 0) {
    d = `M0 140H196L200 24L204 140H400`;
    f = '';
  } else if (dist === 'uniform') {
    const a = X(lo), b = X(hi);
    d = `M0 140H${a}V60H${b}V140H400`; f = `M${a} 140V60H${b}V140Z`;
  } else {
    const sig = 190 / 3;
    for (let x = 0; x <= 400; x += 4) { const y = 140 - 110 * Math.exp(-0.5 * ((x - 200) / sig) ** 2); d += (x ? 'L' : 'M') + x + ' ' + y.toFixed(1); }
    const a = Math.max(0, X(lo)), b = X(hi);
    f = `M${a} 140`; for (let x = a; x <= b; x += 4) f += `L${x.toFixed(1)} ${(140 - 110 * Math.exp(-0.5 * ((x - 200) / sig) ** 2)).toFixed(1)}`; f += `L${b} 140Z`;
  }
  $('#d-curve').setAttribute('d', d); $('#d-area').setAttribute('d', f);
  $('#d-clamp').innerHTML = dist === 'fixed' || sp === 0 ? '' : `<path d="M${Math.max(1, X(lo))} 20V140M${Math.min(399, X(hi))} 20V140"/>`;
  $('#d-tmin').textContent = round(lo) + ' ms'; $('#d-tmax').textContent = round(hi) + ' ms';
  $('#d-note').textContent = dist === 'fixed' ? 'Every pass waits exactly the same time. Games can spot that.' : dist === 'uniform' ? 'Any value between the dashed lines is equally likely.' : 'Values outside the dashed lines are clamped, so a delay can never run away.';
}

/* ---------------------------------------------------------------- recorder */
function smoothPts(P, w) {
  if (w <= 0) return P;
  return P.map((p, i) => {
    let sx = 0, sy = 0, n = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(P.length - 1, i + w); j++) { sx += P[j][0]; sy += P[j][1]; n++; }
    return [sx / n, sy / n, p[2], p[3]];
  });
}
function recSlice() {
  const P = REC.pending.points, N = P.length;
  const ia = Math.round(REC.a / 100 * (N - 1)), ib = Math.max(ia + 1, Math.round(REC.b / 100 * (N - 1)));
  return { ia, ib, Q: smoothPts(P, Math.round(REC.smooth / 12)) };
}
function renderRec() {
  $$('#hz button').forEach(b => b.classList.toggle('on', +b.dataset.hz === (PREFS.record_hz || 60)));
  $('#recbtn').innerHTML = REC.recording ? `Stop recording <kbd>${esc(PREFS.hotkeys.record || '')}</kbd>` : `Record <kbd>${esc(PREFS.hotkeys.record || '')}</kbd>`;
  $('#recbtn').classList.toggle('mad', REC.recording); $('#recbtn').classList.toggle('pri', !REC.recording);
  const body = $('#rec-body');
  if (REC.recording) { body.innerHTML = `<div class="panel"><div class="row start"><span class="beacon"></span><b>Recording</b><span class="m sub" id="recclock">${clock(Date.now() - REC.started)}</span><span class="sub">Move over ${esc(REC.process || 'the app')}. Press ${esc(PREFS.hotkeys.record || '')} again to stop.</span></div></div>`; return; }
  if (!REC.pending || REC.pending.points.length < 2) { body.innerHTML = `<p class="empty-note">No recording yet. Hover the app, press ${esc(PREFS.hotkeys.record || 'Ctrl+Shift+R')}, move through the path, and press it again.</p>`; return; }
  body.innerHTML = `<div class="panel"><svg viewBox="0 0 800 300" class="trace" id="trace"></svg>
    <div class="two" style="margin-top:18px"><div class="field"><label for="r-a">Trim start <span class="m" id="r-av"></span></label><input type="range" id="r-a" min="0" max="49" value="${REC.a}"></div>
    <div class="field"><label for="r-b">Trim end <span class="m" id="r-bv"></span></label><input type="range" id="r-b" min="51" max="100" value="${REC.b}"></div></div>
    <div class="row"><div class="field" style="flex:1 1 240px;margin:0"><label for="r-s">Smoothing <span class="m" id="r-sv"></span></label><input type="range" id="r-s" min="0" max="100" value="${REC.smooth}"></div>
    <div class="m sub" id="r-stats"></div>
    <div class="row"><button class="btn" id="r-discard">Discard</button><button class="btn" id="r-split">Save split at clicks</button><button class="btn pri" id="r-save">Save as step</button></div></div></div>`;
  drawTrace();
}
function drawTrace() {
  const svg = $('#trace'); if (!svg || !REC.pending) return;
  const { ia, ib, Q } = recSlice(), P = REC.pending.points;
  const xs = Q.map(p => p[0]), ys = Q.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const k = Math.min(740 / Math.max(1, x1 - x0), 260 / Math.max(1, y1 - y0));
  const ox = 400 - k * (x0 + x1) / 2, oy = 150 - k * (y0 + y1) / 2;
  const pt = p => (ox + p[0] * k).toFixed(1) + ' ' + (oy + p[1] * k).toFixed(1);
  const seg = (f, t, st, dash) => t > f ? `<path d="M${Q.slice(f, t + 1).map(pt).join('L')}" stroke="${st}" stroke-width="2.4" ${dash ? 'stroke-dasharray="3 6" opacity=".5"' : ''}/>` : '';
  const clicks = Q.slice(ia, ib + 1).filter((p, i, a) => i > 0 && (p[3] & 1) && !(a[i - 1][3] & 1));
  svg.innerHTML = `<g fill="none" stroke-linecap="round" stroke-linejoin="round">${seg(0, ia, '#6f6d66', 1)}${seg(ia, ib, '#d97757')}${seg(ib, Q.length - 1, '#6f6d66', 1)}</g>
    ${clicks.map(p => `<circle cx="${ox + p[0] * k}" cy="${oy + p[1] * k}" r="4" fill="none" stroke="#f5f4ee" stroke-width="1.5"/>`).join('')}
    <circle cx="${ox + Q[ia][0] * k}" cy="${oy + Q[ia][1] * k}" r="6" fill="#5fb89a"/><circle cx="${ox + Q[ib][0] * k}" cy="${oy + Q[ib][1] * k}" r="6" fill="#e5484d"/>`;
  const total = P[P.length - 1][2] - P[0][2], kept = P[ib][2] - P[ia][2];
  $('#r-av').textContent = REC.a + '%'; $('#r-bv').textContent = REC.b + '%'; $('#r-sv').textContent = REC.smooth;
  $('#r-stats').textContent = `${(kept / 1000).toFixed(1)} s kept of ${(total / 1000).toFixed(1)} s, ${ib - ia + 1} points${clicks.length ? ', ' + pl(clicks.length, 'click') : ''}`;
}
$('#rec-body').addEventListener('input', e => {
  if (e.target.id === 'r-a') REC.a = +e.target.value;
  if (e.target.id === 'r-b') REC.b = +e.target.value;
  if (e.target.id === 'r-s') REC.smooth = +e.target.value;
  drawTrace();
});
$('#rec-body').addEventListener('click', e => {
  const id = e.target.closest('button')?.id;
  if (id === 'r-discard') { REC.pending = null; renderRec(); toast('Recording discarded'); }
  if (id === 'r-save' || id === 'r-split') saveRecording(id === 'r-split');
});
function saveRecording(split) {
  const m = cur(), r = REC.pending, w = r.win;
  const { ia, ib, Q } = recSlice();
  let pts = Q.slice(ia, ib + 1);
  const t0 = pts[0][2];
  const auth = m.authored || { w: w.w, h: w.h };
  const sx = w.w ? auth.w / w.w : 1, sy = w.h ? auth.h / w.h : 1;
  pts = pts.map(p => [round(p[0] * sx, 1), round(p[1] * sy, 1), round(p[2] - t0, 1), p[3]]);
  const parts = [];
  if (split) {
    let start = 0;
    for (let i = 1; i < pts.length; i++) if ((pts[i][3] & 1) && !(pts[i - 1][3] & 1) && i - start > 2) { parts.push(pts.slice(start, i)); start = i; }
    parts.push(pts.slice(start));
  } else parts.push(pts);
  mut(() => {
    if (!m.target.process && w.process) { m.target.process = w.process; m.target.title = w.title || ''; }
    if (!m.authored) m.authored = { w: w.w, h: w.h };
    const at = sel >= 0 ? sel + 1 : m.steps.length;
    const steps = parts.filter(p => p.length > 1).map((p, i) => {
      const b = p[0][2];
      return newStep({ name: parts.length > 1 ? `Recorded path ${i + 1}` : 'Recorded path', action: { kind: 'path', points: p.map(q => [q[0], q[1], round(q[2] - b, 1), q[3]]) }, delay: { dist: 'gaussian', mean: 300, spread: 60 } });
    });
    m.steps.splice(at, 0, ...steps);
    sel = at + steps.length - 1;
  }, `Recording saved as ${pl(parts.length, 'step')}`);
  syncTarget();
  REC.pending = null;
  go('seq');
}
$('#hz').onclick = e => { const b = e.target.closest('button[data-hz]'); if (!b) return; PREFS.record_hz = +b.dataset.hz; savePrefs(); renderRec(); };
$('#recbtn').onclick = () => {
  if (!REC.recording && !cur().target.process && APPINFO.os === 'windows') return toast(`Switch to the app and press ${PREFS.hotkeys.record || 'Ctrl+Shift+R'} over it.`);
  invoke('toggle_record_cmd');
};

/* ---------------------------------------------------------------- run log */
let openRun = -1;
async function loadRuns() { try { RUNS = await invoke('load_runs'); } catch { RUNS = []; } if (view === 'log') renderLog(); }
function renderLog() {
  const body = $('#log-body');
  if (!RUNS.length) { body.innerHTML = `<p class="empty-note">No runs yet. Each run you start is logged here with its timing and the reason it ended.</p>`; return; }
  const why = { finished: 'Finished', user: 'Emergency stop', corner: 'Corner failsafe', guard: 'Guard timed out', stopped: 'Stopped', error: 'Error' };
  body.innerHTML = `<ol class="ledger" id="runlist">${RUNS.map((r, i) => `<li data-r="${i}" tabindex="0" style="grid-template-columns:minmax(0,1fr) auto auto auto">
      <div class="st"><b>${esc(r.macro_name)}${r.dry ? ', dry run' : ''}</b><span>${esc(why[r.reason] || r.reason)} on pass ${r.pass}, step ${r.step}. ${when(r.started)}</span></div>
      <span class="m time">${clock(r.elapsed_ms)}</span><span class="m time">${r.pass_ms ? fmt(r.pass_ms) + ' a pass' : ''}</span>
      <button class="btn sm" data-open="${i}">${openRun === i ? 'Hide steps' : 'Show steps'}</button></li>
      ${openRun === i ? `<li style="display:block;padding:0 0 18px"><table class="logtable"><tr><th>Pass</th><th>Step</th><th>At</th><th>Took</th><th>Point</th><th>Guard</th><th>Result</th></tr>
      ${r.log.slice(0, 400).map(e => `<tr><td class="m">${e.pass}</td><td>${e.step}. ${esc(e.name)}</td><td class="m">${clock(e.at_ms)}</td><td class="m">${fmt(e.dur_ms)}</td><td class="m">${e.point ? e.point.join(', ') : ''}</td><td>${esc(e.guard || '')}</td><td>${esc(e.note)}</td></tr>`).join('')}</table>
      ${r.log.length > 400 ? `<p class="sub">Showing 400 of ${r.log.length} entries. Export for the full log.</p>` : ''}</li>` : ''}`).join('')}</ol>`;
}
$('#log-body').addEventListener('click', e => { const b = e.target.closest('[data-open]'); if (b) { openRun = openRun === +b.dataset.open ? -1 : +b.dataset.open; renderLog(); } });
$('#logclear').onclick = async () => { await invoke('clear_runs'); RUNS = []; renderLog(); toast('Run log cleared'); };
$('#logexport').onclick = () => exportJson('aethermacro-run-log.json', RUNS);

/* ---------------------------------------------------------------- macro settings */
function renderSet() {
  const m = cur(), t = m.target, s = m.settings, b = s.breaks;
  $('#set-lede').textContent = `Target window, loop policy and humanization for ${m.name}.`;
  const w = winCache.key === t.process ? winCache.info : null;
  $('#set-body').innerHTML = `<div class="panel">
    <h2 class="section-title">Target window</h2>
    <div class="row" style="margin-bottom:18px"><div class="st"><b>${esc(t.process || 'Whole screen')}</b><span>${t.process ? esc(t.title ? 'Title contains “' + t.title + '”' : 'Any window of this app') : 'Coordinates are relative to the main display'}${m.authored ? `. Captured at ${m.authored.w}×${m.authored.h}` : ''}${w ? `, ${w.w}×${w.h} now` : t.process && winCache.key === t.process ? ', not open right now' : ''}.</span></div>
      <div class="row">${t.process ? '<button class="btn" id="s-screen">Use whole screen</button>' : ''}<button class="btn pri" id="s-pick">Choose a window</button></div></div>
    ${t.process ? `<div class="field"><label for="s-title">Title must contain <span class="hint">optional, process name is matched first</span></label><input type="text" id="s-title" value="${esc(t.title)}"></div>
    <label class="check" style="margin-bottom:14px"><input type="checkbox" id="s-focus" ${t.require_focus ? 'checked' : ''}> Only act while the target is in front, and pause while it is minimized</label>` : ''}
    <div class="field"><span class="lab">If the window size changes</span>${seg('resize', [['scale', 'Scale zones'], ['top_left', 'Anchor top-left'], ['center', 'Anchor centre']], t.on_resize)}</div>
    ${w && m.authored && (w.w !== m.authored.w || w.h !== m.authored.h) ? `<button class="btn" id="s-reauth">Treat ${w.w}×${w.h} as the captured size</button>` : ''}
  </div>
  <div class="panel"><h2 class="section-title">Loop policy</h2>
    <div class="field">${seg('loop', [['infinite', 'Continuous'], ['count', 'Number of passes'], ['duration', 'For a time']], s.loop_mode)}</div>
    ${s.loop_mode === 'count' ? nfield('s-count', 'Passes', s.loop_count, 'min="1"') : ''}
    ${s.loop_mode === 'duration' ? nfield('s-dur', 'Minutes', s.duration_min, 'min="0.1" step="0.5"') : ''}
    <label class="check" style="margin-bottom:14px"><input type="checkbox" id="s-breaks" ${b.enabled ? 'checked' : ''}> Take micro-breaks</label>
    ${b.enabled ? `<div class="inline">${nfield('s-emin', 'Every, from passes', b.every_min, 'min="1"')}${nfield('s-emax', 'to passes', b.every_max, 'min="1"')}${nfield('s-pmin', 'Pause from, s', b.pause_min / 1000, 'min="0" step="0.5"')}${nfield('s-pmax', 'to, s', b.pause_max / 1000, 'min="0" step="0.5"')}</div>` : ''}
  </div>
  <div class="panel"><h2 class="section-title">Humanization</h2>
    <div class="field"><span class="lab">Pointer path</span>${seg('traj', [['bezier', 'Bézier curve'], ['teleport', 'Teleport']], s.trajectory)}</div>
    ${s.trajectory === 'bezier' ? `<div class="two"><div class="field"><label for="s-speed">Speed <span class="m" id="s-speedv">${s.speed}×</span></label><input type="range" id="s-speed" min="0.3" max="3" step="0.1" value="${s.speed}"></div>
    <div class="field"><label for="s-curve">Curvature <span class="m" id="s-curvev">${Math.round(s.curvature * 100)}%</span></label><input type="range" id="s-curve" min="0" max="1" step="0.05" value="${s.curvature}"></div></div>
    <label class="check" style="margin-bottom:10px"><input type="checkbox" id="s-over" ${s.overshoot ? 'checked' : ''}> Sometimes overshoot long moves and correct</label>` : ''}
    <label class="check"><input type="checkbox" id="s-user" ${s.user_override ? 'checked' : ''}> Pause when I move the mouse</label>
    <p class="sub" style="margin:4px 0 0 26px">Turn this off for games that lock the pointer to the centre of the screen, which looks like movement.</p>
  </div>`;
}
$('#set-body').addEventListener('click', e => {
  const m = cur(), sg = e.target.closest('[data-seg] button');
  if (sg) {
    const w = sg.parentElement.dataset.seg, v = sg.dataset.v;
    mut(() => { if (w === 'resize') m.target.on_resize = v; if (w === 'loop') m.settings.loop_mode = v; if (w === 'traj') m.settings.trajectory = v; });
    return;
  }
  const id = e.target.closest('button')?.id;
  if (id === 's-pick') pickWindow();
  if (id === 's-screen') { mut(() => { m.target.process = ''; m.target.title = ''; }, 'Target set to the whole screen'); syncTarget(); }
  if (id === 's-reauth') { const w = winCache.info; mut(() => { m.authored = { w: w.w, h: w.h }; }, 'Captured size updated'); }
});
['focusin', 'input', 'change'].forEach(t => $('#set-body').addEventListener(t, e => {
  const el = e.target, m = cur(), s = m.settings, b = s.breaks;
  if (!el.id) return;
  if (e.type === 'focusin') { el._pre = snap(); return; }
  const v = el.type === 'checkbox' ? el.checked : el.value, n = num(v);
  const struct = ['s-focus', 's-breaks'].includes(el.id);
  if (struct && e.type !== 'change') return;
  switch (el.id) {
    case 's-title': m.target.title = v.trim(); break;
    case 's-focus': m.target.require_focus = v; break;
    case 's-count': s.loop_count = Math.max(1, Math.round(n)); break;
    case 's-dur': s.duration_min = Math.max(0.1, n); break;
    case 's-breaks': b.enabled = v; break;
    case 's-emin': b.every_min = Math.max(1, Math.round(n)); break;
    case 's-emax': b.every_max = Math.max(1, Math.round(n)); break;
    case 's-pmin': b.pause_min = Math.max(0, n * 1000); break;
    case 's-pmax': b.pause_max = Math.max(0, n * 1000); break;
    case 's-speed': s.speed = round(n, 1); $('#s-speedv').textContent = s.speed + '×'; break;
    case 's-curve': s.curvature = n; $('#s-curvev').textContent = Math.round(n * 100) + '%'; break;
    case 's-over': s.overshoot = v; break;
    case 's-user': s.user_override = v; break;
    default: return;
  }
  m.updated = Date.now(); persist();
  if (e.type === 'change' && el._pre) { hist.push(el._pre); redo = []; el._pre = snap(); }
  if (el.id === 's-title') syncTarget();
  if (struct) renderSet();
  $('#pn').textContent = m.name;
}));
async function pickWindow() {
  let list = [];
  try { list = await invoke('list_windows'); } catch { /* empty */ }
  const dlg = $('#dlg');
  dlg.className = 'dlg';
  const byProc = [];
  list.forEach(w => { if (!byProc.some(x => x.process === w.process && x.title === w.title)) byProc.push(w); });
  dlg.innerHTML = `<h2>Choose a window</h2><p>${APPINFO.os === 'windows' ? 'Windows that are open right now. The macro matches by app name first, so it keeps working when the title changes.' : 'Window tracking is not available on this system, so macros use the whole screen.'}</p>
    <ul class="picker">${byProc.map((w, i) => `<li><button data-w="${i}"><b>${esc(w.process || 'Whole screen')}</b><span>${esc(w.title)}, ${w.w}×${w.h}</span></button></li>`).join('') || '<li class="empty-note">No windows found.</li>'}</ul>
    <div class="row end"><button class="btn" id="d-cancel">Cancel</button></div>`;
  openDlg();
  dlg.onclick = e => {
    if (e.target.id === 'd-cancel') return closeDlg();
    const b = e.target.closest('[data-w]'); if (!b) return;
    const w = byProc[+b.dataset.w], m = cur();
    closeDlg();
    mut(() => { m.target.process = w.process; m.target.title = ''; if (!m.authored || !m.steps.length) m.authored = { w: w.w, h: w.h }; }, `Target set to ${w.process || 'the whole screen'}`);
    winCache = { key: '', info: null, at: 0 };
    syncTarget();
  };
}

/* ---------------------------------------------------------------- hotkeys */
function comboOf(e) {
  const c = e.code;
  let k = /^Key[A-Z]$/.test(c) ? c.slice(3) : /^Digit\d$/.test(c) ? c.slice(5) : /^F\d{1,2}$/.test(c) ? c :
    ({ Escape: 'Esc', Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '`' })[c] || (/^Numpad\d$/.test(c) ? 'Num' + c.slice(6) : null);
  if (!k) return null;
  return [e.ctrlKey && 'Ctrl', e.shiftKey && 'Shift', e.altKey && 'Alt', e.metaKey && (APPINFO.os === 'macos' ? 'Cmd' : 'Super'), k].filter(Boolean).join('+');
}
function renderKeys() {
  const used = {};
  HOTKEYS.forEach(([id]) => { const v = PREFS.hotkeys[id]; if (v) (used[v.toLowerCase()] ||= []).push(id); });
  $('#kt').innerHTML = `<tr><th>Action</th><th>Keys</th><th></th><th></th></tr>` + HOTKEYS.map(([id, label]) => {
    const v = PREFS.hotkeys[id] || '', r = HK_RESULTS[id];
    const dup = v && used[v.toLowerCase()].length > 1 ? 'Also bound to ' + HOTKEYS.find(h => h[0] !== id && used[v.toLowerCase()].includes(h[0]))[1].toLowerCase() : '';
    const note = r && !r.ok ? 'Another app already uses this, pick something else' : dup || (CONFLICTS[v] ? 'Clashes with: ' + CONFLICTS[v] : '');
    const lis = listening?.kind === 'hk' && listening.id === id;
    return `<tr class="${note ? 'warn' : ''} ${lis ? 'listen' : ''}"><td>${label}</td><td>${v ? v.split('+').map(k => `<kbd>${esc(k)}</kbd>`).join(' ') : '<span class="dimtxt">Not set</span>'}</td><td class="cf">${esc(note)}</td>
      <td><div class="row end" style="flex-wrap:nowrap">${v && !id.startsWith('stop') ? `<button class="btn sm" data-clear="${id}">Clear</button>` : ''}<button class="btn sm" data-hk="${id}">${lis ? 'Press keys' : 'Rebind'}</button></div></td></tr>`;
  }).join('') + `<tr><td colspan="4" style="text-align:left"><button class="lnk" id="hk-reset">Restore defaults</button></td></tr>`;
}
$('#kt').addEventListener('click', e => {
  const b = e.target.closest('[data-hk]'), c = e.target.closest('[data-clear]');
  if (b) { listening = { kind: 'hk', id: b.dataset.hk }; renderKeys(); }
  if (c) { PREFS.hotkeys[c.dataset.clear] = ''; applyHotkeys(); }
  if (e.target.id === 'hk-reset') { HOTKEYS.forEach(([id, , d]) => PREFS.hotkeys[id] = d); applyHotkeys(); toast('Hotkeys restored'); }
});
async function applyHotkeys() {
  savePrefs();
  try { const res = await invoke('apply_hotkeys', { map: PREFS.hotkeys }); HK_RESULTS = {}; res.forEach(r => HK_RESULTS[r.action] = r); } catch (e) { toast(String(e)); }
  renderKeys();
  if (view === 'seq') renderSeq();
}

/* ---------------------------------------------------------------- app view */
const PILL_KEY = 'aether.pill';
const pillOn = () => { try { return localStorage.getItem(PILL_KEY) !== '0'; } catch { return true; } };
function renderApp() {
  $('#app-body').innerHTML = `<div class="panel"><h2 class="section-title">Overlay</h2>
      <p class="sub" style="margin-bottom:14px">The overlay floats above games running in borderless or windowed fullscreen. Exclusive fullscreen hides every overlay, so switch the game to borderless if you cannot see it.</p>
      <label class="check"><input type="checkbox" id="a-pill" ${pillOn() ? 'checked' : ''}> Show the status pill while a macro runs <kbd>${esc(PREFS.hotkeys.pill || '')}</kbd></label>
      <div class="row start" style="margin-top:12px"><button class="btn" id="a-hud">Toggle telemetry now <kbd>${esc(PREFS.hotkeys.hud || '')}</kbd></button></div></div>
    <div class="panel"><h2 class="section-title">Sound</h2>
      <label class="check" style="margin-bottom:12px"><input type="checkbox" id="a-mute" ${PREFS.muted ? 'checked' : ''}> Mute audio cues</label>
      <div class="field"><label for="a-vol">Volume <span class="m" id="a-volv">${Math.round(PREFS.volume * 100)}%</span></label><input type="range" id="a-vol" min="0" max="1" step="0.05" value="${PREFS.volume}"></div>
      <div class="row start"><button class="btn sm" data-tone="start">Start, 880 Hz</button><button class="btn sm" data-tone="pause">Pause, double beep</button><button class="btn sm" data-tone="stop">Stop, 440 Hz</button><button class="btn sm" data-tone="alert">Alert, 220 Hz</button></div></div>
    <div class="panel"><h2 class="section-title">Updates</h2>
      <div class="row"><div class="st"><b>Version <span class="m">${esc(APPINFO.version)}</span></b><span id="a-updtxt">${UPDATE ? `Version ${esc(UPDATE.version)} is ready to install.` : 'AetherMacro checks GitHub for new releases each time it starts.'}</span></div>
      <div class="row">${UPDATE ? '<button class="btn pri" id="a-install">Restart to update</button>' : '<button class="btn" id="a-check">Check for updates</button>'}</div></div></div>
    <div class="panel"><h2 class="section-title">Saving</h2>
      <p class="sub" style="margin-bottom:14px">Save as asks for a file name and folder, starting in the default folder. After that, Ctrl+S writes straight back to the same file, and Ctrl+Shift+S picks a new one.</p>
      <div class="row"><div class="st" style="min-width:0;flex:1 1 260px"><b>Default folder</b><span class="m" style="user-select:text;overflow-wrap:anywhere;white-space:normal">${esc(PREFS.save_dir || DEFAULT_DIR)}</span></div>
      <div class="row">${PREFS.save_dir ? '<button class="btn" id="a-resetdir">Use Documents</button>' : ''}<button class="btn" id="a-opendlg">Open macro file</button><button class="btn pri" id="a-pickdir">Change folder</button></div></div>
      <hr class="rule"><p class="sub">Every change is also kept automatically in the app's own library, one file per macro, so a damaged file never affects the others.</p><p class="m sub" style="margin-top:8px;user-select:text;overflow-wrap:anywhere">${esc(DATA_DIR)}</p></div>`;
}
$('#app-body').addEventListener('input', e => {
  if (e.target.id === 'a-vol') { PREFS.volume = +e.target.value; $('#a-volv').textContent = Math.round(PREFS.volume * 100) + '%'; savePrefs(); }
});
$('#app-body').addEventListener('change', e => {
  if (e.target.id === 'a-mute') { PREFS.muted = e.target.checked; savePrefs(); }
  if (e.target.id === 'a-pill') { try { localStorage.setItem(PILL_KEY, e.target.checked ? '1' : '0'); } catch { /* ignore */ } T.event.emit('pill-pref', e.target.checked); }
});
$('#app-body').addEventListener('click', async e => {
  const id = e.target.closest('button')?.id;
  if (id === 'a-hud') T.event.emit('overlay-toggle-req', 'hud');
  if (id === 'a-check') {
    $('#a-updtxt').textContent = 'Checking GitHub releases…';
    try {
      const u = await invoke('check_update');
      if (u) { setUpdate(u); renderApp(); } else $('#a-updtxt').textContent = 'You have the latest version.';
    } catch (err) { $('#a-updtxt').textContent = 'Could not check for updates: ' + err; }
  }
  if (id === 'a-install') installUpdate();
  if (id === 'a-pickdir') { const d = await invoke('pick_folder', { dir: PREFS.save_dir || DEFAULT_DIR }); if (d) { PREFS.save_dir = d; savePrefs(); renderApp(); toast('Save as now starts in ' + d); } }
  if (id === 'a-resetdir') { PREFS.save_dir = ''; savePrefs(); renderApp(); toast('Save as now starts in ' + DEFAULT_DIR); }
  if (id === 'a-opendlg') openFiles();
});
function setUpdate(u) { UPDATE = u; $('#upd').hidden = false; $('#updv').textContent = 'Version ' + u.version; }
async function installUpdate() {
  if (RUN.state !== 'idle' && !confirmStop()) return;
  $('#updbtn').disabled = true; $('#updbtn').textContent = 'Downloading';
  try { await invoke('install_update'); }
  catch (e) { toast('Update failed: ' + e); $('#updbtn').disabled = false; $('#updbtn').textContent = 'Restart to update'; }
}
function confirmStop() { toast('Stop the running macro first'); return false; }
$('#updbtn').onclick = installUpdate;

/* ---------------------------------------------------------------- audio */
let actx = null;
function tone(f, at, dur, vol) {
  const o = actx.createOscillator(), g = actx.createGain();
  o.frequency.value = f; o.connect(g); g.connect(actx.destination);
  const t = actx.currentTime + at;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.start(t); o.stop(t + dur + 0.02);
}
function cue(kind, force) {
  if ((PREFS.muted && !force) || !PREFS.volume) return;
  try {
    actx ||= new AudioContext();
    const v = 0.25 * PREFS.volume;
    if (kind === 'start') tone(880, 0, 0.35, v);
    if (kind === 'pause') { tone(660, 0, 0.12, v); tone(660, 0.18, 0.12, v); }
    if (kind === 'stop') tone(440, 0, 0.45, v);
    if (kind === 'alert') { tone(220, 0, 0.3, v * 1.2); tone(220, 0.38, 0.3, v * 1.2); }
  } catch { /* audio unavailable */ }
}
document.addEventListener('click', e => { const b = e.target.closest('[data-tone]'); if (b) cue(b.dataset.tone, true); });

/* ---------------------------------------------------------------- keyboard */
addEventListener('keydown', e => {
  if (listening) {
    e.preventDefault(); e.stopPropagation();
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    const k = comboOf(e);
    if (!k) return;
    const l = listening; listening = null;
    if (l.kind === 'hk') { PREFS.hotkeys[l.id] = k; applyHotkeys(); toast(`${HOTKEYS.find(h => h[0] === l.id)[1]} is now ${k}`); }
    else l.done(k);
    return;
  }
  const typing = e.target.isContentEditable || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName);
  if ($('#scrim').classList.contains('on')) { if (e.key === 'Escape') closeDlg(); return; }
  if ((e.ctrlKey || e.metaKey) && !typing) {
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redoIt(); }
    if (k === 'd' && view === 'seq' && sel >= 0) { e.preventDefault(); stepAction('dup', sel); }
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (document.activeElement === $('#mt')) $('#mt').blur();
    if (e.shiftKey) saveAs(); else saveNow();
  }
  if (e.key === 'Escape' && view === 'ins' && !typing) go('seq');
}, true);

/* ---------------------------------------------------------------- backend events */
function scaleZone(z, sx, sy) {
  if (!z) return z;
  z.x *= sx; z.y *= sy; z.w *= sx; z.h *= sy; z.r *= (sx + sy) / 2;
  z.points = (z.points || []).map(p => [p[0] * sx, p[1] * sy]);
  for (const k of ['x', 'y', 'w', 'h', 'r']) z[k] = round(z[k], 1);
  return z;
}
function intoMacroSpace(m, win) {
  if (!m.authored) m.authored = { w: win.w, h: win.h };
  return [win.w ? m.authored.w / win.w : 1, win.h ? m.authored.h / win.h : 1];
}
listen('capture-step', ({ payload }) => {
  const m = cur(), win = payload.win, raw = payload.step;
  const other = m.target.process && win.process && m.target.process.toLowerCase() !== win.process.toLowerCase();
  if (replaceZoneFor) {
    const id = replaceZoneFor; replaceZoneFor = null;
    const s = m.steps.find(x => x.id === id);
    if (s) {
      mut(() => { const [sx, sy] = intoMacroSpace(m, win); s.zone = scaleZone(raw.zone, sx, sy); if (raw.guard && s.guard) s.guard.samples = raw.guard.samples.map(p => [p[0] * sx, p[1] * sy]); }, `Zone updated on ${s.name}`);
      return;
    }
  }
  let n = 0;
  mut(() => {
    if (!m.target.process && win.process) { m.target.process = win.process; m.target.title = ''; }
    const [sx, sy] = intoMacroSpace(m, win);
    const s = newStep(raw);
    s.id = uid('s');
    s.zone = scaleZone(s.zone, sx, sy);
    if (s.guard) s.guard.samples = s.guard.samples.map(p => [round(p[0] * sx, 1), round(p[1] * sy, 1)]);
    if (s.action.kind === 'drag' && s.action.to) s.action.to = scaleZone(s.action.to, sx, sy);
    const at = sel >= 0 && sel < m.steps.length - 1 ? sel + 1 : m.steps.length;
    m.steps.splice(at, 0, s);
    sel = at; n = at + 1;
  });
  syncTarget();
  const msg = `Step ${n} added to ${m.name}`;
  toast(other ? `${msg}. It was captured over ${win.process}, not ${m.target.process}.` : msg);
  T.event.emit('overlay-toast-req', msg);
});
listen('quick-add', ({ payload }) => {
  const m = cur(), win = payload.win;
  let n = 0;
  mut(() => {
    if (!m.target.process && win.process) m.target.process = win.process;
    const [sx, sy] = intoMacroSpace(m, win);
    const s = newStep({ name: `Click at ${Math.round(payload.x * sx)}, ${Math.round(payload.y * sy)}`, zone: { shape: 'point', x: round(payload.x * sx, 1), y: round(payload.y * sy, 1), w: 0, h: 0, r: 0, points: [], dist: 'gaussian', pad: 0, anti_repeat: 0 } });
    m.steps.push(s); n = m.steps.length;
  });
  syncTarget();
  T.event.emit('overlay-toast-req', `Step ${n} added to ${m.name}`);
});
listen('run-state', ({ payload }) => {
  const prev = RUN.state;
  RUN = payload;
  if (prev !== RUN.state && RUN.state === 'paused' && prev === 'running') cue('pause');
  $('#runmini').hidden = RUN.state === 'idle';
  if (RUN.state !== 'idle') {
    $('#runbeacon').className = 'beacon' + (RUN.state === 'running' ? '' : ' paused');
    $('#runminitxt').textContent = `${RUN.macro_name}, pass ${RUN.pass}`;
  }
  if (view === 'seq') { if (prev === RUN.state && RUN.state !== 'idle') { renderRunbar(); markRunning(); } else renderSeq(); }
  if (view === 'lib' && prev !== RUN.state) renderLib();
});
listen('run-ended', ({ payload: s }) => {
  RUN = { state: 'idle' };
  $('#runmini').hidden = true;
  const m = DB.macros.find(x => x.id === s.macro_id);
  if (m && !s.dry) { m.last_run = Date.now(); persist(); }
  if (['user', 'corner', 'guard'].includes(s.reason) && !s.dry) showStopped(s);
  else if (s.dry) toast(s.reason === 'finished' ? `Dry run done, about ${fmt(s.pass_ms)} per pass` : 'Dry run stopped');
  else if (s.reason === 'finished') toast(`${s.macro_name} finished ${pl(s.pass, 'pass')}`);
  else toast('Stopped. Nothing is held down.');
  renderAll();
  loadRuns();
});
listen('hotkey', ({ payload }) => {
  if (payload === 'start') runMacro({ fromHotkey: true });
  if (payload === 'step') runMacro({ fromHotkey: true, stepMode: true });
});
listen('record-state', ({ payload }) => {
  REC.recording = payload.recording;
  if (payload.recording) { REC.started = payload.started; REC.process = payload.process; }
  $('#recbadge').textContent = payload.recording ? 'Recording' : '';
  if (view === 'rec') renderRec();
});
listen('recording', ({ payload }) => {
  if (!payload.points || payload.points.length < 2) return toast('The recording was too short to keep.');
  const P = payload.points;
  // Pre-trim idle time at both ends: find the first and last point that moved.
  const moved = i => i > 0 && (Math.abs(P[i][0] - P[i - 1][0]) + Math.abs(P[i][1] - P[i - 1][1]) > 0 || P[i][3] !== P[i - 1][3]);
  let f = 1; while (f < P.length && !moved(f)) f++;
  let l = P.length - 1; while (l > f && !moved(l)) l--;
  REC.pending = payload;
  REC.a = Math.min(49, Math.max(0, Math.floor((f - 1) / P.length * 100)));
  REC.b = Math.max(51, Math.min(100, Math.ceil((l + 1) / P.length * 100)));
  REC.smooth = 30;
  T.event.emit('overlay-toast-req', 'Recording kept. Trim it in AetherMacro.');
  go('rec');
});
listen('cue', ({ payload }) => cue(payload));
listen('toast', ({ payload }) => toast(payload));
listen('update-available', ({ payload }) => setUpdate(payload));
listen('update-progress', ({ payload }) => {
  const pct = payload.total ? Math.round(payload.got / payload.total * 100) : null;
  $('#updbtn').textContent = pct != null ? `Downloading ${pct}%` : 'Downloading';
});
setInterval(() => {
  if (RUN.state !== 'idle' && $('#elapsed')) $('#elapsed').textContent = clock(Date.now() - RUN.started);
  if (REC.recording && $('#recclock')) $('#recclock').textContent = clock(Date.now() - REC.started);
}, 1000);
setInterval(() => { if (view === 'seq' || view === 'set') refreshWin(); }, 4000);

/* ---------------------------------------------------------------- boot */
(async function boot() {
  try { APPINFO = await invoke('app_info'); } catch { /* defaults */ }
  let lib = { macros: [], index: {}, broken: [] };
  try { lib = await invoke('load_library'); } catch (e) { toast('Could not load macros: ' + e); }
  DATA_DIR = lib.dir || '';
  try { DEFAULT_DIR = await invoke('default_save_dir'); } catch { /* fallback empty */ }
  const order = lib.index?.order || [];
  DB.macros = lib.macros.sort((a, b) => (order.indexOf(a.id) + 1 || 1e9) - (order.indexOf(b.id) + 1 || 1e9) || a.created - b.created);
  if (!DB.macros.length) DB.macros.push(newMacro('Untitled macro 1'));
  DB.active = DB.macros.some(m => m.id === lib.index?.active) ? lib.index.active : DB.macros[0].id;
  try { const p = await invoke('load_prefs'); if (p && typeof p === 'object') PREFS = Object.assign(PREFS, p); } catch { /* defaults */ }
  PREFS.hotkeys = Object.assign(Object.fromEntries(HOTKEYS.map(([id, , d]) => [id, d])), PREFS.hotkeys || {});
  persist();
  await applyHotkeys();
  syncTarget();
  try { RUN = await invoke('run_status'); if (!RUN.state) RUN = { state: 'idle' }; } catch { /* idle */ }
  loadRuns();
  go('seq');
  renderAll();
  if (lib.broken?.length) toast(`${pl(lib.broken.length, 'macro file')} could not be read and ${lib.broken.length === 1 ? 'was' : 'were'} moved to “needs-repair”.`);
})();

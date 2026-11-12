'use strict';
/* Overlay window: floats above the game, click-through except while capturing. */
const T = window.__TAURI__;
const invoke = T.core.invoke;
const listen = T.event.listen;
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const COLOR = { rect: '#7aa7f0', circle: '#5fb89a', poly: '#b39ce8', point: '#d97757' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return [s / 3600 | 0, (s / 60 | 0) % 60, s % 60].map(n => String(n).padStart(2, '0')).join(':'); };

let G = { ox: 0, oy: 0, k: 1 };
let HUD = false, PILL = true, ZONES = false;
let ZONES_DATA = null, targetWin = null;
try { PILL = localStorage.getItem('aether.pill') !== '0'; } catch { /* default */ }
let RUN = { state: 'idle' };
let REC = { on: false, started: 0 };
let CAP = null;
let ghostUntil = 0, toastUntil = 0;
let KEYS = {};
let shown = { visible: false, interactive: false };

const toCss = (x, y) => [(x - G.ox) / G.k, (y - G.oy) / G.k];

/* Show the window only while something is on it, so the game is untouched otherwise. */
function sync() {
  const now = Date.now();
  const ghost = (RUN.dry && RUN.state !== 'idle' && ghostUntil > 0) || ghostUntil > now;
  const visible = !!(CAP || HUD || ZONES || REC.on || (PILL && RUN.state !== 'idle') || ghost || toastUntil > now);
  const interactive = !!CAP;
  $('#hud').classList.toggle('on', HUD && !CAP);
  $('#pill').classList.toggle('on', !CAP && (REC.on || (PILL && RUN.state !== 'idle')));
  $('#ghost').classList.toggle('on', ghost && !CAP);
  $('#zones').classList.toggle('on', ZONES && !CAP);
  if (visible !== shown.visible || interactive !== shown.interactive) {
    shown = { visible, interactive };
    invoke('overlay_mode', { visible, interactive }).catch(() => {});
  }
}
setInterval(sync, 250);

function toast(t) {
  const e = $('#toast');
  e.textContent = t;
  e.classList.add('on');
  toastUntil = Date.now() + 2200;
  sync();
  clearTimeout(e.t);
  e.t = setTimeout(() => { e.classList.remove('on'); setTimeout(sync, 600); }, 2000);
}

/* ---------------------------------------------------------------- HUD */
$('#loupe').innerHTML = '<i></i>'.repeat(49);
const cells = $$('#loupe i');
let hudBusy = false;
async function hudTick() {
  if (!HUD || CAP || hudBusy) return;
  hudBusy = true;
  try {
    const s = await invoke('hud_sample');
    $('#h-screen').textContent = s.screen.join(', ');
    $('#h-client').textContent = s.client ? s.client.join(', ') : '-';
    if (s.colors.length === 49) { cells.forEach((c, i) => c.style.background = s.colors[i]); $('#h-hex').textContent = s.colors[24]; }
    else $('#h-hex').textContent = 'No screen access';
    $('#h-proc').textContent = s.process;
    $('#h-focus').textContent = s.focused ? 'In front' : 'Behind';
    $('#h-focus').style.color = s.focused ? 'var(--circ)' : 'var(--fog)';
  } catch { /* window may be closing */ }
  hudBusy = false;
}
setInterval(hudTick, 100);

/* ---------------------------------------------------------------- pill */
function renderPill() {
  if (REC.on) {
    $('#p-beacon').className = 'beacon rec';
    $('#p-state').textContent = 'Recording';
    $('#p-pass').textContent = REC.process || '';
    $('#p-seg').innerHTML = '';
    $('#p-step').textContent = 'Move through the path you want to keep';
    $('#p-next').textContent = '';
    $('#p-reason').hidden = true;
    $('#p-hints').innerHTML = `<span><kbd>${esc(KEYS.record || 'Ctrl+Shift+R')}</kbd> stop recording</span>`;
    return;
  }
  if (RUN.state === 'idle') return;
  const paused = RUN.state !== 'running';
  $('#p-beacon').className = 'beacon' + (paused ? ' paused' : '');
  $('#p-state').textContent = RUN.dry ? 'Dry run' : { running: 'Running', paused: 'Paused', waiting: 'Waiting', break: 'On a break' }[RUN.state] || 'Running';
  $('#p-pass').innerHTML = `pass <span class="m">${RUN.pass}</span>${RUN.total_passes ? ' of ' + RUN.total_passes : ''}`;
  const n = Math.max(1, RUN.step_count);
  const segs = $('#p-seg');
  if (segs.children.length !== n) segs.innerHTML = '<i><b></b></i>'.repeat(n);
  [...segs.children].forEach((e, i) => {
    e.classList.toggle('done', i < RUN.step);
    const on = i === RUN.step && RUN.state === 'running';
    if (on && !e.classList.contains('on')) e.style.setProperty('--t', Math.max(80, RUN.next_ms + 250) + 'ms');
    e.classList.toggle('on', on);
  });
  $('#p-step').textContent = RUN.step_name || '';
  $('#p-reason').hidden = !RUN.reason;
  $('#p-reason').textContent = RUN.reason || '';
  const k = id => esc(KEYS[id] || '');
  $('#p-hints').innerHTML = `<span><kbd>${k('pause')}</kbd> ${paused ? 'resume' : 'pause'}</span><span><kbd>${k('step')}</kbd> single step</span><span><kbd>${k('stop')}</kbd> abort</span>`;
}
setInterval(() => {
  if (REC.on) { $('#p-clock').textContent = clock(Date.now() - REC.started); return; }
  if (RUN.state === 'idle') return;
  $('#p-clock').textContent = clock(Date.now() - RUN.started);
  const left = RUN.next_ms - Math.max(0, Date.now() - RUN.step_started - 250);
  $('#p-next').textContent = RUN.state === 'running' && left > 0 ? `next in ${Math.round(left)} ms` : '';
}, 100);

async function loadKeys() {
  try {
    const p = await invoke('load_prefs');
    KEYS = Object.assign({ start: 'F5', pause: 'F6', step: 'F11', stop: 'Esc', record: 'Ctrl+Shift+R', hud: 'F9', pill: 'F10', zones: 'F4' }, p?.hotkeys || {});
    $('#hudkey').textContent = KEYS.hud || '';
    if ($('#z-key')) $('#z-key').textContent = KEYS.zones || 'F4';
  } catch { /* defaults */ }
}

/* ---------------------------------------------------------------- capture */
let tool = 'rect', dist = 'gaussian', shape = null, drag = null, cursor = [0, 0];
function beginCapture(p) {
  G = p.geom; CAP = { win: p.win };
  const w = p.win, [x, y] = toCss(w.x, w.y), ww = w.w / G.k, hh = w.h / G.k;
  CAP.rect = [x, y, ww, hh];
  const W = innerWidth, H = innerHeight;
  $('#dimp').setAttribute('d', `M0 0H${W}V${H}H0Z M${x} ${y}h${ww}v${hh}h${-ww}Z`);
  const di = $('#dimin'); di.setAttribute('x', x); di.setAttribute('y', y); di.setAttribute('width', ww); di.setAttribute('height', hh);
  const r = $('#winr'); r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', ww); r.setAttribute('height', hh);
  const l = $('#winl'); l.setAttribute('x', x + 8); l.setAttribute('y', Math.max(14, y + 18)); l.textContent = `${w.process || 'Whole screen'}  ${w.w}×${w.h}`;
  shape = null; drag = null;
  $('#sname').value = ''; $('#guard').checked = false;
  $('#hits').innerHTML = '';
  $('#cap').classList.add('on');
  setTool(tool);
  draw();
  sync();
  setTimeout(() => { window.focus(); $('#cv').focus?.(); }, 60);
}
function endCapture(step, guardAt) {
  $('#cap').classList.remove('on');
  CAP = null; shape = null; drag = null;
  invoke('capture_end', { step: step || null, guardAt: guardAt || null }).catch(() => {});
  shown = { visible: false, interactive: false };
  sync();
}
function setTool(k) {
  tool = k;
  $$('#tools button').forEach(b => b.classList.toggle('on', b.dataset.k === k));
  if (shape && shape.k !== k) shape = null;
  $('#help').textContent = { rect: 'Drag to draw a box. Shift keeps it square, Alt draws from the centre.', circle: 'Drag from the centre out to the edge.', poly: 'Click to add corners. Backspace removes the last one.', point: 'Click the exact pixel.' }[k] + ' Enter saves, Esc cancels.';
  draw();
}
const toClient = (x, y) => [Math.round((G.ox + x * G.k - CAP.win.x) * 10) / 10, Math.round((G.oy + y * G.k - CAP.win.y) * 10) / 10];
function draw() {
  const c = COLOR[tool];
  let h = '';
  if (shape?.k === 'rect') h = `<rect x="${shape.x}" y="${shape.y}" width="${shape.w}" height="${shape.h}" rx="3"/>`;
  if (shape?.k === 'circle') h = `<circle cx="${shape.cx}" cy="${shape.cy}" r="${shape.r}"/>`;
  if (shape?.k === 'poly') h = shape.p.length > 2 ? `<polygon points="${shape.p.map(p => p.join(',')).join(' ')}"/>` : `<polyline points="${shape.p.map(p => p.join(',')).join(' ')}" fill="none"/>` + shape.p.map(p => `<circle cx="${p[0]}" cy="${p[1]}" r="3" stroke="none" fill="${c}" fill-opacity="1"/>`).join('');
  if (shape?.k === 'point') h = `<path d="M${shape.x - 14} ${shape.y}h28M${shape.x} ${shape.y - 14}v28"/>`;
  $('#zone').innerHTML = `<g fill="${c}" fill-opacity=".16" stroke="${c}" stroke-width="1.8" stroke-dasharray="${tool === 'point' ? 0 : '6 5'}">${h}</g>`;
  const k = G.k, R = Math.round;
  $('#dims').textContent = !shape ? '' : { rect: `${R(shape.w * k)}×${R(shape.h * k)} px`, circle: `radius ${R(shape.r * k)} px`, poly: `${shape.p?.length || 0} vertices`, point: 'exact pixel' }[shape.k];
  $('#save').disabled = !valid();
}
function valid() {
  if (!shape) return false;
  if (shape.k === 'rect') return shape.w * G.k >= 2 && shape.h * G.k >= 2;
  if (shape.k === 'circle') return shape.r * G.k >= 1;
  if (shape.k === 'poly') return shape.p.length >= 3;
  return true;
}
const cv = $('#cv');
cv.addEventListener('pointerdown', e => {
  if (!CAP || e.button !== 0) return;
  const p = [e.clientX, e.clientY];
  $('#hits').innerHTML = '';
  if (tool === 'poly') { if (shape?.k !== 'poly') shape = { k: 'poly', p: [] }; shape.p.push(p); draw(); return; }
  if (tool === 'point') { shape = { k: 'point', x: p[0], y: p[1] }; draw(); return; }
  drag = { o: p, alt: e.altKey };
  cv.setPointerCapture(e.pointerId);
});
cv.addEventListener('pointermove', e => {
  if (!CAP) return;
  cursor = [e.clientX, e.clientY];
  const [cx, cy] = toClient(e.clientX, e.clientY);
  $('#readout').textContent = `${Math.round(cx)}, ${Math.round(cy)}`;
  if (!drag) return;
  const [ox, oy] = drag.o, dx = e.clientX - ox, dy = e.clientY - oy;
  if (tool === 'rect') {
    let w = Math.abs(dx), h = Math.abs(dy);
    if (e.shiftKey) w = h = Math.max(w, h);
    if (drag.alt || e.altKey) shape = { k: 'rect', x: ox - w, y: oy - h, w: w * 2, h: h * 2 };
    else shape = { k: 'rect', x: dx < 0 ? ox - w : ox, y: dy < 0 ? oy - h : oy, w, h };
  }
  if (tool === 'circle') shape = { k: 'circle', cx: ox, cy: oy, r: Math.hypot(dx, dy) };
  draw();
});
cv.addEventListener('pointerup', () => { drag = null; });
$('#pal').addEventListener('pointerdown', e => e.stopPropagation());
$('#tools').onclick = e => { const b = e.target.closest('button[data-k]'); if (b) setTool(b.dataset.k); };
$('#dist').onclick = e => { const b = e.target.closest('button[data-d]'); if (!b) return; dist = b.dataset.d; $$('#dist button').forEach(x => x.classList.toggle('on', x === b)); };
$('#cancel').onclick = () => endCapture(null);
$('#save').onclick = save;
$('#test').onclick = testHits;

function zoneFromShape() {
  const k = G.k;
  if (shape.k === 'rect') { const [x, y] = toClient(shape.x, shape.y); return { shape: 'rect', x, y, w: Math.round(shape.w * k * 10) / 10, h: Math.round(shape.h * k * 10) / 10 }; }
  if (shape.k === 'circle') { const [x, y] = toClient(shape.cx, shape.cy); return { shape: 'circle', x, y, r: Math.round(shape.r * k * 10) / 10 }; }
  if (shape.k === 'poly') { const pts = shape.p.map(p => toClient(p[0], p[1])); const n = pts.length; return { shape: 'poly', x: pts.reduce((a, p) => a + p[0], 0) / n, y: pts.reduce((a, p) => a + p[1], 0) / n, points: pts }; }
  const [x, y] = toClient(shape.x, shape.y); return { shape: 'point', x, y };
}
function save() {
  if (!CAP || !valid()) return;
  const z = Object.assign({ w: 0, h: 0, r: 0, points: [], dist, pad: shape.k === 'point' ? 0 : 2, anti_repeat: shape.k === 'point' ? 0 : 3 }, zoneFromShape());
  const a = $('#act').value;
  const action = { left: { kind: 'click', button: 'left', count: 1 }, right: { kind: 'click', button: 'right', count: 1 }, middle: { kind: 'click', button: 'middle', count: 1 }, double: { kind: 'click', button: 'left', count: 2 }, hold: { kind: 'hold', button: 'left' }, move: { kind: 'move' } }[a];
  const label = $('#act').selectedOptions[0].textContent;
  const word = { rect: 'box', circle: 'circle', poly: 'polygon', point: 'point' }[shape.k];
  const dVal = Math.max(0, parseFloat($('#sdelay')?.value) || 600);
  const step = {
    name: $('#sname').value.trim() || `${label} on ${word}`,
    action, zone: z,
    hold: a === 'hold' ? { min: 900, max: 1300 } : { min: 45, max: 80 },
    delay: { dist, mean: dVal, spread: dist === 'fixed' ? 0 : Math.round(dVal * 0.15) }
  };
  let guardAt = null;
  if ($('#guard').checked) {
    const b = z.shape === 'rect' ? [z.x + z.w / 2, z.y + z.h / 2] : [z.x, z.y];
    guardAt = [Math.round(b[0]), Math.round(b[1])];
  }
  endCapture(step, guardAt);
}
const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
const inPoly = (p, x, y) => { let r = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) if ((p[i][1] > y) !== (p[j][1] > y) && x < (p[j][0] - p[i][0]) * (y - p[i][1]) / (p[j][1] - p[i][1]) + p[i][0]) r = !r; return r; };
function sample() {
  const s = shape;
  if (s.k === 'point') return [s.x, s.y];
  let b, c;
  if (s.k === 'rect') b = [s.x, s.y, s.x + s.w, s.y + s.h];
  if (s.k === 'circle') b = [s.cx - s.r, s.cy - s.r, s.cx + s.r, s.cy + s.r];
  if (s.k === 'poly') { const xs = s.p.map(p => p[0]), ys = s.p.map(p => p[1]); b = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; }
  c = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  if (s.k === 'poly') c = [s.p.reduce((a, p) => a + p[0], 0) / s.p.length, s.p.reduce((a, p) => a + p[1], 0) / s.p.length];
  for (let n = 0; n < 300; n++) {
    const x = dist === 'gaussian' ? c[0] + gauss() * (b[2] - b[0]) / 5 : b[0] + Math.random() * (b[2] - b[0]);
    const y = dist === 'gaussian' ? c[1] + gauss() * (b[3] - b[1]) / 5 : b[1] + Math.random() * (b[3] - b[1]);
    if ((s.k === 'rect' && x > b[0] && x < b[2] && y > b[1] && y < b[3]) || (s.k === 'circle' && Math.hypot(x - s.cx, y - s.cy) <= s.r) || (s.k === 'poly' && inPoly(s.p, x, y))) return [x, y];
  }
  return c;
}
function testHits() {
  if (!valid()) return;
  $('#hits').innerHTML = Array.from({ length: 35 }, () => { const [x, y] = sample(); return `<circle class="hit" cx="${x}" cy="${y}" r="2.2" style="--d:${(Math.random() * 0.9).toFixed(2)}s"/>`; }).join('');
}
function nudge(dx, dy) {
  if (!shape) return;
  const d = [dx / G.k, dy / G.k];
  if (shape.k === 'rect' || shape.k === 'point') { shape.x += d[0]; shape.y += d[1]; }
  if (shape.k === 'circle') { shape.cx += d[0]; shape.cy += d[1]; }
  if (shape.k === 'poly') shape.p = shape.p.map(p => [p[0] + d[0], p[1] + d[1]]);
  $('#hits').innerHTML = '';
  draw();
}
addEventListener('keydown', e => {
  if (!CAP) return;
  const typing = e.target.tagName === 'INPUT' && e.target.type === 'text';
  if (e.key === 'Escape') { e.preventDefault(); return endCapture(null); }
  if (e.key === 'Enter' && !(e.target.tagName === 'BUTTON')) { e.preventDefault(); return save(); }
  if (typing || e.target.tagName === 'SELECT') return;
  const step = e.shiftKey ? 10 : 1;
  if (e.key === 'ArrowLeft') { e.preventDefault(); nudge(-step, 0); }
  if (e.key === 'ArrowRight') { e.preventDefault(); nudge(step, 0); }
  if (e.key === 'ArrowUp') { e.preventDefault(); nudge(0, -step); }
  if (e.key === 'ArrowDown') { e.preventDefault(); nudge(0, step); }
  if (e.key === 'Backspace' && shape?.k === 'poly') { e.preventDefault(); shape.p.pop(); if (!shape.p.length) shape = null; draw(); }
  if (['1', '2', '3', '4'].includes(e.key)) setTool(['rect', 'circle', 'poly', 'point'][+e.key - 1]);
  if (e.key.toLowerCase() === 't') testHits();
});

/* ---------------------------------------------------------------- zones guide */
async function refreshZonesWin() {
  if (!ZONES_DATA) return;
  try {
    const t = ZONES_DATA.target || {};
    targetWin = await invoke('target_info', { process: t.process || '', title: t.title || '' });
  } catch { targetWin = null; }
}

async function toggleZones() {
  ZONES = !ZONES;
  if (ZONES) {
    await loadKeys();
    try { const g = await invoke('overlay_geom'); if (g?.k) G = g; } catch {}
    T.event.emit('zones-request');
    await refreshZonesWin();
    renderZones();
    const count = ZONES_DATA?.steps?.filter(s => s.enabled && s.zone)?.length || 0;
    toast(`Zones guide: on (${count} ${count === 1 ? 'area' : 'areas'})`);
  } else {
    toast('Zones guide: off');
  }
  sync();
}

function renderZones() {
  if (!ZONES || !ZONES_DATA) {
    $('#z-shapes').innerHTML = '';
    $('#z-paths').innerHTML = '';
    $('#z-labels').innerHTML = '';
    $('#z-winr').setAttribute('width', '0');
    $('#z-winl').textContent = '';
    return;
  }

  $('#z-mname').textContent = ZONES_DATA.macro_name || 'Active macro';
  if ($('#z-key')) $('#z-key').textContent = KEYS.zones || 'F4';

  const target = ZONES_DATA.target || {};
  const authored = ZONES_DATA.authored;
  const onResize = target.on_resize || 'scale';

  const w = targetWin || { x: G.ox, y: G.oy, w: innerWidth * G.k, h: innerHeight * G.k, process: target.process || 'Whole screen' };
  const [wx, wy] = toCss(w.x, w.y);
  const ww = w.w / G.k, wh = w.h / G.k;

  if (target.process) {
    $('#z-winr').setAttribute('x', wx);
    $('#z-winr').setAttribute('y', wy);
    $('#z-winr').setAttribute('width', ww);
    $('#z-winr').setAttribute('height', wh);
    $('#z-winl').setAttribute('x', wx + 8);
    $('#z-winl').setAttribute('y', Math.max(14, wy + 18));
    $('#z-winl').textContent = `${target.process}  ${w.w}×${w.h}`;
  } else {
    $('#z-winr').setAttribute('width', '0');
    $('#z-winl').textContent = '';
  }

  const aw = authored?.w > 0 ? authored.w : w.w;
  const ah = authored?.h > 0 ? authored.h : w.h;

  function mapPt(x, y) {
    let px = x, py = y;
    if (onResize === 'center') {
      px = x + (w.w - aw) / 2;
      py = y + (w.h - ah) / 2;
    } else if (onResize === 'top_left') {
      px = x;
      py = y;
    } else {
      if (aw > 0 && ah > 0) {
        px = (x * w.w) / aw;
        py = (y * w.h) / ah;
      }
    }
    return toCss(w.x + px, w.y + py);
  }

  const enabledSteps = (ZONES_DATA.steps || []).filter(s => s.enabled && s.zone);
  $('#z-count').textContent = `${enabledSteps.length} ${enabledSteps.length === 1 ? 'area' : 'areas'}`;

  let shapesHtml = '';
  let pathsHtml = '';
  let labelsHtml = '';
  const centers = [];

  enabledSteps.forEach((s, idx) => {
    const z = s.zone;
    const shapeKind = z.shape || 'point';
    const c = COLOR[shapeKind] || '#d97757';
    const stepNum = s.idx || (idx + 1);

    let center = [0, 0];
    let shapeSvg = '';

    if (shapeKind === 'rect') {
      const [x1, y1] = mapPt(z.x, z.y);
      const scaleX = (w.w / aw) / G.k;
      const scaleY = (w.h / ah) / G.k;
      const sw = Math.max(4, z.w * scaleX);
      const sh = Math.max(4, z.h * scaleY);
      center = [x1 + sw / 2, y1 + sh / 2];
      shapeSvg = `<g>
        <rect x="${x1}" y="${y1}" width="${sw}" height="${sh}" rx="4" fill="${c}" fill-opacity="0.14" stroke="${c}" stroke-width="1.8" stroke-dasharray="6 4"/>
        <rect x="${x1}" y="${y1}" width="${sw}" height="${sh}" rx="4" fill="none" stroke="${c}" stroke-width="0.8" opacity="0.3"/>
        <circle cx="${center[0]}" cy="${center[1]}" r="2.2" fill="${c}" opacity="0.9"/>
      </g>`;
    } else if (shapeKind === 'circle') {
      const [cx, cy] = mapPt(z.x, z.y);
      const scale = (((w.w / aw) + (w.h / ah)) / 2) / G.k;
      const sr = Math.max(3, z.r * scale);
      center = [cx, cy];
      shapeSvg = `<g>
        <circle cx="${cx}" cy="${cy}" r="${sr}" fill="${c}" fill-opacity="0.14" stroke="${c}" stroke-width="1.8" stroke-dasharray="6 4"/>
        <circle cx="${cx}" cy="${cy}" r="2.5" fill="${c}" opacity="0.9"/>
      </g>`;
    } else if (shapeKind === 'poly') {
      const pts = (z.points || []).map(p => mapPt(p[0], p[1]));
      if (pts.length) {
        const avgX = pts.reduce((a, p) => a + p[0], 0) / pts.length;
        const avgY = pts.reduce((a, p) => a + p[1], 0) / pts.length;
        center = [avgX, avgY];
        const ptsStr = pts.map(p => p.join(',')).join(' ');
        shapeSvg = `<g>
          <polygon points="${ptsStr}" fill="${c}" fill-opacity="0.14" stroke="${c}" stroke-width="1.8" stroke-dasharray="6 4"/>
          ${pts.map(p => `<circle cx="${p[0]}" cy="${p[1]}" r="3" fill="${c}"/>`).join('')}
          <circle cx="${center[0]}" cy="${center[1]}" r="2.5" fill="${c}" opacity="0.9"/>
        </g>`;
      }
    } else {
      const [px, py] = mapPt(z.x, z.y);
      center = [px, py];
      shapeSvg = `<g>
        <circle cx="${px}" cy="${py}" r="9" fill="none" stroke="${c}" stroke-width="1.2" stroke-dasharray="3 3"/>
        <path d="M${px - 14} ${py}h28M${px} ${py - 14}v28" stroke="${c}" stroke-width="1.8"/>
        <circle cx="${px}" cy="${py}" r="2.5" fill="var(--bone)"/>
      </g>`;
    }

    shapesHtml += shapeSvg;
    centers.push(center);

    const actionKind = s.action?.kind || 'click';
    const actName = actionKind === 'click' ? (s.action?.count === 2 ? 'Double click' : `${s.action?.button || 'Left'} click`)
      : actionKind === 'hold' ? 'Hold'
      : actionKind === 'drag' ? 'Drag'
      : actionKind === 'key' ? `Key ${s.action?.key || ''}`
      : actionKind === 'text' ? 'Type'
      : actionKind;
    const delayMs = Math.round(s.delay?.mean || 0);

    const bx = Math.round(center[0] + 12);
    const by = Math.round(center[1] - 22);

    const nameText = esc(s.name || `Step ${stepNum}`);
    const actText = esc(actName);
    const delayText = delayMs > 0 ? `· ⏱ ${delayMs}ms` : '';
    const approxW = Math.max(90, Math.min(220, (nameText.length * 7) + 36));

    labelsHtml += `<g class="z-badge" transform="translate(${bx}, ${by})">
      <rect x="0" y="0" width="${approxW}" height="24" rx="6" fill="#0e0d0ce8" stroke="var(--line2)" stroke-width="1"/>
      <circle cx="12" cy="12" r="7.5" fill="${c}"/>
      <text x="12" y="12" fill="#0e0d0c" font-size="10" font-weight="700" text-anchor="middle" dominant-baseline="central">${stepNum}</text>
      <text x="25" y="10" fill="var(--bone)" font-size="11" font-weight="500">${nameText.slice(0, 18)}</text>
      <text x="25" y="20" fill="var(--fog)" font-size="9" font-family="var(--m)">${actText} ${delayText}</text>
    </g>`;
  });

  for (let i = 0; i < centers.length - 1; i++) {
    const p1 = centers[i], p2 = centers[i + 1];
    pathsHtml += `<line x1="${p1[0]}" y1="${p1[1]}" x2="${p2[0]}" y2="${p2[1]}" stroke="var(--dim)" stroke-opacity="0.35" stroke-width="1.4" stroke-dasharray="4 4" marker-end="url(#z-arrow)"/>`;
  }

  $('#z-shapes').innerHTML = shapesHtml;
  $('#z-paths').innerHTML = pathsHtml;
  $('#z-labels').innerHTML = labelsHtml;
}

setInterval(async () => {
  if (!ZONES || CAP) return;
  await refreshZonesWin();
  renderZones();
}, 1000);

/* ---------------------------------------------------------------- events */
listen('overlay-geom', ({ payload }) => { G = payload; });
listen('capture-begin', ({ payload }) => beginCapture(payload));
listen('overlay-toggle', ({ payload }) => {
  if (payload === 'hud') { HUD = !HUD; toast(HUD ? 'Telemetry on' : 'Telemetry off'); }
  if (payload === 'pill') { PILL = !PILL; try { localStorage.setItem('aether.pill', PILL ? '1' : '0'); } catch { /* ignore */ } toast(PILL ? 'Status pill on' : 'Status pill hidden'); }
  if (payload === 'zones') toggleZones();
  sync();
});
listen('overlay-toggle-req', ({ payload }) => {
  if (payload === 'hud') { HUD = !HUD; invoke('overlay_geom').then(g => { if (g.k) G = g; }).catch(() => {}); sync(); }
  if (payload === 'zones') toggleZones();
});
listen('zones-data', ({ payload }) => {
  ZONES_DATA = payload;
  if (ZONES) refreshZonesWin().then(renderZones);
});
listen('pill-pref', ({ payload }) => { PILL = !!payload; sync(); });
listen('overlay-toast', ({ payload }) => toast(payload));
listen('overlay-toast-req', ({ payload }) => { if (!CAP) toast(payload); });
listen('run-state', ({ payload }) => {
  const was = RUN.state;
  RUN = payload;
  if (RUN.state === 'idle') ghostUntil = Math.min(ghostUntil, Date.now() + 800);
  if (was === 'idle' && RUN.state !== 'idle') { loadKeys(); invoke('overlay_geom').then(g => { if (g.k) G = g; }).catch(() => {}); }
  renderPill(); sync();
});
listen('record-state', ({ payload }) => {
  REC = { on: payload.recording, started: payload.started || 0, process: payload.process };
  if (REC.on) loadKeys();
  renderPill(); sync();
});
listen('ghost', ({ payload }) => {
  const [x, y] = toCss(payload.x, payload.y);
  const g = $('#ghost');
  g.style.transform = `translate(${x}px, ${y}px)`;
  ghostUntil = Date.now() + 1500;
  if (payload.click) { const r = document.createElement('i'); r.className = 'ring'; g.appendChild(r); setTimeout(() => r.remove(), 650); }
  sync();
});
loadKeys();
invoke('overlay_geom').then(g => { if (g.k) G = g; }).catch(() => {});

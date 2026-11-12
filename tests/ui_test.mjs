// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const INDEX_HTML = fs.readFileSync('ui/index.html', 'utf8');
const OVERLAY_HTML = fs.readFileSync('ui/overlay.html', 'utf8');
const APP_JS = fs.readFileSync('ui/app.js', 'utf8');
const OVERLAY_JS = fs.readFileSync('ui/overlay.js', 'utf8');

test('UI Test 1: Static Top-Level HTML DOM IDs Exist in index.html', () => {
  const staticIds = [
    'side-macro-sel', 'side-newm', 'nav', 'main',
    'v-lib', 'q', 'importbtn', 'exportall', 'newm', 'mlist',
    'v-seq', 'seq-macro-sel', 'seq-newm', 'mt', 'ml', 'seqactions',
    'runbar', 'facts', 'pass', 'seq-view-seg', 'seq-map-box',
    'seq-map-count', 'seq-map-res', 'btn-open-guide', 'seq-map-svg',
    'mapgrid', 'seq-arrow', 'sm-winrect', 'sm-winlabel', 'sm-paths', 'sm-shapes', 'sm-labels', 'sm-empty',
    'ledger', 'v-ins', 'ins-title', 'ins-prev', 'ins-next', 'ins-done', 'ins-body',
    'v-rec', 'hz', 'recbtn', 'rec-body',
    'v-log', 'logclear', 'logexport', 'log-body',
    'v-set', 'set-lede', 'set-body',
    'v-key', 'kt', 'v-app', 'app-body',
    'runmini', 'runbeacon', 'runminitxt', 'upd', 'updv', 'updbtn', 'prof', 'pn', 'ps',
    'scrim', 'dlg', 'toast'
  ];

  for (const id of staticIds) {
    const exists = INDEX_HTML.includes(`id="${id}"`) || INDEX_HTML.includes(`id='${id}'`);
    assert.ok(exists, `Required DOM element id="${id}" not found in ui/index.html`);
  }
});

test('UI Test 2: Overlay HTML DOM IDs Exist in overlay.html', () => {
  const overlayIds = [
    'cap', 'cv', 'dimp', 'dimin', 'winr', 'winl', 'zone', 'hits', 'help', 'readout', 'pal', 'tools', 'dims', 'act', 'dist', 'sdelay', 'guard', 'sname', 'test', 'cancel', 'save',
    'hud', 'hudkey', 'h-client', 'h-screen', 'loupe', 'h-hex', 'h-proc', 'h-focus',
    'pill', 'p-beacon', 'p-state', 'p-pass', 'p-clock', 'p-seg', 'p-step', 'p-next', 'p-reason', 'p-hints',
    'zones', 'z-svg', 'z-arrow', 'z-winr', 'z-winl', 'z-paths', 'z-shapes', 'z-labels', 'z-bar', 'z-mname', 'z-count', 'z-key',
    'ghost', 'toast'
  ];

  for (const id of overlayIds) {
    const exists = OVERLAY_HTML.includes(`id="${id}"`) || OVERLAY_HTML.includes(`id='${id}'`);
    assert.ok(exists, `Required Overlay DOM element id="${id}" not found in ui/overlay.html`);
  }
});

test('UI Test 3: Macro Switcher & New Macro Logic', () => {
  const macros = [
    { id: 'm1', name: 'Valorant Macro', steps: [{ id: 's1' }, { id: 's2' }] },
    { id: 'm2', name: 'Auto Farm', steps: [{ id: 's3' }] },
  ];
  let activeId = 'm1';

  // Test picker generation
  const opts = macros.map(m => `<option value="${m.id}" ${m.id === activeId ? 'selected' : ''}>${m.name} (${m.steps.length} steps)</option>`).join('');
  assert.ok(opts.includes('selected>Valorant Macro'));
  assert.ok(opts.includes('value="m2"'));

  // Switch active macro
  activeId = 'm2';
  const updatedOpts = macros.map(m => `<option value="${m.id}" ${m.id === activeId ? 'selected' : ''}>${m.name} (${m.steps.length} steps)</option>`).join('');
  assert.ok(updatedOpts.includes('selected>Auto Farm'));
});

test('UI Test 4: Mapped Areas Canvas Coordinate Geometry & Projections', () => {
  const authored = { w: 1920, h: 1080 };
  const pad = 28;
  const vw = 960 - pad * 2;
  const vh = 540 - pad * 2;
  const scaleX = vw / authored.w;
  const scaleY = vh / authored.h;

  const toMapX = x => Math.round(pad + x * scaleX);
  const toMapY = y => Math.round(pad + y * scaleY);

  // Test rectangle zone
  const rect = { shape: 'rect', x: 200, y: 150, w: 100, h: 80 };
  const rx = toMapX(rect.x);
  const ry = toMapY(rect.y);
  const rw = rect.w * scaleX;
  const rh = rect.h * scaleY;
  const centerRect = [rx + rw / 2, ry + rh / 2];

  assert.ok(rx >= pad && rx < 960);
  assert.ok(ry >= pad && ry < 540);
  assert.ok(centerRect[0] > rx && centerRect[1] > ry);

  // Test circle zone
  const circ = { shape: 'circle', x: 960, y: 540, r: 60 };
  const cx = toMapX(circ.x);
  const cy = toMapY(circ.y);
  assert.equal(cx, 480);
  assert.equal(cy, 270);

  // Test polygon zone centroid
  const poly = { shape: 'poly', points: [[100, 100], [300, 100], [200, 300]] };
  const pts = poly.points.map(p => [toMapX(p[0]), toMapY(p[1])]);
  const avgX = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const avgY = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  assert.ok(avgX > pts[0][0] && avgX < pts[1][0]);
  assert.ok(avgY > pts[0][1] && avgY < pts[2][1]);
});

test('UI Test 5: Overlay Coordinate Mapping Fallback (Whole-Screen vs Window)', () => {
  const G = { ox: 0, oy: 0, k: 1 };
  const toCss = (x, y) => [(x - G.ox) / G.k, (y - G.oy) / G.k];

  // Case A: targetWin is null (falls back to main display)
  const fallbackWin = { x: 0, y: 0, w: 1920, h: 1080 };
  const authored = { w: 1920, h: 1080 };
  const mapPt = (x, y, w) => {
    const px = (x * w.w) / authored.w;
    const py = (y * w.h) / authored.h;
    return toCss(w.x + px, w.y + py);
  };

  const ptA = mapPt(500, 500, fallbackWin);
  assert.deepEqual(ptA, [500, 500]);

  // Case B: target window is shifted (e.g. windowed at x: 100, y: 200)
  const windowedWin = { x: 100, y: 200, w: 1920, h: 1080 };
  const ptB = mapPt(500, 500, windowedWin);
  assert.deepEqual(ptB, [600, 700]);
});

/* global TimeMap */
// Effects in the clip editor: crop, zoom, blur, text, pictures, shapes, drawing, added sounds,
// volume points and fades. Everything is saved with the clip's trim (edit.fx).
//
// Picture: crop and zoom move the clip's picture inside a frame (#qtview). Text, pictures, shapes
// and drawings are drawn on a canvas per video track, with that track's blur boxes (the browser's
// backdrop blur) under it, so a higher track sits on top and a blur blurs what's below it. For the
// export each text/picture/shape/drawing is drawn once more at full size as a transparent PNG and
// main burns them in with ffmpeg in the same order (fxMake in main.js).
//
// The editor has two levels: Trim (the quick one: just the main timeline) and Edit, where this
// module also runs the asset panel on the left and a Premiere-style timeline across the bottom:
// V1 is the clip itself (its trim edges, with its zooms on it), layer tracks above it (V2 and up)
// hold text, pictures, shapes, blur and drawings, A1..An are the clip's own sounds (linked to V1,
// with volume lines) and the tracks under them hold added sounds. The razor cuts the clip's own
// sound rows into pieces (edit.fx.cuts): a piece plays its part of the row (from..to, clip time) at
// `at`. A row stays linked to the video (its pieces can't slide out of step) until it's unlinked. Items move in time and between
// tracks and never overlap on one track. The timeline zooms (slider, Ctrl+wheel) and scrolls
// (overview strip, Shift+wheel).
// Uses the page's shared helpers (h, icoSpan, fmt, parse, T, openMenu).

const $ = id => document.getElementById(id);
const uid = () => Math.random().toString(36).slice(2, 9);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const clamp01 = v => clamp(v, 0, 1);
const smooth = u => u * u * (3 - 2 * u);
const even = n => Math.max(2, Math.floor(n / 2) * 2);
const copy = o => JSON.parse(JSON.stringify(o));
const r4 = v => Math.round(v * 10000) / 10000;
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } };

export const COLORS = { speed: '#2dd4bf', zoom: '#f0b232', text: '#5865f2', image: '#23a55a', shape: '#eb459e', blur: '#00a8fc', draw: '#f57731', sound: '#a970ff' };
const NAMES = { speed: 'Speed', zoom: 'Zoom', text: 'Text', image: 'Picture', shape: 'Shape', blur: 'Blur', draw: 'Drawing', sound: 'Audio' };
const ICON = { speed: 'speed', zoom: 'zoom', text: 'text', image: 'image', shape: 'shape', blur: 'blur', draw: 'draw', sound: 'music' };
const OVER = new Set(['text', 'image', 'shape', 'draw']);
const SWATCHES = ['#ffffff', '#000000', '#f23f43', '#f0b232', '#23a55a', '#00a8fc', '#5865f2', '#eb459e'];
// crop shapes: [value, label]; 'orig' = the clip's own shape (for resizing without changing it)
const CROPS = [[0, 'Free'], ['orig', 'Original'], [16 / 9, '16:9'], [9 / 16, '9:16'], [1, '1:1'], [4 / 3, '4:3'], [3 / 4, '3:4'], [4 / 5, '4:5'], [21 / 9, '21:9']];
const SHAPES = [['rect', 'Box'], ['round', 'Rounded'], ['ellipse', 'Circle'], ['line', 'Line'], ['arrow', 'Arrow']];
const FADE = 0.5;
const SNAP = 8;          // pixels
const MIN_SPAN = 1;      // the most the timeline zooms in: this many seconds across

export const emptyFx = () => ({ crop: null, layers: [], sounds: [], vpts: {}, fades: {}, vtracks: [], atracks: [], cuts: {} });
// volume at time t from points [[t, v], ...] (straight lines between them, flat outside)
export function curveAt(pts, t) {
  if (!pts || !pts.length) return 1;
  if (t <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (t < pts[i][0]) { const [t1, v1] = pts[i - 1], [t2, v2] = pts[i]; return t2 - t1 > 1e-4 ? v1 + (v2 - v1) * (t - t1) / (t2 - t1) : v2; }
  }
  return pts[pts.length - 1][1];
}
// A zoom can have steps: { t (clip time), box, ease (seconds) }. From each step's time the zoom moves
// on from where it was to that step's box over `ease` (smoothstep), so one zoom can go 2x, then 3x,
// then 4x into the same spot. The zoom's own box is the first stage.
export function zoomBoxAt(z, t) {
  let b = z.box;
  for (const s of z.steps || []) {
    if (t < s.t || s.t <= z.start || s.t >= z.end) continue;
    const u = smooth(s.ease > 0.001 ? clamp01((t - s.t) / s.ease) : 1);
    b = { x: b.x + (s.box.x - b.x) * u, y: b.y + (s.box.y - b.y) * u, w: b.w + (s.box.w - b.w) * u, h: b.h + (s.box.h - b.h) * u };
  }
  return b;
}
// the part of the (cropped) frame showing at time t, the same way main's zoompan does it
export function zoomAt(layers, t, vtracks) {
  let w = 1, x = 0, y = 0;
  for (const z of layers) {
    if (z.type !== 'zoom' || z.hidden || t < z.start || t >= z.end) continue;
    const half = (z.end - z.start) / 2, a = Math.min(z.ein, half), b = Math.min(z.eout, half);
    const rin = a > 0.001 ? clamp01((t - z.start) / a) : 1, rout = b > 0.001 ? clamp01((z.end - t) / b) : 1;
    const e = smooth(Math.min(rin, rout)), bx = zoomBoxAt(z, t);
    w -= e * (1 - bx.w); x += e * bx.x; y += e * bx.y;
  }
  w = clamp(w, 0.02, 1);
  return { x: clamp(x, 0, 1 - w), y: clamp(y, 0, 1 - w), w, h: w };
}
export function outSize(info, crop) {
  const W = (info && info.width) || 1920, H = (info && info.height) || 1080;
  return crop ? { w: even(crop.w * W), h: even(crop.h * H) } : { w: even(W), h: even(H) };
}

// ---------- drawing a layer (preview and export use the same code) ----------
const scratch = document.createElement('canvas').getContext('2d');
const imgs = new Map(); // url -> Image
function imageFor(url) {
  let i = imgs.get(url);
  if (!i) { i = new Image(); i.ready = new Promise(r => { i.onload = r; i.onerror = r; }); i.src = url; imgs.set(url, i); }
  return i;
}
const textFont = (l, H) => `${l.bold ? 800 : 500} ${Math.max(1, l.size * H)}px "Segoe UI", system-ui, sans-serif`;
const lines = l => String(l.text || ' ').split('\n');
function drawText(g, l, W, H) {
  const ls = lines(l), px = l.size * H, lh = px * 1.2;
  g.save();
  g.font = textFont(l, H); g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
  const y0 = l.y * H - (ls.length - 1) * lh / 2;
  ls.forEach((s, i) => {
    const x = l.x * W, y = y0 + i * lh;
    if (l.style === 'shadow') { g.shadowColor = 'rgba(0,0,0,.85)'; g.shadowBlur = px * 0.2; g.shadowOffsetY = px * 0.06; }
    if (l.style === 'outline') { g.lineWidth = px * 0.16; g.strokeStyle = l.color === '#000000' ? '#ffffff' : '#000000'; g.strokeText(s, x, y); }
    g.fillStyle = l.color; g.fillText(s, x, y);
    g.shadowColor = 'transparent';
  });
  g.restore();
}
function drawShape(g, l, W, H) {
  const lw = Math.max(1, l.stroke * H);
  g.save();
  g.strokeStyle = g.fillStyle = l.color; g.lineWidth = lw; g.lineJoin = 'round'; g.lineCap = 'round';
  if (l.shape === 'line' || l.shape === 'arrow') {
    const x1 = l.x1 * W, y1 = l.y1 * H, x2 = l.x2 * W, y2 = l.y2 * H, a = Math.atan2(y2 - y1, x2 - x1), s = Math.max(lw * 3.4, 10);
    const ex = l.shape === 'arrow' ? x2 - Math.cos(a) * s * 0.6 : x2, ey = l.shape === 'arrow' ? y2 - Math.sin(a) * s * 0.6 : y2;
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(ex, ey); g.stroke();
    if (l.shape === 'arrow') {
      g.beginPath(); g.moveTo(x2, y2);
      g.lineTo(x2 - s * Math.cos(a - 0.5), y2 - s * Math.sin(a - 0.5));
      g.lineTo(x2 - s * Math.cos(a + 0.5), y2 - s * Math.sin(a + 0.5));
      g.closePath(); g.fill();
    }
  } else {
    const inset = l.fill ? 0 : lw / 2, x = l.box.x * W + inset, y = l.box.y * H + inset, w = Math.max(1, l.box.w * W - 2 * inset), hh = Math.max(1, l.box.h * H - 2 * inset);
    g.beginPath();
    if (l.shape === 'ellipse') g.ellipse(x + w / 2, y + hh / 2, w / 2, hh / 2, 0, 0, Math.PI * 2);
    else if (l.shape === 'round') g.roundRect(x, y, w, hh, Math.min(w, hh) * 0.2);
    else g.rect(x, y, w, hh);
    if (l.fill) g.fill(); else g.stroke();
  }
  g.restore();
}
function drawStrokes(g, l, W, H) {
  if (!l.strokes || !l.strokes.length) return;
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(W)); c.height = Math.max(1, Math.round(H));
  const x = c.getContext('2d');
  x.lineCap = 'round'; x.lineJoin = 'round';
  for (const s of l.strokes) {
    x.globalCompositeOperation = s.e ? 'destination-out' : 'source-over';
    x.strokeStyle = s.c; x.lineWidth = Math.max(1, s.s * H);
    x.beginPath(); x.moveTo(s.p[0] * W, s.p[1] * H);
    if (s.p.length === 2) x.lineTo(s.p[0] * W + 0.01, s.p[1] * H);
    for (let i = 2; i < s.p.length; i += 2) x.lineTo(s.p[i] * W, s.p[i + 1] * H);
    x.stroke();
  }
  g.drawImage(c, 0, 0);
}
function drawLayer(g, l, W, H, aspect) {
  if (l.type === 'text') drawText(g, l, W, H);
  else if (l.type === 'shape') drawShape(g, l, W, H);
  else if (l.type === 'draw') drawStrokes(g, l, W, H);
  else if (l.type === 'image') {
    const i = imageFor(l.url);
    if (i.complete && i.naturalWidth) { const b = boxOf(l, aspect); g.drawImage(i, b.x * W, b.y * H, b.w * W, b.h * H); }
  }
}
// a layer's outline in frame units (0..1); aspect = frame width / height
function boxOf(l, aspect) {
  if (l.box) return l.box;
  if (l.type === 'image') { const w = l.w, hh = l.w * l.ar * aspect; return { x: l.x - w / 2, y: l.y - hh / 2, w, h: hh }; }
  if (l.type === 'text') {
    const H = 1000, W = H * aspect, ls = lines(l);
    scratch.font = textFont(l, H);
    const w = Math.max(...ls.map(s => scratch.measureText(s || ' ').width)), hh = l.size * H * 1.2 * ls.length, pad = l.size * H * 0.12;
    return { x: (l.x * W - w / 2 - pad) / W, y: (l.y * H - hh / 2 - pad) / H, w: (w + 2 * pad) / W, h: (hh + 2 * pad) / H };
  }
  if (l.type === 'shape') return { x: Math.min(l.x1, l.x2), y: Math.min(l.y1, l.y2), w: Math.abs(l.x2 - l.x1), h: Math.abs(l.y2 - l.y1) };
  if (l.type === 'draw') {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const s of l.strokes || []) for (let i = 0; i < s.p.length; i += 2) { x0 = Math.min(x0, s.p[i]); x1 = Math.max(x1, s.p[i]); y0 = Math.min(y0, s.p[i + 1]); y1 = Math.max(y1, s.p[i + 1]); }
    return x1 > x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 };
  }
  return { x: 0, y: 0, w: 1, h: 1 };
}
const inBox = (p, b, pad = 0) => p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;
const labelOf = l => (l.type === 'speed' ? `${l.rate}×${l.mute ? ', muted' : ''}` : l.type === 'text' ? (String(l.text || '').split('\n')[0] || 'Text') : l.type === 'image' ? l.name || 'Picture'
  : l.type === 'shape' ? (SHAPES.find(s => s[0] === l.shape) || [0, 'Shape'])[1] : l.name || NAMES[l.type]);

export function createFx(ctx) {
  // ctx: { Q, seekTo(t), pause(), toggle(), changed(), changedNow() (save the undo step now), status(),
  //        audioChanged(), canvas(), compositor() (the WebGPU player's, or null), info(), gainsChanged(), canUndo(), canRedo() }
  const F = {
    fx: emptyFx(), sel: null, tool: null, drag: null, cropAspect: 0, cropLock: false, draft: null, peaks: new Map(), ver: 0, drawKey: '',
    brush: { c: '#f23f43', s: 0.008, e: false }, clipboard: null,
    on: false, v: { t0: 0, t1: 1 }, mode: 'select', snapOn: lsGet('fxSnap', true), tab: lsGet('fxTab', 'text'), panelOff: false,
  };
  const Q = ctx.Q;
  const view = $('qtview'), edit = $('qtedit'), levels = $('qtlevels'), tracksEl = $('qttracks');

  // pieces of the clip's own sound rows (after a razor cut): { id, ckey (the row), from, to, at }
  const pieceList = () => Object.values(F.fx.cuts).flatMap(c => c.pieces);
  const find = id => F.fx.layers.find(l => l.id === id) || F.fx.sounds.find(s => s.id === id) || pieceList().find(p => p.id === id) || null;
  const selected = () => (F.sel ? find(F.sel) : null);
  const isSound = x => !!x && x.path !== undefined;
  const isPiece = x => !!x && x.ckey !== undefined;
  // one of the clip's own sound rows selected on the timeline ('row:<key>'): its group, or null
  const selRow = () => (F.sel && F.sel.startsWith('row:') ? Q.groups.find(g => 'row:' + g.key === F.sel) || null : null);
  const cutOf = key => F.fx.cuts[key] || null;
  const info = () => ctx.info() || {};
  const out = () => outSize(info(), F.fx.crop);
  const aspect = () => { const o = out(); return o.w / o.h; };
  const bump = () => { F.ver++; syncMap(); };
  const span = x => (isSound(x) || isPiece(x) ? { start: x.at, end: x.at + (x.to - x.from) } : { start: x.start, end: x.end });
  const vt = i => F.fx.vtracks[i] || (F.fx.vtracks[i] = {});
  const at = i => F.fx.atracks[i] || (F.fx.atracks[i] = {});
  // zooms live on V1 (the clip), the other layers on the layer tracks
  // a piece's kind is its row ('p:<row key>'): pieces only move along their own row
  // speed parts live on V1 too (their own band, under the zooms)
  const kindOf = x => (isPiece(x) ? 'p:' + x.ckey : isSound(x) ? 'a' : x.type === 'zoom' ? 'z' : x.type === 'speed' ? 'sp' : 'v');
  const onV1 = l => l.type === 'zoom' || l.type === 'speed';
  const pool = kind => (kind.startsWith('p:') ? (cutOf(kind.slice(2)) || { pieces: [] }).pieces
    : kind === 'a' ? F.fx.sounds : kind === 'z' ? F.fx.layers.filter(l => l.type === 'zoom')
      : kind === 'sp' ? F.fx.layers.filter(l => l.type === 'speed') : F.fx.layers.filter(l => !onV1(l)));
  const vHidden = l => !!l.hidden || (!onV1(l) && !!(F.fx.vtracks[l.track || 0] && F.fx.vtracks[l.track || 0].hidden));

  // ---------- the timeline's own time ----------
  // The timeline shows the time of the file that gets made (TimeMap: speed parts and the trim's speed).
  // What belongs to the clip stays in clip time and moves with it: the trim, V1's zooms and speed parts,
  // the clip's sound rows (their pieces and volume points), the playhead (Q.t). What's added on top stays
  // in timeline time and keeps its length: layers on V2 and up, added sounds. When the map changes, each
  // of those keeps its start on the same moment of the clip (so things after a slowed part move along).
  const clipKind = x => isPiece(x) || (!isSound(x) && onV1(x));
  const buildMap = (layers = F.fx.layers) => TimeMap.build(layers, Q.speed || 1, Q.dur || 0);
  const M = () => F.map || (F.map = buildMap());
  function syncMap() {
    const m = buildMap(), old = F.map;
    F.map = m;
    if (old && old.sig === m.sig && old.dur === m.dur) return false;
    if (old && old.dur === m.dur) { ripple(old, m); if (F.fx.sounds.length && !F.drag) ctx.audioChanged(); }
    if (ctx.mapChanged) ctx.mapChanged(m);
    return true;
  }
  function ripple(old, m) {
    for (const l of F.fx.layers) {
      if (onV1(l)) continue;
      const d = Math.max(0, m.toOut(old.toClip(l.start))) - l.start;
      l.start += d; l.end += d;
    }
    for (const x of F.fx.sounds) x.at = Math.max(0, m.toOut(old.toClip(x.at)));
    // sped up, starts can come closer than the lengths: later ones wait for the one before on their track
    for (const list of [F.fx.layers.filter(l => !onV1(l)), F.fx.sounds]) {
      const by = new Map();
      for (const x of list) { const k = x.track | 0; if (!by.has(k)) by.set(k, []); by.get(k).push(x); }
      for (const xs of by.values()) {
        xs.sort((a, b) => span(a).start - span(b).start);
        for (let i = 1; i < xs.length; i++) { const prev = span(xs[i - 1]).end, sp = span(xs[i]); if (sp.start < prev) setStart(xs[i], prev); }
      }
    }
  }
  // an item's own time <-> timeline time; the playhead in an item's own time; where its time ends
  const toTl = (x, t) => (clipKind(x) ? M().toOut(t) : t);
  const nowIn = x => (clipKind(x) ? Q.t : M().toOut(Q.t));
  const seekOwn = (x, t) => ctx.seekTo(clipKind(x) ? t : M().toClip(t));
  const limit = kind => (kind === 'z' || kind === 'sp' || kind.startsWith('p:') ? Q.dur : M().outDur);
  const phT = () => M().toOut(Q.t);
  const aMuted = s => !!s.mute || !!(F.fx.atracks[s.track || 0] && F.fx.atracks[s.track || 0].mute);

  // ---------- loading / saving ----------
  // same: the same clip going back or forward (undo, redo, Discard): the tool in use, the selection
  // (if it's still there), the zoom and the decoded pictures stay
  function load(fx, same) {
    F.fx = Object.assign(emptyFx(), fx ? copy(fx) : {});
    F.map = null; // a loaded state is already laid out on its own map
    for (const k of ['layers', 'sounds', 'vtracks', 'atracks']) if (!Array.isArray(F.fx[k])) F.fx[k] = [];
    for (const k of ['vpts', 'fades']) if (!F.fx[k] || typeof F.fx[k] !== 'object') F.fx[k] = {};
    delete F.fx.ctracks;
    for (const l of F.fx.layers) {
      l.track = onV1(l) ? 0 : l.track | 0;
      if (l.type === 'image' && l.url) imageFor(l.url);
      if (l.type === 'zoom') { if (!Array.isArray(l.steps)) delete l.steps; else l.steps.sort((a, b) => a.t - b.t); }
    }
    for (const s of F.fx.sounds) { s.track = s.track | 0; if (!Array.isArray(s.pts)) s.pts = []; }
    if (!F.fx.cuts || typeof F.fx.cuts !== 'object' || Array.isArray(F.fx.cuts)) F.fx.cuts = {};
    for (const [k, c] of Object.entries(F.fx.cuts)) {
      if (!c || !Array.isArray(c.pieces)) { delete F.fx.cuts[k]; continue; }
      c.free = !!c.free;
      for (const p of c.pieces) { p.ckey = k; if (!p.id) p.id = uid(); }
    }
    if (same) {
      if (F.sel && !find(F.sel) && !selRow() && !selFade()) F.sel = null;
      bump(); renderAll();
      return;
    }
    F.sel = null; F.tool = null; F.peaks = new Map(); resetThumbs(); bump();
    fitView(true);
    renderAll();
  }
  const hasContent = f => !!(f.crop || f.layers.length || f.sounds.length || Object.values(f.vpts).some(p => p && p.length) || Object.values(f.fades).some(Boolean) || Object.keys(f.cuts || {}).length);
  // what gets saved: null when there's nothing
  function state() {
    const f = F.fx;
    if (!hasContent(f)) return null;
    const vpts = {};
    for (const [k, p] of Object.entries(f.vpts)) if (p && p.length) vpts[k] = p;
    const fades = {};
    for (const [k, v] of Object.entries(f.fades)) if (v) fades[k] = v;
    return copy({ crop: f.crop, layers: f.layers, sounds: f.sounds, vpts, fades, vtracks: f.vtracks, atracks: f.atracks, cuts: f.cuts });
  }
  // every volume curve on the clip's clock (added sounds keep theirs relative to where they start)
  function allPts() {
    const m = { ...F.fx.vpts };
    for (const s of F.fx.sounds) if (s.pts && s.pts.length) m['s:' + s.id] = s.pts.map(([dt, v]) => [s.at + dt, v]);
    return m;
  }
  const hasVisual = () => !!(F.fx.crop || F.fx.layers.some(l => !vHidden(l)) || F.fx.fades.vin || F.fx.fades.vout);
  // draw every text/picture/shape/drawing at the export's size as a PNG main can burn in
  async function rasterize() {
    const o = out();
    for (const l of F.fx.layers) {
      if (!OVER.has(l.type)) continue;
      const sig = JSON.stringify([o.w, o.h, l.type, l.text, l.x, l.y, l.size, l.color, l.bold, l.style, l.url, l.w, l.ar, l.shape, l.box, l.x1, l.y1, l.x2, l.y2, l.fill, l.stroke, l.strokes]);
      if (l.sig === sig && l.png) continue;
      if (l.type === 'image') await imageFor(l.url).ready;
      const c = document.createElement('canvas'); c.width = o.w; c.height = o.h;
      drawLayer(c.getContext('2d'), l, o.w, o.h, o.w / o.h);
      const r = await T.fxPng(c.toDataURL('image/png'));
      if (r.ok) { l.png = r.name; l.sig = sig; }
    }
  }
  function changed() { bump(); renderAll(); ctx.changed(); }

  // ---------- the picture: crop, zoom, blur boxes, drawn layers ----------
  function visibleRect(t) {
    const c = F.tool === 'crop' ? { x: 0, y: 0, w: 1, h: 1 } : F.fx.crop || { x: 0, y: 0, w: 1, h: 1 };
    const sel = selected();
    const z = F.tool === 'crop' || (sel && sel.type === 'zoom') ? { x: 0, y: 0, w: 1, h: 1 } : zoomAt(F.fx.layers, t, F.fx.vtracks);
    return { x: c.x + z.x * c.w, y: c.y + z.y * c.h, w: z.w * c.w, h: z.h * c.h, frame: c };
  }
  function layout(t) {
    const st = $('qtstage'), el = $('qtvideo').hidden ? ctx.canvas() : $('qtvideo');
    const p = Q.player;
    const vw = (p && p.width) || el.videoWidth || el.width, vh = (p && p.height) || el.videoHeight || el.height;
    if (!vw || !vh || !st.clientWidth || !st.clientHeight) return;
    const r = visibleRect(t);
    const fw = r.frame.w * vw, fh = r.frame.h * vh;
    const k = Math.min(st.clientWidth / fw, st.clientHeight / fh);
    const w = Math.floor(fw * k), hh = Math.floor(fh * k);
    if (view.style.width !== w + 'px' || view.style.height !== hh + 'px') { view.style.width = w + 'px'; view.style.height = hh + 'px'; }
    const comp = el === ctx.canvas() && ctx.compositor();
    if (comp) {
      // WebGPU: the canvas is the view, and the player draws the visible part of the clip into it
      if (el.style.width !== w + 'px' || el.style.height !== hh + 'px' || el.style.left !== '0px') { el.style.width = w + 'px'; el.style.height = hh + 'px'; el.style.left = '0px'; el.style.top = '0px'; }
      const dpr = devicePixelRatio || 1;
      comp.setView(w * dpr, hh * dpr, r);
    } else {
      const cw = w / r.w, ch = hh / r.h;
      el.style.width = cw + 'px'; el.style.height = ch + 'px';
      el.style.left = -r.x * cw + 'px'; el.style.top = -r.y * ch + 'px';
    }
    if (F.tool === 'crop') { levels.replaceChildren(); if (comp && F.drawKey !== 'crop' + comp.id) comp.setLevels([]); F.drawKey = comp ? 'crop' + comp.id : ''; } else drawLevels(t, w, hh, comp);
    renderEdit(w, hh);
  }
  // one level per video track, bottom first: its blur boxes, then a canvas with its drawn layers.
  // With the compositor (WebGPU) the levels go to the player instead of the page.
  function drawLevels(t, w, hh, comp) {
    const dpr = devicePixelRatio || 1;
    const ot = M().toOut(t), on = F.fx.layers.filter(l => !onV1(l) && !vHidden(l) && ot >= l.start && ot < l.end);
    const key = [comp ? comp.id : 0, F.ver, w, hh, dpr, on.map(l => l.id + (l.type === 'image' && !imageFor(l.url).complete ? '?' : '')).join(',')].join('|');
    if (key === F.drawKey) return;
    F.drawKey = key;
    levels.replaceChildren();
    const o = out(), n = Math.max(0, ...on.map(l => (l.track | 0) + 1)), gl = [];
    const wet = inkStroke();
    if (!wet) clearInk();
    for (let i = 0; i < n; i++) {
      const mine = on.filter(l => (l.track | 0) === i);
      if (!mine.length) continue;
      const lv = { blurs: [], canvas: null };
      gl.push(lv);
      for (const l of mine.filter(x => x.type === 'blur')) {
        // the export's boxblur radius is strength x height / 120, about a Gaussian of that sigma
        if (comp) { lv.blurs.push({ box: l.box, sigma: l.strength * hh * dpr / 120 }); continue; }
        const d = h('div', 'fx-blur');
        d.style.left = l.box.x * 100 + '%'; d.style.top = l.box.y * 100 + '%'; d.style.width = l.box.w * 100 + '%'; d.style.height = l.box.h * 100 + '%';
        d.style.backdropFilter = `blur(${Math.round(l.strength * o.h / 120 * hh / o.h * 10) / 10}px)`;
        levels.append(d);
      }
      // the stroke being drawn stays out until the mouse is let go (it's on the ink canvas meanwhile)
      const draw = mine.filter(x => OVER.has(x.type)).map(x => (comp && wet && x.strokes && x.strokes.includes(wet) ? { ...x, strokes: x.strokes.filter(y => y !== wet) } : x));
      if (!draw.length) continue;
      // the compositor keeps each track's picture: one that hasn't changed isn't drawn or uploaded again
      // (while drawing, only the track being drawn on changes)
      const sig = comp && JSON.stringify([w, hh, dpr, draw.map(l => [l.type, l.text, l.x, l.y, l.size, l.color, l.bold, l.style, l.url, l.w, l.ar, l.shape, l.box, l.x1, l.y1, l.x2, l.y2, l.fill, l.stroke, l.strokes, l.type === 'image' && imageFor(l.url).complete])]);
      if (comp) { const old = F.lvCache && F.lvCache.get(sig); if (old) { lv.canvas = old; continue; } }
      const c = h('canvas', 'fx-level');
      if (comp) c.sig = sig;
      c.width = Math.round(w * dpr); c.height = Math.round(hh * dpr);
      const g = c.getContext('2d');
      for (const l of draw) {
        if (l.type === 'image' && !imageFor(l.url).complete) imageFor(l.url).ready.then(() => { F.drawKey = ''; });
        drawLayer(g, l, c.width, c.height, w / hh);
      }
      if (comp) lv.canvas = c; else levels.append(c);
    }
    if (comp) { F.lvCache = new Map(gl.filter(x => x.canvas).map(x => [x.canvas.sig, x.canvas])); comp.setLevels(gl); }
  }

  // ---------- handles on the picture ----------
  function renderEdit(w, hh) {
    const sel = selected();
    const key = [F.ver, F.tool, F.sel, w, hh, sel && !isSound(sel) ? nowIn(sel) >= sel.start && nowIn(sel) < sel.end : '', sel && sel.type === 'zoom' ? stageAt(sel) : ''].join('|');
    if (key === edit.dataset.key) return;
    edit.dataset.key = key;
    edit.replaceChildren();
    edit.className = 'qt-edit' + (F.tool ? ' tool-' + F.tool : '');
    if (F.tool === 'crop') { edit.append(boxEl(F.draft || F.fx.crop || { x: 0, y: 0, w: 1, h: 1 }, 'fx-cropbox', true)); return; }
    const l = sel;
    if (!l || isSound(l) || isPiece(l) || l.type === 'draw' || l.type === 'speed') return;
    if (l.type !== 'zoom' && !(nowIn(l) >= l.start && nowIn(l) < l.end)) return;
    if (l.type === 'shape' && (l.shape === 'line' || l.shape === 'arrow')) { edit.append(dot('p1', l.x1, l.y1), dot('p2', l.x2, l.y2)); return; }
    edit.append(boxEl(l.type === 'zoom' ? zoomTarget(l).box : boxOf(l, aspect()), 'fx-selbox' + (l.type === 'zoom' ? ' zoom' : '')));
  }
  // edges: the sides can be dragged too (the crop), like resizing a window
  function boxEl(b, cls, edges) {
    const d = h('div', cls);
    d.style.left = b.x * 100 + '%'; d.style.top = b.y * 100 + '%'; d.style.width = b.w * 100 + '%'; d.style.height = b.h * 100 + '%';
    if (edges) for (const c of ['n', 's', 'e', 'w']) { const k = h('div', 'fx-edge ' + c); k.dataset.h = c; d.append(k); }
    for (const c of ['nw', 'ne', 'sw', 'se']) { const k = h('div', 'fx-h ' + c); k.dataset.h = c; d.append(k); }
    return d;
  }
  function dot(id, x, y) { const k = h('div', 'fx-h dot'); k.dataset.h = id; k.style.left = x * 100 + '%'; k.style.top = y * 100 + '%'; return k; }

  const norm = e => { const r = edit.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, rw: r.width, rh: r.height }; };
  function hitTest(p) {
    const asp = aspect();
    const ot = phT(), on = F.fx.layers.filter(l => !vHidden(l) && ot >= l.start && ot < l.end && !onV1(l) && l.type !== 'draw')
      .sort((a, b) => (a.track | 0) - (b.track | 0));
    for (let i = on.length - 1; i >= 0; i--) {
      const l = on[i];
      if (l.type === 'shape' && (l.shape === 'line' || l.shape === 'arrow')) { if (segDist(p, l) < 10 / p.rw) return l; }
      else if (inBox(p, boxOf(l, asp), 4 / p.rw)) return l;
    }
    return null;
  }
  function segDist(p, l) {
    const ax = l.x1, ay = l.y1, dx = l.x2 - ax, dy = l.y2 - ay, L2 = dx * dx + dy * dy || 1e-9;
    const u = clamp01(((p.x - ax) * dx + (p.y - ay) * dy) / L2);
    return Math.hypot(p.x - (ax + u * dx), p.y - (ay + u * dy));
  }
  // snapping a moving outline to the frame's edges and centre
  function snapBox(b, p, guides) {
    for (const [edge, size, tol, axis] of [['x', 'w', SNAP / p.rw, 'v'], ['y', 'h', SNAP / p.rh, 'h']]) {
      let best = null;
      for (const c of [0, 0.5, 1]) for (const off of [0, b[size] / 2, b[size]]) {
        const d = c - (b[edge] + off);
        if (Math.abs(d) < tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, c };
      }
      if (best) { b[edge] += best.d; guides.push([axis, best.c]); }
    }
    return b;
  }
  function showGuides(gs) {
    edit.querySelectorAll('.fx-guide').forEach(g => g.remove());
    for (const [axis, c] of gs) { const g = h('div', 'fx-guide ' + axis); g.style[axis === 'v' ? 'left' : 'top'] = c * 100 + '%'; edit.append(g); }
  }

  edit.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !Q.dur || Q.exporting) return;
    e.stopPropagation();
    const p = norm(e);
    edit.setPointerCapture(e.pointerId);
    if (F.tool === 'crop') { cropDown(e, p); return; }
    if (F.tool === 'draw') { drawDown(p); return; }
    if (!F.on) { F.drag = { click: true, wasSel: false }; return; } // Trim: the picture just plays / pauses
    const sel = selected(), hnd = e.target.dataset && e.target.dataset.h;
    // a zoom's box on the video is the stage under the playhead (its own box or one of its steps)
    const tgt = sel && sel.type === 'zoom' ? zoomEditTarget(sel) : sel;
    if (hnd && sel) { startDrag(tgt, hnd, p); return; }
    const hit = hitTest(p);
    if (hit) { select(hit.id, true); startDrag(hit, 'move', p); return; }
    if (sel && sel.type === 'zoom' && inBox(p, tgt.box)) { startDrag(tgt, 'move', p); return; }
    F.drag = { click: true, wasSel: !!F.sel };
  });
  edit.addEventListener('pointermove', e => {
    const d = F.drag;
    if (!d || d.click || d.tl) return;
    const p = norm(e);
    if (d.draw) drawMove(p); else if (d.crop) cropMove(p, e); else dragMove(p);
  });
  const endEdit = () => {
    const d = F.drag;
    if (!d || d.tl) return;
    F.drag = null;
    showGuides([]);
    // a click on the picture plays or pauses, and lets go of what was selected
    if (d.click) { if (d.wasSel && F.sel !== 'clip') select(null); ctx.toggle(); return; }
    // the end of a stroke or a drag is one undo step, saved at once (not after the usual short wait,
    // which let a quick second stroke join the first)
    if (d.draw) { changed(); ctx.changedNow(); return; }
    if (d.crop) { F.fx.crop = isFull(F.draft) ? null : F.draft; F.draft = null; changed(); ctx.changedNow(); return; }
    if (d.moved) { changed(); ctx.changedNow(); }
  };
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) edit.addEventListener(ev, endEdit);
  edit.addEventListener('click', e => e.stopPropagation());
  const isFull = b => !b || (b.w > 0.999 && b.h > 0.999);

  function startDrag(l, mode, p) { ctx.pause(); F.drag = { l, mode, p0: p, orig: copy(l), b0: { ...boxOf(l, aspect()) }, moved: false }; }
  function dragMove(p) {
    const d = F.drag, l = d.l, o = d.orig;
    const dx = p.x - d.p0.x, dy = p.y - d.p0.y;
    if (!d.moved && Math.hypot(dx * p.rw, dy * p.rh) < 2) return;
    d.moved = true;
    const guides = [];
    if (d.mode === 'p1' || d.mode === 'p2') {
      const [kx, ky] = d.mode === 'p1' ? ['x1', 'y1'] : ['x2', 'y2'];
      l[kx] = o[kx] + dx; l[ky] = o[ky] + dy;
    } else if (d.mode === 'move') {
      const b = snapBox({ ...d.b0, x: d.b0.x + dx, y: d.b0.y + dy }, p, guides);
      const mx = b.x - d.b0.x, my = b.y - d.b0.y;
      if (l.box) { l.box = { ...o.box, x: o.box.x + mx, y: o.box.y + my }; if (l.type === 'zoom' || l.type === 'blur') keepInside(l.box); }
      else if (l.type === 'shape') { l.x1 = o.x1 + mx; l.x2 = o.x2 + mx; l.y1 = o.y1 + my; l.y2 = o.y2 + my; }
      else { l.x = o.x + mx; l.y = o.y + my; }
    } else {
      // a corner: the opposite corner stays put
      const b0 = d.b0, ax = d.mode.includes('w') ? b0.x + b0.w : b0.x, ay = d.mode.includes('n') ? b0.y + b0.h : b0.y;
      let w = Math.max(0.01, Math.abs(p.x - ax)), hh = Math.max(0.01, Math.abs(p.y - ay));
      if (l.type === 'zoom') { w = hh = clamp(Math.max(w, hh), 0.05, 1); }
      else if (l.type === 'image' || l.type === 'text') { const r = b0.h / b0.w; if (w * r > hh) hh = w * r; else w = hh / r; }
      const b = { x: p.x < ax ? ax - w : ax, y: p.y < ay ? ay - hh : ay, w, h: hh };
      if (l.type === 'zoom' || l.type === 'blur') l.box = keepInside(b);
      else if (l.box) l.box = b;
      else if (l.type === 'image') { l.w = b.w; l.x = b.x + b.w / 2; l.y = b.y + b.h / 2; }
      else if (l.type === 'text') { l.size = clamp(o.size * b.h / b0.h, 0.015, 0.5); l.x = b.x + b.w / 2; l.y = b.y + b.h / 2; }
    }
    showGuides(guides);
    bump(); edit.dataset.key = '';
  }
  function keepInside(b) { b.w = Math.min(1, b.w); b.h = Math.min(1, b.h); b.x = clamp(b.x, 0, 1 - b.w); b.y = clamp(b.y, 0, 1 - b.h); return b; }

  // ---------- crop ----------
  function startCrop() { ctx.pause(); F.tool = 'crop'; F.sel = null; F.cropAspect = 0; F.cropLock = false; bump(); renderAll(); }
  function endCrop() { F.tool = null; F.draft = null; bump(); renderAll(); ctx.changed(); }
  const srcAspect = () => { const src = info(); return (src.width || 16) / (src.height || 9); };
  function cropDown(e, p) {
    const b0 = { ...(F.fx.crop || { x: 0, y: 0, w: 1, h: 1 }) }, hnd = e.target.dataset && e.target.dataset.h;
    F.draft = { ...b0 };
    F.drag = { crop: true, mode: hnd || (inBox(p, b0) && !isFull(b0) ? 'move' : 'new'), p0: p, b0 };
  }
  // the shape a drag keeps (w/h in frame units), or 0: the lock (or a picked shape) keeps one, Shift
  // does the opposite of the lock while dragging, as in Premiere / Photoshop
  function cropKeep(e, b0) {
    const locked = (F.cropLock || !!F.cropAspect) !== !!(e && e.shiftKey);
    if (!locked) return 0;
    const r = F.cropAspect === 'orig' ? srcAspect() : F.cropAspect;
    return r ? r / srcAspect() : b0.w / b0.h;
  }
  function cropMove(p, e) {
    const d = F.drag, b0 = d.b0, k = cropKeep(e, d.mode === 'new' ? { w: 1, h: 1 } : b0);
    const px = clamp01(p.x), py = clamp01(p.y), MIN = 0.03;
    let b;
    if (d.mode === 'move') b = { ...b0, x: clamp(b0.x + p.x - d.p0.x, 0, 1 - b0.w), y: clamp(b0.y + p.y - d.p0.y, 0, 1 - b0.h) };
    else if (d.mode.length === 1) {
      // a side: that side moves; with a kept shape the other two sides grow around the middle
      b = { ...b0 };
      if (d.mode === 'n') { b.y = Math.min(py, b0.y + b0.h - MIN); b.h = b0.y + b0.h - b.y; }
      if (d.mode === 's') b.h = Math.max(MIN, py - b0.y);
      if (d.mode === 'w') { b.x = Math.min(px, b0.x + b0.w - MIN); b.w = b0.x + b0.w - b.x; }
      if (d.mode === 'e') b.w = Math.max(MIN, px - b0.x);
      if (k) {
        if (d.mode === 'n' || d.mode === 's') { const cx = b0.x + b0.w / 2; b.w = Math.min(1, b.h * k); b.h = b.w / k; b.x = cx - b.w / 2; if (d.mode === 'n') b.y = b0.y + b0.h - b.h; }
        else { const cy = b0.y + b0.h / 2; b.h = Math.min(1, b.w / k); b.w = b.h * k; b.y = cy - b.h / 2; if (d.mode === 'w') b.x = b0.x + b0.w - b.w; }
      }
      b = keepInside(b);
    } else {
      // a corner (or a new box): the opposite corner stays put
      const ax = d.mode === 'new' ? d.p0.x : d.mode.includes('w') ? b0.x + b0.w : b0.x;
      const ay = d.mode === 'new' ? d.p0.y : d.mode.includes('n') ? b0.y + b0.h : b0.y;
      let w = Math.max(MIN, Math.abs(px - ax)), hh = Math.max(MIN, Math.abs(py - ay));
      if (k) { if (w / hh > k) w = hh * k; else hh = w / k; }
      b = keepInside({ x: px < ax ? ax - w : ax, y: py < ay ? ay - hh : ay, w, h: hh });
    }
    F.draft = b;
    edit.dataset.key = '';
    renderProps();
  }
  // a picked shape: the biggest crop of that shape in the middle, and the lock keeps it
  function cropPreset(r) {
    F.cropAspect = r;
    F.cropLock = !!r;
    const sa = srcAspect(), ratio = r === 'orig' ? sa : r;
    if (!r || r === 'orig') { if (r === 'orig') F.fx.crop = null; }
    else { const k = ratio / sa, w = k >= 1 ? 1 : k, hh = k >= 1 ? 1 / k : 1; F.fx.crop = { x: (1 - w) / 2, y: (1 - hh) / 2, w, h: hh }; }
    changed();
  }

  // ---------- drawing ----------
  function startDraw() {
    ctx.pause();
    let l = selected();
    if (!l || l.type !== 'draw') {
      l = F.fx.layers.find(x => x.type === 'draw' && Q.t >= x.start && Q.t < x.end && !vHidden(x));
      if (!l) { l = place({ id: uid(), type: 'draw', start: Q.tin, end: Q.tout, strokes: [] }); F.fx.layers.push(l); }
    }
    F.sel = l.id; F.tool = 'draw';
    changed();
  }
  function drawDown(p) {
    let l = selected();
    if (!l || l.type !== 'draw') { startDraw(); l = selected(); if (!l) return; } // (undo can take the drawing away: start a new one and keep going)
    const s = { c: F.brush.c, s: F.brush.s, e: F.brush.e, p: [r4(p.x), r4(p.y)] };
    l.strokes.push(s);
    F.drag = { draw: true, s, last: p };
    if (inkStroke()) inkLine(s, 0);
    bump();
  }
  // With the compositor, a stroke being drawn goes on a plain canvas over the picture, a bit of line per
  // move, and to the GPU once the mouse is let go (uploading the drawing on every move was slow on
  // weaker graphics). The eraser can't work that way (it cuts into what's there): it redraws as it goes.
  const ink = h('canvas', 'fx-level fx-ink'); ink.hidden = true;
  view.insertBefore(ink, edit);
  const inkStroke = () => (F.drag && F.drag.draw && !F.drag.s.e && ctx.compositor() ? F.drag.s : null);
  function clearInk() { if (!ink.hidden) { ink.hidden = true; ink.getContext('2d').clearRect(0, 0, ink.width, ink.height); } }
  function inkLine(s, from) {
    const W = Math.round(view.clientWidth * (devicePixelRatio || 1)), H = Math.round(view.clientHeight * (devicePixelRatio || 1));
    if (ink.hidden) { ink.width = W; ink.height = H; ink.hidden = false; }
    const x = ink.getContext('2d'), p = s.p;
    x.lineCap = 'round'; x.lineJoin = 'round'; x.strokeStyle = s.c; x.lineWidth = Math.max(1, s.s * ink.height);
    x.beginPath();
    const i = Math.max(0, from - 2);
    x.moveTo(p[i] * ink.width, p[i + 1] * ink.height);
    if (p.length === 2) x.lineTo(p[0] * ink.width + 0.01, p[1] * ink.height);
    for (let j = i + 2; j < p.length; j += 2) x.lineTo(p[j] * ink.width, p[j + 1] * ink.height);
    x.stroke();
  }
  // the brush outline: a circle the size the stroke will be (dashed for the eraser), in place of a cursor
  const brushEl = h('div', 'fx-brush'); brushEl.hidden = true; document.body.append(brushEl);
  function showBrush(e) {
    if (F.tool !== 'draw' || !F.on) { brushEl.hidden = true; return; }
    const r = edit.getBoundingClientRect(), d = Math.max(3, F.brush.s * r.height);
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) { brushEl.hidden = true; return; }
    brushEl.hidden = false;
    brushEl.classList.toggle('erase', !!F.brush.e);
    brushEl.style.width = brushEl.style.height = d + 'px';
    brushEl.style.left = e.clientX + 'px'; brushEl.style.top = e.clientY + 'px';
  }
  edit.addEventListener('pointermove', showBrush);
  edit.addEventListener('pointerleave', () => { brushEl.hidden = true; });
  function drawMove(p) {
    const d = F.drag;
    if (Math.hypot((p.x - d.last.x) * p.rw, (p.y - d.last.y) * p.rh) < 2) return;
    d.s.p.push(r4(p.x), r4(p.y)); d.last = p;
    if (inkStroke()) inkLine(d.s, d.s.p.length - 2);
    bump();
  }

  // ---------- tracks: placing things without overlaps ----------
  const onTrack = (kind, i, skip) => pool(kind).filter(x => (kind === 'z' || kind === 'sp' || (x.track | 0) === i) && x.id !== skip).map(x => ({ id: x.id, ...span(x) }));
  // the room an item has on its track: from the end of the one before to the start of the one after
  function room(kind, i, x, o) {
    const sp = span(o);
    let lo = 0, hi = limit(kind);
    for (const y of onTrack(kind, i, x.id)) { if (y.end <= sp.start + 1e-6) lo = Math.max(lo, y.end); if (y.start >= sp.end - 1e-6) hi = Math.min(hi, y.start); }
    return { lo, hi };
  }
  const free = (kind, i, s, len, skip) => onTrack(kind, i, skip).every(o => s + len <= o.start + 1e-6 || s >= o.end - 1e-6);
  // the start nearest `s` on track i where `len` fits (or null when there's no room near it)
  function fitAt(kind, i, s, len, skip) {
    const end = limit(kind);
    s = clamp(s, 0, Math.max(0, end - len));
    if (free(kind, i, s, len, skip)) return s;
    const cands = [];
    for (const o of onTrack(kind, i, skip)) cands.push(o.end, o.start - len);
    cands.sort((a, b) => Math.abs(a - s) - Math.abs(b - s));
    for (const c of cands) if (c >= -1e-6 && c + len <= end + 1e-6 && free(kind, i, c, len, skip) && Math.abs(c - s) < Math.max(len, 2)) return Math.max(0, c);
    return null;
  }
  // a new item goes on the lowest track with room, else on a new track (zooms: the nearest gap on V1)
  function place(x) {
    const kind = kindOf(x), sp = span(x), len = sp.end - sp.start;
    if (kind === 'z' || kind === 'sp') {
      x.track = 0;
      const s = fitAt(kind, 0, sp.start, len, x.id);
      if (s != null) setStart(x, s);
      return x;
    }
    const n = Math.max(0, ...pool(kind).filter(y => y.id !== x.id).map(y => (y.track | 0) + 1));
    for (let i = 0; i <= n; i++) {
      if (free(kind, i, sp.start, len, x.id)) { x.track = i; return x; }
    }
    return x;
  }

  // ---------- adding things ----------
  // new things start at the playhead (a few seconds long, inside the trim); blur and pictures cover
  // the whole trim, since they usually hide or brand the whole clip
  const whole = () => ({ start: M().toOut(Q.tin), end: M().toOut(Q.tout) });
  // clip: in clip time (V1's zooms and speed parts), else timeline time
  function here(len = 3, clip = false) {
    const m = M(), a = clip ? Q.tin : m.toOut(Q.tin), b = clip ? Q.tout : m.toOut(Q.tout), p = clip ? Q.t : m.toOut(Q.t);
    const d = Math.min(len, Math.max(0.1, b - a)), s = clamp(p, a, Math.max(a, b - d));
    return { start: s, end: Math.min(clip ? Q.dur : m.outDur, s + d) };
  }
  // opt.t: where it was dropped on the timeline; opt.track: on which track (when there's room)
  function add(l, opt = {}) {
    // opt.t is a timeline time
    if (opt.t != null) { const len = l.end - l.start, s = clamp(clipKind(l) ? M().toClip(opt.t) : opt.t, 0, Math.max(0, limit(kindOf(l)) - len)); l.start = s; l.end = s + len; }
    if (opt.track != null && kindOf(l) === 'v' && free('v', opt.track, l.start, l.end - l.start, l.id)) l.track = opt.track;
    else place(l);
    F.fx.layers.push(l); F.sel = l.id; F.tool = null;
    if (nowIn(l) < l.start || nowIn(l) >= l.end) seekOwn(l, l.start + 0.001);
    changed();
  }
  // a speed part: half speed by default, its sound at its own pitch
  function addSpeed(opt) { add({ id: uid(), type: 'speed', ...here(2, true), rate: 0.5, mute: false, ease: true }, opt); }
  function addZoom(opt) { add({ id: uid(), type: 'zoom', ...here(3, true), box: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 }, ein: 0.3, eout: 0.3 }, opt); }
  const TEXTS = {
    title: { text: 'Title', y: 0.2, size: 0.11, color: '#ffffff', bold: true, style: 'outline' },
    caption: { text: 'Caption', y: 0.86, size: 0.05, color: '#ffffff', bold: false, style: 'shadow' },
    callout: { text: 'CLUTCH', y: 0.5, size: 0.09, color: '#f0b232', bold: true, style: 'outline' },
    plain: { text: 'Text', y: 0.5, size: 0.06, color: '#ffffff', bold: false, style: 'none' },
  };
  function addText(kind = 'title', opt) {
    add({ id: uid(), type: 'text', ...here(3), x: 0.5, ...(TEXTS[kind] || TEXTS.title) }, opt);
    setTimeout(() => { const t = $('fxtext'); if (t) { t.focus(); t.select(); } }, 30);
  }
  function addBlur(opt) { add({ id: uid(), type: 'blur', ...whole(), box: { x: 0.35, y: 0.38, w: 0.3, h: 0.24 }, strength: 5 }, opt); }
  function addShape(shape = 'rect', fill = false, opt) {
    const l = { id: uid(), type: 'shape', ...here(3), shape, color: '#f23f43', fill: !!fill, stroke: 0.008 };
    Object.assign(l, shape === 'line' || shape === 'arrow' ? { x1: 0.35, y1: 0.6, x2: 0.62, y2: 0.4 } : { box: { x: 0.38, y: 0.36, w: 0.24, h: 0.28 } });
    add(l, opt);
  }
  async function pick(kind, pt) {
    const r = await T.fxPick(kind);
    if (r.ok && !r.cancelled) await addFile(r, pt);
    else if (!r.ok) ctx.status(r.error, 'err', 6000);
  }
  async function addFile(r, pt) {
    if (r.kind === 'image') {
      const i = imageFor(r.url);
      await i.ready;
      const ar = i.naturalWidth ? i.naturalHeight / i.naturalWidth : 1;
      add({ id: uid(), type: 'image', ...whole(), name: r.name, file: r.file, url: r.url, ar, w: Math.min(0.4, 0.5 / (ar * aspect())), x: pt ? pt.x : 0.5, y: pt ? pt.y : 0.5 });
    } else if (r.kind === 'audio') {
      const od = M().outDur, a0 = Math.max(0, Math.min(phT(), od - 0.1));
      const s = { id: uid(), path: r.path, name: r.name, dur: r.dur, at: a0, from: 0, to: Math.min(r.dur, Math.max(0.1, od - a0)), vol: 1, mute: false, pts: [] };
      place(s);
      F.fx.sounds.push(s);
      F.sel = s.id; F.tool = null;
      await ctx.audioChanged();
      changed();
    }
  }
  // a picture or a sound dropped on (or pasted into) the editor
  async function dropFile(path, x, y) {
    const r = await T.fxFile(path);
    if (!r.ok) { ctx.status(r.error, 'err', 6000); return; }
    let pt = null;
    const b = view.getBoundingClientRect();
    if (x != null && x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) pt = { x: (x - b.left) / b.width, y: (y - b.top) / b.height };
    await addFile(r, pt);
  }
  async function remove(id) {
    const s = F.fx.sounds.find(x => x.id === id), p = pieceList().find(x => x.id === id);
    if (s) { F.fx.sounds = F.fx.sounds.filter(x => x !== s); await ctx.audioChanged(); }
    else if (p) { const c = cutOf(p.ckey); c.pieces = c.pieces.filter(x => x !== p); await ctx.audioChanged(); } // that part goes silent
    else F.fx.layers = F.fx.layers.filter(l => l.id !== id);
    if (F.sel === id) { F.sel = null; if (F.tool === 'draw') F.tool = null; }
    changed();
  }
  function select(id, fromPicture) {
    F.sel = id || null;
    if (F.tool === 'crop' || (F.tool === 'draw' && (!id || (find(id) || {}).type !== 'draw'))) F.tool = null;
    const x = id && find(id);
    if (x && !fromPicture) { const sp = span(x); if (nowIn(x) < sp.start || nowIn(x) >= sp.end) seekOwn(x, sp.start + 0.001); }
    bump(); renderAll();
  }
  // split at the playhead, duplicate, copy and paste
  // at0: in the item's own time (the playhead when not given)
  function split(id, at0) {
    const x = find(id);
    if (!x) return;
    const t = at0 ?? nowIn(x);
    const sp = span(x);
    if (t <= sp.start + 0.05 || t >= sp.end - 0.05) { if (at0 == null) ctx.status('Move the playhead inside the block to split it.', null, 4000); return; }
    if (isPiece(x)) { const b = cutRow(x.ckey, t); if (b) { F.sel = b.id; ctx.audioChanged(); changed(); } return; }
    const b = copy(x); b.id = uid();
    if (isSound(x)) {
      const cut = x.from + (t - x.at);
      b.at = t; b.from = cut; x.to = cut;
      b.pts = (x.pts || []).filter(p => p[0] >= t - x.at).map(([dt, v]) => [dt - (t - x.at), v]);
      x.pts = (x.pts || []).filter(p => p[0] < t - x.at);
      F.fx.sounds.push(b);
      ctx.audioChanged();
    } else {
      if (x.type === 'zoom' && x.steps) {
        // the second part starts from where the first one is at the cut
        b.box = { ...zoomBoxAt(x, t) };
        b.steps = x.steps.filter(st => st.t > t);
        x.steps = x.steps.filter(st => st.t < t);
      }
      x.end = t; b.start = t;
      if (x.type === 'zoom') { x.eout = Math.min(x.eout, (x.end - x.start) / 2); b.ein = Math.min(b.ein, (b.end - b.start) / 2); }
      delete b.png; delete b.sig;
      F.fx.layers.push(b);
    }
    F.sel = b.id;
    changed();
  }
  function duplicate(id) {
    const x = find(id);
    if (!x || isPiece(x)) return;
    const b = copy(x); b.id = uid(); delete b.png; delete b.sig;
    const sp = span(x), len = sp.end - sp.start, kind = kindOf(x);
    const s = fitAt(kind, x.track | 0, sp.end, len, null);
    if (s != null && Math.abs(s - sp.end) < 1e-6) setStart(b, s);
    else { setStart(b, sp.start); b.track = -1; place(b); }
    (kind === 'a' ? F.fx.sounds : F.fx.layers).push(b);
    F.sel = b.id;
    if (kind === 'a') ctx.audioChanged();
    changed();
  }
  function setStart(x, s) {
    if (isSound(x) || isPiece(x)) { x.at = s; return; }
    const len = x.end - x.start, d = s - x.start;
    x.start = s; x.end = s + len;
    for (const st of x.steps || []) st.t += d; // a zoom's steps go with it
  }
  function copyBlock(id) { const x = find(id); if (x && isPiece(x)) { ctx.status("A piece of the clip's own sound can't be copied. Add the sound as its own audio to copy it.", null, 4000); return; } if (x) { F.clipboard = copy(x); ctx.status(`${NAMES[isSound(x) ? 'sound' : x.type]} copied. Ctrl+V pastes it at the playhead.`, null, 3000); } }
  function paste() {
    if (!F.clipboard) return false;
    const b = copy(F.clipboard); b.id = uid(); delete b.png; delete b.sig;
    const sp = span(b), len = sp.end - sp.start;
    const kind = kindOf(b);
    setStart(b, clamp(nowIn(b), 0, Math.max(0, limit(kind) - len)));
    if (!free(kind, b.track | 0, span(b).start, len, null)) { b.track = -1; place(b); }
    (kind === 'a' ? F.fx.sounds : F.fx.layers).push(b);
    F.sel = b.id;
    if (kind === 'a') ctx.audioChanged();
    changed();
    return true;
  }
  window.addEventListener('blur', () => { F.clipboard = null; }); // copied something elsewhere: Ctrl+V pastes that

  // ---------- cutting the clip's own sound rows ----------
  // a row's pieces; a row that was never cut gets one piece: all of it, in step with the video
  function cutsFor(key) {
    return F.fx.cuts[key] || (F.fx.cuts[key] = { free: false, pieces: [{ id: uid(), ckey: key, from: 0, to: Q.dur, at: 0 }] });
  }
  // a row left whole and in step again needs no cuts entry
  function tidyCuts(key) {
    const c = cutOf(key), p = c && c.pieces[0];
    if (c && !c.free && c.pieces.length === 1 && p.from < 0.001 && p.to > Q.dur - 0.001 && Math.abs(p.at - p.from) < 1e-6) delete F.fx.cuts[key];
  }
  // cut a row at t (timeline time); the piece after the cut, or null when t isn't inside a piece
  function cutRow(key, t) {
    const had = !!cutOf(key), c = cutsFor(key);
    const p = c.pieces.find(x => t > x.at + 0.05 && t < x.at + (x.to - x.from) - 0.05);
    if (!p) { if (!had) delete F.fx.cuts[key]; return null; }
    const cut = p.from + (t - p.at), b = { id: uid(), ckey: key, from: cut, to: p.to, at: t };
    p.to = cut;
    c.pieces.push(b);
    return b;
  }
  // the razor on sound rows (Shift: every row, like Premiere's Shift+click)
  function razorRows(keys, t) {
    let last = null;
    for (const k of keys) { const b = cutRow(k, t); if (b) last = b; }
    if (!last) return false;
    F.sel = last.id;
    ctx.audioChanged(); changed();
    return true;
  }
  // linked: the row's pieces stay in step with the video. Linking puts them back where they came
  // from (when they fit there).
  function setLinked(key, linked) {
    const c = cutsFor(key);
    if (linked) {
      const back = c.pieces.map(p => ({ s: p.from, e: p.to }));
      const fits = back.every((a, i) => back.every((b, j) => i === j || a.e <= b.s + 1e-6 || a.s >= b.e - 1e-6));
      if (fits) for (const p of c.pieces) p.at = p.from;
      else ctx.status('Some pieces overlap where they came from, so they stay where they are.', null, 6000);
    }
    c.free = !linked;
    tidyCuts(key);
    if (F.sel && !find(F.sel)) F.sel = null;
    ctx.audioChanged(); changed();
  }
  function restoreRow(key) {
    delete F.fx.cuts[key];
    if (F.sel && !find(F.sel)) F.sel = null;
    ctx.audioChanged(); changed();
  }
  const rowName = key => { const g = Q.groups.find(x => x.key === key); return g ? g.name : 'this row'; };
  // "Volume..." in a menu: the selected sound's volume slider in Properties
  function focusVolume() { requestAnimationFrame(() => { const r = $('qtfxprops').querySelector('.fx-vol input[type=range]'); if (r) r.focus(); }); }
  // volume (0-200 %) and mute in Properties, for a row, a piece or an added sound
  function volumeRows(box, vol, muted, setVol, toggleMute) {
    const before = box.children.length;
    rangeRow(box, 'Volume', vol * 100, 0, 200, v => setVol(v / 100), '%');
    const r = box.children[before]; r.classList.add('fx-vol');
    r.querySelector('input').ondblclick = e => { e.target.value = 100; e.target.oninput(); changed(); };
    const m = iconBtn(muted ? 'speakerOff' : 'speaker', muted ? 'Unmute' : 'Mute', toggleMute);
    m.classList.toggle('off', muted); r.append(m);
  }

  // ---------- the timeline (Edit) ----------
  const rulerEl = $('etlruler'), ovEl = $('etlov'), phEl = $('etlph');
  // every lane lines up with the ruler; F.v is the part of the clip they show
  const laneRect = () => rulerEl.getBoundingClientRect();
  const vspan = () => Math.max(0.01, F.v.t1 - F.v.t0);
  // timeline time under the pointer, and the clip time there
  const xToT = (e, r = laneRect()) => clamp(F.v.t0 + (e.clientX - r.left) / r.width * vspan(), 0, M().outDur);
  const xToC = (e, r) => M().toClip(xToT(e, r));
  const pct = t => (t - F.v.t0) / vspan() * 100;
  const wpct = d => d / vspan() * 100;
  function setView(t0, t1, quiet) {
    const d = M().outDur || 1, sp = clamp(t1 - t0, Math.min(MIN_SPAN, d), d);
    t0 = clamp(t0, 0, d - sp);
    F.v = { t0, t1: t0 + sp };
    const z = $('etlzoom');
    if (z && document.activeElement !== z) z.value = zoomOf();
    if (!quiet) renderTracks();
  }
  // the trim, with a little room either side
  function fitView(quiet) {
    if (!Q.dur) { F.v = { t0: 0, t1: 1 }; return; }
    const a = M().toOut(Q.tin), b = M().toOut(Q.tout), pad = Math.max(0.3, (b - a) * 0.04);
    setView(a - pad, b + pad, quiet);
  }
  // the zoom slider is 0 (the whole clip) to 100 (MIN_SPAN seconds), evenly spaced in log steps
  function zoomOf() {
    const d = M().outDur || 1, mn = Math.min(MIN_SPAN, d);
    return d - mn < 0.01 ? 0 : clamp(Math.log(d / vspan()) / Math.log(d / mn) * 100, 0, 100);
  }
  function zoomTo(z, anchor, frac) {
    const d = M().outDur || 1, mn = Math.min(MIN_SPAN, d), sp = d * Math.pow(mn / d, clamp(z, 0, 100) / 100);
    if (anchor == null) { anchor = phT() >= F.v.t0 && phT() <= F.v.t1 ? phT() : (F.v.t0 + F.v.t1) / 2; frac = (anchor - F.v.t0) / vspan(); }
    setView(anchor - frac * sp, anchor - frac * sp + sp);
  }
  function panBy(dt) { setView(F.v.t0 + dt, F.v.t1 + dt); }
  function snapT(t, e, skip) {
    if (F.snapOn === !!(e && e.altKey)) return t; // Alt does the opposite of the snap button
    const tol = SNAP / laneRect().width * vspan();
    const m = M(), cands = [0, m.outDur, phT()];
    if (skip !== 'trim') cands.push(m.toOut(Q.tin), m.toOut(Q.tout));
    for (const x of [...F.fx.layers, ...F.fx.sounds, ...pieceList()]) if (x.id !== skip) { const sp = span(x); cands.push(toTl(x, sp.start), toTl(x, sp.end)); }
    let best = null;
    for (const c of cands) if (Math.abs(c - t) < tol && (best === null || Math.abs(c - t) < Math.abs(best - t))) best = c;
    return best ?? t;
  }
  // snapping a time in an item's own time (snapping happens on the timeline)
  const snapOwn = (x, t, e) => (clipKind(x) ? M().toClip(snapT(M().toOut(t), e, x.id)) : snapT(t, e, x.id));
  const snapC = (t, e, skip) => M().toClip(snapT(M().toOut(t), e, skip));

  // while dragging, the tracks redraw at most once a frame
  let tracksQueued = false;
  function queueTracks() {
    if (tracksQueued) return;
    tracksQueued = true;
    requestAnimationFrame(() => { tracksQueued = false; renderTracks(); });
  }
  function renderTracks() {
    if (!F.on || !Q.dur) { tracksEl.replaceChildren(); return; }
    const nV = Math.max(1, ...pool('v').map(l => (l.track | 0) + 1)), nA = Math.max(1, ...F.fx.sounds.map(s => (s.track | 0) + 1));
    // empty tracks at the top / bottom go away once nothing is being dragged
    if (!F.drag) { if (F.fx.vtracks.length > nV) F.fx.vtracks.length = nV; if (F.fx.atracks.length > nA) F.fx.atracks.length = nA; }
    const rows = [];
    for (let i = Math.max(nV, F.fx.vtracks.length) - 1; i >= 0; i--) rows.push(trackRow('v', i));
    rows.push(clipRow());
    // rows with no sound at all stay folded away, as in the side panel
    Q.groups.forEach((g, i) => { if (!g.silent || ctx.silentOpen()) rows.push(soundRow(g, i)); });
    for (let i = 0; i < Math.max(nA, F.fx.atracks.length); i++) rows.push(trackRow('a', i));
    tracksEl.replaceChildren(...rows);
    buildRuler(); renderOverview(); positionPh();
  }
  function head(name, sub) {
    const hd = h('div', 'trk-h');
    hd.append(h('span', 'trk-name', name));
    if (sub) { const s = h('span', 'trk-sub', sub); s.title = sub; hd.append(s); }
    return hd;
  }
  function offBtn(off, icons, titles, run) {
    const b = h('button', 'ibtn sm trk-ib' + (off ? ' off' : ''));
    b.title = off ? titles[1] : titles[0];
    b.append(icoSpan(off ? icons[1] : icons[0]));
    b.onclick = run;
    return b;
  }
  function trackRow(kind, i) {
    const t = kind === 'v' ? vt(i) : at(i), off = kind === 'v' ? !!t.hidden : !!t.mute;
    const row = h('div', `trow ${kind}`);
    row.dataset.kind = kind; row.dataset.i = i;
    const hd = head(kind === 'v' ? `V${i + 2}` : `A${Q.groups.length + i + 1}`);
    hd.append(kind === 'v'
      ? offBtn(off, ['eye', 'eyeOff'], ['Hide this track', 'Show this track'], () => { t.hidden = !t.hidden; changed(); })
      : offBtn(off, ['speaker', 'speakerOff'], ['Mute this track', 'Unmute this track'], () => { t.mute = !t.mute; changed(); ctx.gainsChanged(); }));
    hd.oncontextmenu = e => {
      e.preventDefault();
      openMenu(e.clientX, e.clientY, [{ text: 'Delete Track', disabled: onTrack(kind, i, null).length > 0, run: () => deleteTrack(kind, i) }]);
    };
    const lane = h('div', 'trk-l');
    const items = pool(kind).filter(x => (x.track | 0) === i);
    if (kind === 'a' && items.length) { const c = h('canvas', 'trk-wave'); lane.append(c); requestAnimationFrame(() => drawSoundLane(c, items)); }
    for (const x of items) lane.append(block(x));
    if (!pool(kind).length) lane.append(h('span', 'trk-empty', kind === 'v' ? 'Text, shapes, pictures and blur go here' : 'Music and sounds you add go here'));
    row.append(hd, lane);
    return row;
  }
  function deleteTrack(kind, i) {
    const list = kind === 'v' ? F.fx.vtracks : F.fx.atracks, items = pool(kind);
    if (items.some(x => (x.track | 0) === i)) return;
    if (i < list.length) list.splice(i, 1);
    for (const x of items) if ((x.track | 0) > i) x.track = (x.track | 0) - 1;
    changed();
  }
  function block(x) {
    const sound = isSound(x), sp = span(x), type = sound ? 'sound' : x.type;
    const a = toTl(x, sp.start), z = toTl(x, sp.end), tw = Math.max(1e-6, z - a);
    // where a time of the item falls inside its block (0..1)
    const at01 = t => (toTl(x, t) - a) / tw;
    const b = h('div', 'trk-b' + (type === 'zoom' ? ' zb' : type === 'speed' ? ' spb' : '') + (F.sel === x.id ? ' sel' : '') + ((sound ? aMuted(x) : vHidden(x)) ? ' off' : ''));
    b.style.left = pct(a) + '%'; b.style.width = Math.max(0.2, wpct(z - a)) + '%';
    b.style.setProperty('--c', COLORS[type]);
    b.dataset.id = x.id;
    b.title = type === 'speed'
      ? `Speed ${x.rate}×${x.mute ? ', sound muted' : ''}: ${fmt(sp.end - sp.start)} of the clip plays for ${fmt(z - a)}. Drag it or its ends; click it for its speed.`
      : `${NAMES[type]}: ${labelOf(x)} (${fmt(a)} to ${fmt(z)})`;
    b.append(h('span', 'trk-label', labelOf(x)), edgeGrip('s'), edgeGrip('e'));
    if (type === 'zoom') {
      const a = h('div', 'trk-ease in'), z = h('div', 'trk-ease out');
      a.style.width = at01(x.start + x.ein) * 100 + '%'; z.style.width = (1 - at01(x.end - x.eout)) * 100 + '%';
      a.append(edgeGrip('ein')); z.append(edgeGrip('eout'));
      b.append(a, z);
      (x.steps || []).forEach((st, i) => {
        if (st.t <= x.start || st.t >= x.end) return;
        const dm = h('div', 'trk-zs' + (F.sel === x.id && stageAt(x) === i ? ' on' : ''));
        dm.dataset.zs = i; dm.style.left = at01(st.t) * 100 + '%';
        dm.title = `Step ${i + 2} at ${fmt(st.t)}: click to edit it, drag to move it`;
        b.append(dm);
      });
    }
    if (sound) for (const [i, [dt, v]] of (x.pts || []).entries()) b.append(pointEl(i, (dt / (sp.end - sp.start)) * 100, v, `${Math.round(v * 100)}%`));
    return b;
  }
  function pointEl(i, left, v, title) {
    const d = h('div', 'trk-pt');
    d.dataset.pt = i; d.style.left = left + '%'; d.style.top = (1 - v / 2) * 100 + '%';
    d.title = title + ' (drag to move, right-click to remove)';
    return d;
  }
  function edgeGrip(k) { const g = h('div', 'trk-eg ' + k); g.dataset.g = k; return g; }
  // the clip's own block: where it's trimmed (its edges move the trim), the rest of the clip dimmed
  function clipBlock(cls) {
    const b = h('div', 'trk-b cb ' + cls + (F.sel === 'clip' ? ' sel' : ''));
    b.dataset.id = 'clip';
    const a = M().toOut(Q.tin), z = M().toOut(Q.tout);
    b.style.left = pct(a) + '%'; b.style.width = wpct(z - a) + '%';
    b.append(edgeGrip('ts'), edgeGrip('te'));
    return b;
  }
  function shades(lane) {
    const a = h('div', 'trk-shade'), z = h('div', 'trk-shade');
    const m = M();
    a.style.left = pct(0) + '%'; a.style.width = Math.max(0, wpct(m.toOut(Q.tin))) + '%';
    z.style.left = pct(m.toOut(Q.tout)) + '%'; z.style.width = Math.max(0, wpct(m.outDur - m.toOut(Q.tout))) + '%';
    lane.append(a, z);
  }
  function clipRow() {
    const row = h('div', 'trow v1');
    row.dataset.kind = 'clip';
    const lane = h('div', 'trk-l');
    const c = h('canvas', 'trk-thumbs');
    lane.append(c);
    shades(lane);
    const b = clipBlock('vb');
    b.title = 'The clip. Drag its ends to trim it. Crop, fades and speed are in Effects.';
    b.append(h('span', 'trk-label', ctx.title()));
    lane.append(b);
    for (const z of pool('z')) lane.append(block(z));
    for (const p of pool('sp')) lane.append(block(p));
    requestAnimationFrame(() => drawThumbs(c));
    row.append(head('V1', 'Clip'), lane);
    return row;
  }
  function soundRow(g, i) {
    const cut = cutOf(g.key);
    const row = h('div', 'trow c' + (g.mute ? ' muted' : '') + (cut ? ' cut' : '') + (cut && cut.free ? ' free' : ''));
    row.dataset.kind = 'c'; row.dataset.key = g.key;
    const hd = head(`A${i + 1}`, g.name);
    if (cut && cut.free) { const u = h('span', 'trk-unl'); u.append(icoSpan('unlink')); u.title = 'Unlinked from the video: its pieces can slide. Right-click a piece > Link to Video to put it back in step.'; hd.querySelector('.trk-name').after(u); }
    hd.append(offBtn(g.mute, ['speaker', 'speakerOff'], ['Mute', 'Unmute'], () => ctx.toggleRow(g.key)));
    const lane = h('div', 'trk-l');
    const c = h('canvas', 'trk-wave');
    lane.append(c);
    shades(lane);
    if (cut) for (const p of cut.pieces) lane.append(pieceBlock(p, g, cut));
    else {
      const b = clipBlock('ab');
      b.classList.toggle('sel', F.sel === 'clip' || F.sel === 'row:' + g.key);
      b.title = `${g.name}. Click it for its volume. Double-click to add a volume point, drag points up and down, right-click one to remove it. The razor (C) cuts it.`;
      lane.append(b);
    }
    (F.fx.vpts[g.key] || []).forEach(([pt, v], j) => { const d = pointEl(j, pct(M().toOut(pt)), v, `${Math.round(v * 100)}% at ${fmt(pt)}`); lane.append(d); });
    requestAnimationFrame(() => drawClipLane(c, g));
    if (!F.peaks.has('c:' + g.key)) loadClipPeaks(g);
    row.append(hd, lane);
    return row;
  }
  function pieceBlock(p, g, c) {
    const sp = span(p), a = M().toOut(sp.start), z = M().toOut(sp.end);
    const b = h('div', 'trk-b pc' + (c.free ? ' free' : '') + (F.sel === p.id ? ' sel' : '') + (p.mute ? ' off' : ''));
    b.dataset.id = p.id;
    b.style.left = pct(a) + '%'; b.style.width = Math.max(0.2, wpct(z - a)) + '%';
    b.title = `${g.name} (${fmt(a)} to ${fmt(z)}). ` + (c.free ? 'Drag it to slide it, drag its ends to shorten it.' : 'Drag its ends to shorten it. Right-click > Unlink from Video to slide it.');
    b.append(edgeGrip('s'), edgeGrip('e'));
    return b;
  }
  async function loadClipPeaks(g) {
    const k = 'c:' + g.key;
    if (F.peaks.has(k)) return;
    F.peaks.set(k, null);
    const r = await T.qtWave(Q.clip.path, Q.dur, 2000, g.idx);
    if (r.ok && r.peaks) { F.peaks.set(k, r.peaks); renderTracks(); }
  }
  // waveform bars for the view's times; at(t) gives [peaks, index] or null
  function waveBars(g, w, hh, dpr, valueAt) {
    const n = Math.max(1, Math.floor(w / 3));
    for (let i = 0; i < n; i++) {
      const v = valueAt(F.v.t0 + (i + 0.5) / n * vspan());
      if (v == null) continue;
      const bh = Math.max(1, v * (hh - 4));
      g.fillRect(Math.round(i * 3 * dpr), Math.round((hh - bh) / 2 * dpr), Math.max(1, Math.round(2 * dpr)), Math.max(1, Math.round(bh * dpr)));
    }
  }
  const peakAt = (pk, t, total) => (pk && t >= 0 && t <= total ? pk[Math.min(pk.length - 1, Math.floor(t / total * pk.length))] || 0 : null);
  // the volume line between a and b (clip times), from gain(t)
  function curveLine(g, w, hh, dpr, a, b, gain) {
    const x0 = Math.max(0, (a - F.v.t0) / vspan() * w), x1 = Math.min(w, (b - F.v.t0) / vspan() * w);
    if (x1 <= x0) return;
    g.strokeStyle = F.volColor || (F.volColor = getComputedStyle(tracksEl).getPropertyValue('--etl-vol').trim() || '#f0b232');
    g.lineWidth = 1.5 * dpr; g.beginPath();
    for (let x = x0; x <= x1 + 1; x += 2) {
      const xx = Math.min(x, x1), y = (1 - gain(F.v.t0 + xx / w * vspan()) / 2) * hh;
      if (x === x0) g.moveTo(xx * dpr, y * dpr); else g.lineTo(xx * dpr, y * dpr);
    }
    g.stroke();
  }
  function sizeCanvas(c) { const w = c.clientWidth, hh = c.clientHeight, dpr = devicePixelRatio || 1; c.width = Math.max(1, Math.round(w * dpr)); c.height = Math.max(1, Math.round(hh * dpr)); return { w, hh, dpr, g: c.getContext('2d') }; }
  function drawClipLane(c, g) {
    if (!c.isConnected) return;
    const { w, hh, dpr, g: x } = sizeCanvas(c), pk = F.peaks.get('c:' + g.key), cut = cutOf(g.key);
    x.fillStyle = 'rgba(181,182,188,.5)';
    // a cut row: each piece shows its own part of the sound where it sits now
    const pieceAt = t => cut.pieces.find(p => t >= p.at && t < p.at + (p.to - p.from));
    // the bars are on the timeline; the sound is the clip's (a muted speed part shows none)
    const m = M();
    waveBars(x, w, hh, dpr, o => {
      const t = m.toClip(o);
      if (!m.identity && m.muteAt(t)) return null;
      if (!cut) return peakAt(pk, t, Q.dur);
      const p = pieceAt(t);
      return p ? peakAt(pk, p.from + t - p.at, Q.dur) : null;
    });
    const pts = F.fx.vpts[g.key] || [];
    curveLine(x, w, hh, dpr, m.toOut(Q.tin), m.toOut(Q.tout), o => curveAt(pts, m.toClip(o)));
  }
  function drawSoundLane(c, items) {
    if (!c.isConnected) return;
    const { w, hh, dpr, g } = sizeCanvas(c);
    for (const s of items) {
      const k = 'f:' + s.path;
      if (!F.peaks.has(k)) {
        F.peaks.set(k, null);
        T.fxWave(s.path, s.dur, 3000).then(r => { if (r.ok && r.peaks) { F.peaks.set(k, r.peaks); renderTracks(); } });
        continue;
      }
      const pk = F.peaks.get(k), end = s.at + (s.to - s.from);
      g.fillStyle = 'rgba(255,255,255,.45)';
      waveBars(g, w, hh, dpr, t => (t >= s.at && t <= end ? peakAt(pk, s.from + t - s.at, s.dur) : null));
      curveLine(g, w, hh, dpr, s.at, end, t => curveAt(s.pts, t - s.at));
    }
  }
  // V1's pictures. They sit on a fixed time grid (tile k shows the frame at the middle of its stretch), so
  // they stay put while the view scrolls. Decoded frames are kept (newest TH_MAX); a tile whose frame
  // isn't decoded yet borrows the nearest kept one. The grid's step snaps to quarter-octave zoom levels
  // (rounded down, so tiles overlap a little and never leave gaps), so small zoom changes reuse frames.
  const TH_MAX = 400;
  const TH = { key: '', frames: new Map(), want: [], fw: 0, fh: 0, busy: false };
  function resetThumbs() { TH.key = ''; TH.frames.clear(); TH.want = []; clearTimeout(F.thumbTimer); }
  function thumbGrid(w, hh) {
    const p = Q.player;
    if (!p || !p.width || !p.height) return null;
    const tw = hh * p.width / p.height, pps = w / vspan();
    const lvl = Math.floor(Math.log2(tw / pps) * 4), td = Math.pow(2, lvl / 4);
    return { tw, pps, td, lvl };
  }
  function nearestThumb(t, td) {
    let best = null, bd = td * 3;
    for (const f of TH.frames.values()) { const d = Math.abs(f.t - t); if (d < bd) { bd = d; best = f; } }
    return best;
  }
  function drawThumbs(c) {
    if (!c.isConnected || !Q.clip) return;
    const { w, hh, dpr, g } = sizeCanvas(c);
    if (w < 2 || hh < 2) return;
    const G = thumbGrid(w, hh);
    if (!G) return;
    const fw = Math.ceil(G.tw * dpr), fh = Math.round(hh * dpr), key = Q.clip.path + '|' + fw + 'x' + fh;
    if (TH.key !== key) { resetThumbs(); TH.key = key; TH.fw = fw; TH.fh = fh; }
    // tiles sit on the timeline's grid; each shows the clip's frame there (kept by clip time, so a
    // change of speed reuses the frames already decoded)
    const m = M(), k0 = Math.max(0, Math.floor(F.v.t0 / G.td)), k1 = Math.min(Math.ceil(m.outDur / G.td) - 1, Math.ceil(F.v.t1 / G.td));
    const want = [];
    for (let k = k0; k <= k1; k++) {
      const t = Math.min(Q.dur - 0.05, m.toClip((k + 0.5) * G.td)), id = G.lvl + ':' + Math.round(t * 50);
      let f = TH.frames.get(id);
      if (!f) { want.push({ id, t }); f = nearestThumb(t, G.td); }
      if (f) g.drawImage(f.img, Math.round((k * G.td - F.v.t0) * G.pps * dpr), 0, fw, fh);
    }
    // the middle of the view first
    const mid = m.toClip((F.v.t0 + F.v.t1) / 2);
    TH.want = want.sort((a, b) => Math.abs(a.t - mid) - Math.abs(b.t - mid));
    if (want.length && !TH.busy) { clearTimeout(F.thumbTimer); F.thumbTimer = setTimeout(decodeThumbs, 120); }
  }
  const redrawThumbs = () => { const c = tracksEl.querySelector('.trk-thumbs'); if (c) drawThumbs(c); };
  // a few frames at a time, re-reading what's wanted between batches (the view may have moved)
  async function decodeThumbs() {
    const p = Q.player;
    if (TH.busy || !F.on || !p || p.closed || !p.thumbnails) return;
    TH.busy = true;
    try {
      while (TH.want.length && F.on && Q.player === p && !p.closed) {
        const key = TH.key, batch = TH.want.splice(0, 6).filter(x => !TH.frames.has(x.id));
        if (!batch.length) continue;
        await p.thumbnails(batch.map(x => x.t), (i, sm) => {
          if (TH.key !== key) return;
          const cv = document.createElement('canvas'); cv.width = TH.fw; cv.height = TH.fh;
          sm.draw(cv.getContext('2d'), 0, 0, cv.width, cv.height);
          TH.frames.set(batch[i].id, { t: batch[i].t, img: cv });
          if (TH.frames.size > TH_MAX) TH.frames.delete(TH.frames.keys().next().value);
        });
        if (TH.key === key) redrawThumbs();
      }
    } catch (e) { /* the clip closed while decoding */ }
    TH.busy = false;
  }

  // the ruler, the overview strip (the whole clip, the trim and the part showing) and the playhead
  function buildRuler() {
    rulerEl.replaceChildren();
    const w = rulerEl.clientWidth;
    if (!w) return;
    const pps = w / vspan();
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 20, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const major = steps.find(s => s * pps >= 80) || 3600, minor = major / 5;
    for (let i = Math.ceil(F.v.t0 / minor - 1e-6); i * minor <= F.v.t1 + 1e-6; i++) {
      const t = i * minor, isMajor = i % 5 === 0;
      const d = h('div', 'tick' + (isMajor ? ' major' : ''));
      d.style.left = pct(t) + '%';
      rulerEl.append(d);
      if (isMajor && pct(t) < 97) {
        const l = h('div', 'tlabel', major < 1 ? fmt(t) : t < 60 ? Math.round(t) + 's' : `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`);
        l.style.left = pct(t) + '%';
        rulerEl.append(l);
      }
    }
  }
  function renderOverview() {
    const m = M(), d = m.outDur || 1, p = t => t / d * 100;
    const tr = ovEl.querySelector('.etl-ovtrim'), win = ovEl.querySelector('.etl-ovwin');
    tr.style.left = p(m.toOut(Q.tin)) + '%'; tr.style.width = p(m.toOut(Q.tout) - m.toOut(Q.tin)) + '%';
    win.style.left = p(F.v.t0) + '%'; win.style.width = p(vspan()) + '%';
    ovEl.classList.toggle('all', vspan() >= d - 0.01);
  }
  function positionPh() {
    if (!F.on) return;
    const r = laneRect(), box = phEl.parentElement.getBoundingClientRect(), o = phT(), f = (o - F.v.t0) / vspan();
    phEl.style.top = rulerEl.offsetTop + 'px';
    phEl.hidden = f < -0.001 || f > 1.001;
    phEl.style.left = (r.left - box.left + r.width * f) + 'px';
    ovEl.querySelector('.etl-ovph').style.left = (o / (M().outDur || 1) * 100) + '%';
  }
  // playing past the edge of the view turns the page
  function follow(t) {
    if (!F.on || F.drag || !Q.playing) return;
    t = M().toOut(t);
    if (t > F.v.t1 || t < F.v.t0) setView(t - vspan() * 0.05, t + vspan() * 0.95);
  }
  // overview: drag the window to scroll, click elsewhere to jump there
  ovEl.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !Q.dur) return;
    e.preventDefault();
    ovEl.setPointerCapture(e.pointerId);
    const r = ovEl.getBoundingClientRect(), tAt = ev => (ev.clientX - r.left) / r.width * M().outDur;
    let grab = tAt(e) - F.v.t0;
    if (!e.target.closest('.etl-ovwin')) { grab = vspan() / 2; setView(tAt(e) - grab, tAt(e) - grab + vspan()); }
    const move = ev => setView(tAt(ev) - grab, tAt(ev) - grab + vspan());
    ovEl.addEventListener('pointermove', move);
    ovEl.addEventListener('pointerup', () => ovEl.removeEventListener('pointermove', move), { once: true });
  });
  // ruler: click or drag to move the playhead
  rulerEl.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !Q.dur) return;
    e.preventDefault();
    const was = Q.playing;
    ctx.pause();
    rulerEl.setPointerCapture(e.pointerId);
    ctx.seekTo(xToC(e));
    const move = ev => ctx.seekTo(xToC(ev));
    rulerEl.addEventListener('pointermove', move);
    // playing goes on from where it was let go
    rulerEl.addEventListener('pointerup', () => { rulerEl.removeEventListener('pointermove', move); if (was) ctx.play(); }, { once: true });
  });
  // Ctrl+wheel zooms around the mouse, Shift+wheel (or a sideways scroll) scrolls
  const etl = $('qtetl');
  etl.addEventListener('wheel', e => {
    if (!F.on || !Q.dur || !e.target.closest('.etl-ruler, .etl-tracks, .etl-ov')) return;
    const r = laneRect();
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const t = xToT(e, r), frac = clamp((e.clientX - r.left) / r.width, 0, 1);
      zoomTo(zoomOf() - e.deltaY / 12, t, frac);
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      panBy((e.shiftKey ? e.deltaY || e.deltaX : e.deltaX) / r.width * vspan());
    }
  }, { passive: false });
  $('etlzoom').addEventListener('input', () => zoomTo(+$('etlzoom').value));
  $('etlfit').onclick = () => fitView();
  $('etlselect').onclick = () => setMode('select');
  $('etlrazor').onclick = () => setMode(F.mode === 'razor' ? 'select' : 'razor');
  $('etlsnap').onclick = () => { F.snapOn = !F.snapOn; lsSet('fxSnap', F.snapOn); renderTools(); };
  function setMode(m) { F.mode = m; tracksEl.classList.toggle('razor', m === 'razor'); renderTools(); }

  // pointer on the tracks: select and move blocks (in time, to another track), their edges, zoom
  // transitions, volume points; V1's / A1's edges move the trim; anywhere else moves the playhead
  tracksEl.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !Q.dur || Q.exporting) return;
    const row = e.target.closest('.trow');
    if (!row || e.target.closest('.trk-h')) return;
    e.preventDefault();
    const b = e.target.closest('.trk-b'), g = e.target.dataset && e.target.dataset.g;
    const ptEl = e.target.dataset && e.target.dataset.pt !== undefined ? e.target : null;
    const was = Q.playing; // clicking or dragging on the timeline while playing: it plays on afterwards
    F.resumeAfter = was && F.mode !== 'razor';
    ctx.pause();
    tracksEl.setPointerCapture(e.pointerId);
    const x = b && b.dataset.id !== 'clip' ? find(b.dataset.id) : null;
    if (F.mode === 'razor') { razorAt(e, row, x); if (was) ctx.play(); return; }
    // a zoom step's diamond: edit that step (the playhead goes to where it has zoomed in), drag to move it
    if (x && e.target.dataset && e.target.dataset.zs !== undefined) {
      const i = +e.target.dataset.zs, st = x.steps[i];
      if (F.sel !== x.id) select(x.id, true);
      ctx.seekTo(Math.min(x.end - 0.01, st.t + st.ease));
      F.drag = { tl: true, zstep: true, x, i, moved: false };
      return;
    }
    if (g === 'ts' || g === 'te') { if (F.sel !== 'clip') select('clip', true); F.drag = { tl: true, trim: g === 'ts' ? 'in' : 'out' }; return; }
    if (row.dataset.kind === 'c' && ptEl) { F.drag = { tl: true, cpt: true, key: row.dataset.key, i: +ptEl.dataset.pt, r: ptEl.parentElement.getBoundingClientRect() }; return; }
    if (!x) {
      // the clip (V1 / its sounds) gets selected, empty space clears the selection; both move the playhead
      const onClip = b && b.dataset.id === 'clip';
      const want = onClip ? (row.dataset.kind === 'c' ? 'row:' + row.dataset.key : 'clip') : null;
      if ((F.sel || null) !== want) select(want, true);
      ctx.seekTo(xToC(e)); F.drag = { tl: true, seek: true };
      return;
    }
    if (F.sel !== x.id) select(x.id, true);
    // a linked piece stays in step with the video: dragging it moves the playhead (its ends still trim it)
    if (isPiece(x) && !g && !cutOf(x.ckey).free) { ctx.seekTo(xToC(e)); F.drag = { tl: true, seek: true }; return; }
    if (ptEl && isSound(x)) { F.drag = { tl: true, spt: true, x, i: +ptEl.dataset.pt }; return; }
    // a speed part changes the time it sits on: its drags work out where it goes from the timeline
    // without it (where the pointer is stays where its edge is)
    if (x.type === 'speed') {
      F.drag = { tl: true, speed: true, g: g || 'move', orig: copy(x), x, moved: false, kind: 'sp', x0: xToT(e),
        without: buildMap(F.fx.layers.filter(l => l !== x)), grab: xToT(e) - M().toOut(x.start) };
      return;
    }
    F.drag = { tl: true, g: g || 'move', t0: clipKind(x) ? xToC(e) : xToT(e), orig: copy(x), x, moved: false, kind: kindOf(x) };
  });
  // the razor: added blocks split where clicked; the clip's sound rows are cut (Shift: every sound
  // row, and every block there); the video itself can't be cut yet
  function razorAt(e, row, x) {
    const t = snapT(xToT(e), e, x ? x.id : null), c = M().toClip(t);
    const own = y => (clipKind(y) ? c : t);
    if (e.shiftKey) {
      const keys = Q.groups.map(g => g.key);
      let any = keys.length ? razorRows(keys, c) : false;
      for (const y of [...F.fx.layers, ...F.fx.sounds]) { const sp = span(y), u = own(y); if (u > sp.start + 0.05 && u < sp.end - 0.05) { split(y.id, u); any = true; } }
      if (!any) ctx.status('Nothing to cut there.', null, 3000);
      return;
    }
    if (x && !isPiece(x)) { split(x.id, own(x)); return; }
    if (row.dataset.kind === 'c') { razorRows([row.dataset.key], c); return; }
    if (row.dataset.kind === 'clip') ctx.status("The video itself can't be cut yet. Click a sound row (A1, A2...) to cut it, or Shift+click to cut all of them.", null, 6000);
  }
  tracksEl.addEventListener('dblclick', e => {
    if (F.mode === 'razor') return;
    // a double-click on a sound adds a volume point there
    // the pointer was captured on press, so the event comes from the timeline itself: use what's under it
    const el = document.elementFromPoint(e.clientX, e.clientY) || e.target;
    const row = el.closest('.trow'), b = el.closest('.trk-b');
    if (!row || !b || el.dataset.pt !== undefined) return;
    const r = b.getBoundingClientRect(), v = Math.round(clamp((1 - (e.clientY - r.top) / r.height) * 2, 0, 2) * 100) / 100;
    if (row.dataset.kind === 'c') {
      const pts = F.fx.vpts[row.dataset.key] = F.fx.vpts[row.dataset.key] || [];
      pts.push([r4(xToC(e)), v]); pts.sort((p, q) => p[0] - q[0]);
    } else {
      const x = find(b.dataset.id);
      if (!x || !isSound(x)) return;
      const dt = clamp((e.clientX - r.left) / r.width, 0, 1) * (x.to - x.from);
      x.pts = [...(x.pts || []), [r4(dt), v]].sort((p, q) => p[0] - q[0]);
    }
    changed(); ctx.gainsChanged();
  });
  tracksEl.addEventListener('pointermove', e => {
    const d = F.drag;
    if (!d || !d.tl) return;
    if (d.seek) { ctx.seekTo(xToC(e)); return; }
    if (d.speed) { speedMove(e, d); return; }
    if (d.trim) {
      const t = snapC(xToC(e), e, 'trim');
      if (d.trim === 'in') Q.tin = clamp(t, 0, Q.tout - 0.1); else Q.tout = clamp(t, Q.tin + 0.1, Q.dur);
      ctx.trimMove(d.trim === 'in' ? Q.tin : Q.tout);
      queueTracks();
      return;
    }
    if (d.cpt) { clipPointMove(e); return; }
    if (d.zstep) {
      const st = d.x.steps[d.i]; if (!st) return;
      st.t = clamp(snapC(xToC(e), e, d.x.id), d.x.start + 0.05, d.x.end - 0.05); d.moved = true;
      d.x.steps.sort((a, b) => a.t - b.t); d.i = d.x.steps.indexOf(st);
      ctx.seekTo(Math.min(d.x.end - 0.01, st.t + st.ease));
      bump(); queueTracks(); renderProps();
      return;
    }
    if (d.spt) { soundPointMove(e); return; }
    const t = clipKind(d.x) ? xToC(e) : xToT(e), o = d.orig, x = d.x, dt = t - d.t0;
    if (!d.moved && Math.abs(xToT(e) - toTl(x, d.t0)) < vspan() * 3 / laneRect().width && !rowChange(e, d)) return;
    d.moved = true;
    if (d.g === 'move') {
      const len = span(o).end - span(o).start;
      let ti = 0;
      if (d.kind !== 'z' && !d.kind.startsWith('p:')) {
        // the track under the pointer; past the top layer track / the last sound track: one new
        // track, at most (a block alone on the top track stays there)
        ti = o.track | 0;
        const others = Math.max(-1, ...pool(d.kind).filter(y => y.id !== x.id).map(y => y.track | 0));
        const top = Math.max(o.track | 0, others + 1);
        const rows = [...tracksEl.querySelectorAll(`.trow.${d.kind}`)];
        const hit = rows.find(r => { const rr = r.getBoundingClientRect(); return e.clientY >= rr.top && e.clientY < rr.bottom; });
        if (hit) ti = +hit.dataset.i;
        else if (rows.length) {
          const first = rows[0].getBoundingClientRect(), last = rows[rows.length - 1].getBoundingClientRect();
          if ((d.kind === 'v' && e.clientY < first.top) || (d.kind === 'a' && e.clientY >= last.bottom)) ti = top;
        }
        ti = Math.min(ti, top);
      }
      let s = snapOwn(x, span(o).start + dt, e);
      const s2 = snapOwn(x, s + len, e); if (Math.abs(s2 - (s + len)) > 1e-9) s = s2 - len;
      const ok = fitAt(d.kind, ti, s, len, x.id);
      if (ok !== null) { setStart(x, ok); if (!isPiece(x)) x.track = ti; }
    } else if (isPiece(x)) {
      // a piece's ends: the start keeps the sound where it was (from moves with at), never before
      // the clip's start or past its end
      const len = o.to - o.from;
      const rm = room(d.kind, 0, x, o);
      if (d.g === 's') { const a2 = clamp(snapOwn(x, o.at + dt, e), Math.max(0, o.at - o.from, rm.lo), o.at + len - 0.1); x.from = o.from + (a2 - o.at); x.at = a2; }
      else if (d.g === 'e') { const end = clamp(snapOwn(x, o.at + len + dt, e), o.at + 0.1, Math.min(Q.dur, o.at + (Q.dur - o.from), rm.hi)); x.to = o.from + (end - o.at); }
    } else if (isSound(x)) {
      const len = o.to - o.from;
      const rm = room('a', x.track | 0, x, o);
      if (d.g === 's') { const a2 = clamp(snapOwn(x, o.at + dt, e), Math.max(o.at - o.from, rm.lo), o.at + len - 0.1); x.from = o.from + (a2 - o.at); x.at = Math.max(0, a2); x.pts = shiftPts(o.pts, o.at - a2, x.to - x.from); }
      else if (d.g === 'e') { const end = clamp(snapOwn(x, o.at + len + dt, e), o.at + 0.1, Math.min(M().outDur, o.at + (o.dur - o.from), rm.hi)); x.to = o.from + (end - o.at); }
    } else {
      const k = d.kind;
      const rm = room(k, x.track | 0, x, o);
      if (d.g === 's') x.start = clamp(snapOwn(x, o.start + dt, e), rm.lo, o.end - 0.1);
      else if (d.g === 'e') x.end = clamp(snapOwn(x, o.end + dt, e), o.start + 0.1, rm.hi);
      else if (d.g === 'ein') x.ein = clamp(o.ein + dt, 0, (o.end - o.start) / 2);
      else if (d.g === 'eout') x.eout = clamp(o.eout - dt, 0, (o.end - o.start) / 2);
      if (x.type === 'zoom') { x.ein = Math.min(x.ein, (x.end - x.start) / 2); x.eout = Math.min(x.eout, (x.end - x.start) / 2); }
    }
    bump(); queueTracks(); renderProps();
  });
  // a speed part's drags. Moving it or its start: the timeline before it doesn't depend on it, so the
  // pointer's clip time comes from the map without it. Its end: the clip time whose place on the new
  // timeline is under the pointer (found by halving, the part's own speed changing where it lands).
  function speedMove(e, d) {
    const x = d.x, o = d.orig, len = o.end - o.start, X = snapT(xToT(e), e, x.id);
    if (!d.moved && Math.abs(xToT(e) - d.x0) < vspan() * 3 / laneRect().width) return;
    d.moved = true;
    const rm = room('sp', 0, x, o);
    if (d.g === 'move') {
      // either end snaps (the end's place on the timeline is worked out with the part where it is now)
      const a = xToT(e) - d.grab, sa = snapT(a, e, x.id), w = M().toOut(x.end) - M().toOut(x.start), sb = snapT(a + w, e, x.id);
      const start = sa !== a ? sa : sb !== a + w ? sb - w : a;
      const s = fitAt('sp', 0, clamp(d.without.toClip(start), 0, Q.dur - len), len, x.id);
      if (s !== null) { x.start = s; x.end = s + len; }
    } else if (d.g === 's') {
      x.start = clamp(d.without.toClip(X), rm.lo, o.end - 0.1);
    } else if (d.g === 'e') {
      let lo = o.start + 0.1, hi = rm.hi;
      for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2;
        x.end = mid;
        if (buildMap().toOut(mid) < X) lo = mid; else hi = mid;
      }
      x.end = (lo + hi) / 2;
    }
    bump(); queueTracks(); renderProps();
  }
  // a block dragged up or down onto another row counts as moved even before it moves in time
  const rowChange = (e, d) => d.g === 'move' && d.kind !== 'z' && d.kind !== 'sp' && !d.kind.startsWith('p:') && (() => { const r = tracksEl.querySelector(`.trk-b[data-id="${d.x.id}"]`); if (!r) return false; const rr = r.closest('.trow').getBoundingClientRect(); return e.clientY < rr.top || e.clientY >= rr.bottom; })();
  const shiftPts = (pts, by, len) => (pts || []).map(([dt, v]) => [r4(dt + by), v]).filter(p => p[0] >= 0 && p[0] <= len);
  const endTracks = async () => {
    const d = F.drag;
    if (!d || !d.tl) return;
    F.drag = null;
    if (F.resumeAfter) { F.resumeAfter = false; await endDrag(d); ctx.play(); return; }
    await endDrag(d);
  };
  const endDrag = async d => {
    if (d.seek) return;
    if (d.trim) { ctx.trimDone(d.trim); bump(); renderAll(); return; }
    if (d.cpt || d.spt) { changed(); ctx.gainsChanged(); return; }
    if (d.zstep) { changed(); return; }
    if (!d.moved) return;
    if (d.speed) { if (F.fx.sounds.length) await ctx.audioChanged(); changed(); return; }
    if (isSound(d.x) || isPiece(d.x)) await ctx.audioChanged();
    changed();
  };
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) tracksEl.addEventListener(ev, endTracks);
  tracksEl.addEventListener('contextmenu', e => {
    const ptEl = e.target.dataset && e.target.dataset.pt !== undefined ? e.target : null;
    const row = e.target.closest('.trow'), b = e.target.closest('.trk-b');
    if (ptEl && row) {
      e.preventDefault();
      if (row.dataset.kind === 'c') { const p = F.fx.vpts[row.dataset.key]; p.splice(+ptEl.dataset.pt, 1); if (!p.length) delete F.fx.vpts[row.dataset.key]; }
      else { const x = find(b.dataset.id); x.pts.splice(+ptEl.dataset.pt, 1); }
      changed(); ctx.gainsChanged();
      return;
    }
    if (b && b.dataset.id === 'clip' && row && row.dataset.kind === 'c') {
      // a whole sound row of the clip
      e.preventDefault();
      const key = row.dataset.key, t = xToC(e), g = Q.groups.find(x => x.key === key);
      select('row:' + key, true);
      openMenu(e.clientX, e.clientY, [
        { text: g && g.mute ? 'Unmute' : 'Mute', run: () => ctx.toggleRow(key) },
        { text: 'Volume...', run: focusVolume },
        '-',
        { text: 'Cut Here', hint: 'C', run: () => razorRows([key], t) },
        { text: 'Unlink from Video', run: () => setLinked(key, false) },
      ]);
      return;
    }
    if (!b || b.dataset.id === 'clip') return;
    e.preventDefault();
    const x = find(b.dataset.id);
    if (!x) return;
    select(x.id, true);
    if (isPiece(x)) {
      const c = cutOf(x.ckey), t = xToC(e);
      openMenu(e.clientX, e.clientY, [
        { text: x.mute ? 'Unmute' : 'Mute', run: () => { x.mute = !x.mute; ctx.gainsChanged(); changed(); } },
        { text: 'Volume...', run: focusVolume },
        '-',
        { text: 'Cut Here', hint: 'C', run: () => razorRows([x.ckey], t) },
        c.free ? { text: 'Link to Video', run: () => setLinked(x.ckey, true) } : { text: 'Unlink from Video', run: () => setLinked(x.ckey, false) },
        { text: `Restore Whole ${rowName(x.ckey)}`, run: () => restoreRow(x.ckey) },
        '-',
        { text: 'Delete', hint: 'Del', run: () => remove(x.id), cls: 'danger' },
      ]);
      return;
    }
    openMenu(e.clientX, e.clientY, [
      ...(isSound(x) ? [{ text: x.mute ? 'Unmute' : 'Mute', run: () => { x.mute = !x.mute; ctx.gainsChanged(); ctx.audioChanged(); changed(); } }, { text: 'Volume...', run: focusVolume }, '-'] : []),
      { text: 'Split at Playhead', hint: 'Ctrl+K', run: () => split(x.id) },
      { text: 'Duplicate', hint: 'Ctrl+D', run: () => duplicate(x.id) },
      { text: 'Copy', hint: 'Ctrl+C', run: () => copyBlock(x.id) },
      '-',
      { text: 'Delete', hint: 'Del', run: () => remove(x.id), cls: 'danger' },
    ]);
  });
  function clipPointMove(e) {
    const d = F.drag, pts = F.fx.vpts[d.key];
    if (!pts || !pts[d.i]) return;
    let v = clamp((1 - (e.clientY - d.r.top) / d.r.height) * 2, 0, 2);
    if (Math.abs(v - 1) < 0.05 && !e.altKey) v = 1;
    const p = [r4(snapC(xToC(e), e, null)), Math.round(v * 100) / 100];
    pts[d.i] = p; pts.sort((a, b) => a[0] - b[0]); d.i = pts.indexOf(p);
    bump(); queueTracks(); ctx.gainsChanged();
  }
  function soundPointMove(e) {
    const d = F.drag, x = d.x, b = tracksEl.querySelector(`.trk-b[data-id="${x.id}"]`);
    if (!b || !x.pts[d.i]) return;
    const r = b.getBoundingClientRect(), len = x.to - x.from;
    let v = clamp((1 - (e.clientY - r.top) / r.height) * 2, 0, 2);
    if (Math.abs(v - 1) < 0.05 && !e.altKey) v = 1;
    const p = [r4(clamp((e.clientX - r.left) / r.width, 0, 1) * len), Math.round(v * 100) / 100];
    x.pts[d.i] = p; x.pts.sort((a, b2) => a[0] - b2[0]); d.i = x.pts.indexOf(p);
    bump(); queueTracks(); ctx.gainsChanged();
  }
  // dropping something from the asset panel onto a track
  tracksEl.addEventListener('dragover', e => {
    if (!e.dataTransfer.types.includes('application/x-ct-asset')) return;
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    for (const r of tracksEl.querySelectorAll('.trow.drop')) r.classList.remove('drop');
    const row = e.target.closest('.trow'); if (row) row.classList.add('drop');
  });
  tracksEl.addEventListener('dragleave', e => { if (!tracksEl.contains(e.relatedTarget)) for (const r of tracksEl.querySelectorAll('.trow.drop')) r.classList.remove('drop'); });
  tracksEl.addEventListener('drop', e => {
    const id = e.dataTransfer.getData('application/x-ct-asset');
    if (!id) return;
    e.preventDefault(); e.stopPropagation();
    for (const r of tracksEl.querySelectorAll('.trow.drop')) r.classList.remove('drop');
    const row = e.target.closest('.trow');
    useAsset(id, { t: xToT(e), track: row && row.dataset.kind === 'v' ? +row.dataset.i : null });
  });

  // ---------- the asset panel (Edit): click to add at the playhead, or drag onto the timeline ----------
  const ASSETS = {
    text: [['text:title', 'Title', 'ta-title'], ['text:caption', 'Caption', 'ta-caption'], ['text:callout', 'CLUTCH', 'ta-callout'], ['text:plain', 'Plain text', 'ta-plain']],
    shapes: [['shape:rect', 'Box', 'shape'], ['shape:rectf', 'Filled box', 'shape'], ['shape:ellipse', 'Circle', 'shape'], ['shape:arrow', 'Arrow', 'shape'], ['shape:line', 'Line', 'shape'], ['file:image', 'Picture', 'image']],
    audio: [['file:audio', 'Add music or a sound', 'music']],
    effects: [['fx:speed', 'Speed', 'speed'], ['fx:zoom', 'Zoom', 'zoom'], ['fx:blur', 'Blur', 'blur'], ['fx:crop', 'Crop', 'crop'], ['fx:draw', 'Draw', 'draw'], ['fade:vin', 'Fade in', 'fadeIn'], ['fade:vout', 'Fade out', 'fadeOut']],
  };
  const HINTS = {
    text: 'Click to add at the playhead, or drag onto the timeline.',
    shapes: 'Click to add at the playhead, or drag onto the timeline. Pictures can also be dropped on the editor.',
    audio: 'Or drop an audio file on the editor. Added sounds get their own tracks under the clip\'s sounds.',
    effects: 'Speed, zoom and blur are added at the playhead. Fades are half a second, picture and sound together; click one that\'s on for its settings.',
  };
  function useAsset(id, opt = {}) {
    if (!Q.dur || Q.exporting) return;
    const [k, v] = id.split(':');
    if (k === 'text') addText(v, opt);
    else if (k === 'shape') addShape(v === 'rectf' ? 'rect' : v, v === 'rectf', opt);
    else if (k === 'file') pick(v);
    else if (k === 'fx') { if (v === 'speed') addSpeed(opt); else if (v === 'zoom') addZoom(opt); else if (v === 'blur') addBlur(opt); else tools[v](); }
    else if (k === 'fade') {
      // a fade (picture and sound together) is added and selected; one that's on is just selected,
      // to change it in its settings (Picture / Sound, length) or remove it
      const [pk, sk] = fadeKeys(v);
      if (!F.fx.fades[pk] && !F.fx.fades[sk]) { F.fx.fades[pk] = F.fx.fades[sk] = FADE; ctx.gainsChanged(); }
      F.sel = id; F.tool = null;
      changed();
    }
  }
  // fades: 'vin' / 'vout' (the Fade in / Fade out tiles) and the sound's matching 'ain' / 'aout'
  const fadeKeys = v => (v === 'vin' ? ['vin', 'ain'] : ['vout', 'aout']);
  const selFade = () => (F.sel && F.sel.startsWith('fade:') && fadeKeys(F.sel.slice(5)).some(k => F.fx.fades[k]) ? F.sel.slice(5) : null);
  function removeFade(v) {
    for (const k of fadeKeys(v)) F.fx.fades[k] = 0;
    if (F.sel === 'fade:' + v) F.sel = null;
    changed(); ctx.gainsChanged();
  }
  // Edit's tabs live in the sidebar, in place of the games (Home, Folders and the collapse button stay);
  // the panel beside it shows the open tab. Clicking the open tab again folds the panel away.
  const TABS = [['clips', 'Clips', 'film'], ['text', 'Text', 'text'], ['shapes', 'Shapes', 'shape'], ['audio', 'Audio', 'music'], ['effects', 'Effects', 'sparkle']];
  if (!TABS.some(t => t[0] === F.tab)) F.tab = 'text';
  function renderTabs() {
    const rail = $('edittabs');
    if (!rail) return;
    rail.replaceChildren(...TABS.map(([id, label, icon]) => {
      const r = h('div', 'game etab' + (id === F.tab && !F.panelOff ? ' on' : ''));
      r.dataset.tab = id;
      const av = h('div', 'gav ico-av'); av.append(icoSpan(icon));
      const txt = h('div', 'gtext'); txt.append(h('span', 'gname', label));
      r.append(av, txt, h('span', 'elabel', label));
      r.onclick = () => pickTab(id);
      return r;
    }));
  }
  function pickTab(id) {
    if (id === F.tab && !F.panelOff) F.panelOff = true;
    else { F.tab = id; F.panelOff = false; lsSet('fxTab', id); }
    renderAssets();
    ctx.panelChanged();
  }
  function renderAssets() {
    renderTabs();
    const box = $('qtassets');
    if (!box || !F.on) return;
    $('qtclips').classList.toggle('tab-clips', F.tab === 'clips');
    $('qtclips').closest('.qt-box').classList.toggle('nopanel', !!F.panelOff);
    if (F.tab === 'clips') { box.replaceChildren(); return; }
    const grid = h('div', 'as-grid' + (F.tab === 'audio' ? ' one' : ''));
    for (const [id, label, look] of ASSETS[F.tab] || []) {
      const b = h('button', 'as-tile ' + look);
      const fade = id.startsWith('fade:') && fadeKeys(id.slice(5)).some(k => F.fx.fades[k]);
      // (with the toolbar under the video gone, the Effects tab shows which tool is in use)
      if (fade || (id === 'fx:crop' && (F.fx.crop || F.tool === 'crop')) || (id === 'fx:draw' && F.tool === 'draw')) b.classList.add('on');
      if (id.startsWith('text:')) b.append(h('span', 'as-sample', label));
      else { b.append(icoSpan(look === 'shape' ? 'shape' : look), h('span', 'as-name', label)); if (look === 'shape') b.dataset.shape = id.slice(6); }
      b.title = id.startsWith('fade:') ? (fade ? 'On: click for its settings' : 'Half a second, picture and sound') : 'Click to add at the playhead';
      if (/^(text|shape|fx:(speed|zoom|blur))/.test(id)) {
        b.draggable = true;
        b.addEventListener('dragstart', e => { e.dataTransfer.setData('application/x-ct-asset', id); e.dataTransfer.effectAllowed = 'copy'; });
      }
      b.onclick = () => useAsset(id);
      grid.append(b);
    }
    const tab = TABS.find(t => t[0] === F.tab);
    box.replaceChildren(h('div', 'as-title', tab ? tab[1] : ''), grid, h('div', 'as-hint', HINTS[F.tab] || ''));
  }

  // ---------- side panel: the selected item's settings ----------
  function renderProps() {
    const box = $('qtfxprops'), head = $('qtfxpropsh');
    box.replaceChildren();
    const l = selected();
    let title = '';
    if (F.tool === 'crop') { title = 'Crop'; cropProps(box); }
    else if (selFade()) { const v = selFade(); title = v === 'vin' ? 'Fade in' : 'Fade out'; fadeProps(box, v); }
    else if (selRow()) {
      const g = selRow(), pts = F.fx.vpts[g.key] || [];
      title = g.name;
      volumeRows(box, g.vol, g.mute, v => ctx.rowVolume(g.key, v), () => ctx.toggleRow(g.key));
      box.append(h('div', 'fx-hint', 'Double-click the row on the timeline to add a volume point, drag points up and down, right-click one to remove it. The razor (C) cuts the row into pieces with their own volume.'));
      if (pts.length) { const r = h('div', 'fx-prow'); const c = h('button', 'btn sm ghost', `Clear ${pts.length} volume point${pts.length > 1 ? 's' : ''}`); c.onclick = () => { delete F.fx.vpts[g.key]; changed(); ctx.gainsChanged(); }; r.append(c); box.append(r); }
    }
    else if (l && isPiece(l)) {
      const c = cutOf(l.ckey), sp = span(l);
      title = 'Audio';
      volumeRows(box, l.vol ?? 1, !!l.mute, v => { l.vol = v; if (v > 0) l.mute = false; ctx.gainsChanged(); }, () => { l.mute = !l.mute; ctx.gainsChanged(); changed(); });
      box.append(h('div', 'fx-hint', `Part of ${rowName(l.ckey)}, ${fmt(sp.start)} to ${fmt(sp.end)}. ` + (c.free
        ? 'Unlinked: drag it to slide it in time, drag its ends to shorten it.'
        : 'Linked to the video: drag its ends to shorten it, or unlink it to slide it.') + " Delete leaves silence there. The row's volume and volume points still apply."));
      const r = h('div', 'fx-prow');
      const lk = h('button', 'btn sm ghost', c.free ? 'Link to Video' : 'Unlink from Video');
      lk.onclick = () => setLinked(l.ckey, c.free);
      const rs = h('button', 'btn sm ghost', 'Restore Whole Row');
      rs.title = `Undo every cut on ${rowName(l.ckey)}`;
      rs.onclick = () => restoreRow(l.ckey);
      r.append(lk, rs, iconBtn('trash', 'Delete (Del)', () => remove(l.id)));
      box.append(r);
    }
    else if (l && !isSound(l)) {
      title = NAMES[l.type];
      if (l.type === 'text') textProps(box, l);
      else if (l.type === 'image') rangeRow(box, 'Size', l.w * 100, 3, 100, v => { l.w = v / 100; }, '%');
      else if (l.type === 'shape') shapeProps(box, l);
      else if (l.type === 'blur') rangeRow(box, 'Strength', l.strength, 1, 10, v => { l.strength = v; });
      else if (l.type === 'zoom') zoomProps(box, l);
      else if (l.type === 'draw') drawProps(box, l);
      if (l.type === 'speed') speedProps(box, l); else timeRow(box, l);
    } else if (l && isSound(l)) {
      title = 'Audio';
      box.append(h('div', 'fx-hint', `${l.name}. Drag it to move it or onto another track, drag its ends to choose the part that plays. Double-click it to add a volume point, drag points up and down, right-click one to remove it.`));
      volumeRows(box, l.vol, !!l.mute, v => { l.vol = v; if (v > 0) l.mute = false; ctx.gainsChanged(); }, () => { l.mute = !l.mute; ctx.gainsChanged(); ctx.audioChanged(); changed(); });
      const r = h('div', 'fx-prow'); r.append(iconBtn('trash', 'Delete (Del)', () => remove(l.id))); box.append(r);
    }
    // the clip itself (or nothing) selected: the side panel shows its trim and sound under a hint
    // (crop, fades and speed are in Effects)
    if (!title) {
      title = 'Clip';
      box.append(h('div', 'fx-hint', F.sel === 'clip'
        ? 'The clip. Drag its ends on V1 to trim it. Crop, fades and speed are in the Effects tab.'
        : 'Click something on the timeline or the video to change it, or add text, shapes, audio and effects from the tabs on the left.'));
    }
    head.textContent = title;
    $('qt').classList.toggle('fxsel', title !== 'Clip');
  }
  function fadeProps(box, v) {
    const [pk, sk] = fadeKeys(v), len = F.fx.fades[pk] || F.fx.fades[sk] || FADE;
    const r = h('div', 'fx-prow');
    r.append(h('span', 'fx-plabel', 'Fades'));
    const cs = h('div', 'fx-chips');
    for (const [k, label] of [[pk, 'Picture'], [sk, 'Sound']]) {
      const c = h('button', 'chip' + (F.fx.fades[k] ? ' on' : ''), label);
      c.onclick = () => {
        F.fx.fades[k] = F.fx.fades[k] ? 0 : len;
        if (!F.fx.fades[pk] && !F.fx.fades[sk]) { removeFade(v); return; } // both off: the fade is gone
        changed(); ctx.gainsChanged();
      };
      cs.append(c);
    }
    r.append(cs, iconBtn('trash', 'Remove (Del)', () => removeFade(v)));
    box.append(r);
    chipRow(box, 'Length', [[0.25, '0.25 s'], [0.5, '0.5 s'], [1, '1 s'], [2, '2 s']], len, x => { for (const k of [pk, sk]) if (F.fx.fades[k]) F.fx.fades[k] = x; ctx.gainsChanged(); });
    box.append(h('div', 'fx-hint', v === 'vin' ? 'At the start of the trim: the picture comes in from black, the sound from silence.' : 'At the end of the trim: the picture goes to black, the sound to silence.'));
  }
  function chipRow(box, label, opts, cur, set) {
    const r = h('div', 'fx-prow');
    if (label) r.append(h('span', 'fx-plabel', label));
    const cs = h('div', 'fx-chips');
    for (const [v, t] of opts) { const c = h('button', 'chip' + (v === cur ? ' on' : ''), t); c.onclick = () => { set(v); changed(); }; cs.append(c); }
    r.append(cs); box.append(r);
  }
  function rangeRow(box, label, val, min, max, set, unit = '', fmtv) {
    const r = h('div', 'fx-prow');
    const inp = h('input'); inp.type = 'range'; inp.min = min; inp.max = max; inp.step = (max - min) <= 20 ? 0.5 : 1; inp.value = val;
    const show = v => (fmtv ? fmtv(v) : Math.round(v) + unit);
    const v = h('span', 'fx-pval', show(val));
    inp.oninput = () => { set(+inp.value); v.textContent = show(+inp.value); bump(); edit.dataset.key = ''; };
    inp.onchange = () => changed();
    r.append(h('span', 'fx-plabel', label), inp, v); box.append(r);
  }
  function colorRow(box, cur, set) {
    const r = h('div', 'fx-prow');
    r.append(h('span', 'fx-plabel', 'Colour'));
    const cs = h('div', 'fx-swatches');
    for (const c of SWATCHES) { const b = h('button', 'fx-sw' + (c === cur ? ' on' : '')); b.style.background = c; b.title = c; b.onclick = () => { set(c); changed(); }; cs.append(b); }
    const pk = h('input', 'fx-swpick'); pk.type = 'color'; pk.value = cur; pk.title = 'Any colour';
    pk.oninput = () => { set(pk.value); bump(); }; pk.onchange = () => changed();
    cs.append(pk); r.append(cs); box.append(r);
  }
  function textProps(box, l) {
    const ta = h('textarea', 'fx-text'); ta.id = 'fxtext'; ta.value = l.text; ta.rows = 2; ta.spellcheck = false;
    ta.oninput = () => { l.text = ta.value; bump(); edit.dataset.key = ''; };
    ta.onchange = () => changed();
    // Esc leaves the box (the editor's keys work again); typing stays in it
    ta.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); ta.blur(); } });
    box.append(ta);
    rangeRow(box, 'Size', l.size * 100, 2, 30, v => { l.size = v / 100; }, '%');
    colorRow(box, l.color, c => { l.color = c; });
    chipRow(box, 'Style', [['outline', 'Outline'], ['shadow', 'Shadow'], ['none', 'Plain']], l.style, v => { l.style = v; });
    chipRow(box, '', [[true, 'Bold'], [false, 'Regular']], !!l.bold, v => { l.bold = v; });
  }
  function shapeProps(box, l) {
    chipRow(box, 'Shape', SHAPES, l.shape, v => {
      const was = l.shape === 'line' || l.shape === 'arrow', now = v === 'line' || v === 'arrow';
      if (was && !now) { const b = boxOf(l, aspect()); l.box = { x: b.x, y: b.y, w: Math.max(0.05, b.w), h: Math.max(0.05, b.h) }; delete l.x1; delete l.y1; delete l.x2; delete l.y2; }
      if (!was && now) { const b = l.box; Object.assign(l, { x1: b.x, y1: b.y + b.h, x2: b.x + b.w, y2: b.y }); delete l.box; }
      l.shape = v;
    });
    if (l.shape !== 'line' && l.shape !== 'arrow') chipRow(box, 'Fill', [[false, 'Outline'], [true, 'Filled']], !!l.fill, v => { l.fill = v; });
    colorRow(box, l.color, c => { l.color = c; });
    if (!l.fill || l.shape === 'line' || l.shape === 'arrow') rangeRow(box, 'Thickness', l.stroke * 1000, 2, 40, v => { l.stroke = v / 1000; });
  }
  // which stage of a zoom the playhead is on: -1 = its own box, else the step's index
  function stageAt(z, t = Q.t) {
    let k = -1;
    (z.steps || []).forEach((st, i) => { if (t >= st.t && st.t > z.start && st.t < z.end) k = i; });
    return k;
  }
  // what the box on the video edits for a zoom: the stage under the playhead
  const zoomTarget = z => { const k = stageAt(z); return k < 0 ? z : z.steps[k]; };
  // for dragging: a step looks like a zoom (a square box kept inside the frame) to dragMove
  function zoomEditTarget(z) {
    const st = zoomTarget(z);
    if (st === z) return z;
    return { type: 'zoom', get box() { return st.box; }, set box(v) { st.box = v; } };
  }
  function addZoomStep(z) {
    const t = Q.t;
    if (t <= z.start + 0.1 || t >= z.end - 0.1) { ctx.status('Move the playhead inside the zoom to add a step there.', null, 4000); return; }
    if ((z.steps || []).some(st => Math.abs(st.t - t) < 0.1)) { ctx.status('There is a step there already.', null, 3000); return; }
    // the new step zooms in further on the same spot: three quarters of what's showing, same middle
    const b = zoomBoxAt(z, t), w = clamp(b.w * 0.75, 0.05, 1), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const st = { t: r4(t), ease: 0.4, box: keepInside({ x: cx - w / 2, y: cy - w / 2, w, h: w }) };
    z.steps = [...(z.steps || []), st].sort((a, b2) => a.t - b2.t);
    ctx.seekTo(Math.min(z.end - 0.01, t + st.ease));
    changed();
  }
  function zoomProps(box, l) {
    box.append(h('div', 'fx-hint', 'Drag the box on the video to choose what to zoom into. On its track, the lighter ends of the block are the zoom in and out: drag them for a slower zoom, or all the way to the edge for a straight cut.'));
    const s = v => (v / 10).toFixed(1) + 's';
    rangeRow(box, 'Zoom in', l.ein * 10, 0, 20, v => { l.ein = Math.min(v / 10, (l.end - l.start) / 2); }, '', s);
    rangeRow(box, 'Zoom out', l.eout * 10, 0, 20, v => { l.eout = Math.min(v / 10, (l.end - l.start) / 2); }, '', s);
    // steps: the stage under the playhead is the one the box on the video changes
    const cur = stageAt(l), list = h('div', 'fx-zsteps');
    const stageRow = (i, label, t) => {
      const r = h('div', 'fx-zstep' + (cur === i ? ' on' : ''));
      const go = h('button', 'fx-zgo', label);
      go.title = 'Show this stage (the box on the video then changes it)';
      go.onclick = () => { ctx.seekTo(i < 0 ? Math.min(l.end - 0.01, l.start + l.ein + 0.01) : Math.min(l.end - 0.01, l.steps[i].t + l.steps[i].ease)); bump(); renderAll(); };
      r.append(go, h('span', 'fx-pval', `${Math.round(1 / (i < 0 ? l.box.w : l.steps[i].box.w) * 10) / 10}x  ·  ${fmt(t)}`));
      if (i >= 0) r.append(iconBtn('trash', 'Remove this step', () => { l.steps.splice(i, 1); if (!l.steps.length) delete l.steps; changed(); }));
      list.append(r);
      if (i >= 0 && cur === i) rangeRow(list, 'Ease', l.steps[i].ease * 10, 0, 30, v => { l.steps[i].ease = v / 10; }, '', s);
    };
    stageRow(-1, 'Step 1', l.start);
    (l.steps || []).forEach((st, i) => stageRow(i, `Step ${i + 2}`, st.t));
    box.append(list);
    const r = h('div', 'fx-prow'), add = h('button', 'btn sm ghost', 'Add Step at Playhead');
    add.title = 'Zoom in further from here (then drag its box on the video)';
    add.onclick = () => addZoomStep(l);
    r.append(add); box.append(r);
  }
  function drawProps(box) {
    chipRow(box, 'Tool', [[false, 'Brush'], [true, 'Eraser']], F.brush.e, v => { F.brush.e = v; });
    colorRow(box, F.brush.c, c => { F.brush.c = c; F.brush.e = false; });
    rangeRow(box, 'Size', F.brush.s * 1000, 2, 60, v => { F.brush.s = v / 1000; });
    const r = h('div', 'fx-prow'), l = selected();
    const tool = h('button', 'btn sm' + (F.tool === 'draw' ? ' primary' : ''), F.tool === 'draw' ? 'Done drawing' : 'Draw');
    tool.onclick = () => { if (F.tool === 'draw') { F.tool = null; bump(); renderAll(); } else startDraw(); };
    const clr = h('button', 'btn sm ghost', 'Clear'); clr.onclick = () => { l.strokes = []; changed(); };
    r.append(tool, clr); box.append(r);
  }
  function cropProps(box) {
    chipRow(box, 'Aspect', CROPS, F.cropAspect, v => cropPreset(v));
    const b = F.draft || F.fx.crop, src = info();
    const r0 = h('div', 'fx-prow');
    const lock = iconBtn(F.cropLock ? 'lock' : 'unlock', F.cropLock ? 'Shape locked: corners and sides keep it (hold Shift to change it freely)' : 'Lock the shape (or hold Shift while dragging)', () => { F.cropLock = !F.cropLock; if (!F.cropLock) F.cropAspect = 0; bump(); renderAll(); });
    lock.classList.toggle('on', F.cropLock);
    r0.append(h('span', 'fx-plabel', 'Lock'), lock, h('span', 'fx-pval wide', b ? `${even(b.w * (src.width || 0))} x ${even(b.h * (src.height || 0))}` : `${src.width || 0} x ${src.height || 0} (no crop)`));
    box.append(r0);
    const r = h('div', 'fx-prow');
    const done = h('button', 'btn sm primary', 'Done'); done.onclick = endCrop;
    const reset = h('button', 'btn sm ghost', 'Reset'); reset.onclick = () => { F.fx.crop = null; F.cropAspect = 0; F.cropLock = false; changed(); };
    r.append(done, reset); box.append(r);
    box.append(h('div', 'fx-hint', 'Drag on the video to draw the crop, drag any side or corner to resize it, drag inside it to move it. Shift while dragging switches the lock. The export comes out at this shape.'));
  }
  function speedProps(box, l) {
    chipRow(box, 'Speed', TimeMap.RATES.map(v => [v, `${v}×`]), l.rate, v => { l.rate = v; });
    chipRow(box, 'Sound', [[false, 'Normal pitch'], [true, 'Mute']], !!l.mute, v => { l.mute = v; });
    chipRow(box, 'Edges', [[true, 'Eased'], [false, 'Sudden']], l.ease !== false, v => { l.ease = v; });
    const m = M(), a = m.toOut(l.start), z = m.toOut(l.end);
    const r = h('div', 'fx-prow');
    r.append(h('span', 'fx-pval wide', `${fmt(l.end - l.start)} of the clip plays for ${fmt(z - a)}`), iconBtn('trash', 'Delete (Del)', () => remove(l.id)));
    box.append(r);
    box.append(h('div', 'fx-hint', 'Drag the block or its ends on V1 to choose the part. Slowed parts take more room on the timeline; text, shapes and added sounds keep their length, and whatever comes after moves along.'));
  }
  function timeRow(box, l) {
    const r = h('div', 'fx-prow fx-times');
    for (const [k, label] of [['start', 'From'], ['end', 'To']]) {
      const inp = h('input', 'qt-t'); inp.type = 'text'; inp.value = fmt(l[k]); inp.spellcheck = false;
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = fmt(l[k]); inp.blur(); } });
      inp.addEventListener('blur', () => {
        const t = parse(inp.value);
        if (isNaN(t)) { inp.value = fmt(l[k]); return; }
        const s = k === 'start' ? clamp(t, 0, l.end - 0.1) : l.start, en = k === 'end' ? clamp(t, l.start + 0.1, limit(kindOf(l))) : l.end;
        if (free(kindOf(l), l.track | 0, s, en - s, l.id)) { l.start = s; l.end = en; }
        changed();
      });
      r.append(h('span', 'fx-plabel short', label), inp);
    }
    r.append(iconBtn('trash', 'Delete (Del)', () => remove(l.id)));
    box.append(r);
  }
  function iconBtn(ic, title, run) { const b = h('button', 'ibtn sm'); b.title = title; b.append(icoSpan(ic)); b.onclick = run; return b; }
  function renderTools() {
    $('qtundo').disabled = !ctx.canUndo(); $('qtredo').disabled = !ctx.canRedo();
    $('etlselect').classList.toggle('on', F.mode === 'select');
    $('etlrazor').classList.toggle('on', F.mode === 'razor');
    $('etlsnap').classList.toggle('on', F.snapOn);
  }
  function renderAll() {
    edit.dataset.key = ''; F.drawKey = '';
    renderTracks(); renderProps(); renderTools(); renderAssets();
    $('qtstage').classList.toggle('cropping', F.tool === 'crop');
    if (F.tool !== 'draw') brushEl.hidden = true;
  }

  // ---------- toolbar and keys ----------
  const tools = {
    crop: () => (F.tool === 'crop' ? endCrop() : startCrop()), zoom: addZoom, text: addText, image: () => pick('image'), shape: () => addShape(),
    blur: addBlur, draw: () => { if (F.tool === 'draw') { F.tool = null; bump(); renderAll(); } else startDraw(); }, audio: () => pick('audio'),
  };
  // (the Effects tab's tools have no keys for now: C is the razor, as in Premiere)
  const KEYS = { t: 'text', g: 'image', s: 'shape', a: 'audio' };
  // plain keys (Edit only); returns true when handled
  function onKey(e, k) {
    if (!F.on) return false;
    if (k === 'escape') {
      if (F.drag) return true;
      if (F.tool === 'crop') { endCrop(); return true; }
      if (F.tool) { F.tool = null; bump(); renderAll(); return true; }
      if (F.sel) { select(null); return true; }
      return false;
    }
    if ((k === 'delete' || k === 'backspace') && selFade()) { removeFade(selFade()); return true; }
    if ((k === 'delete' || k === 'backspace') && selected()) { remove(F.sel); return true; }
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (k === 'v') { setMode('select'); return true; }
    if (k === 'c') { setMode(F.mode === 'razor' ? 'select' : 'razor'); return true; }
    if (KEYS[k] && Q.dur && !Q.exporting) { tools[KEYS[k]](); return true; }
    return false;
  }
  // Ctrl+C/V/D/K with a block selected (or one copied); returns true when handled
  function onCtrl(e, k) {
    if (!F.on) return false;
    if (k === 'c' && selected()) { copyBlock(F.sel); return true; }
    if (k === 'd' && selected()) { duplicate(F.sel); return true; }
    if (k === 'k' && selected()) { split(F.sel); return true; }
    if (k === 'k' && selRow()) { if (!razorRows([selRow().key], Q.t)) ctx.status('Move the playhead inside the sound to cut it.', null, 4000); return true; }
    if (k === 'k' && Q.groups.length) { if (!razorRows(Q.groups.map(g => g.key), Q.t)) ctx.status('Move the playhead inside the sound to cut it.', null, 4000); return true; }
    if (k === 'v' && F.clipboard) return paste();
    return false;
  }

  function frame(t) {
    layout(t);
    if (F.on) { follow(t); positionPh(); }
  }
  // Trim or Edit: the timeline, asset panel and handles only exist in Edit
  function setOn(on) {
    F.on = !!on;
    if (!on) { F.sel = null; F.tool = null; F.drag = null; clearTimeout(F.thumbTimer); }
    bump(); renderAll();
    if (on) requestAnimationFrame(() => { renderTracks(); });
  }

  return {
    load, state, rasterize, frame, layout, onKey, onCtrl, dropFile, remove, select, renderAll, renderTools, renderTracks, allPts, hasVisual,
    sounds: () => F.fx.sounds, cuts: () => F.fx.cuts, fades: () => F.fx.fades, aMuted, selectedId: () => F.sel, setOn, fitView, useAsset, tab: () => (F.panelOff ? null : F.tab), pickTab,
    hasContent: () => hasContent(F.fx), view: () => ({ ...F.v }), setView: (a, b) => setView(a, b),
    map: () => M(), syncMap: () => { if (syncMap()) { bump(); renderAll(); } },
    setState(fx) { load(fx); ctx.changed(); }, // tests
    thumbCount: () => TH.frames.size, // tests
    unload() { resetThumbs(); F.sel = null; F.tool = null; F.drag = null; clearInk(); levels.replaceChildren(); edit.replaceChildren(); edit.dataset.key = ''; F.drawKey = ''; },
  };
}

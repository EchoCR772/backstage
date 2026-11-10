// The clip editor: a page beside the sidebar for one clip at a time, in two levels. Trim is the
// quick one (the clip list, the video, one timeline, Copy Video); Edit adds the asset panel, the
// picture tools and a full timeline (fx.mjs). Trims, audio settings, effects and names are saved
// per clip (the file is never changed unless you choose Replace original); Copy/Export make a new
// file from them.
// The picture comes from the GPU player (gpuplayer.mjs), the sound from the audio engine
// (engine.mjs), which also drives the clock the picture follows.
// Uses the page's shared helpers from app.js / library.js ($, h, T, icoSpan, setIco, fmt, ...).
import { GpuPlayer, ElementPlayer } from './gpuplayer.mjs';
import { createFx, curveAt } from './fx.mjs';

const Q = {
  tabs: [], tab: null,      // open clips; the one shown in the editor (null: the library is showing)
  loaded: null,             // the tab whose clip is loaded into the player
  visible: false,
  clip: null, info: null, player: null, session: null,
  dur: 0, fps: 30, tin: 0, tout: 0, t: 0, playing: false, base: { t: 0, p: 0 },
  groups: [], drag: null, wasPlaying: false, exporting: false, saveTimer: null, peaks: null, gen: 0,
  loop: true,
};
try { Q.loop = localStorage.getItem('qtLoop') !== 'off'; } catch (e) { /* ignore */ }
const qclamp = (x, a, b) => Math.min(b, Math.max(a, x));
Q.hist = []; Q.future = []; Q.snap = null;
// effects (crop, zoom, layers, added audio...): fx.mjs
const FX = createFx({
  Q, seekTo: t => seekTo(t), pause: () => pause(), play: () => play(), toggle: () => stageToggle(), changed: () => scheduleSave(),
  status: (...a) => status(...a), audioChanged: () => syncSounds(), canvas: () => $('qtcanvas'), info: () => Q.info,
  gainsChanged: () => applyGains(), canUndo: () => Q.hist.length > 0, canRedo: () => Q.future.length > 0,
  toggleRow: key => { const g = Q.groups.find(x => x.key === key); if (g) { g.mute = !g.mute; applyGains(); buildAudioRows(); FX.renderAll(); scheduleSave(); } },
  // a sound row's volume from Edit's Properties (the side panel's slider shows the same)
  rowVolume: (key, v) => { const g = Q.groups.find(x => x.key === key); if (g) { g.vol = v; if (v > 0) g.mute = false; applyGains(); buildAudioRows(); scheduleSave(); } },
  title: () => (Q.clip ? clipTitle(Q.clip) : ''),
  // V1's edges move the trim: the picture follows the edge while it's dragged
  trimMove: t => { Q.t = t; if (Q.player) Q.player.show(t); },
  trimDone: which => { Q.t = which === 'in' ? Q.tin : Math.max(Q.tin, Q.tout - 1 / Q.fps); seekTo(Q.t); drawWave(); scheduleSave(); },
  panelChanged: () => window.qtSideChanged(), // a sidebar tab folded the panel away or opened it
  silentOpen: () => !!Q.silentOpen, // the side panel's silent tracks are unfolded
  // the timeline's time changed (a speed part, the trim's speed): the sound follows it
  mapChanged: m => { if (Q.session) Q.session.setMap(m); },
});
const qpct = t => (Q.dur ? t / Q.dur * 100 : 0);
let tabSeq = 0;

// ---------- audio rows ----------
// The rows come from main (one per person in Discord clips); each keeps its mute and volume.
function savedFor(g, audio) {
  const s = (audio || {})[g.key] || (g.key.startsWith('v:') ? (audio || {}).voice : null);
  return { mute: !!(s && s.mute), vol: s ? qclamp(+s.vol || 0, 0, 2) : 1 };
}
const groupsFrom = (info, audio) => (info.groups || []).map(g => ({ ...g, ...savedFor(g, audio), open: false }));
function audioState() {
  const audio = {};
  for (const g of Q.groups) if (g.mute || Math.abs(g.vol - 1) > 0.001) audio[g.key] = { mute: g.mute, vol: Math.round(g.vol * 100) / 100 };
  return audio;
}

// ---------- the open clip ----------
// One clip at a time (Q.tab holds it and its state).
function findTab(path) { return Q.tabs.find(t => samePathR(t.clip.path, path)); }
async function openQuickTrim(c, el) {
  if (Q.tab && !samePathR(Q.tab.clip.path, c.path) && !(await canLeave())) return;
  let tab = findTab(c.path);
  if (!tab) {
    for (const t of Q.tabs.slice()) await closeTab(t, true);
    tab = { id: ++tabSeq, clip: c, st: null, peaks: null, strip: null };
    Q.tabs.push(tab);
  } else tab.clip = c;
  await activate(tab, el);
}
window.openQuickTrim = openQuickTrim;

async function activate(tab, el) {
  hideMenu(); stopPreview(); closeSettings();
  Q.tab = tab;
  showEditor(true);
  startFrames();
  // a clip that didn't load (still saving, or an error) loads again when it's clicked again
  if (Q.loaded !== tab || !Q.info) {
    if (Q.loaded) unload();
    await load(tab, el);
  }
  navCommit();
}
// going to the library closes the editor (after asking, when Edit has unsaved changes); false when
// the user kept editing
async function qtHide() {
  if (!Q.tab) return true;
  if (!(await canLeave())) return false;
  closeTab(Q.tab);
  return true;
}
window.qtHide = qtHide;
window.qtIsOpen = () => Q.visible;
window.qtActivePath = () => (Q.visible && Q.tab ? Q.tab.clip.path : null);
window.qtHasTab = p => !!findTab(p);
window.qtActivatePath = p => { const t = findTab(p); if (t) activate(t); return !!t; };
window.closeActiveTab = () => qtHide();
// what the app menu's Playback items do
window.qtApi = {
  toggle: () => toggle(), step: d => step(d), seek: d => seekTo(now() + d), loop: () => $('qtloop').click(),
  isLoop: () => Q.loop, hasPrev: () => !!neighbor(-1), hasNext: () => !!neighbor(1),
  copy: () => exportAs('video', 'clipboard'), rename: () => editTitle(),
  t: () => Q.t, seekTo: t => seekTo(t), // tests: the playhead in clip time
};

function showEditor(on) {
  Q.visible = on;
  const box = $('qt');
  if (on) {
    box.hidden = false;
    requestAnimationFrame(() => box.classList.add('on'));
    $('library').classList.add('away');
    window.addEventListener('keydown', onKey, true);
  } else {
    box.classList.remove('on');
    setTimeout(() => { if (!Q.visible) box.hidden = true; }, 160);
    $('library').classList.remove('away');
    window.removeEventListener('keydown', onKey, true);
    $('qthelpbox') && $('qthelpbox').remove();
    if (L.dirty) loadLibrary();
  }
  $('libtab').classList.toggle('active', !on);
  sideMode();
}

async function closeTab(tab, quiet) {
  if (Q.exporting && tab === Q.loaded) { T.cancel(); return; }
  const i = Q.tabs.indexOf(tab);
  if (i < 0) return;
  if (tab === Q.loaded) unload();
  Q.tabs.splice(i, 1);
  if (tab === Q.tab) { Q.tab = null; if (!quiet) { showEditor(false); navCommit(); } }
}
// clips about to be deleted: close their tabs first so the files aren't in use
window.qtCloseTabsFor = async (paths, dirs) => {
  const under = p => paths.some(x => samePathR(x, p)) || dirs.some(d => String(p).toLowerCase().startsWith(String(d).toLowerCase().replace(/[\\/]+$/, '') + (d.includes('\\') ? '\\' : '/')));
  for (const t of Q.tabs.slice()) if (under(t.clip.path)) await closeTab(t);
};

// ---------- loading a clip into the editor ----------
async function load(tab, el) {
  const c = tab.clip;
  const gen = ++Q.gen;
  Q.loaded = tab;
  Q.clip = c; Q.exporting = false; Q.playing = false; Q.peaks = tab.peaks; Q.info = null; Q.silentOpen = false;
  el && el.classList.add('opening');
  showHead();
  renderClipList();
  status('');
  $('qtmsg').textContent = '';
  $('qtaudio').replaceChildren();
  clearCanvas($('qtstrip'));

  let r = await T.qtOpen(c.path);
  el && el.classList.remove('opening');
  if (gen !== Q.gen) return;
  // a clip the recorder is still saving: say so and open it the moment it's done (the message waits a
  // moment, so a program that only glances at the file doesn't make it flash)
  if (r.ok && r.saving) {
    const since = Date.now();
    while (r.ok && r.saving) {
      if (Date.now() - since > 300) $('qtmsg').textContent = "Still saving... It opens by itself when it's done.";
      await new Promise(res => setTimeout(res, 250));
      if (gen !== Q.gen) return;
      r = await T.qtOpen(c.path);
      if (gen !== Q.gen) return;
    }
    $('qtmsg').textContent = '';
  }
  if (!r.ok) { status(r.error, 'err'); return; }
  const info = Q.info = r.info;
  if (r.title !== undefined && r.title !== c.title) { c.title = r.title; showHead(); }
  Q.dur = info.duration || c.duration || 0;
  Q.fps = info.fps || 30;
  const e = r.edit || c.edit || null;
  const st = tab.st;
  Q.tin = qclamp(st ? st.tin : e && e.in != null ? +e.in : 0, 0, Q.dur);
  Q.tout = qclamp(st ? st.tout : e && e.out != null ? +e.out : Q.dur, Q.tin + 0.05, Q.dur);
  if (Q.tout - Q.tin < 0.05) { Q.tin = 0; Q.tout = Q.dur; }
  Q.t = qclamp(st ? st.t : Q.tin, Q.tin, Q.tout);
  Q.groups = groupsFrom(info, st ? st.audio : e && e.audio);
  Q.speed = cleanSpeed(st ? st.speed : e && e.speed);
  renderSpeed();
  // silent tracks come with the clip (main proves them while it opens), so the rows are built folded;
  // tracks it couldn't settle are decoded in the background and fold later if they turn out silent
  markSilent(r.silent || []);
  if (info.encore && Q.groups.length > 1 && (!r.silent || (r.unsure && r.unsure.length))) findSilent(gen, c.path);
  FX.load(st ? st.fx : e && e.fx);
  // a clip that already has effects opens straight in Edit
  setLevel(st && st.level ? st.level : FX.hasContent() ? 'edit' : 'trim', true);
  // added sounds: the editor may read them again if they're still there
  const snd = FX.sounds();
  if (snd.length) { const a = await T.fxAllow(snd.map(x => x.path)); snd.forEach((x, i) => { x.missing = !(a.ok && a.found[i]); }); }
  if (gen !== Q.gen) return;
  $('qttot').textContent = fmt(Q.dur);
  buildAudioRows();
  layoutLane();

  // picture
  const canvas = freshCanvas();
  try {
    Q.player = await GpuPlayer.open(c.path, canvas);
  } catch (err) {
    canvas.hidden = true;
    const v = $('qtvideo'); v.hidden = false;
    try { Q.player = await ElementPlayer.open(c.url, v); } catch (err2) { $('qtmsg').textContent = "This video can't be previewed."; }
  }
  if (gen !== Q.gen) { if (Q.player) Q.player.close(); return; }
  if (Q.player) { Q.player.show(Q.t); $('qtstage').dataset.renderer = Q.player.renderer; fitPicture(); }
  // sound
  try {
    await audioReady;
    const specs = Q.groups.flatMap(g => g.idx.map(i => ({ key: 't' + i, path: c.path, index: i })))
      .concat(FX.sounds().filter(x => !x.missing).map(soundSpec), pieceSpecs(c.path));
    if (specs.length) Q.session = await window.ClipAudio.Session.open(specs, reader);
    if (Q.session) Q.session.setMap(FX.map());
  } catch (err) { Q.session = null; status("The sound can't be previewed for this clip (the export still has it).", 'err', 8000); }
  if (gen !== Q.gen) { closeMedia(); return; }
  applyGains();
  if (Q.session) Q.session.seek(Q.t);
  // timeline pictures and waveform, in the background (kept with the tab)
  if (Q.peaks) drawWave(); else loadWave(gen, tab);
  if (tab.strip && tab.stripW === $('qtstrip').clientWidth) drawSavedStrip(tab); else loadStrip(gen, tab);
  schedulePrepare(400);
  Q.hist = []; Q.future = []; Q.snap = snapNow(); FX.renderTools();
  startFrames();
  // the clips before and after this one in the list are checked next, for stepping through them
  for (const d of [1, -1]) { const n = neighbor(d); if (n && n.origin === 'encore' && n.kind !== 'export' && n.size > 0) T.silenceFirst(n.path); }
}
// Encore clips: rows whose tracks have no sound at all (main checks every sample; a single non-zero one
// keeps the row) fold away under one line in the side panel and on Edit's timeline
function markSilent(list) {
  const s = new Set(list);
  let changed = false;
  for (const g of Q.groups) {
    const v = g.idx.length > 0 && g.idx.every(i => s.has(i));
    if (!!g.silent !== v) changed = true;
    g.silent = v;
  }
  return changed;
}
async function findSilent(gen, path) {
  const r = await T.qtSilent(path, Q.groups.flatMap(g => g.idx));
  if (gen !== Q.gen || !r.ok) return;
  if (markSilent(r.silent)) { buildAudioRows(); FX.renderAll(); }
}
window.qtFx = FX; // tests reach the effects through this
// added sounds sit on the timeline (out): they play at their own speed wherever the clip is sped up
const soundSpec = x => ({ key: 's' + x.id, path: x.path, index: 0, offset: x.from - x.at, from: x.from, to: x.to, out: true });
// pieces of the clip's own sound rows (after a razor cut): each plays its part of every track in its row
function pieceSpecs(path) {
  const out = [];
  for (const [k, c] of Object.entries(FX.cuts())) {
    const g = Q.groups.find(x => x.key === k);
    if (g) for (const p of c.pieces) for (const i of g.idx) out.push({ key: `p${p.id}:${i}`, path, index: i, offset: p.from - p.at, from: p.from, to: p.to, row: k, piece: p });
  }
  return out;
}
// the added sounds or the pieces changed: the audio engine plays exactly those, where they are now
async function syncSounds() {
  const specs = FX.sounds().filter(x => !x.missing).map(soundSpec).concat(Q.clip ? pieceSpecs(Q.clip.path) : []);
  if (!Q.session && specs.length) {
    try { await audioReady; Q.session = await window.ClipAudio.Session.open([], reader); Q.session.setMap(FX.map()); } catch (e) { return; }
  }
  if (Q.session) {
    for (const key of [...Q.session.tracks.keys()]) if ((key[0] === 's' || key[0] === 'p') && !specs.some(x => x.key === key)) Q.session.remove(key);
    for (const sp of specs) {
      const t = Q.session.tracks.get(sp.key);
      if (!t) await Q.session.add(sp);
      else if (t.offset !== sp.offset || t.from !== sp.from || t.to !== sp.to) Q.session.setWindow(sp.key, { offset: sp.offset, from: sp.from, to: sp.to });
    }
  }
  applyGains();
  buildAudioRows();
}
// put the current clip away (switching tabs, closing): its state stays with the tab
function unload() {
  const tab = Q.loaded;
  Q.gen++;
  pause();
  flushSave();
  if (tab && Q.info) tab.st = { tin: Q.tin, tout: Q.tout, t: Q.t, audio: audioState(), fx: FX.state(), level: Q.level, speed: Q.speed };
  FX.unload();
  if (tab) tab.peaks = Q.peaks;
  closeMedia();
  if (Q.clip) T.qtClose(Q.clip.path);
  Q.loaded = null; Q.clip = null; Q.info = null;
}

function showHead() {
  const c = Q.clip;
  $('qttitletext').textContent = clipTitle(c);
  $('qttitle').classList.toggle('named', !!c.title);
  $('qtsub').replaceChildren(...subParts(c));
  document.title = clipTitle(c) + ' - ' + (window.APP_TITLE || T.appName);
}
function subParts(c) {
  const f = L.data && c.root && L.data.folders.find(x => samePathR(x.path, c.root));
  const parts = [c.gameName];
  if (f) parts.push(srcLabel(f));
  parts.push(new Date(c.date).toLocaleString());
  const out = [];
  parts.filter(Boolean).forEach((p, i) => { if (i) out.push(h('span', 'dot', '·')); out.push(h('span', '', p)); });
  out.push(h('span', 'dot', '·'));
  const file = h('span', 'qt-file', c.name);
  file.title = c.path;
  out.push(file);
  return out;
}
// a clip's file was renamed (Settings > File names): its tabs follow (the open clip is never renamed under the editor)
window.qtClipMoved = (from, to, move) => {
  for (const t of Q.tabs) move(t.clip);
  if (Q.clip) move(Q.clip);
  if (Q.visible) { renderClipList(true, true); if (Q.clip && samePathR(Q.clip.path, to)) showHead(); }
};
window.qtTitleChanged = (p, title) => {
  const t = findTab(p);
  if (t) t.clip.title = title;
  if (Q.clip && samePathR(Q.clip.path, p)) { Q.clip.title = title; showHead(); refreshListCard(Q.clip); FX.renderTracks(); }
};

// the picture is as big as fits in the stage at its own shape, so its outline sits on the video
// (fx.mjs lays it out: the frame is the crop's shape, and the picture moves inside it for zooms)
function fitPicture() { FX.layout(Q.t); }
new ResizeObserver(fitPicture).observe($('qtstage'));

function freshCanvas() {
  // a canvas can only ever have one kind of drawing context, so each clip gets a new one
  const old = $('qtcanvas'), c = document.createElement('canvas');
  c.id = 'qtcanvas';
  old.replaceWith(c);
  $('qtvideo').hidden = true;
  return c;
}
function clearCanvas(c) { const g = c.getContext('2d'); g.clearRect(0, 0, c.width, c.height); }

function closeMedia() {
  if (Q.player) { Q.player.close(); Q.player = null; }
  if (Q.session) { Q.session.close(); Q.session = null; }
}

$('qtclose').onclick = () => qtHide();
// clicking outside the editor closes it (right-clicks do nothing)
$('qt').addEventListener('pointerdown', e => { if (e.target === $('qt') && e.button === 0) qtHide(); });

// ---------- previous / next clip (in the library's current list) ----------
function neighbor(d) {
  if (!Q.clip || !L.list.length) return null;
  const i = L.list.findIndex(c => samePathR(c.path, Q.clip.path));
  return i < 0 ? null : L.list[i + d] || null;
}
async function step(d) { const c = neighbor(d); if (c) await goClip(c); }
// the editor moves on to another clip (its edits are saved first)
async function goClip(c) {
  if (!c || Q.exporting || !Q.tab) return;
  if (Q.clip && samePathR(c.path, Q.clip.path)) return;
  if (!(await canLeave())) return;
  const open = findTab(c.path);
  if (open) { activate(open); return; }
  const tab = Q.tab;
  await flushSave();
  unload();
  tab.clip = c; tab.st = null; tab.peaks = null; tab.strip = null;
  if (L.opened && !L.opened.has(c.path)) { L.opened.add(c.path); updateCardEdit(c); }
  await load(tab);
  navCommit();
}

// ---------- Trim / Edit ----------
// Trim always saves as you go. Edit does too with Settings > Saving edits on "Save automatically";
// otherwise (the default) its changes are held (Q.hold) until Save Changes, Cancel puts back how the
// clip was when Edit opened (Q.editBase), and leaving with unsaved changes asks first. Copy and Export
// always use what's on screen.
Q.level = 'trim'; Q.hold = false; Q.editBase = null;
const manualSave = () => L.editSave !== 'auto';
function setLevel(level, quiet) {
  Q.level = level === 'edit' ? 'edit' : 'trim';
  const edit = Q.level === 'edit';
  if (Q.saveTimer && Q.saveTimer !== -1) flushSave(); // a change made in Trim saves before Edit starts holding
  Q.hold = edit && manualSave();
  Q.editBase = edit ? snapNow() : null;
  qbox.classList.toggle('edit', edit); qbox.classList.toggle('trim', !edit);
  qbox.classList.toggle('manual', manualSave());
  applyUi();
  sideMode();
  if (!edit) $('qt').classList.remove('fxsel');
  FX.setOn(edit);
  if (!quiet) { renderClipList(); fitPicture(); if (!edit) requestAnimationFrame(() => { layoutLane(); }); }
  showEditBtn(); showSaveState();
}
// in Edit the sidebar holds Edit's tabs instead of the games
function sideMode() { document.body.classList.toggle('editlevel', Q.visible && Q.level === 'edit'); }
// Trim's Edit button shows when the clip has effects (they're in the copy either way)
function showEditBtn() { $('qtedit-btn').classList.toggle('has', FX.hasContent()); }
const dirty = () => !!(Q.hold && Q.editBase && Q.info && snapNow() !== Q.editBase);
window.qtDirty = dirty;
function showSaveState() { $('qtsave-btn').classList.toggle('dirty', dirty()); }
async function saveChanges() {
  Q.hold = false;
  if (!Q.saveTimer) Q.saveTimer = -1;
  await flushSave();
  Q.editBase = snapNow();
}
async function discardChanges() {
  if (!Q.editBase) return;
  const base = Q.editBase;
  Q.hold = false;
  clearTimeout(Q.saveTimer); Q.saveTimer = null;
  applySnap(base); // puts the clip back and saves that (it's what was saved)
  await flushSave();
}
async function backToTrim() {
  if (Q.level !== 'edit') return;
  if (dirty()) {
    const ok = await confirmBox({ title: 'Discard changes?', body: 'The changes you made in Edit will be discarded.', ok: 'Discard' });
    if (!ok) return;
    await discardChanges();
  }
  setLevel('trim');
}
// before switching clips or leaving the editor: true when it's fine to go
async function canLeave() {
  if (!dirty()) return true;
  pause();
  const v = await choiceBox({ title: 'Unsaved changes', body: 'You have changes in Edit that aren\'t saved yet.',
    buttons: [{ text: 'Keep Editing', value: null }, { text: 'Discard', value: 'discard', cls: 'danger' }, { text: 'Save Changes', value: 'save', cls: 'primary' }] });
  if (v === 'save') await saveChanges();
  else if (v === 'discard') await discardChanges();
  return !!v;
}
window.qtCanLeave = canLeave;
// closing the window with unsaved changes asks too
let closeOk = false;
window.addEventListener('beforeunload', e => {
  if (closeOk || !window.qtDirty()) return; // (through window so the tests can close the app)
  e.preventDefault(); e.returnValue = '';
  canLeave().then(ok => { if (ok) { closeOk = true; window.close(); } });
});
// Settings > Saving edits changed while in Edit
window.qtSaveModeChanged = async () => {
  qbox.classList.toggle('manual', manualSave());
  if (Q.level !== 'edit') return;
  if (!manualSave() && Q.hold) await saveChanges();
  Q.hold = manualSave(); Q.editBase = snapNow(); showSaveState();
};
$('qtedit-btn').onclick = () => setLevel('edit');
$('qttrim-btn').onclick = () => setLevel('trim');
$('qtcancel-btn').onclick = () => backToTrim();
$('qtsave-btn').onclick = async () => { await saveChanges(); setLevel('trim'); };

// ---------- the clip list beside the editor: the library's current list, as its cards ----------
// It belongs to the sidebar: with the sidebar collapsed it narrows to just the pictures.
const qls = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } };
const qlsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } };
const UI = { clipsW: qls('qtClipsW', 250), sideW: qls('qtSideW', 330), tlH: qls('qtTlH', 330) };
const qbox = $('qt').querySelector('.qt-box');
function applyUi() {
  qbox.classList.toggle('mini', L.side.collapsed && Q.level !== 'edit');
  qbox.style.setProperty('--qtclipsw', UI.clipsW + 'px');
  qbox.style.setProperty('--qtside', UI.sideW + 'px');
  qbox.style.setProperty('--qttl', UI.tlH + 'px');
  document.documentElement.style.setProperty('--qttlh', UI.tlH + 'px'); // in Edit the sidebar stops above the timeline
}
applyUi();
const saveUi = () => { qlsSet('qtClipsW', UI.clipsW); qlsSet('qtSideW', UI.sideW); qlsSet('qtTlH', UI.tlH); };
// the sidebar opened or collapsed
window.qtSideChanged = () => { applyUi(); if (Q.visible) { fitPicture(); requestAnimationFrame(() => { layoutLane(); FX.renderTracks(); renderClipList(); }); } };
// Virtual scrolling: every card is the same height, so the cards on screen are worked out from the
// scroll position; only those (plus OVERSCAN above and below) exist, the rest is empty space that
// keeps the scrollbar right. Spacing comes from CSS variables on the list (--qc-padx/--qc-gap/--qc-top).
const OVERSCAN = 6;
const listBox = $('qtcliplist');
const VL = { list: [], n: -1, els: new Map(), on: -1, w: 0, cardH: 0, rowH: 0, padx: 0, top: 0, queued: false };
const listSpace = h('div', 'qc-space');
listBox.append(listSpace);
function listMetrics() {
  const st = getComputedStyle(listBox), num = (k, d) => parseFloat(st.getPropertyValue(k)) || d;
  const padx = num('--qc-padx', 10), gap = num('--qc-gap', 10), top = num('--qc-top', 2);
  const w = listBox.clientWidth - padx * 2, cardH = Math.round(w * 3 / 4);
  return { padx, top, w, cardH, rowH: cardH + gap };
}
function placeCard(el, i) {
  el.style.top = (VL.top + i * VL.rowH) + 'px'; el.style.left = VL.padx + 'px';
  el.style.width = VL.w + 'px'; el.style.height = VL.cardH + 'px';
}
function layoutList() {
  VL.queued = false;
  const m = listMetrics();
  if (m.w <= 0) return;
  if (m.w !== VL.w || m.rowH !== VL.rowH || m.padx !== VL.padx || m.top !== VL.top) {
    Object.assign(VL, m);
    for (const [i, el] of VL.els) placeCard(el, i);
  }
  const n = VL.list.length;
  listSpace.style.height = (VL.top * 2 + n * VL.rowH) + 'px';
  const y = listBox.scrollTop;
  const first = Math.max(0, Math.floor((y - VL.top) / VL.rowH) - OVERSCAN);
  const last = Math.min(n - 1, Math.ceil((y + listBox.clientHeight - VL.top) / VL.rowH) + OVERSCAN);
  for (const [i, el] of VL.els) {
    if (i >= first && i <= last) continue;
    if (preview.el === el) stopPreview();
    el.remove(); VL.els.delete(i);
  }
  for (let i = first; i <= last; i++) {
    if (VL.els.has(i)) continue;
    const el = listCard(VL.list[i]);
    placeCard(el, i);
    el.classList.toggle('on', i === VL.on);
    listBox.append(el);
    VL.els.set(i, el);
    loadThumb(el); // from the cache once the picture has been made
  }
}
const queueList = () => { if (!VL.queued) { VL.queued = true; requestAnimationFrame(layoutList); } };
listBox.addEventListener('scroll', queueList, { passive: true });
new ResizeObserver(queueList).observe(listBox);
// the library's own card, without the hover seek bar; opening it here moves the editor on to it
function listCard(c) {
  const el = card(c);
  thumbObs.unobserve(el);
  el.classList.add('lc');
  el.title = clipTitle(c);
  const go = e => { if (e) e.stopPropagation(); goClip(el._clip); };
  el.onclick = e => { if (e.ctrlKey || e.metaKey || e.shiftKey) return; go(e); };
  el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.stopImmediatePropagation(); go(e); } }, true);
  return el;
}
// the list is the library's current list (the game picked in the sidebar)
function renderClipList(rebuild, keepScroll) {
  if (!Q.clip) return;
  const list = L.list && L.list.length ? L.list : [Q.clip];
  $('qtclipstitle').textContent = $('libname').textContent || 'Clips';
  window.fillGamePick($('qtgamepick'));
  if (rebuild || list !== VL.list || list.length !== VL.n) {
    for (const el of VL.els.values()) el.remove();
    VL.els.clear(); VL.list = list; VL.n = list.length;
  }
  VL.on = list.findIndex(c => samePathR(c.path, Q.clip.path));
  for (const [i, el] of VL.els) if ((i === VL.on) !== el.classList.contains('on')) el.classList.toggle('on', i === VL.on);
  layoutList();
  // the open clip in view (not when the library refreshed under it)
  if (VL.on >= 0 && VL.rowH && !keepScroll) {
    const y = VL.top + VL.on * VL.rowH;
    if (y < listBox.scrollTop || y + VL.cardH > listBox.scrollTop + listBox.clientHeight) { listBox.scrollTop = Math.max(0, y - (listBox.clientHeight - VL.cardH) / 2); layoutList(); }
  }
}
window.qtListChanged = keepScroll => { if (Q.visible) renderClipList(true, keepScroll); };
// Edit's Clips tab: the game filter is a picker above the list (with search and sort)
$('qtgamepick').onclick = () => window.openGamePicker($('qtgamepick'));
// the open clip's card follows its trim and name
function refreshListCard(c) {
  for (const el of VL.els.values()) if (samePathR(el._clip.path, c.path)) { el._clip = c; refreshCard(el, c); }
}
backToTop($('qtcliplist'));
// dragging the dividers: the clip list, the side panel, Edit's timeline (remembered)
function dragGrip(el, onMove, onReset) {
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const move = ev => { onMove(ev); applyUi(); fitPicture(); };
    const up = () => { el.removeEventListener('pointermove', move); document.body.classList.remove('resizing'); saveUi(); fitPicture(); FX.renderTracks(); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up, { once: true });
    el.addEventListener('pointercancel', up, { once: true });
  });
  el.addEventListener('dblclick', () => { onReset(); applyUi(); saveUi(); fitPicture(); FX.renderTracks(); });
}
dragGrip($('qtclipsgrip'), e => { UI.clipsW = Math.round(qclamp(e.clientX - $('qtclips').getBoundingClientRect().left, 190, 420)); }, () => { UI.clipsW = 250; });
dragGrip($('qtsidegrip'), e => { UI.sideW = Math.round(qclamp(qbox.getBoundingClientRect().right - e.clientX, 280, 560)); }, () => { UI.sideW = 330; });
dragGrip($('qttlgrip'), e => {
  const r = qbox.getBoundingClientRect();
  UI.tlH = Math.round(qclamp(r.bottom - e.clientY, 200, Math.max(220, r.height - 260)));
}, () => { UI.tlH = 330; });

// ---------- renaming (click the title) ----------
function editTitle() {
  if (!Q.clip) return;
  const inp = $('qttitlein');
  inp.value = Q.clip.title || '';
  inp.placeholder = `Clip from ${fmtWhen(Q.clip.date)}`;
  $('qttitle').hidden = true;
  inp.hidden = false;
  inp.focus(); inp.select();
}
function endTitle(save) {
  const inp = $('qttitlein');
  if (inp.hidden) return;
  inp.hidden = true;
  $('qttitle').hidden = false;
  if (save && Q.clip && inp.value.trim() !== (Q.clip.title || '')) setClipTitle(Q.clip, inp.value);
}
$('qttitle').onclick = editTitle;
$('qttitlein').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); endTitle(true); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endTitle(false); }
});
$('qttitlein').addEventListener('blur', () => endTitle(true));

// ---------- speed (Trim's Speed row): the whole trim plays and exports at this speed, sound at its own pitch ----------
const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4];
const cleanSpeed = v => (SPEEDS.includes(+v) ? +v : 1);
function renderSpeed() {
  const box = $('qtspeed');
  box.replaceChildren(...SPEEDS.map(v => {
    const b = h('button', 'chip' + (v === Q.speed ? ' on' : ''), `${v}×`);
    b.onclick = () => setSpeed(v);
    return b;
  }));
}
function setSpeed(v) {
  if (!Q.info || v === Q.speed) return;
  const at = now();
  Q.speed = v;
  renderSpeed();
  FX.syncMap(); // the sound follows, and what's added on the timeline keeps its place on the clip
  if (Q.playing && !Q.session) Q.base = { t: at, p: performance.now() }; // no sound: the clock goes on from here
  scheduleSave();
}

// ---------- playback ----------
// with no sound playing, the picture keeps the timeline's time (speed parts included)
const clock = () => {
  if (Q.starting) return Q.base.t;
  if (Q.session && Q.session.playing) return Q.session.audible;
  const m = FX.map();
  return m.toClip(m.toOut(Q.base.t) + (performance.now() - Q.base.p) / 1000);
};
async function play(from = Q.t) {
  if (!Q.player || !Q.dur) return;
  if (from < Q.tin - 0.01 || from >= Q.tout - 0.03) from = Q.tin;
  Q.playing = true;
  Q.starting = true; // until the sound is scheduled, the clock holds at `from`
  for (const b of [$('qtplay'), $('etlplay')]) setIco(b.firstElementChild, 'pause');
  Q.base = { t: from, p: performance.now() };
  Q.player.play(clock, from);
  if (Q.session) await Q.session.play(from);
  Q.base = { t: from, p: performance.now() };
  Q.starting = false;
}
function pause() {
  if (!Q.playing) return;
  Q.t = qclamp(clock(), Q.tin, Q.tout);
  Q.playing = false;
  Q.starting = false;
  for (const b of [$('qtplay'), $('etlplay')]) setIco(b.firstElementChild, 'play');
  if (Q.session) Q.session.pause();
  if (Q.player) Q.player.stop();
}
const toggle = () => (Q.playing ? pause() : play());
$('qtplay').onclick = toggle;
$('etlplay').onclick = toggle;
function seekTo(t) {
  Q.t = qclamp(t, Q.tin, Q.tout);
  if (Q.playing) { play(Q.t); return; }
  if (Q.player) Q.player.show(Q.t);
  if (Q.session) Q.session.seek(Q.t);
}
const now = () => (Q.playing ? clock() : Q.t);
// Trim's and Edit's transport bars have the same buttons
$('qttostart').onclick = $('etltostart').onclick = () => seekTo(Q.tin);
$('qtmarkin').onclick = $('etlmarkin').onclick = () => setIn(now());
$('qtmarkout').onclick = $('etlmarkout').onclick = () => setOut(now());
$('qtfback').onclick = $('etlfback').onclick = () => { pause(); seekTo(Q.t - 1 / Q.fps); };
$('qtffwd').onclick = $('etlffwd').onclick = () => { pause(); seekTo(Q.t + 1 / Q.fps); };
window.qtDropFile = (p, x, y) => (Q.info && !Q.exporting ? FX.dropFile(p, x, y) : null);
$('qttoend').onclick = $('etltoend').onclick = () => { pause(); seekTo(Q.tout - 1 / Q.fps); };
$('qtback').onclick = $('etlback').onclick = () => seekTo(now() - 10);
$('qtfwd').onclick = $('etlfwd').onclick = () => seekTo(now() + 10);
function showLoop() { for (const b of [$('qtloop'), $('etlloop')]) { b.classList.toggle('on', Q.loop); b.dataset.tip = Q.loop ? 'Looping the trim (click to play through once)' : 'Loop the trim while playing'; } }
$('qtloop').onclick = $('etlloop').onclick = () => { Q.loop = !Q.loop; showLoop(); try { localStorage.setItem('qtLoop', Q.loop ? 'on' : 'off'); } catch (e) { /* ignore */ } };
showLoop();
// click the picture to play / pause, with a quick icon like most players
$('qtstage').addEventListener('click', e => { if (!e.target.closest('#qtedit')) stageToggle(); });
function stageToggle() {
  if (!Q.player || Q.exporting) return;
  toggle();
  const f = $('qtflash');
  f.replaceChildren(icoSpan(Q.playing ? 'play' : 'pause'));
  f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
}

// one drawing loop, running while the editor is showing
function startFrames() { if (!Q.frameOn) { Q.frameOn = true; requestAnimationFrame(frame); } }
function frame() {
  if (!Q.visible && !Q.playing) { Q.frameOn = false; return; }
  if (Q.playing && !Q.starting) {
    const t = clock();
    if (t >= Q.tout - 0.005) { if (Q.loop) play(Q.tin); else { pause(); Q.t = Q.tout; } }
    else Q.t = Math.max(Q.tin, t);
  }
  FX.frame(Q.t);
  if (Q.playing) applyGains();
  // fades in the preview: the picture over black
  const fd = FX.fades(), m = FX.map(), oa = m.toOut(Q.tin), oz = m.toOut(Q.tout), ot = m.toOut(Q.t);
  let vk = 1;
  if (fd.vin) vk = Math.min(vk, qclamp((ot - oa) / fd.vin, 0, 1));
  if (fd.vout) vk = Math.min(vk, qclamp((oz - ot) / fd.vout, 0, 1));
  $('qtview').style.opacity = vk;
  $('qtframe').textContent = `frame ${Math.round(Q.t * Q.fps)}`;
  $('qtph').style.left = qpct(Q.t) + '%';
  $('qtsel').style.left = `calc(${qpct(Q.tin)}% - 4px)`;
  $('qtsel').style.width = `calc(${qpct(Q.tout) - qpct(Q.tin)}% + 8px)`;
  $('qtshadeL').style.width = qpct(Q.tin) + '%';
  $('qtshadeR').style.width = (100 - qpct(Q.tout)) + '%';
  // Edit shows the timeline's time; Trim the clip's
  $('qtcur').textContent = fmt(Q.t);
  $('etlcur').textContent = fmt(ot);
  // with another speed, the length and size are those of the file it makes
  const outLen = oz - oa;
  $('etllen').textContent = fmt(outLen);
  $('qtlen').textContent = fmt(outLen);
  $('qtof').textContent = ` of ${fmt(Q.dur)}`;
  const whole = Q.tin <= 0.01 && Q.tout >= Q.dur - 0.01 && m.identity, sz = Q.info && Q.info.size;
  $('qtsize').textContent = sz ? (whole ? `Size ${fmtSize(sz)}` : `Size ≈ ${fmtSize(estSize(sz, outLen, Q.dur))} (from ${fmtSize(sz)})`) : '';
  if (document.activeElement !== $('qtin')) $('qtin').value = fmt(Q.tin);
  if (document.activeElement !== $('qtout')) $('qtout').value = fmt(Q.tout);
  $('qtreset').disabled = !(Q.tin > 0.01 || Q.tout < Q.dur - 0.01);
  requestAnimationFrame(frame);
}

// ---------- timeline ----------
const lane = $('qtlane');
const xToT = e => { const r = lane.getBoundingClientRect(); return qclamp((e.clientX - r.left) / r.width * Q.dur, 0, Q.dur); };
function dragTo(e) {
  const t = xToT(e);
  if (Q.drag === 'in') { Q.tin = qclamp(t, 0, Q.tout - 0.1); Q.t = Q.tin; if (Q.player) Q.player.show(Q.tin); drawWave(); }
  else if (Q.drag === 'out') { Q.tout = qclamp(t, Q.tin + 0.1, Q.dur); Q.t = Q.tout; if (Q.player) Q.player.show(Q.tout); drawWave(); }
  else { Q.t = qclamp(t, Q.tin, Q.tout); if (Q.player) Q.player.show(Q.t); } // the playhead stays inside the selection
}
lane.addEventListener('pointerdown', e => {
  if (!Q.dur || e.button !== 0 || Q.exporting) return;
  lane.setPointerCapture(e.pointerId);
  Q.wasPlaying = Q.playing;
  pause();
  Q.drag = e.target.id === 'qtgin' ? 'in' : e.target.id === 'qtgout' ? 'out' : 'seek';
  dragTo(e);
});
lane.addEventListener('pointermove', e => { if (Q.drag) dragTo(e); });
function endDrag() {
  if (!Q.drag) return;
  const d = Q.drag;
  Q.drag = null;
  if (d === 'in' || d === 'out') { Q.t = d === 'in' ? Q.tin : Q.t; scheduleSave(); }
  if (Q.session && !Q.wasPlaying) Q.session.seek(Q.t);
  if (Q.wasPlaying) play(d === 'out' ? Math.max(Q.tin, Q.tout - 2) : d === 'in' ? Q.tin : Q.t);
  Q.wasPlaying = false;
}
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) lane.addEventListener(ev, endDrag);

function layoutLane() { buildQtRuler(); drawWave(); }
// when the editor changes size the ruler and waveform follow right away, the pictures (which take
// decoding) once it settles
let stripTimer = null;
new ResizeObserver(() => {
  if (!Q.loaded) return;
  buildQtRuler(); drawWave();
  clearTimeout(stripTimer);
  if (Q.player) stripTimer = setTimeout(() => loadStrip(Q.gen, Q.loaded), 250);
}).observe(lane);

function buildQtRuler() {
  const r = $('qtruler');
  r.replaceChildren();
  const w = lane.clientWidth;
  if (!Q.dur || !w) return;
  const pps = w / Q.dur;
  const steps = [0.5, 1, 2, 5, 10, 15, 20, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const major = steps.find(s => s * pps >= 70) || 3600, minor = major / 5;
  const n = Math.floor(Q.dur / minor + 1e-6);
  for (let i = 0; i <= n; i++) {
    const t = i * minor, isMajor = i % 5 === 0;
    const d = h('div', 'tick' + (isMajor ? ' major' : ''));
    d.style.left = qpct(t) + '%';
    r.append(d);
    if (isMajor && qpct(t) < 96) {
      const l = h('div', 'tlabel', t < 60 ? (major < 1 ? t.toFixed(1) : Math.round(t)) + 's' : `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`);
      l.style.left = qpct(t) + '%';
      r.append(l);
    }
  }
}

async function loadWave(gen, tab) {
  const w = lane.clientWidth;
  // the waveform shows the voices (Discord voices, NVIDIA's mic track); clips without one show their audio
  const voices = Q.groups.filter(g => g.icon === 'mic').flatMap(g => g.idx);
  const r = await T.qtWave(Q.clip.path, Q.dur, Math.round(w / 3), voices.length ? voices : null);
  if (gen !== Q.gen || !r.ok || !r.peaks) return;
  Q.peaks = tab.peaks = r.peaks;
  drawWave();
}
function drawWave() {
  const c = $('qtwave'), dpr = devicePixelRatio || 1;
  const w = c.clientWidth, hh = c.clientHeight;
  c.width = Math.round(w * dpr); c.height = Math.round(hh * dpr);
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  if (!Q.peaks || !w) return;
  const n = Q.peaks.length, bw = w / n;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n * Q.dur;
    const v = Math.max(0.04, Q.peaks[i]);
    const bh = v * (hh - 2);
    g.fillStyle = t >= Q.tin && t <= Q.tout ? '#b5b6bc' : '#4a4950';
    g.fillRect(Math.round(i * bw * dpr), Math.round((hh - bh) / 2 * dpr), Math.max(1, Math.round((bw - 1) * dpr)), Math.max(1, Math.round(bh * dpr)));
  }
}

async function loadStrip(gen, tab) {
  const c = $('qtstrip'), dpr = devicePixelRatio || 1;
  const w = c.clientWidth, hh = c.clientHeight;
  if (!w || !hh || !Q.player || !Q.dur) return;
  c.width = Math.round(w * dpr); c.height = Math.round(hh * dpr);
  const g = c.getContext('2d');
  const ar = (Q.player.width || 16) / (Q.player.height || 9);
  const tw = hh * ar, n = Math.max(1, Math.ceil(w / tw));
  const times = Array.from({ length: n }, (_x, i) => Math.min(Q.dur - 0.05, (i + 0.5) * Q.dur / n));
  try {
    await Q.player.thumbnails(times, (i, s) => {
      if (gen !== Q.gen) return;
      s.draw(g, Math.round(i * tw * dpr), 0, Math.ceil(tw * dpr), c.height);
    });
  } catch (e) { return; } // the strip just stays as far as it got
  // kept with the tab, so switching back doesn't decode them again
  if (gen === Q.gen && tab) { try { tab.strip = await createImageBitmap(c); tab.stripW = w; } catch (e) { /* ignore */ } }
}
function drawSavedStrip(tab) {
  const c = $('qtstrip');
  c.width = tab.strip.width; c.height = tab.strip.height;
  c.getContext('2d').drawImage(tab.strip, 0, 0);
}

// ---------- trim ----------
function setIn(t) { Q.tin = qclamp(t, 0, Q.tout - 0.1); seekTo(Q.tin); drawWave(); scheduleSave(); }
function setOut(t) { Q.tout = qclamp(t, Q.tin + 0.1, Q.dur); if (Q.t > Q.tout) seekTo(Q.tout); drawWave(); scheduleSave(); }
$('qtreset').onclick = () => { Q.tin = 0; Q.tout = Q.dur; seekTo(0); drawWave(); scheduleSave(); };
// typing a start or end time
for (const [id, fn, get] of [['qtin', setIn, () => Q.tin], ['qtout', setOut, () => Q.tout]]) {
  const el = $(id);
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter') { const t = parse(el.value); if (!isNaN(t)) fn(t); el.blur(); }
    if (e.key === 'Escape') { e.stopPropagation(); el.value = fmt(get()); el.blur(); }
  });
  el.addEventListener('blur', () => { const t = parse(el.value); if (Q.dur && !isNaN(t) && Math.abs(t - get()) > 0.001) fn(t); });
}

function editState() {
  const audio = audioState(), fx = FX.state();
  const trimmed = Q.tin > 0.01 || Q.tout < Q.dur - 0.01;
  if (!trimmed && !Object.keys(audio).length && !fx && Q.speed === 1) return null;
  const e = { in: Math.round(Q.tin * 1000) / 1000, out: Math.round(Q.tout * 1000) / 1000, dur: Q.dur, audio };
  if (fx) e.fx = fx;
  if (Q.speed !== 1) e.speed = Q.speed;
  return e;
}
// ---------- undo / redo (Ctrl+Z, Ctrl+Shift+Z): trims, audio rows and effects ----------
const snapNow = () => JSON.stringify({ tin: Math.round(Q.tin * 1000) / 1000, tout: Math.round(Q.tout * 1000) / 1000, audio: audioState(), fx: FX.state(), speed: Q.speed },
  (k, v) => (k === 'png' || k === 'sig' || k === 'missing' ? undefined : v));
function pushHistory() {
  const s = snapNow();
  if (Q.snap !== null && s !== Q.snap) { Q.hist.push(Q.snap); if (Q.hist.length > 100) Q.hist.shift(); Q.future = []; }
  Q.snap = s;
  FX.renderTools();
}
async function undo() { if (!Q.info) return; await flushSave(); if (!Q.hist.length) return; Q.future.push(Q.snap); applySnap(Q.hist.pop()); }
async function redo() { if (!Q.info) return; await flushSave(); if (!Q.future.length) return; Q.hist.push(Q.snap); applySnap(Q.future.pop()); }
function applySnap(s) {
  const o = JSON.parse(s);
  pause();
  Q.tin = o.tin; Q.tout = o.tout;
  Q.speed = cleanSpeed(o.speed); renderSpeed();
  for (const g of Q.groups) { const a = o.audio[g.key]; g.mute = !!(a && a.mute); g.vol = a ? qclamp(+a.vol, 0, 2) : 1; }
  FX.load(o.fx, true); // keeps the tool in use (drawing goes on after Ctrl+Z)
  if (Q.session) Q.session.setMap(FX.map());
  Q.snap = s;
  seekTo(qclamp(Q.t, Q.tin, Q.tout));
  drawWave();
  syncSounds();
  Q.saveTimer = -1;
  flushSave();
}
$('qtundo').onclick = () => undo();
$('qtredo').onclick = () => redo();
function scheduleSave() { clearTimeout(Q.saveTimer); Q.saveTimer = setTimeout(flushSave, 250); schedulePrepare(); }
// make the trimmed clip in the background so Copy Video and dragging the card are instant
function schedulePrepare(ms = 900) {
  clearTimeout(Q.prepTimer);
  Q.prepTimer = setTimeout(() => {
    if (!Q.loaded || !Q.info || Q.drag || !editState() || FX.state() || Q.speed !== 1) return; // effects and speed take a full encode: made when asked
    T.qtPrepare({ path: Q.clip.path, start: Q.tin, end: Q.tout, audio: audioState() });
  }, ms);
}
async function flushSave() {
  if (!Q.saveTimer || !Q.clip || !Q.info) return;
  clearTimeout(Q.saveTimer); Q.saveTimer = null;
  const clip = Q.clip, hold = Q.hold;
  await FX.rasterize(); // text, pictures, shapes and drawings as PNGs for the export
  if (hold) { if (Q.clip === clip) { pushHistory(); showSaveState(); } return; } // Edit, not saved yet
  const e = editState();
  clip.edit = e;
  await T.qtEdit(clip.path, e);
  updateCardEdit(clip);
  if (Q.clip === clip) { pushHistory(); refreshListCard(clip); }
}

// ---------- audio rows ----------
function buildAudioRows() {
  const box = $('qtaudio');
  box.replaceChildren();
  if (!Q.groups.length && !FX.sounds().length) { box.append(h('div', 'qt-none', 'This clip has no sound.')); }
  const quiet = Q.groups.filter(g => g.silent);
  for (const g of Q.groups) if (!g.silent) box.append(groupRow(g));
  if (quiet.length) {
    const fold = h('button', 'qt-silentfold' + (Q.silentOpen ? ' open' : ''));
    fold.title = 'These tracks have no sound at all in this clip';
    fold.append(icoSpan('chev'), h('span', '', `${quiet.length} silent track${quiet.length > 1 ? 's' : ''}`));
    fold.onclick = () => { Q.silentOpen = !Q.silentOpen; buildAudioRows(); FX.renderAll(); };
    box.append(fold);
    if (Q.silentOpen) for (const g of quiet) box.append(groupRow(g));
  }
  function groupRow(g) {
    const row = h('div', 'qt-arow' + (g.open ? ' open' : '') + (g.mute ? ' muted' : '') + (g.silent ? ' silent' : ''));
    const head = h('div', 'qt-ahead');
    const name = h('button', 'qt-aname');
    name.title = 'Volume';
    name.append(icoSpan(g.icon), h('span', 'qt-anametext', g.name), h('span', 'qt-avol', Math.abs(g.vol - 1) > 0.001 ? Math.round(g.vol * 100) + '%' : ''));
    name.onclick = () => { g.open = !g.open; buildAudioRows(); };
    head.append(name);
    // people in Discord clips can be named once; the name is used in every clip they're in
    if (g.user && !g.me) {
      const ren = h('button', 'ibtn sm qt-aren');
      ren.title = g.named ? 'Rename' : 'Name this person';
      ren.append(icoSpan('edit'));
      ren.onclick = () => nameRow(row, g);
      head.append(ren);
    }
    head.append(ptsBtn(g.key));
    const mute = h('button', 'ibtn sm qt-amute');
    mute.title = g.mute ? 'Unmute' : 'Mute';
    mute.append(icoSpan(g.mute ? 'speakerOff' : 'speaker'));
    mute.onclick = () => { g.mute = !g.mute; applyGains(); buildAudioRows(); FX.renderAll(); scheduleSave(); };
    head.append(mute);
    row.append(head);
    if (g.open) {
      const sl = h('div', 'qt-aslider');
      const r = h('input'); r.type = 'range'; r.min = 0; r.max = 200; r.step = 5; r.value = Math.round(g.vol * 100);
      const v = h('span', '', Math.round(g.vol * 100) + '%');
      r.oninput = () => { g.vol = r.value / 100; v.textContent = r.value + '%'; if (g.vol > 0) g.mute = false; applyGains(); row.querySelector('.qt-avol').textContent = Math.abs(g.vol - 1) > 0.001 ? r.value + '%' : ''; scheduleSave(); };
      r.onchange = () => { if (FX.selectedId() === 'row:' + g.key) FX.renderAll(); };
      r.ondblclick = () => { r.value = 100; r.oninput(); };
      sl.append(r, v);
      row.append(sl);
    }
    return row;
  }
  // added audio (music, sound effects)
  for (const x of FX.sounds()) {
    const row = h('div', 'qt-arow' + (x.open ? ' open' : '') + (x.mute ? ' muted' : '') + (x.missing ? ' missing' : ''));
    const head = h('div', 'qt-ahead');
    const name = h('button', 'qt-aname');
    name.title = x.missing ? `Not found: ${x.path}` : 'Volume';
    name.append(icoSpan('music'), h('span', 'qt-anametext', x.name + (x.missing ? ' (missing)' : '')), h('span', 'qt-avol', Math.abs(x.vol - 1) > 0.001 ? Math.round(x.vol * 100) + '%' : ''));
    name.onclick = () => { x.open = !x.open; buildAudioRows(); };
    const mute = h('button', 'ibtn sm qt-amute');
    mute.title = x.mute ? 'Unmute' : 'Mute';
    mute.append(icoSpan(x.mute ? 'speakerOff' : 'speaker'));
    mute.onclick = () => { x.mute = !x.mute; applyGains(); buildAudioRows(); FX.renderAll(); scheduleSave(); };
    const del = h('button', 'ibtn sm');
    del.title = 'Remove this audio';
    del.append(icoSpan('trash'));
    del.onclick = () => FX.remove(x.id);
    head.append(name, ptsBtn('s:' + x.id), mute, del);
    row.append(head);
    if (x.open) {
      const sl = h('div', 'qt-aslider');
      const r = h('input'); r.type = 'range'; r.min = 0; r.max = 200; r.step = 5; r.value = Math.round(x.vol * 100);
      const v = h('span', '', Math.round(x.vol * 100) + '%');
      r.oninput = () => { x.vol = r.value / 100; v.textContent = r.value + '%'; if (x.vol > 0) x.mute = false; applyGains(); row.querySelector('.qt-avol').textContent = Math.abs(x.vol - 1) > 0.001 ? r.value + '%' : ''; scheduleSave(); };
      r.ondblclick = () => { r.value = 100; r.oninput(); };
      sl.append(r, v);
      row.append(sl);
    }
    box.append(row);
  }
  const add = h('button', 'btn sm ghost qt-addaudio');
  add.append(icoSpan('plus'), document.createTextNode('Add audio'));
  add.onclick = () => FX.useAsset('file:audio');
  box.append(add);
}
// volume points for a row: opens its track on the timeline
function ptsBtn(key) {
  const b = h('button', 'ibtn sm qt-apts' + (FX.allPts()[key] ? ' on' : ''));
  b.title = 'Volume points: change the volume over time on Edit\'s timeline';
  b.append(icoSpan('points'));
  // in Edit, that row (or added sound) gets selected: its Properties say how to add points
  b.onclick = () => { if (Q.level !== 'edit') setLevel('edit'); FX.select(key.startsWith('s:') ? key.slice(2) : 'row:' + key); };
  return b;
}
function nameRow(row, g) {
  const label = row.querySelector('.qt-aname');
  const inp = h('input', 'qt-ain');
  inp.type = 'text'; inp.maxLength = 40; inp.spellcheck = false;
  inp.value = g.named ? g.name : ''; inp.placeholder = g.name;
  label.replaceWith(inp);
  inp.focus(); inp.select();
  let done = false;
  const finish = async save => {
    if (done) return;
    done = true;
    if (save && inp.value.trim() !== (g.named ? g.name : '')) {
      const r = await T.personName(g.user, inp.value);
      if (r.ok) {
        // everywhere this person shows up, in every open tab
        for (const x of Q.groups) if (x.user === g.user) { x.named = !!r.name; if (r.name) x.name = r.name; }
        if (!r.name && Q.info) { const fresh = (await T.qtOpen(Q.clip.path)); if (fresh.ok) { Q.info.groups = fresh.info.groups; for (const x of Q.groups) { const f = fresh.info.groups.find(y => y.key === x.key); if (f) { x.name = f.name; x.named = f.named; } } } }
      } else status(r.error, 'err', 6000);
    }
    buildAudioRows();
  };
  inp.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  inp.addEventListener('blur', () => finish(true));
}
// each row's volume, following its volume points and the sound fades
function applyGains() {
  if (!Q.session) return;
  const t = Q.playing ? clock() : Q.t, vp = FX.allPts(), fd = FX.fades(), m = FX.map(), o = m.toOut(t);
  let k = 1;
  if (fd.ain) k = Math.min(k, qclamp((o - m.toOut(Q.tin)) / fd.ain, 0, 1));
  if (fd.aout) k = Math.min(k, qclamp((m.toOut(Q.tout) - o) / fd.aout, 0, 1));
  // a cut row plays through its pieces only
  const cuts = FX.cuts();
  for (const g of Q.groups) for (const i of g.idx) Q.session.setGain('t' + i, g.mute || cuts[g.key] ? 0 : g.vol * curveAt(vp[g.key], t) * k);
  if (Object.keys(cuts).length) for (const sp of pieceSpecs('')) { const g = Q.groups.find(x => x.key === sp.row), p = sp.piece; Q.session.setGain(sp.key, g.mute || p.mute ? 0 : g.vol * (p.vol ?? 1) * curveAt(vp[g.key], t) * k); }
  for (const x of FX.sounds()) Q.session.setGain('s' + x.id, FX.aMuted(x) ? 0 : x.vol * curveAt(vp['s:' + x.id], o) * k);
}

// listening volume (shared with the rest of the app; never changes the export)
function showListen() {
  $('qtlvol').value = Math.round(listenVol * 100);
  setIco($('qtlmute').firstElementChild, listenMute || !listenVol ? 'headphonesOff' : 'headphones');
  $('qtlmute').classList.toggle('off', listenMute);
}
$('qtlvol').addEventListener('input', () => { listenVol = Number($('qtlvol').value) / 100; listenMute = false; applyListen(); showListen(); });
$('qtlmute').onclick = () => { listenMute = !listenMute; applyListen(); showListen(); };
$('qtlisten').addEventListener('wheel', e => {
  e.preventDefault();
  listenVol = Math.min(1, Math.max(0, Math.round(listenVol * 100 - Math.sign(e.deltaY) * 5) / 100));
  listenMute = false; applyListen(); showListen();
}, { passive: false });
showListen();

// ---------- messages and the export confirmation ----------
// A small card at the left of the bottom row: what happened, the file, and what you can do next.
function status(text, cls, hideMs) {
  const s = $('qtstatus');
  s.className = 'qt-status' + (cls ? ' ' + cls : '');
  s.replaceChildren(...(Array.isArray(text) ? text : [text || '']));
  clearTimeout(status.t);
  if (hideMs) armHide(hideMs);
}
function armHide(ms) {
  const s = $('qtstatus');
  status.t = setTimeout(() => { if (s.matches(':hover')) armHide(1500); else { s.classList.add('fade'); status.t = setTimeout(() => status(''), 300); } }, ms);
}
function done({ title, detail, actions = [], warn, cls = 'ok', ms = 10000 }) {
  const card = h('div', 'qt-done');
  const ic = h('span', 'qt-doneicon'); ic.append(icoSpan(cls === 'err' ? 'x' : 'checkCircle'));
  const txt = h('div', 'qt-donetext');
  txt.append(h('b', '', title));
  if (detail) { const d = h('span', 'qt-donedetail', detail); d.title = detail; txt.append(d); }
  if (warn) txt.append(h('span', 'qt-donewarn', warn));
  card.append(ic, txt);
  for (const a of actions) { const b = h('button', 'btn sm', a.text); b.onclick = a.run; card.append(b); }
  status([card], cls, ms);
}
T.onQtProgress(p => {
  if (!Q.exporting) return;
  $('qtbar').value = p;
  const n = $('qtstatus').querySelector('.qt-pct');
  if (n) n.textContent = Math.round(p * 100) + '%';
});
const working = text => { const w = h('span', 'qt-working'); w.append(h('span', 'qt-spin'), h('span', '', text + ' '), h('span', 'qt-pct', '')); status([w]); };

// ---------- copy / export ----------
async function exportAs(as, dest, target) {
  if (!Q.loaded || !Q.info || Q.exporting) return;
  pause();
  if (!Q.saveTimer) Q.saveTimer = -1; // make sure the effects' pictures are saved
  await flushSave();
  Q.exporting = true;
  $('qt').classList.add('busy');
  // Copy Video is usually ready already; only show progress if it takes a moment
  const slow = setTimeout(() => { $('qtbar').hidden = false; $('qtbar').value = 0; working(dest === 'clipboard' ? `Making the ${as === 'audio' ? 'audio' : 'clip'}...` : 'Exporting...'); }, dest === 'clipboard' && !target ? 250 : 0);
  const r = await T.qtExport({ path: Q.clip.path, start: Q.tin, end: Q.tout, as, dest, audio: audioState(), fx: FX.state(), speed: Q.speed, target: target || 0 });
  clearTimeout(slow);
  Q.exporting = false;
  $('qt').classList.remove('busy');
  $('qtbar').hidden = true;
  if (!Q.loaded) return;
  if (!r.ok) { done({ title: "Couldn't " + (dest === 'clipboard' ? 'copy it' : 'export it'), detail: r.error, cls: 'err', ms: 15000 }); return; }
  if (r.cancelled) { status(''); return; }
  const file = r.out.split(/[\\/]/).pop();
  if (dest === 'clipboard') {
    done({ title: as === 'audio' ? 'Audio copied' : 'Copied', detail: `${file}  ·  ${fmtSize(r.size)}`,
      warn: r.size > 20 * 1048576 && as !== 'audio' ? 'Over 20 MB: Discord needs Nitro to send it. Try Copy under 20 MB.' : 'Paste into Discord with Ctrl+V.', ms: 9000 });
  } else {
    done({ title: 'Exported', detail: `${file}  ·  ${fmtSize(r.size)}`, actions: [{ text: 'Show in folder', run: () => T.reveal(r.out) }], ms: 12000 });
    if (L.data) L.dirty = true;
  }
}
$('qtcopy').onclick = () => exportAs('video', 'clipboard');
$('qtsave').onclick = () => exportAs('video', 'save');
$('qtreveal').onclick = () => { if (Q.clip) T.libAction('reveal', Q.clip.path); };

// replace the original with the trimmed clip (asks first)
async function replaceOriginal() {
  if (!Q.loaded || !Q.info || Q.exporting) return;
  const trimmed = Q.tin > 0.01 || Q.tout < Q.dur - 0.01;
  if (!trimmed) { done({ title: 'Nothing to replace', detail: 'Trim the clip first.', cls: 'err', ms: 5000 }); return; }
  if (FX.hasVisual()) { done({ title: "Replace original only trims", detail: 'Crop, zoom, text and the other picture effects need an export. Hide or remove them first.', cls: 'err', ms: 8000 }); return; }
  pause();
  if (!(await confirmBox({
    title: 'Replace the original?',
    body: `The original video will be permanently deleted. The trimmed clip (${fmtLen(Q.tout - Q.tin)}) takes its place with the same ${L.renameFiles && Q.clip.title ? 'date and audio tracks, under the name "' + Q.clip.title + '"' : 'file name, date and audio tracks'}.`,
    ok: 'Replace',
  }))) return;
  const tab = Q.loaded, c = Q.clip;
  flushSave();
  const start = Q.tin, end = Q.tout;
  // the file can't be in use while it's replaced
  Q.gen++;
  closeMedia();
  await T.qtClose(c.path);
  Q.exporting = true;
  $('qt').classList.add('busy');
  $('qtbar').hidden = false; $('qtbar').value = 0;
  working('Replacing the original...');
  const r = await T.qtReplace({ path: c.path, start, end });
  Q.exporting = false;
  $('qt').classList.remove('busy');
  $('qtbar').hidden = true;
  if (Q.loaded !== tab) return;
  if (r.ok && !r.cancelled) {
    // with Settings > File names it was renamed after the clip, too
    if (r.path && !samePathR(r.path, c.path)) { const from = c.path; window.clipMovedHere({ from, to: r.path, name: r.name, url: r.url }); }
    c.size = r.size; c.duration = r.duration;
    c.edit = null;
    L.thumbs.delete(c.path);
    tab.st = null; tab.peaks = null; tab.strip = null;
    if (L.data) L.dirty = true;
    updateCardEdit(c);
  }
  Q.loaded = null;
  await load(tab);
  if (!r.ok) done({ title: "Couldn't replace it", detail: r.error, cls: 'err', ms: 15000 });
  else if (!r.cancelled) done({ title: 'Original replaced', detail: `${c.name}  ·  ${fmtSize(r.size)}  ·  ${fmtLen(r.duration)}`, ms: 9000 });
}

// a menu button opens its menu, or closes it when it's already open
function menuOpenFor(id) {
  const m = $('ctxmenu');
  if (!m.hidden && m.dataset.for === id) { hideMenu(); return true; }
  return false;
}
function markMenu(id) { $('ctxmenu').dataset.for = id; $(id).classList.add('open'); }
const trimmedNow = () => Q.tin > 0.01 || Q.tout < Q.dur - 0.01;
function menuAbove(id, items) {
  const r = $(id).getBoundingClientRect();
  openMenu(r.right, r.top - 6, items, true);
  const m = $('ctxmenu'); m.style.top = Math.max(8, r.top - m.offsetHeight - 6) + 'px';
  markMenu(id);
}
$('qtsavemenu').onclick = e => {
  e.stopPropagation();
  if (menuOpenFor('qtsavemenu')) return;
  menuAbove('qtsavemenu', [
    { icon: 'export', text: 'Export as...', run: () => exportAs('video', 'saveas') },
    { icon: 'export', text: 'Export under 20 MB (Discord)', run: () => exportAs('video', 'save', 20 * 1048576) },
    { icon: 'music', text: 'Export audio as...', run: () => exportAs('audio', 'saveas') },
    '-',
    { icon: 'replace', text: 'Replace original', run: replaceOriginal, cls: 'danger', disabled: !trimmedNow() },
  ]);
};
$('qtcopymenu').onclick = e => {
  e.stopPropagation();
  if (menuOpenFor('qtcopymenu')) return;
  menuAbove('qtcopymenu', [
    { icon: 'copy', text: 'Copy under 20 MB (Discord)', run: () => exportAs('video', 'clipboard', 20 * 1048576) },
    { icon: 'music', text: 'Copy Audio', run: () => exportAs('audio', 'clipboard') },
  ]);
};
$('qtmore').onclick = e => {
  e.stopPropagation();
  if (menuOpenFor('qtmore')) return;
  const r = $('qtmore').getBoundingClientRect();
  openMenu(r.right, r.bottom + 6, [
    { icon: 'copy', text: 'Copy Video', run: () => exportAs('video', 'clipboard') },
    { icon: 'music', text: 'Copy Audio', run: () => exportAs('audio', 'clipboard') },
    '-',
    { icon: 'export', text: 'Export Video File', run: () => exportAs('video', 'save') },
    { icon: 'export', text: 'Export Audio File', run: () => exportAs('audio', 'save') },
    '-',
    { icon: 'edit', text: 'Rename', run: editTitle },
    { icon: 'replace', text: 'Replace original', run: replaceOriginal, cls: 'danger', disabled: !trimmedNow() },
  ], true);
  markMenu('qtmore');
};

// ---------- shortcuts ----------
const KEYS = [['Space', 'Play / pause'], ['I  O', 'Set start / end at the playhead'],
  ['E', 'Edit / back to Trim'], ['T G S A', 'Edit: text, picture, shape, add audio'], ['V  C', 'Edit: select / razor (cut)'], ['Del', 'Delete the selected effect'], ['Ctrl+Z', 'Undo'], ['Ctrl+Shift+Z', 'Redo'], [',  .', 'One frame back / forward'], ['←  →', 'One frame (Shift = 1 second)'],
  ['J  L', 'Back / forward 10 seconds'], ['Home  End', 'Jump to start / end of the trim'], ['F2', 'Rename'], ['Ctrl+C', 'Copy the trimmed clip'],
  ['Esc', 'Deselect'], ['Ctrl+W', 'Close the clip']];
$('qthelp').onclick = e => {
  e.stopPropagation();
  if ($('qthelpbox')) { $('qthelpbox').remove(); return; }
  const b = h('div', 'qt-helpbox'); b.id = 'qthelpbox';
  for (const [k, d] of KEYS) b.append(h('kbd', '', k), h('span', '', d));
  $('qt').querySelector('.qt-box').append(b);
};
document.addEventListener('pointerdown', e => { const b = $('qthelpbox'); if (b && !b.contains(e.target) && e.target.closest('#qthelp') === null) b.remove(); });

function onKey(e) {
  if (!Q.visible) return;
  if (document.querySelector('.modal-ov')) return; // a dialog is open
  const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
  // text boxes (times, names) handle their own keys
  if ((e.target.tagName === 'INPUT' && e.target.type !== 'range') || e.target.tagName === 'TEXTAREA') return;
  e.stopPropagation();
  if (k === 'escape') {
    e.preventDefault();
    if (!$('ctxmenu').hidden) { hideMenu(); return; }
    if ($('gpicker')) { closeGamePicker(); return; }
    if ($('qthelpbox')) { $('qthelpbox').remove(); return; }
    if (Q.exporting) { T.cancel(); return; }
    FX.onKey(e, 'escape'); // deselects / ends a tool; Esc never leaves the editor
    return;
  }
  if (ctrl && k === 'w') { e.preventDefault(); qtHide(); return; }
  // Ctrl+B: the sidebar (and the clip list with it)
  if (ctrl && k === 'b') { e.preventDefault(); toggleSidebar(); return; }
  if (ctrl && k === 'o') { e.preventDefault(); pickFile(); return; }
  if (e.altKey && (k === 'arrowleft' || k === 'arrowright')) { e.preventDefault(); navInput(k === 'arrowleft' ? -1 : 1, true); return; }
  if (ctrl && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (ctrl && !e.shiftKey && !e.altKey && FX.onCtrl(e, k)) { e.preventDefault(); return; }
  if (ctrl && k === 'c') { if (String(window.getSelection())) return; e.preventDefault(); exportAs('video', 'clipboard'); return; }
  if (ctrl && k === 'v') { pasteKey(); return; }
  if (k === 'f2') { e.preventDefault(); editTitle(); return; }
  if (ctrl || e.altKey || !Q.dur || Q.exporting) return;
  if (FX.onKey(e, k)) { e.preventDefault(); return; }
  if (k === 'e') { e.preventDefault(); if (Q.level === 'edit') backToTrim(); else setLevel('edit'); return; }
  const frameStep = 1 / Q.fps;
  let handled = true;
  if (k === ' ') toggle();
  else if (k === 'i') setIn(now());
  else if (k === 'o') setOut(now());
  else if (k === 'arrowleft') { pause(); seekTo(Q.t - (e.shiftKey ? 1 : frameStep)); }
  else if (k === 'arrowright') { pause(); seekTo(Q.t + (e.shiftKey ? 1 : frameStep)); }
  else if (k === ',') { pause(); seekTo(Q.t - frameStep); }
  else if (k === '.') { pause(); seekTo(Q.t + frameStep); }
  else if (k === 'j') seekTo(now() - 10);
  else if (k === 'l') seekTo(now() + 10);
  else if (k === 'home') seekTo(Q.tin);
  else if (k === 'end') { pause(); seekTo(Q.tout - frameStep); }
  else handled = false;
  if (handled) e.preventDefault();
}

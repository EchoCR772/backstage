// ---------- the Clips library, the title bar's library tab, back/forward, Settings ----------
// The library lists every clip in the user's clip folders (NVIDIA's per-game folders, Discord's
// clip folder, the Trimmed folder, anything they add). The sidebar lists games across the chosen
// folders; the Folders button picks which folders count. Back/forward (title bar arrows, mouse side
// buttons, Alt+arrows) moves between views and open clips like a browser.

const L = {
  data: null, scanning: false, again: false, dirty: true,
  game: 'all', folders: null, kind: 'all', sort: 'new', q: '',
  gameSort: 'recent',  // the games in the sidebar and Edit's Clips picker: 'recent' (newest clip first) or 'alpha'
  gq: '',              // the sidebar's game search
  months: true,        // split Newest/Oldest into month sections
  side: { w: 300, collapsed: false },
  folderOpen: false,   // the Folders panel in the sidebar
  thumbs: new Map(),   // path -> { url, duration, error }
  sel: new Set(), anchor: -1, // selected clip paths; last clicked (for Shift+click)
  list: [], shown: 0,  // filtered clips and how many are on the page so far
  seen: {},            // view -> when it was last left (clips saved after that are NEW)
  opened: new Set(),   // clips opened this session (no longer NEW)
  viewKey: null, newSince: null,
};
try {
  const p = JSON.parse(localStorage.getItem('library') || '{}');
  for (const k of ['game', 'kind', 'sort']) if (typeof p[k] === 'string') L[k] = p[k];
  if (p.oldExportsSeen) L.oldExportsSeen = true;
  if (p.gameSort === 'alpha') L.gameSort = 'alpha';
  if (Array.isArray(p.folders)) L.folders = p.folders.filter(x => typeof x === 'string');
  if (typeof p.months === 'boolean') L.months = p.months;
  if (p.side) L.side = { w: Math.min(460, Math.max(220, +p.side.w || 300)), collapsed: !!p.side.collapsed };
  if (p.seen && typeof p.seen === 'object') L.seen = p.seen;
} catch (e) { /* ignore */ }
const saveLibPrefs = () => {
  try { localStorage.setItem('library', JSON.stringify({ game: L.game, folders: L.folders, kind: L.kind, sort: L.sort, gameSort: L.gameSort, months: L.months, side: L.side, seen: L.seen, oldExportsSeen: L.oldExportsSeen })); } catch (e) { /* ignore */ }
};

// The filters above the cards (Nov 4, his call): Clips are the short saved moments (Discord clips,
// NVIDIA Instant Replay, Encore Echoes), Recordings the full ones, Edited anything Backstage made or
// changed: exports, replaced originals, clips with a saved trim or edit.
const KINDS = [['all', 'All'], ['clip', 'Clips'], ['recording', 'Recordings'], ['edited', 'Edited']];
if (!KINDS.some(([k]) => k === L.kind)) L.kind = 'all'; // saved from before 1.49.0, when they went by app
const isEdited = c => !!(c.edited || c.edit);
const kindHas = (c, k) => k === 'all' || (k === 'edited' ? isEdited(c) : c.type === k);
const KIND_BADGE = { discord: 'Clip', replay: 'Instant Replay', echo: 'Echo', recording: 'Recording', export: 'Export' };
const SRC_LOOK = {
  nvidia: { label: 'NVIDIA', icon: 'gamepad', color: '#1e1e1e', img: 'img/nvidia.png' },
  discord: { label: 'Discord', icon: 'chat', color: '#1e1e1e', img: 'img/discord.png' },
  encore: { label: 'Encore', icon: 'gamepad', color: '#1e1e1e', img: 'img/encore.png' },
  folder: { label: '', icon: 'folder', color: '#2e2d31' },
  trimmed: { label: 'Old exports', icon: 'scissors', color: '#1f8b4c' },
};
const samePathR = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
// (one formatter each: making a new one per call was a good part of what a card cost)
const WHEN = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const MONTH = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
const fmtWhen = ms => WHEN.format(new Date(ms));
const fmtMonth = ms => MONTH.format(new Date(ms));
const isToday = ms => { const a = new Date(ms), b = new Date(); return a.getDate() === b.getDate() && a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear(); };
const fmtLen = s => { s = Math.round(s); const m = Math.floor(s / 60); return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`; };
const hue = s => { let x = 0; for (const c of s) x = (x * 31 + c.charCodeAt(0)) | 0; return Math.abs(x) % 360; };
const folderName = p => p.split(/[\\/]/).filter(Boolean).pop() || p;
const srcLabel = f => SRC_LOOK[f.kind].label || folderName(f.path);
// a clip's title: the name you gave it, else when it was made
const clipTitle = c => c.title || `Clip from ${fmtWhen(c.date)}`;

// ---------- title bar ----------
// the view's name in the middle of the title bar (like Discord's server name) closes the editor
$('libtab').onclick = () => showLibrary();
$('navback').onclick = () => navInput(-1, true);
$('navfwd').onclick = () => navInput(1, true);
let appVersion = '';
T.settingsGet().then(r => { if (r.ok) { appVersion = r.version; L.deleteMode = r.deleteMode; L.editSave = r.editSave; L.renameFiles = r.renameFiles; } });
// the test copy says so, in the title bar and the window title
window.APP_TITLE = T.isTest ? `${T.appName} (Test build)` : T.appName;
if (T.isTest) $('testbadge').hidden = false;
document.title = window.APP_TITLE;
// every shortcut, in a dialog like Discord's
// ---------- updates ----------
// Ask first (default): a soft "Update available" button in the title bar opens what's new with
// Download / Later. Later turns it into a quiet icon. Once downloaded: "Restart to update".
// Automatic: downloads in the background and only shows "Restart to update". Off: Help > Check only.
let upd = { state: 'idle' };
const VER = v => String(v || '').split('.').map(n => parseInt(n, 10) || 0);
const newerThan = (a, b) => { const x = VER(a), y = VER(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
function showUpdate(u) {
  upd = u || upd;
  const b = $('updbtn'), t = $('updtext');
  const ask = upd.state === 'available', dl = upd.state === 'downloading' && upd.mode !== 'auto', ready = upd.state === 'ready';
  b.hidden = !(ask || dl || ready);
  b.classList.toggle('quiet', ask && !!upd.later);
  if (ask) { t.textContent = upd.later ? '' : 'Update available'; b.dataset.tip = upd.later ? `Update ${upd.version} available` : `See what's new in ${upd.version}`; }
  else if (dl) { t.textContent = `Downloading ${upd.progress || 0}%`; b.dataset.tip = `Downloading ${upd.version}`; }
  else if (ready) { t.textContent = 'Restart to update'; b.dataset.tip = `Restart into ${upd.version}`; }
}
T.onUpdate(u => {
  const was = upd.state;
  showUpdate(u);
  if (checkingByHand && was === 'checking') {
    checkingByHand = false;
    if (u.state === 'none') libToast(`You're on the latest version (${appVersion}).`);
    else if (u.state === 'available') updateBox();
    else if (u.state === 'error') libToast("Couldn't check for updates: " + u.error, 'err');
  }
});
T.updateGet().then(showUpdate);
let checkingByHand = false;
async function checkUpdates() {
  const u = await T.updateGet();
  if (!u.enabled) { libToast('Updates are checked in the installed app.'); return; }
  if (u.state === 'available') { updateBox(); return; }
  if (u.state === 'ready') { libToast(`${u.version} is ready. Restart to update.`); return; }
  checkingByHand = true;
  T.updateCheck();
}
$('updbtn').onclick = () => {
  if (upd.state === 'ready') T.updateInstall();
  else if (upd.state === 'available') updateBox();
};

// The updater brings the notes as GitHub's HTML (&gt; for >): back to the same Markdown, as text
// only. Tags are dropped and entities decoded by hand, nothing is ever parsed as HTML.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function htmlNotes(text) {
  const t = String(text || '');
  if (!/<\/?[a-z][^>]*>|&[#a-z0-9]+;/i.test(t)) return t;
  return t.replace(/\r/g, '')
    .replace(/<h[1-6][^>]*>/gi, '\n## ').replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ').replace(/<br\s*\/?>|<\/p>|<\/li>|<\/ul>|<\/ol>/gi, '\n')
    .replace(/<\/?(strong|b)>/gi, '**').replace(/<\/?code>/gi, '`')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e) => {
      const k = e.toLowerCase();
      if (ENTITIES[k] !== undefined) return ENTITIES[k];
      const n = k[0] === '#' ? (k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10)) : NaN;
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    })
    .replace(/\n(?:[ \t]*\n)+(?=[ \t]*- )/g, '\n'); // one list stays one list
}
// Release notes are short Markdown (headings, "- " lists, **bold**, `code`); turned into elements, never HTML.
function mdNodes(text) {
  text = htmlNotes(text);
  const out = []; let list = null;
  const inline = str => {
    const e = h('p');
    for (const part of String(str).split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
      if (!part) continue;
      if (/^\*\*.+\*\*$/.test(part)) e.append(h('strong', '', part.slice(2, -2)));
      else if (/^`.+`$/.test(part)) e.append(h('code', '', part.slice(1, -1)));
      else e.append(document.createTextNode(part));
    }
    return e;
  };
  for (const raw of String(text || '').replace(/\r/g, '').replace(/<[^>]+>/g, '').split('\n')) {
    const line = raw.trim();
    if (!line) { list = null; continue; }
    const m = line.match(/^#{1,6}\s+(.*)$/);
    if (m) { list = null; out.push(h('h4', '', m[1])); continue; }
    const li = line.match(/^[-*•]\s+(.*)$/);
    if (li) {
      if (!list) { list = h('ul', 'notes'); out.push(list); }
      const item = h('li'); item.append(...inline(li[1]).childNodes); list.append(item); continue;
    }
    list = null; out.push(inline(line));
  }
  return out.length ? out : [h('p', '', 'Bug fixes and improvements.')];
}
// one release's notes under its version and date
function releaseNodes(r) {
  const head = h('h3', 'relhead', r.version);
  if (r.date) head.append(h('small', '', new Date(r.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })));
  return [head, ...mdNodes(r.notes)];
}
// The notes for versions after `from` up to `to` (both optional), newest first. Falls back to the
// notes the updater brought when GitHub can't be reached.
async function releasesBetween(from, to, fallback) {
  const r = await T.changelog().catch(() => ({ ok: false }));
  if (r && r.ok && r.releases.length) {
    return r.releases.filter(x => (!from || newerThan(x.version, from)) && (!to || !newerThan(x.version, to)));
  }
  return fallback ? [{ version: fallback.version, notes: fallback.notes }] : null;
}
// "Update available": what's new since your version, the size, Download / Later
async function updateBox() {
  if (document.querySelector('.modal.upd')) return;
  hideMenu(); hideTip();
  const ov = h('div', 'modal-ov'), box = h('div', 'modal wide upd');
  const x = h('button', 'modal-x'); x.append(icoSpan('x'));
  const sub = h('div', 'updsub', `Version ${upd.version}${upd.size ? '  ·  ' + fmtSize(upd.size) : ''}  ·  you have ${appVersion}`);
  const body = h('div', 'modal-body updnotes');
  body.append(h('p', '', 'Loading the changelog...'));
  const row = h('div', 'modal-btns');
  const later = h('button', 'mbtn', 'Later'), go = h('button', 'mbtn primary', 'Download');
  row.append(later, go);
  box.append(x, h('h2', '', 'Update available'), sub, body, row);
  ov.append(box); document.body.append(ov);
  requestAnimationFrame(() => ov.classList.add('on'));
  const done = () => { document.removeEventListener('keydown', key, true); ov.classList.remove('on'); setTimeout(() => ov.remove(), 160); };
  const key = e => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); later.click(); } else if (e.key === 'Enter') { e.preventDefault(); go.click(); } };
  document.addEventListener('keydown', key, true);
  x.onclick = () => later.click();
  ov.addEventListener('pointerdown', e => { if (e.target === ov && e.button === 0) later.click(); });
  later.onclick = () => { done(); if (!upd.later) T.updateLater(); };
  go.onclick = () => { done(); T.updateDownload(); };
  const list = await releasesBetween(appVersion, upd.version, upd);
  body.replaceChildren(...(list && list.length ? list.flatMap(releaseNodes) : mdNodes(upd.notes)));
}
// Help > Changelog: every version's notes
async function changelogBox() {
  infoBox('Changelog', [h('p', '', 'Loading...')]);
  const body = document.querySelector('.modal-ov:last-child .modal-body');
  const list = await releasesBetween(null, null, null);
  if (!body || !body.isConnected) return;
  if (!list) { body.replaceChildren(h('p', '', "Couldn't reach GitHub. "), (() => { const a = h('button', 'linkbtn', 'Open the releases page'); a.onclick = () => T.openUrl('https://github.com/EchoCR772/backstage/releases'); return a; })()); return; }
  body.replaceChildren(...list.flatMap(r => releaseNodes(r)));
  body.classList.add('updnotes');
}
// after an update: what changed, once
T.whatsNew().then(async w => {
  if (!w) return;
  const list = await releasesBetween(null, w.version, w);
  const mine = list && list.find(r => r.version === w.version);
  infoBox(`What's new in ${w.version}`, mdNodes(mine ? mine.notes : w.notes));
});

// a simple dialog with a title and text (or nodes)
function infoBox(title, body) {
  hideMenu();
  const ov = h('div', 'modal-ov'), box = h('div', 'modal wide');
  const x = h('button', 'modal-x'); x.append(icoSpan('x'));
  const content = h('div', 'modal-body');
  content.append(...(typeof body === 'string' ? mdNodes(body) : body));
  box.append(x, h('h2', '', title), content);
  ov.append(box); document.body.append(ov);
  requestAnimationFrame(() => ov.classList.add('on'));
  const done = () => { document.removeEventListener('keydown', key, true); ov.classList.remove('on'); setTimeout(() => ov.remove(), 160); };
  const key = e => { e.stopPropagation(); if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); done(); } };
  document.addEventListener('keydown', key, true);
  x.onclick = done;
  ov.addEventListener('pointerdown', e => { if (e.target === ov && e.button === 0) done(); });
}
// ---------- reports: a problem, and replies to the ones sent ----------
let reportsUnread = 0;
function showReportsDot() { $('appmenu').classList.toggle('dot', reportsUnread > 0); }
T.onReports(n => {
  const more = n > reportsUnread;
  reportsUnread = n; showReportsDot();
  if (more) libToast(`You have a reply to a report. Help > My Reports.`, null, 8000);
});
T.reportsList(false).then(r => { if (r.ok) { reportsUnread = r.unread; showReportsDot(); } });
// a dialog with our own buttons; returns { box, body, done }
function dialog(title, cls = '') {
  hideMenu(); hideTip();
  const ov = h('div', 'modal-ov'), box = h('div', 'modal wide ' + cls);
  const x = h('button', 'modal-x'); x.append(icoSpan('x'));
  const body = h('div', 'modal-body');
  box.append(x, h('h2', '', title), body);
  ov.append(box); document.body.append(ov);
  requestAnimationFrame(() => ov.classList.add('on'));
  const done = () => { document.removeEventListener('keydown', key, true); ov.classList.remove('on'); setTimeout(() => ov.remove(), 160); };
  const key = e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') { if (e.key === 'Escape') { e.preventDefault(); done(); } e.stopPropagation(); return; }
    e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); done(); }
  };
  document.addEventListener('keydown', key, true);
  x.onclick = done;
  ov.addEventListener('pointerdown', e => { if (e.target === ov && e.button === 0) done(); });
  return { box, body, done };
}
async function problemBox() {
  const { box, body, done } = dialog('Report a problem', 'report');
  const what = h('textarea', 'modal-in report-ta'); what.rows = 4; what.placeholder = 'What happened? (what you expected, and what you got instead)'; what.maxLength = 4000;
  const doing = h('textarea', 'modal-in report-ta'); doing.rows = 2; doing.placeholder = 'What were you doing when it happened? (optional)'; doing.maxLength = 2000;
  const inc = h('label', 'report-check'); const cb = h('input'); cb.type = 'checkbox'; cb.checked = true;
  inc.append(cb, document.createTextNode(' Include the app\'s log and PC details (Windows version, graphics card, settings)'));
  const pre = h('pre', 'report-pre'); pre.hidden = true; pre.textContent = 'Loading...';
  const see = h('button', 'linkbtn', "See what's sent"); see.onclick = () => { pre.hidden = !pre.hidden; see.textContent = pre.hidden ? "See what's sent" : "Hide what's sent"; };
  body.append(what, doing, inc, see, pre, h('p', 'report-note', 'Your Windows username is taken out of everything first. No clips or pictures are sent. Replies show up in Help > My Reports.'));
  const row = h('div', 'modal-btns');
  const cancel = h('button', 'mbtn', 'Cancel'), send = h('button', 'mbtn primary', 'Send');
  row.append(cancel, send); box.append(row);
  cancel.onclick = done;
  what.focus();
  const d = await T.problemDetails();
  pre.textContent = d.ok ? d.text : d.error;
  if (d.ok && !d.ready) { send.disabled = true; body.append(h('p', 'report-note warn', "Reports aren't switched on in this version yet.")); }
  send.onclick = async () => {
    if (what.value.trim().length < 5) { what.focus(); libToast('Say what happened first.', 'err'); return; }
    send.disabled = true; send.textContent = 'Sending...';
    const r = await T.problemSend({ what: what.value, doing: doing.value, details: cb.checked });
    if (!r.ok) { send.disabled = false; send.textContent = 'Send'; libToast(r.error, 'err'); return; }
    done(); libToast('Sent. Thanks! Replies show up in Help > My Reports.');
  };
}
async function reportsBox() {
  const { body } = dialog('My reports', 'reports');
  body.append(h('p', '', 'Checking for replies...'));
  const r = await T.reportsList(true);
  body.replaceChildren();
  if (!r.ok) { body.append(h('p', '', r.error)); return; }
  if (!r.reports.length) body.append(h('p', '', r.ready ? "You haven't sent any reports yet. Help > Report a Problem sends one." : "Reports aren't switched on in this version yet."));
  for (const x of r.reports.slice().reverse()) {
    const card = h('div', 'rep' + (x.unread ? ' new' : ''));
    const head = h('div', 'rep-head');
    head.append(h('b', '', x.title || (x.kind === 'recorder' ? 'Recording software info' : 'Problem')), h('span', 'rep-state ' + x.state, x.state === 'closed' ? 'Closed' : 'Open'));
    card.append(head, h('div', 'rep-sub', `${x.kind === 'recorder' ? 'Recording software info' : 'Problem'} #${x.n}  ·  sent ${new Date(x.at).toLocaleString()}`));
    if (!x.replies.length) card.append(h('div', 'rep-none', 'No reply yet.'));
    for (const y of x.replies) { const rp = h('div', 'rep-reply'); rp.append(h('div', 'rep-when', new Date(y.at).toLocaleString()), ...mdNodes(y.body)); card.append(rp); }
    body.append(card);
  }
  await T.reportsSeen();
  reportsUnread = 0; showReportsDot();
}
function aboutBox() {
  const link = (text, url) => { const a = h('button', 'linkbtn', text); a.onclick = () => T.openUrl(url); return a; };
  const p = (...kids) => { const e = h('p'); e.append(...kids); return e; };
  infoBox(`${T.appName} ${appVersion}`, [
    p('Trim and share your NVIDIA and Discord clips. Made by Echo.'),
    p(link('github.com/EchoCR772/backstage', 'https://github.com/EchoCR772/backstage')),
    h('h3', '', 'Open-source parts'),
    p('FFmpeg (GPL v3), used to read and make videos. Source: ', link('ffmpeg.org', 'https://ffmpeg.org/download.html'), ', build: ', link('ffmpeg-static', 'https://github.com/eugeneware/ffmpeg-static')),
    p('Mediabunny (MPL 2.0), Electron (MIT), electron-updater (MIT). Full notices: ', link('THIRD_PARTY_NOTICES', 'https://github.com/EchoCR772/backstage/blob/main/THIRD_PARTY_NOTICES.md')),
  ]);
}

function shortcutsBox() {
  const rows = [['Ctrl+O', 'Open a video'], ['Ctrl+B', 'Show / hide Your Library'], ['Ctrl+= / - / 0', 'Zoom in / out / actual size'], ['F11', 'Full screen'], ['Ctrl+V', 'Open a video copied in File Explorer'], ['Ctrl+F', 'Search'], ['Ctrl+A', 'Select all clips'], ['Delete', 'Delete the selected clips'],
    ['F2', 'Rename'], ['Alt+Left / Right', 'Back / forward'], ['Ctrl+,', 'Settings'], ['', ''], ['Space', 'Play / pause (editor)'], ['I  O', 'Set start / end at the playhead'],
    [',  .', 'One frame back / forward'], ['J  L', 'Back / forward 10 seconds'], ['Home  End', 'Start / end of the trim'], ['Ctrl+C', 'Copy the trimmed clip'], ['Esc', 'Deselect'], ['Ctrl+W', 'Close the clip']];
  hideMenu();
  const ov = h('div', 'modal-ov'), box = h('div', 'modal wide');
  const x = h('button', 'modal-x'); x.append(icoSpan('x'));
  const grid = h('div', 'keys');
  for (const [k, d] of rows) { if (!k) { grid.append(h('div', 'keysep'), h('div', 'keysep')); continue; } grid.append(h('kbd', '', k), h('span', '', d)); }
  box.append(x, h('h2', '', 'Keyboard shortcuts'), grid);
  ov.append(box); document.body.append(ov);
  requestAnimationFrame(() => ov.classList.add('on'));
  const done = () => { document.removeEventListener('keydown', key, true); ov.classList.remove('on'); setTimeout(() => ov.remove(), 160); };
  const key = e => { e.stopPropagation(); if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); done(); } };
  document.addEventListener('keydown', key, true);
  x.onclick = done;
  ov.addEventListener('pointerdown', e => { if (e.target === ov && e.button === 0) done(); });
}
// the menu at the top left (like Discord's): opening videos, folders, settings
$('appmenu').onclick = e => {
  e.stopPropagation();
  const m = $('ctxmenu');
  if (!m.hidden && m.dataset.for === 'appmenu') { hideMenu(); return; }
  const r = $('appmenu').getBoundingClientRect();
  const ed = window.qtIsOpen && window.qtIsOpen(), q = window.qtApi;
  const sel = L.sel.size ? selected() : [];
  openMenu(r.left, r.bottom + 6, [
    { text: 'File', sub: [
      { text: 'Open Video...', hint: 'Ctrl+O', run: () => pickFile() },
      { text: 'Add Clips Folder...', run: async () => folderAdded(await T.libAddFolder()) },
      '-',
      { text: 'Settings', hint: 'Ctrl+Comma', run: () => openSettings() },
      '-',
      { text: 'Close Clip', hint: 'Ctrl+W', run: () => window.closeActiveTab(), disabled: !ed },
      { text: 'Exit', hint: 'Alt+F4', run: () => window.close() },
    ] },
    { text: 'Edit', sub: [
      { text: ed ? 'Copy Video' : sel.length > 1 ? `Copy ${sel.length} Videos` : 'Copy Video', hint: 'Ctrl+C', run: () => (ed ? q.copy() : copyClips(sel)), disabled: !ed && !sel.length },
      { text: 'Paste Video', hint: 'Ctrl+V', run: () => T.clipboardFile().then(openResult) },
      { text: 'Delete', hint: 'Del', run: () => trashClips(sel), disabled: ed || !sel.length },
      { text: 'Rename', hint: 'F2', run: () => (ed ? q.rename() : renameClip(sel[0])), disabled: !ed && sel.length !== 1 },
      '-',
      { text: 'Select All', hint: 'Ctrl+A', run: () => selectAll(), disabled: ed },
      { text: 'Clear Selection', hint: 'Esc', run: () => clearSel(), disabled: ed || !sel.length },
      '-',
      { text: 'Find...', hint: 'Ctrl+F', run: () => showLibrary().then(() => { $('libsearch').focus(); $('libsearch').select(); }) },
    ] },
    { text: 'View', sub: [
      { text: 'Your Library', hint: 'Ctrl+B', check: !L.side.collapsed, run: () => toggleSidebar() },
      { text: 'Folders', check: L.folderOpen && !L.side.collapsed, run: () => { if (L.side.collapsed) { L.side.collapsed = false; applySide(); saveLibPrefs(); L.folderOpen = true; } else L.folderOpen = !L.folderOpen; $('folderbox').classList.toggle('open', L.folderOpen); } },
      '-',
      { text: 'Zoom In', hint: 'Ctrl+=', run: () => T.win('zoom-in') },
      { text: 'Zoom Out', hint: 'Ctrl+-', run: () => T.win('zoom-out') },
      { text: 'Actual Size', hint: 'Ctrl+0', run: () => T.win('zoom-reset') },
      '-',
      { text: 'Full Screen', hint: 'F11', run: () => T.win('fullscreen') },
    ] },
    { text: 'Playback', sub: [
      { text: 'Play / Pause', hint: 'Space', run: () => q.toggle(), disabled: !ed },
      { text: 'Previous Clip', run: () => q.step(-1), disabled: !ed || !q.hasPrev() },
      { text: 'Next Clip', run: () => q.step(1), disabled: !ed || !q.hasNext() },
      '-',
      { text: 'Back 10 Seconds', hint: 'J', run: () => q.seek(-10), disabled: !ed },
      { text: 'Forward 10 Seconds', hint: 'L', run: () => q.seek(10), disabled: !ed },
      '-',
      { text: 'Loop Trim', check: q ? q.isLoop() : true, run: () => q.loop(), disabled: !ed },
    ] },
    { text: 'Help', sub: [
      { text: 'Keyboard Shortcuts', hint: 'Ctrl+/', run: shortcutsBox },
      '-',
      upd.state === 'ready' ? { text: `Restart to Update (${upd.version})`, run: () => T.updateInstall() }
        : upd.state === 'available' ? { text: `Update to ${upd.version}...`, run: updateBox }
        : { text: upd.state === 'downloading' ? `Downloading Update... ${upd.progress || 0}%` : 'Check for Updates...', run: checkUpdates, disabled: upd.state === 'downloading' || upd.state === 'checking' },
      { text: 'Changelog', run: changelogBox },
      '-',
      { text: 'Report a Problem...', run: problemBox },
      { text: reportsUnread ? `My Reports (${reportsUnread} new)` : 'My Reports', run: reportsBox },
      '-',
      { text: `About ${T.appName}`, run: aboutBox },
    ] },
  ]);
  m.dataset.for = 'appmenu';
  $('appmenu').classList.add('open');
};
// the library's name sits in the middle of the title bar; clicking it (or Home) closes the editor
async function showLibrary() {
  closeSettings();
  if (window.qtHide && !(await window.qtHide())) return; // kept editing (unsaved changes)
  $('libtab').classList.add('active');
  if (L.dirty || !L.data) loadLibrary();
  document.title = window.APP_TITLE;
  navCommit();
}

// ---------- back / forward ----------
const H = { list: [], i: -1, applying: false, timer: 0 };
function navState() {
  const p = window.qtActivePath && window.qtActivePath();
  if (p) return { clip: p };
  return { game: L.game }; // the folder checkboxes are a filter, not a place: back/forward leaves them alone
}
// record where we are; several changes in one go (open a clip -> switch tab) become one step
function navCommit() {
  if (H.applying) return;
  clearTimeout(H.timer);
  H.timer = setTimeout(() => {
    const s = navState(), cur = H.list[H.i];
    if (cur && JSON.stringify(cur) === JSON.stringify(s)) return;
    H.list.splice(H.i + 1);
    H.list.push(s);
    if (H.list.length > 100) H.list.shift();
    H.i = H.list.length - 1;
    showNavButtons();
  }, 0);
}
function showNavButtons() {
  $('navback').disabled = H.i <= 0;
  $('navfwd').disabled = H.i >= H.list.length - 1;
}
async function navGo(d) {
  if (window.qtCanLeave && !(await window.qtCanLeave())) return;
  clearTimeout(H.timer);
  for (let j = H.i + d; j >= 0 && j < H.list.length; j += d) {
    const s = H.list[j];
    if (s.clip && !(window.qtHasTab && window.qtHasTab(s.clip))) continue; // that tab was closed
    if (JSON.stringify(s) === JSON.stringify(navState())) { H.i = j; continue; }
    H.i = j;
    H.applying = true;
    try {
      if (s.clip) window.qtActivatePath(s.clip);
      else {
        // a game that has no clips in the ticked folders any more falls back to All clips
        const game = s.game === 'all' || !L.data || L.data.clips.some(c => c.game === s.game && inFolders(c)) ? s.game : 'all';
        const changed = L.game !== game;
        L.game = game;
        showLibrary();
        if (changed && L.data) { saveLibPrefs(); renderSide(); renderGrid(true); }
      }
    } finally { H.applying = false; }
    showNavButtons();
    return;
  }
}
let lastNav = 0;
function navInput(d, key) {
  const now = Date.now();
  if (!key && now - lastNav < 300) return; // the mouse button arrives both as a click and as an app command
  if (!key) lastNav = now;
  hideMenu();
  navGo(d);
}
window.addEventListener('mousedown', e => { if (e.button === 3 || e.button === 4) e.preventDefault(); });
window.addEventListener('mouseup', e => { if (e.button === 3 || e.button === 4) { e.preventDefault(); navInput(e.button === 3 ? -1 : 1); } });
T.onNav(dir => navInput(dir === 'back' ? -1 : 1));
showNavButtons();

// ---------- loading ----------
async function loadLibrary() {
  if (L.scanning) { L.again = true; return; }
  L.scanning = true; L.dirty = false;
  if (!L.data) libEmpty('Looking for clips...');
  const r = await T.libScan();
  L.scanning = false;
  if (r.ok) {
    // folder activity often changes nothing we show; then leave the cards alone instead of rebuilding them
    const sig = JSON.stringify([r.folders, r.clips.map(c => [c.path, c.size, c.date, c.duration, c.game, c.gameName, c.title])]);
    if (!(L.data && sig === L.sig)) {
      const first = !L.data;
      L.sig = sig; L.data = r;
      renderLibrary(!first);
    }
  } else libEmpty(r.error);
  if (L.again) { L.again = false; loadLibrary(); }
}
// also while the editor is open: its clip list is the library's list, so a newly saved clip shows up there
T.onLibChanged(() => loadLibrary());
T.onLibProgress(n => { if (!L.data) libEmpty(`Reading your clips... ${n}`); });
window.addEventListener('beforeunload', () => { leaveView(); saveLibPrefs(); });

function libEmpty(text, withButton) {
  const box = $('libgrid');
  V.rows = []; V.list = []; box.style.height = ''; box.classList.remove('virtual');
  box.replaceChildren();
  const d = h('div', 'libempty');
  d.append(h('div', '', text));
  if (withButton) {
    const b = h('button', 'btn'); b.append(icoSpan('gear'), document.createTextNode('Open Settings'));
    b.onclick = () => openSettings();
    d.append(b);
  }
  box.append(d);
}

// update: the library changed under us (keep the scroll position and the cards that are still there)
function renderLibrary(update) {
  const d = L.data;
  if (!d) return;
  if (L.game !== 'all' && !d.clips.some(c => c.game === L.game && inFolders(c))) L.game = 'all';
  renderFolders();
  renderSide();
  renderGrid(false, update);
  if (window.qtListChanged) window.qtListChanged(true); // the editor's clip list, keeping its scroll position
}

// right-click a folder in the Folders panel
function folderMenu(e, f) {
  e.preventDefault(); e.stopPropagation();
  const items = [{ text: 'Open in File Explorer', run: async () => { const x = await T.libOpenFolder(f.path); if (!x.ok) libToast(x.error, 'err'); } }];
  if (f.kind === 'folder') items.push({ text: 'Send Recording Software Info...', run: () => reportBox(f.path) });
  items.push('-', { text: 'Remove from Library', cls: 'danger', run: () => removeFolder(f) });
  openMenu(e.clientX, e.clientY, items);
}
// nothing is deleted: the folder just stops showing up (NVIDIA/Discord come back with "Use the detected folders")
async function removeFolder(f) {
  const x = await T.libRemoveFolder(f.path);
  if (!x.ok) { libToast(x.error, 'err'); return; }
  if (L.folders) { L.folders = L.folders.filter(p => !samePathR(p, f.path)); saveLibPrefs(); }
  libToast(`Removed ${srcLabel(f)} from your library. Nothing was deleted.`);
  L.dirty = true;
  await loadLibrary();
}

// ---------- adding folders, and the optional "help add this recording software" card ----------
async function folderAdded(x) {
  if (!x || !x.ok) { if (x && x.error) libToast(x.error, 'err'); return; }
  if (x.already) { libToast('That folder is already in your library.'); return; }
  if (!x.changed) return;
  // a new folder is ticked right away (when only some folders are ticked)
  if (L.folders && x.added && !L.folders.some(p => samePathR(p, x.added))) { L.folders.push(x.added); saveLibPrefs(); }
  libToast('Folder added.');
  L.dirty = true;
  await loadLibrary();
  if (x.added) reportCard(x.added);
}
window.folderAdded = folderAdded;
// A small card beside the new folder's row: easy to ignore (fades after 15 s), ✕ closes it for good.
async function reportCard(dir) {
  const f = liveFolders().find(x => samePathR(x.path, dir));
  if (!f || f.kind !== 'folder') return; // NVIDIA, Discord and the trimmed folder are known already
  const r = await T.reportCard(dir);
  if (!r.ok || !r.show) return;
  if (!$('setov').hidden) { L.pendingCard = dir; return; }
  document.querySelectorAll('.rcard').forEach(e => e.remove());
  if (!L.side.collapsed && !L.folderOpen) { L.folderOpen = true; $('folderbox').classList.add('open'); }
  const card = h('div', 'rcard');
  const x = h('button', 'rc-x'); x.append(icoSpan('x')); x.title = "Don't show this again";
  const see = h('button', 'btn sm primary', "See what's sent");
  const btns = h('div', 'rc-btns'); btns.append(see);
  card.append(x, h('div', 'rc-title', 'Help add this recording software?'),
    h('div', 'rc-text', `Send how ${srcLabel(f)} stores its clips, so Backstage can find it automatically for everyone. You'll see exactly what's sent first.`), btns);
  document.body.append(card);
  const place = () => {
    const row = [...document.querySelectorAll('#folderlist .frow')].find(e => samePathR(e.title, dir));
    const side = $('libside').getBoundingClientRect();
    const rr = row && row.offsetParent ? row.getBoundingClientRect() : null;
    card.style.left = side.right + 12 + 'px';
    card.style.top = Math.max(52, Math.min(window.innerHeight - card.offsetHeight - 12, rr ? rr.top + rr.height / 2 - 28 : 110)) + 'px';
  };
  setTimeout(() => { place(); card.classList.add('on'); }, 260); // after the Folders panel slides open
  let timer = setTimeout(close, 15000);
  card.addEventListener('pointerenter', () => clearTimeout(timer));
  card.addEventListener('pointerleave', () => { timer = setTimeout(close, 6000); });
  function close() { card.classList.remove('on'); setTimeout(() => card.remove(), 200); window.removeEventListener('resize', place); }
  window.addEventListener('resize', place);
  x.onclick = () => { T.reportCard(dir, 'dismiss'); close(); };
  see.onclick = () => { close(); reportBox(dir); };
}
// The preview: the exact text that would be sent, the software's name (editable), Send / Cancel.
async function reportBox(dir) {
  hideMenu(); hideTip();
  const ov = h('div', 'modal-ov'), box = h('div', 'modal wide report');
  const x = h('button', 'modal-x'); x.append(icoSpan('x'));
  const body = h('div', 'modal-body');
  body.append(h('p', '', 'Reading the folder...'));
  const row = h('div', 'modal-btns');
  const cancel = h('button', 'mbtn', 'Cancel'), send = h('button', 'mbtn primary', 'Send');
  send.disabled = true;
  row.append(cancel, send);
  box.append(x, h('h2', '', 'Send recording software info?'), body, row);
  ov.append(box); document.body.append(ov);
  requestAnimationFrame(() => ov.classList.add('on'));
  const done = () => { document.removeEventListener('keydown', key, true); ov.classList.remove('on'); setTimeout(() => ov.remove(), 160); };
  const key = e => { if (e.target.tagName === 'INPUT') { if (e.key === 'Escape') { e.preventDefault(); done(); } e.stopPropagation(); return; } e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); done(); } };
  document.addEventListener('keydown', key, true);
  cancel.onclick = done; x.onclick = done;
  ov.addEventListener('pointerdown', e => { if (e.target === ov && e.button === 0) done(); });
  const r = await T.reportBuild(dir);
  if (!r.ok) { body.replaceChildren(h('p', '', r.error)); send.remove(); cancel.textContent = 'Close'; row.style.gridTemplateColumns = '1fr'; return; }
  const name = h('input', 'modal-in');
  name.type = 'text'; name.value = r.recorder; name.placeholder = 'Which recording software is this? (e.g. SteelSeries Moments)'; name.maxLength = 100; name.spellcheck = false;
  const pre = h('pre', 'report-pre', r.text);
  body.replaceChildren(
    h('p', '', 'This is everything that gets sent. It helps add automatic folder detection for this software in a later version.'),
    h('div', 'report-label', 'Recording software'), name,
    h('div', 'report-label', `App version: ${r.version}`),
    h('div', 'report-label', 'Folder details'), pre,
    h('p', 'report-note', 'Your Windows username is replaced with %USERNAME%. No clips, pictures or other personal info are sent.'));
  send.disabled = false;
  if (!r.recorder) name.focus();
  send.onclick = async () => {
    send.disabled = true; send.textContent = 'Sending...';
    const y = await T.reportSend(dir, name.value.trim(), r.text);
    if (!y.ok) { send.disabled = false; send.textContent = 'Send'; libToast(y.error, 'err'); return; }
    done(); libToast('Sent. Thanks for helping!');
    if (!$('setov').hidden) renderSettings();
  };
}

// ---------- which folders count (the Folders button in the sidebar) ----------
const liveFolders = () => (L.data ? L.data.folders.filter(f => !f.missing) : []);
// the chosen folders' paths: by default all of them (the old exports folder too, since 1.49.0: its
// clips show under Edited)
function chosenFolders() {
  const live = liveFolders();
  if (L.folders && !L.oldExportsSeen) {
    // a saved choice from before 1.49.0 left the old exports folder out: put it in once
    const old = live.find(f => f.kind === 'trimmed');
    if (old && !L.folders.some(p => samePathR(p, old.path))) L.folders.push(old.path);
    L.oldExportsSeen = true; saveLibPrefs();
  }
  let list = L.folders ? live.filter(f => L.folders.some(p => samePathR(p, f.path))) : live;
  if (!list.length) list = live;
  return list.map(f => f.path);
}
const inFolders = c => chosenFolders().some(p => samePathR(p, c.root));
function renderFolders() {
  const live = liveFolders(), chosen = chosenFolders();
  const box = $('folderlist');
  box.replaceChildren();
  for (const f of live) {
    const on = chosen.some(p => samePathR(p, f.path));
    const n = L.data.clips.filter(c => samePathR(c.root, f.path)).length;
    const look = SRC_LOOK[f.kind];
    const row = h('button', 'frow' + (on ? ' on' : ''));
    row.title = f.path;
    const box2 = h('span', 'fchk'); box2.append(icoSpan('check'));
    row.append(box2, iconAvatar(look.icon, look.color, look.img), h('span', 'fname', srcLabel(f)), h('span', 'fcount', String(n)));
    row.oncontextmenu = e => folderMenu(e, f);
    row.onclick = () => {
      let next = chosen.slice();
      if (on) { if (next.length === 1) return; next = next.filter(p => !samePathR(p, f.path)); } // at least one stays on
      else next.push(f.path);
      L.folders = next;
      saveLibPrefs();
      renderLibrary();
    };
    box.append(row);
  }
  // add another folder (OBS, SteelSeries, anything) right here
  const add = h('button', 'frow fadd');
  const plus = h('span', 'fplus'); plus.append(icoSpan('plus'));
  add.append(h('span', 'fspace'), plus, h('span', 'fname', 'Add folder'));
  add.title = 'Add a folder with clips';
  add.onclick = async () => folderAdded(await T.libAddFolder());
  box.append(add);
  const all = live.length && chosen.length === live.length;
  $('foldertext').textContent = !live.length ? 'No folders' : all ? 'All folders'
    : chosen.length <= 2 ? chosen.map(p => srcLabel(live.find(f => samePathR(f.path, p)))).join(', ') : `${chosen.length} folders`;
}
$('folderbtn').onclick = () => {
  if (L.side.collapsed) { L.side.collapsed = false; applySide(); saveLibPrefs(); L.folderOpen = true; }
  else L.folderOpen = !L.folderOpen;
  $('folderbox').classList.toggle('open', L.folderOpen);
  hideTip();
};

// ---------- tooltips (Spotify-style: a small dark label above the thing you hover) ----------
const tip = { el: null, timer: 0 };
function showTip(el, text, pos) {
  const t = $('tip');
  clearTimeout(tip.hideTimer);
  t.textContent = text || el.dataset.tip;
  t.classList.toggle('rail', pos === 'right' || pos === 'left');
  t.hidden = false;
  const r = el.getBoundingClientRect(), w = t.offsetWidth, ht = t.offsetHeight;
  let x, y;
  if (pos === 'left') { x = r.left - w - 10; y = r.top + r.height / 2 - ht / 2; }
  else if (pos === 'right' || el.dataset.tipPos === 'right') {
    const box = pos === 'right' ? (el.querySelector('.gav') || el).getBoundingClientRect() : r;
    x = box.right + 12; y = box.top + box.height / 2 - ht / 2;
  }
  else {
    x = r.left + r.width / 2 - w / 2; y = r.top - ht - 8;
    // no room above, or it would land in the title bar (Windows draws its buttons over it): show it below
    if (y < 4 || (r.top >= 40 && y < 42)) y = r.bottom + 8;
  }
  t.style.left = Math.max(6, Math.min(x, innerWidth - w - 6)) + 'px';
  t.style.top = Math.max(4, Math.min(y, innerHeight - ht - 4)) + 'px';
  // restart the fade for each new label: jump to invisible with no transition, then fade in
  t.style.transition = 'none';
  t.classList.remove('on');
  void t.offsetWidth;
  t.style.transition = '';
  t.classList.add('on');
}
function hideTip() {
  clearTimeout(tip.timer);
  const t = $('tip');
  const wasRail = t.classList.contains('rail') && t.classList.contains('on');
  tip.el = null;
  t.classList.remove('on');
  clearTimeout(tip.hideTimer);
  // the sidebar labels fade out quickly (like Discord's); others just disappear
  if (wasRail) tip.hideTimer = setTimeout(() => { if (!tip.el) t.hidden = true; }, 110);
  else t.hidden = true;
}
document.addEventListener('mouseover', e => {
  // the app's own controls (buttons, icons, sliders) get this style: their title="" is turned
  // into one when hovered. Everything else (file names, game names, paths) keeps the normal tooltip.
  const titled = e.target.closest && e.target.closest('[title]');
  if (titled && titled.matches('button:not(.frow):not(.qt-title), input[type=range], .ibtn, .btn, .chip, .tb-btn')) {
    const tt = titled.getAttribute('title');
    titled.removeAttribute('title');
    if (tt) titled.dataset.tip = tt; else delete titled.dataset.tip;
  }
  const rail = e.target.closest && $('libside').classList.contains('collapsed') && e.target.closest('#libside [data-rail-tip]');
  if (rail) {
    if (rail === tip.el) return;
    hideTip();
    tip.el = rail;
    showTip(rail, rail.dataset.railTip, 'right'); // no delay
    return;
  }
  const el = e.target.closest && e.target.closest('[data-tip]');
  if (el === tip.el) return;
  hideTip();
  if (!el) return;
  tip.el = el;
  tip.timer = setTimeout(() => { if (tip.el === el && el.isConnected) showTip(el); }, 250);
});
document.addEventListener('pointerdown', () => { if (tip.el) { const el = tip.el; hideTip(); tip.el = el; } }, true);
window.addEventListener('blur', hideTip);

// ---------- sidebar ----------
applySide();
function applySide() {
  $('library').style.setProperty('--sidew', (L.side.collapsed ? 80 : L.side.w) + 'px');
  document.documentElement.style.setProperty('--sidew', (L.side.collapsed ? 80 : L.side.w) + 'px'); // the editor page sits beside it
  $('libside').classList.toggle('collapsed', L.side.collapsed);
  if (L.side.collapsed) { L.folderOpen = false; $('folderbox').classList.remove('open'); }
  $('sidetoggle').dataset.tip = L.side.collapsed ? 'Open Your Library' : 'Collapse Your Library';
  $('sidetoggle').dataset.tipPos = L.side.collapsed ? 'right' : '';
  if (tip.el === $('sidetoggle')) showTip($('sidetoggle'));
  if (window.qtSideChanged) window.qtSideChanged(); // the editor's clip list goes with it
}
function toggleSidebar() { L.side.collapsed = !L.side.collapsed; applySide(); saveLibPrefs(); }
$('sidetoggle').onclick = toggleSidebar;

// drag the edge to resize; drag it narrow enough and it collapses
$('sidegrip').addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  e.preventDefault();
  const grip = $('sidegrip'), left = $('libside').getBoundingClientRect().left;
  grip.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing');
  const move = ev => {
    const w = ev.clientX - left;
    if (w < 150) { if (!L.side.collapsed) { L.side.collapsed = true; applySide(); } return; }
    L.side.collapsed = false;
    L.side.w = Math.min(460, Math.max(220, Math.round(w)));
    applySide();
  };
  const up = () => {
    grip.removeEventListener('pointermove', move);
    document.body.classList.remove('resizing');
    saveLibPrefs();
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up, { once: true });
  grip.addEventListener('pointercancel', up, { once: true });
});
$('sidegrip').addEventListener('dblclick', () => { L.side.collapsed = false; L.side.w = 300; applySide(); saveLibPrefs(); });

// a game's picture: its icon from Discord's game list, else a frame from its newest clip,
// else its initials
const gameIcons = new Map(); // game name -> icon url or null
function avatar(name, path) {
  if (/^desktop$/i.test(name)) return iconAvatar('monitor', '#2e2d31');
  const a = h('div', 'gav');
  a.style.background = `hsl(${hue(name)} 45% 32%)`;
  a.textContent = name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
  const picture = url => { a.textContent = ''; a.style.background = `#222 url("${url}") center/cover`; };
  const thumb = () => {
    if (!path) return;
    const fill = r => { if (r && r.url) picture(r.url); };
    const known = L.thumbs.get(path);
    if (known) fill(known); else T.libThumb(path).then(r => { L.thumbs.set(path, r); fill(r); });
  };
  if (gameIcons.has(name)) { const u = gameIcons.get(name); if (u) picture(u); else thumb(); }
  else T.gameIcon(name).then(u => { gameIcons.set(name, u || null); if (u) picture(u); else thumb(); });
  return a;
}
function iconAvatar(icon, color, img) {
  const a = h('div', 'gav ico-av' + (img ? ' logo ' + img.replace(/^img\/|\.png$/g, '') : ''));
  a.style.background = color;
  if (img) { const i = new Image(); i.src = img; i.alt = ''; i.draggable = false; a.append(i); } else a.append(icoSpan(icon));
  return a;
}

// games among `clips`, newest first
function gamesOf(clips) {
  const m = new Map();
  for (const c of clips) {
    let g = m.get(c.game);
    if (!g) { g = { key: c.game, name: c.gameName, count: 0, latest: 0, latestPath: null }; m.set(c.game, g); }
    g.count++;
    if (c.date > g.latest) { g.latest = c.date; g.latestPath = c.path; }
  }
  return [...m.values()].sort((a, b) => b.latest - a.latest);
}

function renderSide() {
  const d = L.data;
  const top = $('sidefixed'), box = $('games');
  top.replaceChildren(); box.replaceChildren();
  const row = (name, count, av, on, click, title) => {
    const r = h('div', 'game' + (on ? ' on' : ''));
    // collapsed sidebar: the name pops up right next to the picture, straight away (like Discord)
    r.dataset.railTip = name;
    // like Spotify: picture, name, and a quieter line underneath
    const txt = h('div', 'gtext');
    const nm = h('span', 'gname', name);
    nm.title = title || name; // expanded: the full name if it's cut off
    txt.append(nm, h('span', 'gcount', `${count} clip${count === 1 ? '' : 's'}`));
    r.append(av, txt);
    r.onclick = click;
    return r;
  };
  // clicking the one you're on does nothing (All clips) or goes back to all clips (a game)
  const pick = key => () => {
    // from the editor: back to the library, on the game clicked
    // in the editor the games filter its clip list (the same way they filter the library)
    if (window.qtIsOpen && window.qtIsOpen()) {
      if (key === L.game && key !== 'all') key = 'all';
      if (key !== L.game) { L.game = key; saveLibPrefs(); renderSide(); renderGrid(true); if (window.qtListChanged) window.qtListChanged(); }
      return;
    }
    if (key === L.game) { if (key === 'all') { showLibrary(); return; } key = 'all'; }
    L.game = key; saveLibPrefs(); renderSide(); renderGrid(true); showLibrary();
  };
  // the filter above the cards (Clips, Recordings, Edited) narrows the games too
  const here = d.clips.filter(c => inFolders(c) && kindHas(c, L.kind));
  // Home: back to the big cards (from the editor), or to the top of them
  const home = h('div', 'game home');
  home.dataset.railTip = 'Home';
  const ht = h('div', 'gtext'); ht.append(h('span', 'gname', 'Home'));
  home.append(iconAvatar('home', '#1a191c'), ht);
  home.onclick = () => { if (window.qtIsOpen && window.qtIsOpen()) showLibrary(); else $('libscroll').scrollTo({ top: 0, behavior: 'smooth' }); };
  top.append(home);
  // All clips stays put above the games, which scroll on their own; a line separates them
  const all = row('All clips', here.length, iconAvatar('grid', '#1a191c'), L.game === 'all', pick('all'));
  all.classList.add('allclips');
  top.append(all, h('div', 'gdiv'));
  // games with no clips in the chosen folders aren't listed; the search box narrows them down
  const games = sortGames(gamesOf(here)).filter(g => gameMatch(g, L.gq));
  for (const g of games) {
    const r = row(g.name, g.count, avatar(g.name, g.latestPath), L.game === g.key, pick(g.key));
    r.addEventListener('contextmenu', e => gameMenu(e, g));
    box.append(r);
  }
  if (!games.length && L.gq) box.append(h('div', 'gempty', 'No games match'));
  $('gsorttext').textContent = L.gameSort === 'alpha' ? 'A-Z' : 'Recent';
}

// ---------- finding a game: search and sort (the sidebar and Edit's Clips picker) ----------
// sorted by name (numbers in order, case ignored), or as gamesOf gives them (newest clip first)
const sortGames = games => (L.gameSort === 'alpha' ? games.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })) : games);
// "dead" finds Deadlock, "cod" finds Call of Duty (first letters of the words), "2" finds Destiny 2
function gameMatch(g, q) {
  q = String(q || '').trim().toLowerCase();
  if (!q) return true;
  const name = g.name.toLowerCase();
  if (name.includes(q)) return true;
  const flat = name.replace(/[^a-z0-9]+/g, ''), qq = q.replace(/[^a-z0-9]+/g, '');
  if (qq && flat.includes(qq)) return true;
  const initials = name.split(/[^a-z0-9]+/).filter(Boolean).map(w => w[0]).join('');
  return !!qq && initials.startsWith(qq);
}
function gameSortMenu(btn, after) {
  const m = $('ctxmenu');
  if (!m.hidden && m.dataset.for === 'gsort') { hideMenu(); return; }
  const r = btn.getBoundingClientRect();
  openMenu(r.right, r.bottom + 6, [['recent', 'Recent'], ['alpha', 'Alphabetical']].map(([k, label]) => ({
    icon: L.gameSort === k ? 'check' : 'blank', text: label, cls: L.gameSort === k ? 'cur' : '',
    run: () => { L.gameSort = k; saveLibPrefs(); renderSide(); if (after) after(); },
  })), true, 'gsort');
  btn.classList.add('open');
}
// the sidebar: a search button that opens into a box (like Spotify's Your Library), and the sort button
function openGameSearch() {
  if (L.side.collapsed) { L.side.collapsed = false; applySide(); saveLibPrefs(); }
  $('gsearchin').focus();
}
function closeGameSearch() {
  $('gsearchin').value = '';
  if (L.gq) { L.gq = ''; renderSide(); }
}
$('gsearchbtn').onclick = openGameSearch;
$('gsearchin').addEventListener('input', () => { L.gq = $('gsearchin').value; renderSide(); $('games').scrollTop = 0; });
$('gsearchin').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeGameSearch(); $('gsearchin').blur(); }
  else if (e.key === 'Enter') { const first = $('games').querySelector('.game'); if (first) first.click(); }
});
$('gsearchx').addEventListener('pointerdown', e => e.preventDefault()); // keeps the box focused
$('gsearchx').onclick = e => { e.preventDefault(); closeGameSearch(); $('gsearchin').focus(); };
$('gsortbtn').onclick = e => { e.stopPropagation(); gameSortMenu($('gsortbtn')); };

// Edit's Clips tab: a button showing the game the clip list is on; it opens a list of the games with
// a search box and the sort button. Picking one filters the clip list like the sidebar does.
function fillGamePick(btn) {
  if (!btn || !L.data) return;
  const here = L.data.clips.filter(c => inFolders(c) && kindHas(c, L.kind));
  const g = L.game === 'all' ? null : gamesOf(here).find(x => x.key === L.game);
  const av = g ? avatar(g.name, g.latestPath) : iconAvatar('grid', '#1a191c');
  const txt = h('div', 'gtext');
  txt.append(h('span', 'gname', g ? g.name : 'All clips'), h('span', 'gcount', `${g ? g.count : here.length} clip${(g ? g.count : here.length) === 1 ? '' : 's'}`));
  const chev = icoSpan('chev'); chev.classList.add('chev');
  btn.replaceChildren(av, txt, chev);
}
window.fillGamePick = fillGamePick;
let pickerShutAt = 0;
function closeGamePicker() {
  const p = $('gpicker');
  if (!p) return;
  p.remove();
  document.querySelectorAll('.gpick.open').forEach(b => b.classList.remove('open'));
}
function openGamePicker(anchor) {
  if ($('gpicker')) { closeGamePicker(); return; }
  if (Date.now() - pickerShutAt < 400 || !L.data) return; // the click on its button that just closed it
  hideMenu(); hideTip();
  const here = L.data.clips.filter(c => inFolders(c) && kindHas(c, L.kind));
  const p = h('div', 'gpicker'); p.id = 'gpicker';
  const box = h('label', 'search');
  const input = h('input'); input.type = 'text'; input.placeholder = 'Search games'; input.spellcheck = false;
  box.append(icoSpan('search'), input);
  const sort = h('button', 'ibtn gpsort'); sort.id = 'gpsort'; sort.append(icoSpan('sort'));
  sort.dataset.tip = 'Sort';
  const top = h('div', 'gp-top'); top.append(box, sort);
  const list = h('div', 'gp-list');
  p.append(top, list);
  let hi = 0;
  const choose = key => {
    closeGamePicker();
    if (key !== L.game) { L.game = key; saveLibPrefs(); renderSide(); renderGrid(true); if (window.qtListChanged) window.qtListChanged(); }
  };
  const mark = () => list.querySelectorAll('.gp-row').forEach((r, i) => { r.classList.toggle('hi', i === hi); if (i === hi) r.scrollIntoView({ block: 'nearest' }); });
  const fill = () => {
    const q = input.value;
    const rows = [];
    const row = (key, name, count, av) => {
      const r = h('div', 'gp-row' + (key === L.game ? ' on' : ''));
      const txt = h('div', 'gtext'); txt.append(h('span', 'gname', name), h('span', 'gcount', `${count} clip${count === 1 ? '' : 's'}`));
      r.append(av, txt);
      if (key === L.game) r.append(icoSpan('check'));
      r.onclick = () => choose(key);
      r.addEventListener('mousemove', () => { const i = rows.indexOf(r); if (i !== hi) { hi = i; mark(); } });
      rows.push(r);
    };
    if (!q.trim()) row('all', 'All clips', here.length, iconAvatar('grid', '#1a191c'));
    for (const g of sortGames(gamesOf(here)).filter(x => gameMatch(x, q))) row(g.key, g.name, g.count, avatar(g.name, g.latestPath));
    list.replaceChildren(...rows);
    if (!rows.length) list.append(h('div', 'gempty', 'No games match'));
    hi = Math.max(0, rows.findIndex(r => r.classList.contains('on')));
    if (q.trim()) hi = 0;
    mark();
  };
  input.addEventListener('input', fill);
  input.addEventListener('keydown', e => {
    const rows = list.querySelectorAll('.gp-row');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (rows.length) { hi = (hi + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length; mark(); } }
    else if (e.key === 'Enter') { e.preventDefault(); if (rows[hi]) rows[hi].click(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeGamePicker(); }
  });
  sort.onclick = e => { e.preventDefault(); e.stopPropagation(); gameSortMenu(sort, () => { fill(); input.focus(); }); };
  document.body.append(p);
  const r = anchor.getBoundingClientRect();
  const w = Math.max(r.width, 300);
  p.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
  p.style.top = (r.bottom + 6) + 'px';
  p.style.width = w + 'px';
  p.style.maxHeight = Math.max(200, innerHeight - r.bottom - 22) + 'px';
  anchor.classList.add('open');
  fill();
  input.focus();
}
window.openGamePicker = openGamePicker;
// a click outside the picker closes it, and only that (like the menus); its sort menu counts as inside
document.addEventListener('pointerdown', e => {
  const p = $('gpicker');
  if (!p || p.contains(e.target) || $('ctxmenu').contains(e.target)) return;
  const onAnchor = e.target.closest && e.target.closest('.gpick');
  closeGamePicker();
  if (onAnchor) pickerShutAt = Date.now();
  if (e.button !== 0 || onAnchor) return;
  e.stopPropagation();
  const eat = ev => { ev.stopPropagation(); ev.preventDefault(); };
  window.addEventListener('click', eat, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', eat, true), 600);
}, true);
window.addEventListener('blur', closeGamePicker);
window.addEventListener('resize', closeGamePicker);

// ---------- grid ----------
function scope() {
  return L.data.clips.filter(c => inFolders(c) && (L.game === 'all' || c.game === L.game));
}
function filtered(base) {
  const q = L.q.trim().toLowerCase();
  let list = base.filter(c => kindHas(c, L.kind));
  if (q) list = list.filter(c => (c.gameName + ' ' + c.name + ' ' + c.sub + ' ' + (c.title || '')).toLowerCase().includes(q));
  const dur = c => { const t = L.thumbs.get(c.path); return (t && t.duration) || c.duration || 0; };
  const by = {
    new: (a, b) => b.date - a.date,
    old: (a, b) => a.date - b.date,
    long: (a, b) => dur(b) - dur(a) || b.date - a.date,
    big: (a, b) => b.size - a.size,
  }[L.sort] || ((a, b) => b.date - a.date);
  return list.sort(by);
}

// ---------- NEW clips ----------
// Like Discord: clips saved since you last looked at this view are marked NEW; the mark goes away
// once you leave the view or open the clip.
const viewKey = () => JSON.stringify([L.game, chosenFolders().map(p => p.toLowerCase()).sort()]);
function leaveView() { if (L.viewKey) L.seen[L.viewKey] = Date.now(); }
function enterView() {
  const k = viewKey();
  if (k === L.viewKey) return;
  leaveView();
  L.viewKey = k;
  // a view never seen before: what's new since the app was last open
  L.newSince = L.seen[k] || L.seen.quit || Date.now();
  const keys = Object.keys(L.seen);
  if (keys.length > 200) for (const x of keys.sort((a, b) => L.seen[a] - L.seen[b]).slice(0, keys.length - 200)) delete L.seen[x];
  saveLibPrefs();
}
window.addEventListener('beforeunload', () => { L.seen.quit = Date.now(); saveLibPrefs(); });
const isNew = c => L.newSince && c.date > L.newSince && !L.opened.has(c.path);

function libTitle() {
  const d = L.data;
  const base = scope();
  const g = L.game === 'all' ? null : base[0] || d.clips.find(c => c.game === L.game);
  const chosen = chosenFolders(), live = liveFolders();
  const one = chosen.length === 1 && live.length > 1 ? live.find(f => samePathR(f.path, chosen[0])) : null;
  $('libname').textContent = g ? g.gameName : one ? `All ${srcLabel(one)} clips` : 'All clips';
  // the game's (or folder's) picture, like Discord's server icon
  const hk = g ? 'g:' + g.game : one ? 'f:' + one.path : 'all';
  if ($('libicon').dataset.k !== hk) {
    $('libicon').dataset.k = hk;
    const look = one ? SRC_LOOK[one.kind] : null;
    $('libicon').replaceChildren(g ? avatar(g.gameName, (gamesOf(base)[0] || {}).latestPath)
      : look ? iconAvatar(look.icon, look.color, look.img) : iconAvatar('grid', '#1a191c'));
  }
}

function pickKind(k) {
  if (k === L.kind) return; // All while on All: nothing moves
  L.kind = k; saveLibPrefs(); renderSide(); renderGrid(true);
  if (window.qtListChanged) window.qtListChanged();
}
function renderGrid(resetScroll, update) {
  const d = L.data;
  if (!d) return;
  enterView();
  libTitle();
  const base = scope();
  // the filters: only ones that pick out some of what's here, not none or all of it. Clicking the one
  // that's on turns it off; the sidebar's games follow it.
  const chips = $('libkinds');
  chips.replaceChildren();
  const count = k => base.reduce((n, c) => n + (kindHas(c, k) ? 1 : 0), 0);
  if (L.kind !== 'all' && !count(L.kind)) { L.kind = 'all'; saveLibPrefs(); renderSide(); }
  const show = KINDS.filter(([k]) => k !== 'all' && (k === L.kind || (count(k) > 0 && count(k) < base.length)));
  if (show.length) {
    for (const [k, label] of [KINDS[0], ...show]) {
      const c = h('button', 'chip' + (L.kind === k ? ' on' : ''), label);
      c.onclick = () => pickKind(L.kind === k ? 'all' : k);
      chips.append(c);
    }
  }
  $('sorttext').textContent = (SORTS.find(x => x[0] === L.sort) || SORTS[0])[1];

  L.list = filtered(base);
  const here = new Set(L.list.map(c => c.path));
  for (const p of [...L.sel]) if (!here.has(p)) L.sel.delete(p);
  L.anchor = -1;
  queueMicrotask(showSel);
  const total = L.list.reduce((s, c) => s + c.size, 0);
  $('libcount').textContent = `${L.list.length} clip${L.list.length === 1 ? '' : 's'}  ·  ${fmtSize(total)}`;
  stopPreview();
  const box = $('libgrid');
  const keep = resetScroll ? 0 : $('libscroll').scrollTop;
  // a new view (another game, a filter) makes its cards again, so the first screen waves in; a
  // refresh keeps the cards whose clip hasn't changed, so nothing blinks
  if (!update) { V.els.clear(); box.replaceChildren(); }
  else for (const [p, el] of V.els) { const c = L.list.find(x => x.path === p); if (!c || thumbStamp(el._clip) !== thumbStamp(c)) { el.remove(); V.els.delete(p); } else refreshCard(el, c); }
  if (!d.folders.some(x => !x.missing)) return libEmpty("Couldn't find a clips folder. Add the folder your clips are saved in.", true);
  if (!d.clips.length) return libEmpty('No clips in your folders yet.', true);
  if (!L.list.length) return libEmpty(L.q ? `No clips match "${L.q}".` : 'No clips here.');
  box.querySelector('.libempty')?.remove();
  V.fresh = !update; V.t0 = performance.now(); V.waved = 0;
  layoutGrid();
  $('libscroll').scrollTop = keep;
  paintGrid();
  backgroundThumbs();
}

// ---------- the home grid: virtual scrolling ----------
// Only the rows on screen (and some above and below) have cards; the rest of the grid is empty
// space worked out from the scroll position, so scrolling stays smooth however many clips there
// are, and whatever card you land on is there to click. Cards that scroll away are kept (up to
// V_KEEP) with their pictures, so scrolling back is instant. Cards only wave in when a view opens
// (V.fresh): while scrolling they're simply there, no fade.
const V = { rows: [], list: [], height: 0, cols: 1, cw: 310, ch: 232, els: new Map(), heads: new Map(), fresh: false, t0: 0, waved: 0, raf: 0 };
const V_GAP = 18, V_MIN = 310, V_OVER = 900, V_KEEP = 360;
let vHeadH = 0;
function layoutGrid() {
  const box = $('libgrid');
  box.classList.add('virtual');
  const W = box.clientWidth || 1000;
  if (!vHeadH) { const m = h('h4', 'month', 'May 2026'); m.style.visibility = 'hidden'; box.append(m); const cs = getComputedStyle(m); vHeadH = m.offsetHeight + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom); m.remove(); }
  V.w = W; V.cols = Math.max(1, Math.floor((W + V_GAP) / (V_MIN + V_GAP)));
  V.cw = (W - V_GAP * (V.cols - 1)) / V.cols; V.ch = V.cw * 3 / 4;
  const byDate = (L.sort === 'new' || L.sort === 'old') && L.months;
  V.list = L.list; V.rows = [];
  let y = 0, i = 0;
  while (i < L.list.length) {
    // one month (or everything when not sorted by date)
    const month = byDate ? (isToday(L.list[i].date) ? 'Today' : fmtMonth(L.list[i].date)) : '';
    let j = i;
    while (j < L.list.length && (!byDate || (isToday(L.list[j].date) ? 'Today' : fmtMonth(L.list[j].date)) === month)) j++;
    if (byDate) { V.rows.push({ head: month, y }); y += vHeadH; }
    for (let k = i; k < j; k += V.cols) { V.rows.push({ from: k, to: Math.min(j, k + V.cols), y }); y += V.ch + V_GAP; }
    y -= V_GAP; // no gap under a month's last row (the next heading has its own space)
    i = j;
  }
  V.height = Math.max(0, y);
  box.style.height = V.height + 'px';
}
function paintGrid() {
  const box = $('libgrid'), sc = $('libscroll');
  if (!V.rows.length) return;
  silenceOnScreen();
  const top = box.getBoundingClientRect().top - sc.getBoundingClientRect().top; // the grid's top, on screen
  const y0 = -top - V_OVER, y1 = -top + sc.clientHeight + V_OVER;
  const want = new Set(), heads = new Set();
  const firstOnScreen = V.rows.find(r => r.y + (r.head ? vHeadH : V.ch) > -top);
  for (const r of V.rows) {
    const rh = r.head ? vHeadH : V.ch;
    if (r.y + rh < y0) continue;
    if (r.y > y1) break;
    if (r.head) {
      heads.add(r.head);
      let el = V.heads.get(r.head);
      if (!el) { el = h('h4', 'month vhead', r.head); V.heads.set(r.head, el); }
      el.style.top = r.y + 'px';
      if (el.parentNode !== box) box.append(el);
      continue;
    }
    for (let i = r.from; i < r.to; i++) {
      const c = V.list[i], col = (i - r.from);
      want.add(c.path);
      let el = V.els.get(c.path);
      if (!el) {
        // only the first screen of a new view waves in
        const wave = V.fresh && V.waved < 15 && firstOnScreen && r.y < -top + sc.clientHeight;
        el = card(c, wave);
        if (wave) el._waveAt = V.t0 + (V.waved++) * 45; // 45 ms apart
        V.els.set(c.path, el);
      } else if (el._clip !== c || !el.parentNode) { refreshCard(el, c); el.classList.toggle('sel', L.sel.has(c.path)); } // (badges and names may have changed while it was away)
      el.style.left = col * (V.cw + V_GAP) + 'px'; el.style.top = r.y + 'px'; el.style.width = V.cw + 'px';
      if (el.parentNode !== box) box.append(el);
      if (!el._thumbing) loadThumb(el);
    }
  }
  V.fresh = false; // after the first paint, new cards are just there
  // off-screen cards leave the page; the most recent ones are kept for coming back
  for (const [p, el] of V.els) if (!want.has(p) && el.parentNode) { if (preview.el === el) stopPreview(); el.remove(); }
  for (const [k, el] of V.heads) if (!heads.has(k) && el.parentNode) el.remove();
  if (V.els.size > V_KEEP) for (const p of V.els.keys()) { if (V.els.size <= V_KEEP) break; if (!want.has(p)) V.els.delete(p); }
}
const queuePaint = () => { if (!V.raf) V.raf = requestAnimationFrame(() => { V.raf = 0; paintGrid(); }); };
$('libscroll').addEventListener('scroll', queuePaint, { passive: true });
// (watches the scroll box, not the grid: the grid's own height is set here, which would loop)
new ResizeObserver(() => requestAnimationFrame(() => { if (!V.rows.length) return; const w = $('libgrid').clientWidth; if (w && w !== V.w) { V.w = w; layoutGrid(); paintGrid(); } })).observe($('libscroll'));
$('libscroll').addEventListener('scroll', hideMenu, { passive: true });

// a round arrow that slides down over the top of a scrolled list and takes it back up
function backToTop(sc) {
  const b = h('button', 'totop');
  b.title = 'Back to the top';
  b.append(icoSpan('up'));
  b.onclick = () => sc.scrollTo({ top: 0, behavior: 'smooth' });
  sc.parentElement.append(b);
  sc.addEventListener('scroll', () => { b.style.top = (sc.offsetTop + 10) + 'px'; b.classList.toggle('show', sc.scrollTop > 240); }, { passive: true });
}
backToTop($('games'));
backToTop($('libscroll'));

// A picture is kept for one version of the file (its size and time): a clip that was still being
// written when it was first seen (Encore saves a replay in a few seconds) gets a new one once it's done.
const thumbStamp = c => `${c.size}:${c.mtime || 0}`;
function knownThumb(c) { const t = L.thumbs.get(c.path); return t && t.stamp === thumbStamp(c) ? t : null; }
function keepThumb(c, r) { if (r) r.stamp = thumbStamp(c); L.thumbs.set(c.path, r); }
function loadThumb(el) {
  if (el._thumbing) return Promise.resolve();
  el._thumbing = true;
  thumbObs.unobserve(el);
  const c = el._clip, known = knownThumb(c);
  if (known) { paintCard(el, known); return Promise.resolve(); }
  return T.libThumb(c.path).then(r => { keepThumb(c, r); paintCard(el, r); });
}
const thumbObs = new IntersectionObserver(es => {
  for (const e of es) if (e.isIntersecting) loadThumb(e.target);
}, { root: $('libscroll'), rootMargin: '1600px 0px' }); // load pictures well before they scroll into view
// and keep loading the rest in the background, in order, so nothing is blank when you get there
let bgThumbs = 0;
function backgroundThumbs() {
  const run = ++bgThumbs;
  let i = 0;
  const next = () => {
    if (run !== bgThumbs) return;
    while (i < V.list.length && knownThumb(V.list[i])) i++;
    const c = V.list[i++];
    if (!c) return;
    T.libThumb(c.path).then(r => {
      keepThumb(c, r);
      const el = V.els.get(c.path); if (el && el.isConnected && !el._thumbing) loadThumb(el);
      return window.requestIdleCallback ? requestIdleCallback(next, { timeout: 300 }) : setTimeout(next, 16);
    });
  };
  setTimeout(next, 600); // after the first screen has had its turn
}

// Encore cards on screen once scrolling stops: main works out their silent tracks ahead of time, so
// the editor opens with them already folded (only what's looked at, not the whole library)
let silenceTimer = null;
function silenceOnScreen() {
  clearTimeout(silenceTimer);
  silenceTimer = setTimeout(() => {
    if ($('libgrid').classList.contains('scrolling') || $('library').classList.contains('away')) return;
    const r = $('libscroll').getBoundingClientRect();
    const paths = [...document.querySelectorAll('#libgrid .clip')].filter(el => {
      const b = el.getBoundingClientRect(), c = el._clip;
      return c && c.origin === 'encore' && c.kind !== 'export' && c.size > 0 && b.bottom > r.top && b.top < r.bottom;
    }).map(el => el._clip.path);
    if (paths.length) T.silencePrefetch(paths);
  }, 300);
}

// the Encore card under the mouse is checked first: it's the likeliest to be opened next
const silenceFirst = c => { if (c && c.origin === 'encore' && c.kind !== 'export' && c.size > 0) T.silenceFirst(c.path); };

// scrolling: no hover effects or previews on the cards sliding under the mouse - they made it stutter
let scrollIdle = null;
$('libscroll').addEventListener('scroll', () => {
  const g = $('libgrid');
  if (!g.classList.contains('scrolling')) {
    g.classList.add('scrolling');
    if (!preview.dragging) stopPreview();
  }
  clearTimeout(scrollIdle);
  scrollIdle = setTimeout(() => {
    g.classList.remove('scrolling');
    silenceOnScreen();
    // the card that ended up under the mouse gets its preview, same as hovering it
    const el = document.elementFromPoint(mouseAt.x, mouseAt.y);
    const cardEl = el && el.closest && el.closest('#libgrid .clip');
    if (cardEl && cardEl !== preview.el) schedulePreview(cardEl, cardEl._clip);
  }, 160);
}, { passive: true });
// a click while the cards are still ignoring the mouse (right after scrolling) still opens the card
// under it: the scrolling state ends on the press and the click goes to that card
let scrollPress = null;
$('libscroll').addEventListener('pointerdown', e => {
  const g = $('libgrid');
  scrollPress = null;
  if (!g.classList.contains('scrolling') || e.button !== 0) return;
  clearTimeout(scrollIdle);
  g.classList.remove('scrolling');
  const hit = document.elementsFromPoint(e.clientX, e.clientY).find(x => x.closest && x.closest('#libgrid .clip'));
  scrollPress = hit ? hit.closest('#libgrid .clip') : null;
}, true);
$('libscroll').addEventListener('click', e => {
  const el = scrollPress; scrollPress = null;
  if (el && el.isConnected && !(e.target.closest && e.target.closest('.clip'))) { e.stopPropagation(); el.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, metaKey: e.metaKey })); }
}, true);
const mouseAt = { x: -1, y: -1 };
window.addEventListener('pointermove', e => { mouseAt.x = e.clientX; mouseAt.y = e.clientY; }, { passive: true });

function card(c, wave) {
  // starts as a dark placeholder; fades in once its picture is ready (paintCard)
  const el = h('div', 'clip' + (wave ? ' loading' : '') + (L.sel.has(c.path) ? ' sel' : ''));
  el._clip = c;
  el.tabIndex = 0;
  el.draggable = true;
  el.append(h('div', 'ph'), h('div', 'shade2'));
  const chk = h('button', 'cchk');
  chk.title = 'Select (Ctrl+click)';
  chk.append(icoSpan('check'));
  chk.onclick = e => { e.stopPropagation(); toggleSel(c, e.shiftKey); };
  el.append(chk);
  const b = h('span', 'ckind');
  el.append(b);
  const acts = h('div', 'cact');
  const more = h('button', 'cbtn'); more.title = 'More'; more.append(icoSpan('more'));
  more.onclick = e => { e.stopPropagation(); const r = more.getBoundingClientRect(); showMenu(r.right - 8, r.bottom + 4, el._clip, el); };
  const del = h('button', 'cbtn'); del.title = 'Delete'; del.append(icoSpan('trash'));
  del.onclick = e => { e.stopPropagation(); trashClips(L.sel.has(el._clip.path) ? selected() : [el._clip]); };
  acts.append(more, del);
  el.append(acts);
  // bottom: title, then a line that fades away on hover while the seek bar and buttons slide up
  const bottom = h('div', 'cbottom');
  bottom.append(h('div', 'ctitle'));
  const subrow = h('div', 'csubrow');
  subrow.append(h('span', 'csub'), h('span', 'cdur'));
  bottom.append(subrow, h('div', 'cfile')); // the actual file name, on every card
  const hb = h('div', 'hbar');
  const trk = h('div', 'trk'); trk.append(h('div', 'fill'));
  trk.addEventListener('pointerdown', e => { e.stopPropagation(); seekPreview(el, el._clip, e); });
  trk.onclick = e => e.stopPropagation();
  const btns = h('div', 'cbtns');
  const edit = h('button', 'hbtn'); edit.append(icoSpan('scissors'), h('span', '', 'Trim'));
  edit.onclick = e => { e.stopPropagation(); openClip(el._clip, el); };
  const copy = h('button', 'hbtn primary'); copy.append(icoSpan('copy'), h('span', '', 'Copy Video'));
  copy.title = 'Copy the clip, then paste it into Discord with Ctrl+V';
  copy.onclick = e => { e.stopPropagation(); copyClips([el._clip]); };
  btns.append(edit, copy);
  hb.append(trk, btns);
  bottom.append(hb);
  el.append(bottom);
  refreshCard(el, c);
  el.onclick = e => {
    if (e.ctrlKey || e.metaKey) toggleSel(el._clip);
    else if (e.shiftKey) toggleSel(el._clip, true);
    else if (L.sel.size) toggleSel(el._clip);
    else openClip(el._clip, el);
  };
  el.addEventListener('keydown', e => { if (e.key === 'Enter') openClip(el._clip, el); });
  el.addEventListener('contextmenu', e => { e.preventDefault(); showMenu(e.clientX, e.clientY, el._clip, el); });
  el.addEventListener('mouseenter', () => { schedulePreview(el, el._clip); readyDrag(el._clip, 250); silenceFirst(el._clip); });
  el.addEventListener('mouseleave', () => { if (preview.el === el && !preview.dragging) stopPreview(); clearTimeout(preview.timer); clearTimeout(dragTimer); });
  el.addEventListener('pointerdown', e => { if (e.button === 0) readyDrag(el._clip, 0); });
  el.addEventListener('dragstart', e => dragOut(e, el._clip));
  thumbObs.observe(el);
  return el;
}
// the parts of a card that follow the clip's details (title, badges, length)
function refreshCard(el, c) {
  el._clip = c;
  el.querySelector('.ctitle').textContent = clipTitle(c);
  el.querySelector('.ctitle').title = c.name;
  // an edited clip shows the size it will have when dragged, copied or exported
  const tr = trimOf(c), sz = tr ? '≈ ' + fmtSize(estSize(c.size, tr.len, c.duration || (c.edit && c.edit.dur))) : fmtSize(c.size);
  const sub = [L.game === 'all' ? c.gameName : '', c.sub, sz].filter(Boolean).join('  ·  ');
  el.querySelector('.csub').textContent = sub;
  el.querySelector('.cfile').textContent = c.name;
  setLength(el.querySelector('.cdur'), c);
  const b = el.querySelector('.ckind');
  b.replaceChildren();
  if (isNew(c)) b.append(h('span', 'cnew', 'NEW'));
  if (c.origin) { const t = h('span', 'csrc ' + c.origin), i = new Image(); i.src = SRC_LOOK[c.origin].img; i.alt = ''; i.draggable = false; t.append(i); b.append(t); }
  if (KIND_BADGE[c.kind] || c.origin) b.append(h('span', 'cklabel', KIND_BADGE[c.kind] || SRC_LOOK[c.origin].label));
  b.hidden = !b.childNodes.length;
  b.classList.toggle('hasnew', isNew(c));
}
const cardsFor = path => [...document.querySelectorAll('#libgrid .clip')].filter(el => samePathR(el._clip.path, path));

// ---------- dragging a card out (into Discord, a folder...) ----------
// What's dropped is the clip as you left it: trimmed, with your audio changes, under its name. That
// file is made ahead of time (hovering or pressing the card) since a drag needs it at once.
let dragTimer = null;
const needsMaking = c => !!(c.edit || c.title);
function readyDrag(c, ms) {
  clearTimeout(dragTimer);
  if (!needsMaking(c)) return;
  dragTimer = setTimeout(() => T.dragPrepare(c.path), ms);
}
function dragOut(e, c) {
  e.preventDefault();
  stopPreview();
  const file = needsMaking(c) ? T.dragReady(c.path) : c.path;
  if (!file) {
    libToast('Getting it ready... drag it again in a moment.');
    T.dragPrepare(c.path).then(r => { if (r.ok) libToast('Ready. Drag it again.'); else libToast(r.error, 'err'); });
    return;
  }
  // our own window shouldn't offer "Drop to edit" for it; the card lifts away while it's dragged
  const card = e.currentTarget && e.currentTarget.classList && e.currentTarget.classList.contains('clip') ? e.currentTarget : null;
  document.body.classList.add('dragout');
  if (card) card.classList.add('lifted');
  const done = () => { document.body.classList.remove('dragout'); if (card) card.classList.remove('lifted'); window.removeEventListener('pointermove', done); };
  setTimeout(() => window.addEventListener('pointermove', done), 300);
  T.dragStart(c.path, file, dragPicture(c, card));
}
// The picture under the mouse while dragging a clip out: a small version of its card (frame, name
// in up to two lines, length), drawn at twice the size so it's sharp on high-DPI screens. It's as wide
// as Windows' drag picture can be, which leaves no room for the file path Electron would add beside it.
const DRAG_W = 150, DRAG_H = 112;
function dragPicture(c, card) {
  try {
    const S = 2, W = DRAG_W * S, H = DRAG_H * S, R = 10 * S;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const round = () => { g.beginPath(); g.moveTo(R, 0); g.arcTo(W, 0, W, H, R); g.arcTo(W, H, 0, H, R); g.arcTo(0, H, 0, 0, R); g.arcTo(0, 0, W, 0, R); g.closePath(); };
    round(); g.save(); g.clip();
    g.fillStyle = '#1a191c'; g.fillRect(0, 0, W, H);
    const img = card && card.querySelector(':scope > img');
    if (img && img.naturalWidth) { // cover
      const k = Math.max(W / img.naturalWidth, H / img.naturalHeight), iw = img.naturalWidth * k, ih = img.naturalHeight * k;
      g.drawImage(img, (W - iw) / 2, (H - ih) / 2, iw, ih);
    }
    const grad = g.createLinearGradient(0, H * 0.35, 0, H);
    grad.addColorStop(0, 'rgba(0,0,0,0)'); grad.addColorStop(1, 'rgba(0,0,0,.85)');
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
    // name: one line if it fits, else two balanced lines (split after a comma when there is one);
    // only a very long name gets "..."
    const pad = 9 * S, maxW = W - pad * 2;
    const fit = (txt, w) => { if (g.measureText(txt).width <= w) return txt; while (txt.length > 1 && g.measureText(txt + '...').width > w) txt = txt.slice(0, -1); const sp = txt.lastIndexOf(' '); if (sp > txt.length - 12 && sp > 0) txt = txt.slice(0, sp); return txt.replace(/[\s,.:;·-]+$/, '') + '...'; };
    g.font = `600 ${12 * S}px Inter, "Segoe UI", sans-serif`;
    const name = clipTitle(c);
    let lines = [name];
    if (g.measureText(name).width > maxW) {
      const words = name.split(/\s+/);
      let best = null;
      for (let i = 1; i < words.length; i++) { // the split that keeps both lines inside and closest in length
        const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
        const wa = g.measureText(a).width, wb = g.measureText(b).width;
        let score = Math.abs(wa - wb) + (/,$/.test(a) ? -100 * S : 0) + (wa > maxW ? 1e6 : 0) + (wb > maxW ? 1e5 : 0);
        if (!best || score < best.score) best = { a, b, score };
      }
      lines = best ? [fit(best.a, maxW), fit(best.b, maxW)] : [fit(name, maxW)];
    }
    const lh = 15 * S, metaY = H - pad;
    // under the name: the length (or trimmed length), and the game when there's room
    const t = trimOf(c), len = (t ? '✂ ' : '') + fmtLen(t ? t.len : c.duration || 0);
    g.font = `500 ${10.5 * S}px Inter, "Segoe UI", sans-serif`; g.fillStyle = 'rgba(255,255,255,.75)';
    const withGame = c.gameName ? len + '  ·  ' + c.gameName : len;
    g.fillText(g.measureText(withGame).width <= maxW ? withGame : c.gameName ? fit(withGame, maxW) : len, pad, metaY);
    g.font = `600 ${12 * S}px Inter, "Segoe UI", sans-serif`; g.fillStyle = '#fff';
    lines.forEach((ln, i) => g.fillText(ln, pad, metaY - 14 * S - (lines.length - 1 - i) * lh));
    g.restore();
    round(); g.lineWidth = S; g.strokeStyle = 'rgba(255,255,255,.14)'; g.stroke();
    return cv.toDataURL('image/png');
  } catch (err) { return null; }
}

// ---------- saved trims on cards ----------
// the part of the clip that's kept (whole clip when it hasn't been trimmed)
// a clip's trim and speed (Trim's Speed row); len = how long the file it makes plays
// the trim and how long the file it makes plays (the trim's speed and Edit's speed parts: TimeMap)
const trimOf = c => {
  const e = c.edit, d = c.duration || (e && e.dur) || 0, s = e && [0.25, 0.5, 1.5, 2, 4].includes(+e.speed) ? +e.speed : 1;
  const sp = e && e.fx && Array.isArray(e.fx.layers) ? e.fx.layers.filter(l => l && l.type === 'speed') : [];
  if (!e || !d || (e.in <= 0.01 && e.out >= d - 0.01 && s === 1 && !sp.length)) return null;
  const a = Math.max(0, e.in || 0), b = Math.min(d, e.out || d);
  const m = TimeMap.build(sp, s, d);
  return { a, b, s, len: m.toOut(b) - m.toOut(a), parts: sp.length };
};
const showLength = (el, c) => setLength(el.querySelector('.cdur'), c);
function setLength(d, c) {
  if (!d) return;
  const t = trimOf(c);
  d.replaceChildren();
  if (t) { d.append(icoSpan('scissors'), document.createTextNode(fmtLen(t.len))); d.title = `Trimmed from ${fmtLen(c.duration)}` + (t.s !== 1 ? `, at ${t.s}× speed` : '') + (t.parts ? `, with ${t.parts} speed part${t.parts > 1 ? 's' : ''}` : ''); }
  else { d.textContent = c.duration ? fmtLen(c.duration) : ''; d.removeAttribute('title'); }
}
// the editor changed a clip (trim, name): update its cards and the library's copy of it
function updateCardEdit(c) {
  const lib = L.data && L.data.clips.find(x => samePathR(x.path, c.path));
  if (lib && lib !== c) { lib.edit = c.edit; lib.title = c.title; if (c.duration) lib.duration = c.duration; }
  for (const el of cardsFor(c.path)) refreshCard(el, lib || c);
}

// ---------- selecting ----------
const selected = () => L.list.filter(c => L.sel.has(c.path));
function toggleSel(c, range) {
  const i = L.list.indexOf(c);
  if (range && L.anchor >= 0 && i >= 0) {
    const [a, b] = L.anchor < i ? [L.anchor, i] : [i, L.anchor];
    for (let k = a; k <= b; k++) L.sel.add(L.list[k].path);
  } else {
    if (L.sel.has(c.path)) L.sel.delete(c.path); else L.sel.add(c.path);
    L.anchor = i;
  }
  showSel();
}
function selectAll() { for (const c of L.list) L.sel.add(c.path); showSel(); }
function clearSel() { L.sel.clear(); L.anchor = -1; showSel(); }
function showSel() {
  for (const el of document.querySelectorAll('#libgrid .clip')) el.classList.toggle('sel', L.sel.has(el._clip.path));
  const list = selected();
  $('libgrid').classList.toggle('selecting', list.length > 0);
  $('selbar').hidden = !list.length;
  $('libtools').hidden = !!list.length;
  if (list.length) $('seltext').textContent = `${list.length} selected  ·  ${fmtSize(list.reduce((s, c) => s + c.size, 0))}`;
}
$('selall').onclick = selectAll;
$('selcopy').onclick = () => copyClips(selected());
$('seldel').onclick = () => trashClips(selected());
$('selclear').onclick = clearSel;

// Copy Video from cards: trims, audio changes and names are applied (made ahead when possible)
async function copyClips(list) {
  if (!list.length) return;
  const edited = list.filter(c => c.edit).length;
  const slow = setTimeout(() => libToast(edited > 1 ? `Making ${edited} trimmed clips...` : 'Making the trimmed clip...'), 300);
  const r = await T.copyClips(list.map(c => c.path));
  clearTimeout(slow);
  if (!r.ok) return libToast(r.error, 'err');
  const big = r.files.filter(f => f.size > 20 * 1048576).length;
  const what = list.length === 1 ? 'Copied' : `Copied ${list.length} clips`;
  libToast(big ? `${what}. ${big === 1 && list.length === 1 ? `It's ${fmtSize(r.files[0].size)}, so` : `${big} of them are over 20 MB, so`} Discord needs Nitro to send ${big === 1 ? 'it' : 'them'}.` : `${what}. Paste into Discord with Ctrl+V.`);
}

// cards fade in one after another in reading order (a wave), however the pictures happen to load
const showCard = el => {
  const wait = Math.max(0, (el._waveAt || 0) - performance.now());
  setTimeout(() => requestAnimationFrame(() => el.classList.remove('loading')), wait);
};
function paintCard(el, r) {
  if (r && r.url) {
    const img = h('img');
    img.alt = '';
    img.draggable = false;
    img.decoding = 'async';
    img.onerror = () => { img.remove(); el.classList.add('noimg'); showCard(el); };
    img.src = r.url;
    // only shown once the picture is decoded, so it never pops in half-drawn
    (img.decode ? img.decode() : Promise.resolve()).then(() => { el.prepend(img); showCard(el); }, () => { el.prepend(img); showCard(el); });
  } else if (r && r.error && !r.triedPlayer) {
    // ffmpeg couldn't read it; the built-in player often can, so take the frame from there
    r.triedPlayer = true;
    playerThumb(el._clip).then(x => {
      if (x && x.url) { keepThumb(el._clip, x); paintCard(el, x); } else paintCard(el, r);
    });
  } else {
    el.classList.add('noimg');
    el.querySelector('.ph').textContent = r && r.error ? "Can't preview this file" : '';
    showCard(el);
  }
  const c = el._clip;
  if (r && r.duration && !c.duration) { c.duration = r.duration; showLength(el, c); }
}

// one at a time: load the clip in a hidden player, grab a frame about a third in, save it
let playerQueue = Promise.resolve();
function playerThumb(c) {
  if (!c.size) return Promise.resolve(null); // an empty file (a recorder claiming the name): nothing to load
  const job = playerQueue.then(() => new Promise(resolve => {
    const vid = document.createElement('video');
    vid.muted = true; vid.preload = 'auto';
    let done = false;
    const finish = x => { if (done) return; done = true; clearTimeout(timer); vid.removeAttribute('src'); vid.load(); resolve(x); };
    const timer = setTimeout(() => finish(null), 8000);
    vid.addEventListener('error', () => finish(null));
    vid.addEventListener('loadedmetadata', () => { vid.currentTime = isFinite(vid.duration) && vid.duration > 1 ? vid.duration * 0.3 : 0; });
    vid.addEventListener('seeked', async () => {
      try {
        const w = 480, ht = Math.round(w * (vid.videoHeight || 270) / (vid.videoWidth || 480));
        const cv = document.createElement('canvas'); cv.width = w; cv.height = ht;
        cv.getContext('2d').drawImage(vid, 0, 0, w, ht);
        finish(await T.libSaveThumb(c.path, cv.toDataURL('image/jpeg', 0.8), vid.duration));
      } catch (e) { finish(null); }
    }, { once: true });
    vid.src = c.url;
  }));
  playerQueue = job.catch(() => null);
  return job;
}

function openClip(c, el) {
  if (isNew(c)) { L.opened.add(c.path); for (const x of cardsFor(c.path)) refreshCard(x, c); }
  openQuickTrim(c, el);
}

// ---------- hover preview ----------
const preview = { el: null, video: null, timer: null };
function schedulePreview(el, c) {
  clearTimeout(preview.timer);
  if ($('libgrid').classList.contains('scrolling')) return;
  preview.timer = setTimeout(() => startPreview(el, c), 120);
}
function startPreview(el, c) {
  stopPreview();
  if (!el.isConnected || $('library').classList.contains('away')) return;
  if (!c.size) return; // an empty file (a recorder claiming the name) has nothing to play
  const vid = h('video');
  vid.muted = true; vid.playsInline = true; vid.loop = true; vid.preload = 'auto';
  // Big clips are read from the drive as they play; the first time, the first frame shows up
  // well before the rest is buffered, so the picture would stall and jump. Wait until the
  // browser says it can keep playing, and only show the video once it has really drawn a few
  // frames in a row - until then the thumbnail stays up.
  vid.addEventListener('loadedmetadata', () => {
    if (preview.dragging) return; // the seek bar is being held; it decides where to start
    vid.currentTime = trimOf(c) ? trimOf(c).a : 0; // every hover starts from the beginning (of the trim)
    vid.playbackRate = trimOf(c) ? trimOf(c).s : 1; // and plays at the clip's speed
  }, { once: true });
  let started = false;
  const go = () => {
    if (started || preview.video !== vid || preview.dragging) return;
    started = true;
    vid.play().catch(() => { /* ignore */ });
    if (vid.requestVideoFrameCallback) {
      let frames = 0;
      const seen = () => { if (preview.video !== vid) return; if (++frames >= 3) vid.classList.add('on'); else vid.requestVideoFrameCallback(seen); };
      vid.requestVideoFrameCallback(seen);
    } else vid.addEventListener('playing', () => setTimeout(() => vid.classList.add('on'), 120), { once: true });
  };
  vid.addEventListener('canplaythrough', go);
  // some files never report "can play through" (long recordings on a slow drive); don't wait forever
  vid.addEventListener('canplay', () => setTimeout(go, 700));
  vid.src = c.url;
  el.insertBefore(vid, el.querySelector('.shade2'));
  preview.el = el; preview.video = vid;
  const fill = el.querySelector('.fill');
  const tick = () => {
    if (preview.video !== vid) { fill.style.width = '0'; return; }
    const t = trimOf(c);
    if (t && !preview.dragging && !vid.seeking && (vid.currentTime >= t.b || vid.currentTime < t.a - 0.3)) vid.currentTime = t.a; // loop the kept part
    const a = t ? t.a : 0, b = t ? t.b : vid.duration;
    if (vid.duration && !preview.dragging) fill.style.width = Math.min(100, Math.max(0, (vid.currentTime - a) / (b - a) * 100)) + '%';
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
// click or drag on the seek bar: while held, the preview pauses and only the knob follows the
// mouse; letting go jumps there once and plays on
function seekPreview(el, c, e) {
  const trk = el.querySelector('.trk'), fill = el.querySelector('.fill');
  if (preview.el !== el) startPreview(el, c);
  const vid = preview.video;
  if (!vid) return;
  let f = 0;
  const at = ev => {
    const r = trk.getBoundingClientRect();
    f = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    fill.style.width = (f * 100) + '%';
  };
  preview.dragging = true;
  el.classList.add('scrubbing');
  vid.pause();
  at(e);
  trk.setPointerCapture(e.pointerId);
  const move = ev => at(ev);
  const done = () => {
    trk.removeEventListener('pointermove', move);
    preview.dragging = false;
    el.classList.remove('scrubbing');
    if (preview.video !== vid) return;
    const go = () => { const t = trimOf(c); vid.currentTime = t ? t.a + f * (t.b - t.a) : f * vid.duration; vid.play().catch(() => { /* ignore */ }); vid.classList.add('on'); };
    if (vid.duration) go(); else vid.addEventListener('loadedmetadata', go, { once: true });
    if (!el.matches(':hover')) stopPreview(); // let go outside the card
  };
  trk.addEventListener('pointermove', move);
  trk.addEventListener('pointerup', done, { once: true });
  trk.addEventListener('pointercancel', done, { once: true });
}
function stopPreview() {
  clearTimeout(preview.timer);
  const vid = preview.video;
  if (vid) { vid.pause(); vid.removeAttribute('src'); vid.load(); vid.remove(); }
  preview.el = preview.video = null;
  preview.dragging = false;
}

// ---------- right-click menu ----------
// items: { icon, text, hint, run, cls, disabled } or { ..., sub: [items] } (opens to the side on hover) or '-'
function fillMenu(m, items) {
  m.replaceChildren();
  const checks = items.some(it => it && it.check !== undefined);
  for (const it of items) {
    if (it === '-') { m.append(h('div', 'msep')); continue; }
    const b = h('button', it.cls || '');
    if (checks) { const c = icoSpan(it.check ? 'check' : 'blank'); c.classList.add('mcheck'); b.append(c); }
    if (it.icon) b.append(icoSpan(it.icon));
    b.append(h('span', '', it.text));
    if (it.hint) b.append(h('span', 'mhint', it.hint));
    if (it.sub) { const c = icoSpan('back'); c.classList.add('flip', 'msub'); b.append(c); b.classList.add('hassub'); }
    if (it.disabled) b.disabled = true;
    if (it.sub) {
      const show = () => { for (const x of m.querySelectorAll('.hassub')) x.classList.toggle('subopen', x === b); openSub(b, it.sub); };
      b.addEventListener('mouseenter', show);
      b.onclick = show;
    } else {
      if (m.id === 'ctxmenu') b.addEventListener('mouseenter', () => { closeSub(); for (const x of m.querySelectorAll('.hassub')) x.classList.remove('subopen'); });
      b.onclick = () => { hideMenu(); it.run(); };
    }
    m.append(b);
  }
}
function openMenu(x, y, items, alignRight, forName) {
  stopPreview();
  closeSub();
  const m = $('ctxmenu');
  m.dataset.for = forName || ''; // set before measuring: some menus are narrower (CSS by data-for)
  fillMenu(m, items);
  m.hidden = false;
  const r = m.getBoundingClientRect();
  if (alignRight) x -= r.width;
  m.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
}
function openSub(btn, items) {
  let sm = $('ctxsub');
  if (!sm) { sm = h('div'); sm.id = 'ctxsub'; document.body.append(sm); }
  fillMenu(sm, items);
  sm.hidden = false;
  const r = btn.getBoundingClientRect(), mr = btn.parentElement.getBoundingClientRect(), w = sm.offsetWidth, ht = sm.offsetHeight;
  const x = mr.right - 2 + w > innerWidth - 8 ? mr.left - w + 2 : mr.right - 2; // right against the menu, like Spotify's
  sm.style.left = Math.max(8, x) + 'px';
  sm.style.top = Math.max(8, Math.min(r.top - 5, innerHeight - ht - 8)) + 'px';
}
function closeSub() { const sm = $('ctxsub'); if (sm) sm.hidden = true; }
function showMenu(x, y, c, el) {
  const many = L.sel.has(c.path) && L.sel.size > 1 ? selected() : null;
  if (many) {
    openMenu(x, y, [
      { icon: 'copy', text: `Copy ${many.length} Videos`, run: () => copyClips(many) },
      '-',
      { icon: 'trash', text: `Delete ${many.length} Videos`, run: () => trashClips(many), cls: 'danger' },
    ]);
    return;
  }
  openMenu(x, y, [
    { icon: 'copy', text: 'Copy Video', run: () => copyClips([c]) },
    { icon: 'scissors', text: 'Edit', run: () => openClip(c, el) },
    { icon: 'edit', text: 'Rename', run: () => renameClip(c) },
    '-',
    { icon: 'folder', text: 'Show in Folder', run: () => T.libAction('reveal', c.path) },
    '-',
    { icon: 'trash', text: 'Delete', run: () => trashClips([c]), cls: 'danger' },
  ]);
}
const MENU_BUTTONS = ['appmenu', 'libsort', 'gsortbtn', 'gpsort', 'qtsavemenu', 'qtcopymenu', 'qtmore']; // buttons that open a menu; clicking one again closes it
function hideMenu() { $('ctxmenu').hidden = true; closeSub(); for (const id of MENU_BUTTONS) { const b = $(id); if (b) b.classList.remove('open'); } }
// While any menu is open, a click outside it only closes it (like Discord): clicking the button that
// opened it closes it, and clicking a card doesn't also open the clip. Every menu goes through
// openMenu/#ctxmenu, so this covers all of them. A right-click elsewhere still opens that menu.
document.addEventListener('pointerdown', e => {
  const m = $('ctxmenu'), sub = $('ctxsub');
  if (m.hidden || m.contains(e.target) || (sub && sub.contains(e.target))) return;
  hideMenu();
  if (e.button !== 0) return;
  e.stopPropagation();
  const eat = ev => { ev.stopPropagation(); ev.preventDefault(); };
  window.addEventListener('click', eat, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', eat, true), 600);
}, true);
window.addEventListener('blur', hideMenu);

// ---------- rename (in the app; the file too with Settings > File names) ----------
async function renameClip(c) {
  const body = L.renameFiles ? 'The video file is renamed too (Settings > File names). The name is also used for exports and copies.'
    : 'The name is used in the app and for exports and copies. The file itself keeps its name (Settings > File names can change that).';
  const t = await promptBox({ title: 'Rename clip', body, value: c.title || '', placeholder: clipTitle({ date: c.date }), ok: 'Save' });
  if (t === null) return;
  setClipTitle(c, t);
}
async function setClipTitle(c, t) {
  const from = c.path;
  const r = await T.renameClip(from, t);
  if (!r.ok) return libToast(r.error, 'err');
  c.title = r.title;
  updateCardEdit(c);
  if (window.qtTitleChanged) window.qtTitleChanged(from, r.title);
  if (r.path && !samePathR(r.path, from)) clipMoved({ from, to: r.path, name: r.name, url: r.url });
}
// a clip's file was renamed (Settings > File names): everything that knows it by its path follows
function clipMoved({ from, to, name, url }) {
  const move = c => { if (c && samePathR(c.path, from)) { c.path = to; c.name = name; c.url = url; } };
  if (L.data) L.data.clips.forEach(move);
  if (window.qtClipMoved) window.qtClipMoved(from, to, move);
  if (L.thumbs.has(from)) { L.thumbs.set(to, L.thumbs.get(from)); L.thumbs.delete(from); }
  for (const set of [L.sel, L.opened]) if (set.has(from)) { set.delete(from); set.add(to); }
  if (V.els.has(from)) { V.els.get(from).remove(); V.els.delete(from); }
  if (L.data) renderGrid(false, true);
}
T.onClipMoved(clipMoved);
window.clipMovedHere = clipMoved;

// after deleting clips or a game folder (Recycle Bin or for good, per Settings)
function afterTrash(r, what) {
  if (!r.ok) { libToast(r.error, 'err'); return false; }
  if (r.cancelled) return false;
  const gone = new Set((r.trashed || []).map(p => p.toLowerCase()));
  const under = p => [...gone].some(g => p.toLowerCase() === g || p.toLowerCase().startsWith(g + '\\') || p.toLowerCase().startsWith(g + '/'));
  L.data.clips = L.data.clips.filter(c => !under(c.path));
  for (const p of [...L.sel]) if (under(p)) L.sel.delete(p);
  renderLibrary(true);
  showSel();
  if (r.failed && r.failed.length) libToast(`Couldn't delete: ${r.failed.join('; ')}`, 'err');
  else libToast(r.permanent ? `Deleted ${what}.` : `Moved ${what} to the Recycle Bin.`);
  return true;
}
// ---------- confirm before deleting (styled like Discord's) ----------

// a Discord-style dialog; with `value` it has a text box and resolves to its text (null = cancelled)
function confirmBox({ title, body, ok = 'Delete', danger = true, value, placeholder }) {
  return new Promise(resolve => {
    hideTip(); hideMenu();
    const ov = h('div', 'modal-ov'), box = h('div', 'modal');
    const x = h('button', 'modal-x'); x.append(icoSpan('x')); x.setAttribute('aria-label', 'Close');
    const row = h('div', 'modal-btns');
    const cancel = h('button', 'mbtn', 'Cancel'), go = h('button', 'mbtn ' + (danger ? 'danger' : 'primary'), ok);
    row.append(cancel, go);
    box.append(x, h('h2', '', title), h('p', '', body));
    let input = null;
    if (value !== undefined) {
      input = h('input', 'modal-in');
      input.type = 'text'; input.value = value; input.placeholder = placeholder || ''; input.spellcheck = false; input.maxLength = 120;
      box.append(input);
    }
    box.append(row);
    ov.append(box);
    document.body.append(ov);
    requestAnimationFrame(() => ov.classList.add('on'));
    const done = v => {
      document.removeEventListener('keydown', key, true);
      ov.classList.remove('on');
      setTimeout(() => ov.remove(), 160);
      resolve(input ? (v ? input.value : null) : v);
    };
    const key = e => {
      e.stopPropagation(); // the app's own shortcuts wait while this is open
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
      else if (e.key === 'Enter') { e.preventDefault(); done(true); }
    };
    document.addEventListener('keydown', key, true);
    cancel.onclick = () => done(false);
    x.onclick = () => done(false);
    go.onclick = () => done(true);
    ov.addEventListener('pointerdown', e => { if (e.target === ov && e.button === 0) done(false); });
    if (input) { input.focus(); input.select(); } else go.focus();
  });
}
const promptBox = o => confirmBox({ danger: false, ...o, value: o.value ?? '' });
// a question with several answers: buttons [{ text, value, cls }] left to right (the last one is
// the default for Enter); Esc, the x and clicking outside answer null
function choiceBox({ title, body, buttons }) {
  return new Promise(resolve => {
    hideTip(); hideMenu();
    const ov = h('div', 'modal-ov'), box = h('div', 'modal choice');
    const x = h('button', 'modal-x'); x.append(icoSpan('x')); x.setAttribute('aria-label', 'Close');
    const row = h('div', 'modal-btns n' + buttons.length);
    const done = v => { document.removeEventListener('keydown', key, true); ov.classList.remove('on'); setTimeout(() => ov.remove(), 160); resolve(v); };
    const els = buttons.map(b => { const el = h('button', 'mbtn ' + (b.cls || ''), b.text); el.onclick = () => done(b.value); row.append(el); return el; });
    const key = e => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
      else if (e.key === 'Enter' && document.activeElement && document.activeElement.parentElement !== row) { e.preventDefault(); done(buttons[buttons.length - 1].value); }
    };
    box.append(x, h('h2', '', title), h('p', '', body), row);
    ov.append(box); document.body.append(ov);
    requestAnimationFrame(() => ov.classList.add('on'));
    document.addEventListener('keydown', key, true);
    x.onclick = () => done(null);
    ov.addEventListener('pointerdown', e => { if (e.target === ov && e.button === 0) done(null); });
    els[els.length - 1].focus();
  });
}

async function trashClips(list) {
  if (!list.length) return;
  stopPreview();
  const n = list.length, size = fmtSize(list.reduce((s, c) => s + c.size, 0));
  if (!(await confirmBox({
    title: n === 1 ? 'Delete this clip?' : `Delete ${n} clips?`,
    body: L.deleteMode === 'delete'
      ? (n === 1 ? `The clip (${size}) will be permanently deleted.` : `${n} clips (${size}) will be permanently deleted.`)
      : (n === 1 ? `This moves the clip (${size}) to the Recycle Bin, so you can still get it back.` : `This moves ${n} clips (${size}) to the Recycle Bin, so you can still get them back.`),
  }))) return;
  const paths = list.map(c => c.path);
  if (window.qtCloseTabsFor) await window.qtCloseTabsFor(paths, []);
  afterTrash(await T.libTrash(paths, true), n === 1 ? 'the clip' : `${n} clips`);
}

// right-click a game in the sidebar: its folder(s), or (Discord, no folders) its clips
function gameMenu(e, g) {
  e.preventDefault();
  const clips = L.data.clips.filter(c => c.game === g.key && inFolders(c));
  const dirs = new Set();
  let loose = 0;
  for (const c of clips) {
    const root = String(c.root).replace(/[\\/]+$/, ''), sep = root.includes('\\') ? '\\' : '/';
    const parts = c.path.slice(root.length + 1).split(/[\\/]/);
    if (parts.length > 1) dirs.add(root + sep + parts[0]); else loose++;
  }
  const items = [];
  if (dirs.size) items.push({ icon: 'folder', text: dirs.size > 1 ? 'Open folders' : 'Open folder', run: () => { for (const d of dirs) T.libAction('reveal-folder', d); } });
  items.push({ icon: 'check', text: `Select all ${clips.length} clips`, run: () => {
    if (L.game !== g.key) { L.game = g.key; saveLibPrefs(); renderSide(); renderGrid(true); navCommit(); }
    selectAll();
  } });
  items.push('-');
  if (dirs.size && !loose) {
    items.push({ icon: 'trash', cls: 'danger', text: `Delete folder${dirs.size > 1 ? 's' : ''}`, run: async () => {
      const st = await T.libFolderStats([...dirs]);
      if (!st.ok) return libToast(st.error, 'err');
      const what = [`${st.videos} video${st.videos === 1 ? '' : 's'}`];
      if (st.other) what.push(`${st.other} other file${st.other === 1 ? '' : 's'} (screenshots and such)`);
      if (!(await confirmBox({
        title: `Delete the ${g.name} folder${dirs.size > 1 ? 's' : ''}?`,
        body: L.deleteMode === 'delete'
          ? `Everything in it will be permanently deleted: ${what.join(' and ')}, ${fmtSize(st.bytes)}.`
          : `Everything in it goes to the Recycle Bin: ${what.join(' and ')}, ${fmtSize(st.bytes)}. You can still get it back from there.`,
      }))) return;
      if (window.qtCloseTabsFor) await window.qtCloseTabsFor([], [...dirs]);
      if (afterTrash(await T.libTrashFolders([...dirs], g.name, true), `the ${g.name} folder${dirs.size > 1 ? 's' : ''}`) && L.game === g.key) {
        L.game = 'all'; saveLibPrefs(); renderSide(); renderGrid(true);
      }
    } });
  } else {
    items.push({ icon: 'trash', cls: 'danger', text: `Delete all ${clips.length} clips`, run: () => trashClips(clips) });
  }
  openMenu(e.clientX, e.clientY, items);
}

let toastTimer = null;
function libToast(text, cls) {
  const t = $('libtoast');
  t.textContent = text;
  t.className = 'show' + (cls ? ' ' + cls : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, cls === 'err' ? 7000 : 3500);
}

// ---------- toolbar ----------
let searchTimer = null;
$('libsearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { L.q = $('libsearch').value; if (L.data) renderGrid(true); }, 120);
});
// sort menu: a button like Discord's "Recent" that opens a small menu with a check on the current choice
const SORTS = [['new', 'Newest'], ['old', 'Oldest'], ['long', 'Longest'], ['big', 'Largest']];
$('libsort').onclick = e => {
  e.stopPropagation();
  const m = $('ctxmenu');
  if (!m.hidden && m.dataset.for === 'sort') { hideMenu(); return; }
  const r = $('libsort').getBoundingClientRect();
  openMenu(r.right, r.bottom + 6, SORTS.map(([k, label]) => ({
    icon: L.sort === k ? 'check' : 'blank', text: label, cls: L.sort === k ? 'cur' : '',
    run: () => { L.sort = k; saveLibPrefs(); renderGrid(true); },
  })).concat(L.sort === 'new' || L.sort === 'old' ? ['-', {
    icon: L.months ? 'check' : 'blank', text: 'Separate by month', cls: L.months ? 'cur' : '',
    run: () => { L.months = !L.months; saveLibPrefs(); renderGrid(); },
  }] : []), true);
  m.dataset.for = 'sort';
  $('libsort').classList.add('open');
};

// keys while the library is showing
function libKey(e) {
  const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (ctrl && k === 'f') { e.preventDefault(); $('libsearch').focus(); $('libsearch').select(); return true; }
  const typing = e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT';
  if (!typing && ctrl && k === 'a') { e.preventDefault(); selectAll(); return true; }
  if (!typing && k === 'delete') {
    e.preventDefault();
    if (L.sel.size) trashClips(selected());
    else if (document.activeElement && document.activeElement._clip) trashClips([document.activeElement._clip]);
    else if (preview.el) trashClips([preview.el._clip]);
    return true;
  }
  if (!typing && k === 'f2') {
    const c = (document.activeElement && document.activeElement._clip) || (preview.el && preview.el._clip);
    if (c) { e.preventDefault(); renameClip(c); return true; }
  }
  if (k === 'escape') {
    if (!$('ctxmenu').hidden) hideMenu();
    else if (L.sel.size) clearSel();
    else if ($('libsearch').value) { $('libsearch').value = ''; L.q = ''; renderGrid(true); }
    else if (L.game !== 'all') navInput(-1, true);
    return true;
  }
  return false;
}

// ---------- settings (an overlay over the library) ----------
const settingsOpen = () => !$('setov').hidden;
function openSettings() {
  hideMenu(); hideTip();
  const ov = $('setov');
  if (!ov.hidden) return;
  ov.hidden = false;
  requestAnimationFrame(() => ov.classList.add('on'));
  renderSettings();
}
function closeSettings() {
  const ov = $('setov');
  if (ov.hidden) return;
  ov.classList.remove('on');
  setTimeout(() => {
    if (!ov.classList.contains('on')) ov.hidden = true;
    if (L.pendingCard) { const d = L.pendingCard; L.pendingCard = null; reportCard(d); }
  }, 160);
  if (L.dirty) loadLibrary();
}
$('setclose').onclick = closeSettings;
$('setov').addEventListener('pointerdown', e => { if (e.target === $('setov') && e.button === 0) closeSettings(); });

async function renderSettings() {
  const r = await T.settingsGet();
  const box = $('setbody');
  box.replaceChildren();
  if (!r.ok) { box.append(h('div', 'setnote', r.error)); return; }
  const section = (title, note) => {
    const s = h('section', 'setsec');
    s.append(h('h3', '', title));
    if (note) s.append(h('p', 'setnote', note));
    box.append(s);
    return s;
  };
  const after = async fn => { const x = await fn(); if (x && !x.ok) libToast(x.error, 'err'); L.dirty = true; L.thumbs.clear(); renderSettings(); };

  // clip folders
  const fs = section('Clip folders', 'Where the library looks. NVIDIA and Discord folders are found automatically; removing one only hides it, nothing is deleted. You can also drop a folder onto the window to add it.');
  const list = h('div', 'setcard');
  for (const f of r.folders) {
    const row = h('div', 'setrow');
    const look = SRC_LOOK[f.kind];
    const txt = h('div', 'settext');
    const name = h('div', 'setname', srcLabel(f));
    if (f.missing) name.append(h('small', 'bad', '  not found'));
    txt.append(name, h('div', 'setpath', f.path));
    const open = h('button', 'btn sm ghost', 'Open');
    open.disabled = f.missing;
    open.onclick = async () => { const x = await T.libOpenFolder(f.path); if (!x.ok) libToast(x.error, 'err'); };
    const rm = h('button', 'btn sm ghost', 'Remove');
    rm.onclick = () => after(() => T.libRemoveFolder(f.path));
    row.append(iconAvatar(look.icon, look.color, look.img), txt, open, rm);
    list.append(row);
  }
  if (!r.folders.length) list.append(h('div', 'setnote pad', 'No folders yet.'));
  fs.append(list);
  const btns = h('div', 'setbtns');
  const add = h('button', 'btn sm'); add.append(icoSpan('plus'), document.createTextNode('Add folder'));
  add.onclick = async () => { await folderAdded(await T.libAddFolder()); L.thumbs.clear(); renderSettings(); };
  btns.append(add);
  if (r.custom && r.detected.length) {
    const reset = h('button', 'btn sm ghost', 'Use the detected folders');
    reset.title = r.detected.join('\n');
    reset.onclick = () => after(() => T.libResetFolders());
    btns.append(reset);
  }
  fs.append(btns);

  // file names: Rename and Replace original can rename the file itself (off by default)
  const fns = section('File names', 'Exports are saved next to the clip they come from. Names you give clips are used for exports and copies.');
  const fnc = h('div', 'setcard');
  for (const [id, name, note] of [[false, 'Keep the original file names', 'Renaming a clip only changes its name in Backstage.'],
    [true, 'Rename the files too', 'Renaming a clip, or using Replace original on a named clip, renames the video file too, so you can find it outside Backstage. A clip open in the editor is renamed when you leave it.']]) {
    const row = h('button', 'setrow setopt' + (r.renameFiles === id ? ' on' : ''));
    const t = h('div', 'settext'); t.append(h('div', 'setname', name), h('div', 'setpath wrap', note));
    row.append(h('span', 'radio'), t);
    row.onclick = async () => { if (r.renameFiles === id) return; await T.settingsSet({ renameFiles: id }); L.renameFiles = id; renderSettings(); };
    fnc.append(row);
  }
  fns.append(fnc);

  // Discord account
  const ds = section('Your Discord account', 'Used to label your own voice "You" in Discord clips. Found automatically from the clips you saved; set it here if it picks the wrong person.');
  const card = h('div', 'setcard');
  const row = h('div', 'setrow');
  const txt = h('div', 'settext');
  const cur = r.discordIdManual || r.discordIdDetected;
  txt.append(h('div', 'setname', cur ? `User ID ${cur}` : 'Not found yet'),
    h('div', 'setpath', r.discordIdManual ? 'Set by you' : r.discordIdDetected ? 'Detected from your clips' : 'Open a few Discord clips or add your Discord clips folder'));
  const input = h('input', 'setinput');
  input.placeholder = 'Discord user ID';
  input.value = r.discordIdManual || '';
  input.spellcheck = false;
  const save = h('button', 'btn sm', 'Save');
  save.onclick = () => after(() => T.settingsSet({ discordIdManual: input.value }));
  input.addEventListener('keydown', e => { if (e.key === 'Enter') save.click(); });
  row.append(txt, input, save);
  if (r.discordIdManual) {
    const auto = h('button', 'btn sm ghost', 'Use detected');
    auto.onclick = () => after(() => T.settingsSet({ discordIdManual: null }));
    row.append(auto);
  }
  card.append(row);
  ds.append(card);

  // deleting
  L.deleteMode = r.deleteMode;
  const dls = section('Deleting', 'What Delete does with clips and game folders. You are always asked first.');
  const dlc = h('div', 'setcard');
  for (const [id, name, note] of [['recycle', 'Move to the Recycle Bin', 'You can still get them back from the Recycle Bin.'], ['delete', 'Delete permanently', 'Gone right away, and the space is freed. They can\'t be brought back.']]) {
    const row = h('button', 'setrow setopt' + (r.deleteMode === id ? ' on' : ''));
    const t = h('div', 'settext'); t.append(h('div', 'setname', name), h('div', 'setpath wrap', note));
    row.append(h('span', 'radio'), t);
    row.onclick = async () => { if (r.deleteMode === id) return; await T.settingsSet({ deleteMode: id }); renderSettings(); };
    dlc.append(row);
  }
  dls.append(dlc);

  // saving edits made in the editor's Edit view (Trim always saves as you go)
  L.editSave = r.editSave;
  const svs = section('Saving edits', 'How changes made in Edit are kept. Trims made in Trim always save as you go.');
  const esc = h('div', 'setcard');
  for (const [id, name, note] of [['manual', 'Save Changes or Cancel', 'Edit has Cancel and Save Changes buttons, and asks before leaving with unsaved changes.'], ['auto', 'Save automatically', 'Changes save as you make them; Edit just has Back to Trim.']]) {
    const row = h('button', 'setrow setopt' + (r.editSave === id ? ' on' : ''));
    const t = h('div', 'settext'); t.append(h('div', 'setname', name), h('div', 'setpath wrap', note));
    row.append(h('span', 'radio'), t);
    row.onclick = async () => { if (r.editSave === id) return; await T.settingsSet({ editSave: id }); L.editSave = id; if (window.qtSaveModeChanged) window.qtSaveModeChanged(); renderSettings(); };
    esc.append(row);
  }
  svs.append(esc);

  // updates
  const us = section('Updates', 'New versions come from the GitHub releases page.');
  const uc = h('div', 'setcard');
  const modes = [['ask', 'Ask first', 'Tells you when there is an update and shows what changed. Nothing downloads until you click Download.'],
    ['auto', 'Automatic', 'Downloads updates in the background and installs them the next time the app restarts.'],
    ['off', 'Off', "Doesn't check by itself. Use Help > Check for Updates."]];
  for (const [id, name, note] of modes) {
    const row = h('button', 'setrow setopt' + (r.updateMode === id ? ' on' : ''));
    const dot = h('span', 'radio');
    const t = h('div', 'settext'); t.append(h('div', 'setname', name), h('div', 'setpath wrap', note));
    row.append(dot, t);
    row.onclick = async () => { if (r.updateMode === id) return; await T.settingsSet({ updateMode: id }); renderSettings(); };
    uc.append(row);
  }
  const vrow = h('div', 'setrow');
  vrow.append(h('div', 'settext', `Version ${r.version}`));
  const chk = h('button', 'btn sm ghost', 'Check now'); chk.onclick = () => { closeSettings(); checkUpdates(); };
  const log = h('button', 'btn sm ghost', 'Changelog'); log.onclick = () => changelogBox();
  vrow.append(chk, log);
  uc.append(vrow);
  us.append(uc);

  // thumbnails
  const ts = section('Thumbnails', 'Previews for the library are saved so they load instantly. Clearing them is safe; they get made again as you scroll.');
  const tc = h('div', 'setcard');
  const trow = h('div', 'setrow');
  trow.append(h('div', 'settext', `${r.cache.files} files  ·  ${fmtSize(r.cache.bytes)}`));
  const clear = h('button', 'btn sm ghost', 'Clear');
  clear.onclick = () => after(() => T.thumbsClear());
  trow.append(clear);
  tc.append(trow);
  ts.append(tc);

  // empty folders
  const es = section('Empty folders', 'NVIDIA makes a folder for every game it sees, even if you never saved a clip. Folders with no files at all can go.');
  const ec = h('div', 'setcard');
  const erow = h('div', 'setrow');
  const etxt = h('div', 'settext', 'Checking...');
  erow.append(etxt);
  ec.append(erow);
  es.append(ec);
  T.libEmptyFolders().then(x => {
    const list = (x.ok && x.folders) || [];
    etxt.replaceChildren(h('div', 'setname', list.length ? `${list.length} empty folder${list.length === 1 ? '' : 's'}` : 'No empty folders'));
    if (list.length) {
      etxt.append(h('div', 'setpath wrap', list.map(folderName).join(', ')));
      const b = h('button', 'btn sm ghost', 'Delete');
      b.onclick = async () => {
        if (!(await confirmBox({
          title: `Delete ${list.length} empty folder${list.length === 1 ? '' : 's'}?`,
          body: `${list.map(folderName).join(', ')}. There are no files in them, and NVIDIA makes them again if you record that game.`,
        }))) return;
        const y = await T.libTrashEmpty(true);
        if (!y.ok) libToast(y.error, 'err');
        else {
          libToast(y.failed.length ? `Deleted ${y.deleted.length}. Skipped (not empty any more): ${y.failed.join(', ')}` : `Deleted ${y.deleted.length} empty folder${y.deleted.length === 1 ? '' : 's'}.`, y.failed.length ? 'err' : '');
          L.dirty = true; renderSettings();
        }
      };
      erow.append(b);
    }
  });

  // help add recording software (optional)
  const rs = section('Help add recording software', "Optional. If the app didn't find your recording software's folder by itself, you can send how that software stores its clips, so a later version finds it automatically for everyone. You'll see exactly what's sent before anything goes out.");
  const rc = h('div', 'setcard');
  const rrow = h('div', 'setrow');
  rrow.append(h('div', 'settext', 'Looking at your folders...'));
  rc.append(rrow);
  rs.append(rc);
  T.reportFolders().then(x => {
    rc.replaceChildren();
    const list = (x.ok && x.folders) || [];
    if (!list.length) { const row = h('div', 'setrow'); const t = h('div', 'settext'); t.append(h('div', 'setpath wrap', 'Add your recording software\'s folder first (Folders > Add folder in the sidebar).')); row.append(t); rc.append(row); return; }
    for (const f of list) {
      const row = h('div', 'setrow');
      const t = h('div', 'settext'); t.append(h('div', 'setname', f.guess || folderName(f.path)), h('div', 'setpath', f.path));
      const b = h('button', 'btn sm ' + (f.reported ? 'ghost' : ''), f.reported ? 'Sent · send again' : 'Send info...');
      b.onclick = () => reportBox(f.path);
      row.append(iconAvatar('folder', '#4e5058'), t, b);
      rc.append(row);
    }
  });

  box.append(h('p', 'setnote ver', `${T.appName} ${r.version}`));
}

// ---------- start ----------
loadLibrary();
navCommit();

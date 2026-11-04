const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, net, screen, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { pathToFileURL } = require('url');

let FFMPEG = null;
try {
  FFMPEG = require('ffmpeg-static');
  if (FFMPEG) FFMPEG = FFMPEG.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
} catch (e) { /* fall back to PATH below */ }
if (!FFMPEG || !fs.existsSync(FFMPEG)) FFMPEG = 'ffmpeg';
if (process.env.BACKSTAGE_FFMPEG) FFMPEG = process.env.BACKSTAGE_FFMPEG; // tests: the Linux build can't read MPEG-TS
const smartcut = require('./smartcut.js');

const VIDEO_EXT = ['mp4', 'mkv', 'mov', 'webm', 'avi', 'flv', 'ts', 'm4v'];

const state = { outputs: new Set(), child: null, kids: new Set(), cancelled: false };

// ---------- the app's log (userData/logs/app.log): what went wrong, for problem reports ----------
const logFile = () => path.join(app.getPath('userData'), 'logs', 'app.log');
function log(...a) {
  try {
    const f = logFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    try { if (fs.statSync(f).size > 1 << 20) fs.renameSync(f, f + '.old'); } catch (e) { /* new file */ }
    const text = a.map(x => (typeof x === 'string' ? x : x instanceof Error ? x.stack || x.message : JSON.stringify(x))).join(' ');
    fs.appendFileSync(f, `${new Date().toISOString()} ${text.slice(0, 4000)}\n`);
  } catch (e) { /* never let logging break anything */ }
}
function logTail(n) {
  try {
    const f = logFile(), st = fs.statSync(f), len = Math.min(st.size, 256 * 1024), b = Buffer.alloc(len);
    const fd = fs.openSync(f, 'r'); fs.readSync(fd, b, 0, len, st.size - len); fs.closeSync(fd);
    return b.toString('utf8').split('\n').slice(-n - 1).join('\n').trim();
  } catch (e) { return ''; }
}
process.on('uncaughtException', e => log('error (main):', e));
process.on('unhandledRejection', e => log('error (main, promise):', e));
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
// video files opened from outside the clip folders (Open file, drag and drop, paste); the overlay
// may read and export these too
const opened = new Set();
let win = null;
const IS_WIN = process.platform === 'win32';
// Chromium skips drawing pictures it hasn't decoded yet while you scroll and fills them in a
// moment later, which made cards flash blank. Decode them as they're drawn instead.
app.commandLine.appendSwitch('disable-checker-imaging');
// The app's name comes from package.json (productName). Names it used to have (newest first), so a
// rename keeps everyone's settings, caches and trimmed-clips folder.
const APP_NAME = app.getName();
const OLD_NAMES = ['Clip Editor', 'Clip Trimmer'].filter(n => n !== APP_NAME);
(function keepOldData() {
  // After a rename, bring the old name's settings, trims, clip names, thumbnails and library
  // choices over once. Moving the folder is quickest; if the new one already exists (or the old app
  // still had files open), the files are copied instead.
  try {
    const now = app.getPath('userData'), mark = path.join(now, '.migrated');
    if (fs.existsSync(mark)) return;
    for (const n of OLD_NAMES) {
      const old = path.join(app.getPath('appData'), n);
      if (!fs.existsSync(path.join(old, 'settings.json'))) continue;
      if (!fs.existsSync(now)) {
        try { fs.renameSync(old, now); fs.writeFileSync(mark, n); return; } catch (e) { /* copy instead */ }
      }
      fs.mkdirSync(now, { recursive: true });
      for (const f of ['settings.json', 'edits.json', 'names.json', 'people.json', 'games.json', 'thumbs', 'icons', 'Local Storage']) {
        const src = path.join(old, f);
        if (fs.existsSync(src)) { try { fs.cpSync(src, path.join(now, f), { recursive: true, force: true }); } catch (e) { /* skip that one */ } }
      }
      fs.writeFileSync(mark, n);
      return;
    }
    if (fs.existsSync(now)) fs.writeFileSync(mark, '');
  } catch (e) { /* start fresh */ }
})();
const copyDir = () => path.join(app.getPath('temp'), APP_NAME);

// ---------- clipboard (files) ----------

// One PowerShell kept running for clipboard work: starting a new one costs about half a second
// per copy. Commands go in one line at a time; each answer ends with a marker line.
let ps = null;
function psStart() {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command',
    "$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8; while ($true) { $l = [Console]::In.ReadLine(); if ($l -eq $null) { break }; try { Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($l))) | Out-String -Width 4096 | Write-Output } catch { Write-Output '' }; Write-Output '<<END>>' }"],
  { windowsHide: true });
  const p = { child, buf: '', queue: [] };
  child.stdout.on('data', d => {
    p.buf += d.toString('utf8');
    let i;
    while ((i = p.buf.indexOf('<<END>>')) >= 0) {
      const out = p.buf.slice(0, i);
      p.buf = p.buf.slice(i + 7).replace(/^\r?\n/, '');
      const job = p.queue.shift();
      if (job) { clearTimeout(job.timer); job.resolve(out.trim()); }
    }
  });
  const dead = () => { if (ps === p) ps = null; for (const j of p.queue.splice(0)) { clearTimeout(j.timer); j.resolve(null); } };
  child.on('error', dead);
  child.on('close', dead);
  return p;
}
function powershell(cmd) {
  return new Promise(resolve => {
    try {
      if (!ps) ps = psStart();
      const p = ps;
      const job = { resolve, timer: setTimeout(() => { try { p.child.kill(); } catch (e) { /* ignore */ } }, 15000) };
      p.queue.push(job);
      p.child.stdin.write(Buffer.from(cmd, 'utf8').toString('base64') + '\n');
    } catch (e) { resolve(null); }
  });
}
// started a few seconds after launch so the first copy is quick too
app.whenReady().then(() => setTimeout(() => { if (IS_WIN && !ps) ps = psStart(); }, 4000));
app.on('will-quit', () => {
  // renames waiting for the editor to let go of a clip, then the saved edits (written a moment later otherwise)
  for (const j of [...pendingNames.values()]) { qtFiles.delete(editKey(j.p)); closeFd(j.p); renamePending(j.p); }
  if (editsTimer) { clearTimeout(editsTimer); try { fs.writeFileSync(editsFile(), JSON.stringify(allEdits())); } catch (e) { /* ignore */ } }
  if (ps) { try { ps.child.stdin.end(); ps.child.kill(); } catch (e) { /* ignore */ } }
});
const psQuote = s => "'" + String(s).replace(/'/g, "''") + "'";

// Put a file on the clipboard the same way Explorer's Ctrl+C does, so Discord can paste it.
async function copyFileToClipboard(p) {
  const list = Array.isArray(p) ? p : [p];
  if (IS_WIN) {
    const r = await powershell(`Set-Clipboard -LiteralPath ${list.map(psQuote).join(',')}; (Get-Clipboard -Format FileDropList | Select-Object -First 1).FullName`);
    if (!r || !list.some(x => path.resolve(r).toLowerCase() === path.resolve(x).toLowerCase())) throw new Error("Couldn't put the clip on the clipboard.");
    return;
  }
  clipboard.writeText(list.join('\n'));
}

// Path of a file copied in Explorer, or a path copied as text. Tries each source and
// returns the first one that is an existing file.
async function clipboardPath() {
  const isFile = p => { try { return !!p && fs.statSync(cleanPath(p)).isFile(); } catch (e) { return false; } };
  if (IS_WIN) {
    try {
      const buf = await clipboard.readBuffer('FileNameW');
      const p = buf && buf.length ? Buffer.from(buf).toString('ucs2').replace(/\0[\s\S]*$/, '') : '';
      if (isFile(p)) return p;
    } catch (e) { /* ignore */ }
    const p = await powershell('(Get-Clipboard -Format FileDropList | Select-Object -First 1).FullName');
    if (isFile(p)) return p;
  }
  const t = String((await clipboard.readText()) || '').trim().split(/\r?\n/)[0];
  return isFile(t) ? cleanPath(t) : '';
}

// Copies made for the clipboard live in temp; clear out ones older than a day.
function cleanCopies() {
  try {
    for (const d of fs.readdirSync(copyDir())) {
      const full = path.join(copyDir(), d);
      if (Date.now() - fs.statSync(full).mtimeMs > 24 * 3600 * 1000) fs.rmSync(full, { recursive: true, force: true });
    }
  } catch (e) { /* folder may not exist yet */ }
}

// ---------- ffmpeg helpers ----------

// Reads ffmpeg's own description of a file (no ffprobe needed).
function ffInfo(file) {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, ['-hide_banner', '-i', file], { windowsHide: true, maxBuffer: 1 << 22 }, (err, _out, stderr) => {
      if (err && err.code === 'ENOENT') return reject(new Error('ffmpeg was not found.'));
      const s = String(stderr || '');
      const dm = s.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      const duration = dm ? (+dm[1]) * 3600 + (+dm[2]) * 60 + parseFloat(dm[3]) : 0;
      let video = null, cur = null, comment = '', seenStream = false;
      const audio = [];
      for (const l of s.split(/\r?\n/)) {
        const sm = l.match(/^\s*Stream #0:\d+.*?: (Video|Audio|Subtitle|Data|Attachment): (.*)$/);
        if (!seenStream && !sm) { const cm = l.match(/^\s+comment\s*:\s*(.+?)\s*$/); if (cm) comment = cm[1]; }
        if (sm) {
          seenStream = true;
          cur = null;
          if (sm[1] === 'Video' && !video && !/attached pic/.test(l)) video = sm[2];
          if (sm[1] === 'Audio') {
            cur = { codec: (sm[2].match(/^(\w+)/) || [])[1] || '?', channels: ((sm[2].match(/\d+ Hz, ([^,]+)/) || [])[1] || '').trim(), title: '' };
            audio.push(cur);
          }
          continue;
        }
        const t = cur && l.match(/^\s+(title|handler_name)\s*:\s*(.+?)\s*$/);
        if (t) cur[t[1] === 'title' ? 'title' : 'handler'] = t[2];
      }
      resolve({ duration, video, audio, comment });
    });
  });
}

async function probeVideo(file) {
  const { duration, video, audio, comment } = await ffInfo(file);
  if (!video) throw new Error('No video stream found in that file.');
  const res = video.match(/,\s*(\d{2,5})x(\d{2,5})/);
  const f = video.match(/(\d+(?:\.\d+)?)\s*fps/) || video.match(/(\d+(?:\.\d+)?)\s*tbr/);
  let fps = f ? parseFloat(f[1]) : 30;
  if (!(fps >= 1 && fps <= 480)) fps = 30;
  // Discord clips label each audio track "<user id>:<kind>": all (full mix), application,
  // voice (one per person), soundboard, all_copy (duplicate of all)
  for (const a of audio) {
    const m = (a.handler || '').match(/^(\d+):([a-z_]+)$/);
    if (m) { a.kind = m[2]; a.user = m[1]; }
  }
  const discord = audio.length > 1 && audio.every(a => a.kind) && audio.some(a => a.kind === 'all');
  // Discord's clip info lists who was in the call, starting with whoever saved the clip
  let owner = null, users = [];
  if (discord) {
    const meta = await readDiscordMeta(file, fs.statSync(file).size);
    if (meta && Array.isArray(meta.users)) users = meta.users.map(String);
    // "You" is whoever saved most of the Discord clips on this PC (learned by the library);
    // until that's known, whoever saved this one
    const st = readSettings();
    owner = st.discordIdManual || st.discordId || users[0] || null;
  }
  // Encore recordings: tracks named in handler_name (Full mix, Microphone, Desktop audio, one per app).
  // Marked with comment "rec-format:N"; the track names alone also identify them (the marker is lost
  // when a file is re-saved by another tool).
  const encore = !discord ? encoreLayout(audio, comment) : null;
  // NVIDIA's own captures ("separate both tracks" gives game audio, then the mic)
  const nvidia = !discord && !encore && (NV_DATE.test(path.basename(file)) || audio.some(a => /^SoundHandle$/.test(a.handler || '')));
  return {
    discord, owner, users, nvidia, encore, videoLine: video,
    name: path.basename(file),
    url: pathToFileURL(file).href,
    codec: (video.match(/^(\w+)/) || [])[1] || '?',
    width: res ? +res[1] : null,
    height: res ? +res[2] : null,
    fps: Math.round(fps * 1000) / 1000,
    duration,
    size: fs.statSync(file).size,
    audio,
  };
}

const cleanPath = p => String(p || '').trim().replace(/^"(.*)"$/, '$1');

// The bundled Windows ffmpeg has no software AV1 decoder (NVIDIA's AV1 recordings fail with
// "Bitstream not supported"), but it can decode AV1 on the graphics card - and any PC that
// records AV1 has a card that can decode it.
const av1In = codec => (IS_WIN && /^av1/i.test(codec || '') ? ['-hwaccel', 'd3d11va', '-c:v', 'av1'] : []);

// tracks: audio track numbers to draw (mixed together); default the first
function waveform(file, dur, buckets, tracks) {
  return new Promise(resolve => {
    const rate = 2000;
    const total = Math.max(1, dur * rate);
    const peaks = new Array(buckets).fill(0);
    let idx = 0, leftover = null;
    const t = Array.isArray(tracks) && tracks.length ? tracks.filter(i => Number.isInteger(i) && i >= 0) : [0];
    const pick = t.length > 1
      ? ['-filter_complex', t.map(i => `[0:a:${i}]`).join('') + `amix=inputs=${t.length}:duration=longest:normalize=0[w]`, '-map', '[w]']
      : ['-map', `0:a:${t[0] || 0}`];
    const c = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, ...pick, '-vn',
      '-ac', '1', '-ar', String(rate), '-f', 's16le', '-'], { windowsHide: true });
    c.stdout.on('data', d => {
      if (leftover) { d = Buffer.concat([leftover, d]); leftover = null; }
      if (d.length & 1) { leftover = d.subarray(d.length - 1); d = d.subarray(0, d.length - 1); }
      // each sample goes to the bucket for its moment in the clip, so the peaks always span the
      // whole width (rounding the bucket size up used to leave the last few empty)
      for (let i = 0; i < d.length; i += 2) {
        const v = Math.abs(d.readInt16LE(i));
        const b = Math.min(buckets - 1, Math.floor(idx++ * buckets / total));
        if (v > peaks[b]) peaks[b] = v;
      }
    });
    c.on('error', () => resolve(null));
    c.on('close', () => {
      const top = Math.max(1, ...peaks);
      resolve(peaks.map(p => Math.round(p / top * 1000) / 1000));
    });
  });
}

// a free file name in `dir`: "name.ext", then "name (2).ext", ...
function freeName(dir, name, ext) {
  let out = path.join(dir, name + ext);
  for (let n = 2; fs.existsSync(out); n++) out = path.join(dir, `${name} (${n})${ext}`);
  return out;
}

function runFfmpeg(args, length, onProgress, job = state) {
  return new Promise(resolve => {
    const tail = [];
    const child = spawn(FFMPEG, args, { windowsHide: true });
    job.child = child;
    (job.kids || (job.kids = new Set())).add(child);
    let buf = '';
    child.stdout.on('data', d => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) {
        const m = l.match(/^out_time_(?:us|ms)=(\d+)/);
        if (m && length > 0 && onProgress) onProgress(Math.min(1, (+m[1] / 1e6) / length));
      }
    });
    child.stderr.on('data', d => {
      tail.push(...d.toString().split(/\r?\n/).filter(Boolean));
      if (tail.length > 8) tail.splice(0, tail.length - 8);
    });
    child.on('error', e => { job.child = null; job.kids.delete(child); resolve({ ok: false, err: [e.message] }); });
    child.on('close', code => {
      job.child = null;
      job.kids.delete(child);
      if (code !== 0 && !job.cancelled) log(`ffmpeg failed (exit ${code}):`, tail.join(' | '), '| args:', args.filter(x => !String(x).includes(path.sep)).join(' ').slice(0, 1500));
      resolve({ ok: code === 0 && !job.cancelled, err: tail, cancelled: job.cancelled });
    });
  });
}

// ---------- quick trim (the overlay over the library) ----------
// Trims and audio settings are remembered per clip, like Discord: the clip itself is never
// changed, and a file is only made when you copy or save.
const editsFile = () => path.join(app.getPath('userData'), 'edits.json');
let edits = null, editsTimer = null;
const editKey = p => path.resolve(p).toLowerCase();
function allEdits() {
  if (!edits) { try { edits = JSON.parse(fs.readFileSync(editsFile(), 'utf8')) || {}; } catch (e) { edits = {}; } }
  return edits;
}
const editFor = p => allEdits()[editKey(p)] || null;
function setEdit(p, e) {
  const all = allEdits();
  if (e) all[editKey(p)] = { ...e, at: Date.now() }; else delete all[editKey(p)];
  clearTimeout(editsTimer);
  editsTimer = setTimeout(() => { editsTimer = null; try { fs.writeFileSync(editsFile(), JSON.stringify(all)); } catch (err) { /* ignore */ } }, 300);
}
const qtFiles = new Set(); // clips open in the overlay; their bytes can be read by the player

// Encoding on the graphics card when there is one (NVIDIA, AMD or Intel), else the CPU. Checked
// once with a tiny test encode, since an encoder can be listed but not work on this PC.
let videoEnc = null;
function encoderWorks(args) {
  return new Promise(resolve => {
    const c = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=0.5',
      ...args, '-f', 'null', '-'], { windowsHide: true });
    const t = setTimeout(() => { try { c.kill(); } catch (e) { /* ignore */ } resolve(false); }, 10000);
    c.on('error', () => { clearTimeout(t); resolve(false); });
    c.on('close', code => { clearTimeout(t); resolve(code === 0); });
  });
}
const rateArgs = k => ['-b:v', `${k}k`, '-maxrate', `${Math.round(k * 1.5)}k`, '-bufsize', `${k * 2}k`];
const ENCODERS = [
  // p3: measured on a 1440p60 clip, 25% faster than p4 at practically the same quality (SSIM .978 vs .979)
  ['h264_nvenc', k => ['-c:v', 'h264_nvenc', '-preset', 'p3', '-tune', 'hq', '-rc', 'vbr', ...rateArgs(k), '-pix_fmt', 'yuv420p']],
  ['h264_amf', k => ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'vbr_peak', ...rateArgs(k), '-pix_fmt', 'yuv420p']],
  ['h264_qsv', k => ['-c:v', 'h264_qsv', '-preset', 'medium', ...rateArgs(k), '-pix_fmt', 'nv12']],
];
const X264 = () => ['-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'];
async function pickEncoder() {
  if (videoEnc) return videoEnc;
  for (const [name, args] of ENCODERS) if (await encoderWorks(args(2000))) return (videoEnc = { name, args });
  return (videoEnc = { name: 'libx264', args: X264 });
}

// About the same bitrate as the original: the trim looks the same and stays about the same size per second
function sourceKbps(info) {
  const m = String(info.videoLine || '').match(/(\d+) kb\/s/);
  const k = m ? +m[1] : (info.size && info.duration ? info.size * 8 / info.duration / 1000 * 0.92 : 12000);
  return Math.round(Math.min(60000, Math.max(2000, k)));
}

// ---------- audio rows ----------
// Encore's file contract (marker rec-format:N): audio tracks are named in handler_name.
//  N=2 (Encore 0.4.1+) and files from 0.4.0: "Full mix" = everything incl. the mic, "Microphone",
//  "Desktop audio" (system sound without the mic, only when a mic was recorded), then one per app.
//  Older files (0.3.x, marker 1, no "Desktop audio" track): "Full mix" does NOT include the mic.
const ENCORE_RESERVED = ['full mix', 'microphone', 'desktop audio'];
function encoreLayout(audio, comment) {
  if (!audio || audio.length < 2) return null;
  const names = audio.map(a => (a.handler || '').trim().toLowerCase());
  const m = String(comment || '').match(/rec-format:(\d+)/i);
  if (!m && names[0] !== 'full mix') return null;
  const format = m ? +m[1] : 1;
  const at = n => names.indexOf(n);
  const full = at('full mix'), mic = at('microphone'), desktop = at('desktop audio');
  const apps = names.map((n, i) => (n && !ENCORE_RESERVED.includes(n) ? i : -1)).filter(i => i >= 0);
  // the old layout's Full mix lacks the mic: an untouched export has to add it back
  const old = format < 2 && mic >= 0 && desktop < 0;
  return { format, full, mic, desktop, apps, old };
}
// Discord clips carry each source separately (the game/app, one voice track per person, the
// soundboard) plus a full mix; NVIDIA's "separate tracks" recordings have the game, then the mic.
// Each row ("group") is one or more audio tracks with its own mute and volume.
function audioGroups(info) {
  const a = info.audio || [];
  if (!a.length) return [];
  const g = (key, name, icon, idx, extra) => ({ key, name, icon, idx, ...extra });
  if (info.discord) {
    const of = test => a.map((x, i) => (test(x) ? i : -1)).filter(i => i >= 0);
    const out = [];
    const game = of(x => x.kind === 'application' || !['all', 'all_copy', 'voice', 'soundboard'].includes(x.kind));
    if (game.length) out.push(g('game', 'Game / Desktop', 'gamepad', game));
    // one row per person: you first, then everyone else in the order Discord stored them
    const people = allPeople(), me = info.owner;
    const voices = of(x => x.kind === 'voice').sort((x, y) => (a[y].user === me) - (a[x].user === me) || x - y);
    let n = me && voices.some(i => a[i].user === me) ? 1 : 0;
    for (const i of voices) {
      const u = a[i].user, mine = !!me && u === me;
      out.push(g('v:' + u, mine ? 'You' : people[u] || `Person ${++n}`, 'mic', [i], { user: u, me: mine, named: !mine && !!people[u] }));
    }
    const sb = of(x => x.kind === 'soundboard');
    if (sb.length) out.push(g('sb', 'Soundboard', 'music', sb));
    if (out.length) return out;
    return [g('audio', 'Audio', 'speaker', [Math.max(0, a.findIndex(x => x.kind === 'all'))])];
  }
  if (a.length === 1) return [g('audio', 'Audio', 'speaker', [0])];
  if (info.encore) {
    // one row per track except Full mix (it already contains the rest); Desktop audio only when
    // there are no per-app tracks. Never mixed with the others.
    const E = info.encore, out = [];
    if (E.mic >= 0) out.push(g('e:microphone', 'Microphone', 'mic', [E.mic]));
    for (const i of E.apps) out.push(g('e:' + a[i].handler.trim().toLowerCase(), a[i].handler.trim(), 'speaker', [i]));
    if (E.desktop >= 0 && !E.apps.length) out.push(g('e:desktop audio', 'Desktop audio', 'speaker', [E.desktop]));
    return out.length ? out : [g('audio', 'Audio', 'speaker', [Math.max(0, E.full)])];
  }
  const mic = a.map((x, i) => i).filter(i => i > 0 && (info.nvidia || /\b(mic|microphone|voice|commentary)\b/i.test(a[i].title || '') || a.length === 2));
  const game = a.map((x, i) => i).filter(i => !mic.includes(i));
  return [g('game', 'Game / Desktop', 'gamepad', game), g('voice', 'Microphone', 'mic', mic)].filter(x => x.idx.length);
}
// a group's saved mute/volume (Discord voices saved before there was a row per person used 'voice')
function savedFor(g, audio) {
  const s = (audio || {})[g.key] || (g.key.startsWith('v:') ? (audio || {}).voice : null);
  return { mute: !!(s && s.mute), vol: s ? Math.min(2, Math.max(0, +s.vol || 0)) : 1 };
}
// what goes into the exported file: an untouched Discord clip keeps Discord's own full mix
function sourcesFor(info, audio) {
  const groups = audioGroups(info).map(g => ({ ...g, ...savedFor(g, audio) }));
  const untouched = groups.every(g => !g.mute && Math.abs(g.vol - 1) < 0.001);
  if (info.discord && untouched) { const all = (info.audio || []).findIndex(x => x.kind === 'all'); if (all >= 0) return [{ index: all, gain: 1 }]; }
  // an untouched Encore clip keeps its own Full mix (plus the mic for files whose Full mix lacks it)
  if (info.encore && untouched && info.encore.full >= 0) {
    const E = info.encore;
    return [{ index: E.full, gain: 1 }, ...(E.old ? [{ index: E.mic, gain: 1 }] : [])];
  }
  return groups.filter(g => !g.mute && g.vol > 0.001).flatMap(g => g.idx.map(i => ({ index: i, gain: g.vol })));
}

// ---------- names (only inside the app; files are never renamed) ----------
// Tied to the clip itself rather than its path, so a name survives the file being moved or renamed:
// Discord clips by when they were made and who saved them, others by size and modified time.
const jsonStore = file => {
  let data = null, timer = null;
  const f = () => path.join(app.getPath('userData'), file);
  const all = () => { if (!data) { try { data = JSON.parse(fs.readFileSync(f(), 'utf8')) || {}; } catch (e) { data = {}; } } return data; };
  const save = () => { clearTimeout(timer); timer = setTimeout(() => { try { fs.writeFileSync(f(), JSON.stringify(data)); } catch (e) { /* ignore */ } }, 200); };
  return { all, save };
};
const names = jsonStore('names.json'), people = jsonStore('people.json');
// what a clip was before Backstage renamed its file (type, recorder, date, game: things read from
// the old name, like NVIDIA's ".DVR"), keyed like names.json
const kept = jsonStore('kept.json');
const allPeople = () => people.all();
// A clip's key for names.json and kept.json: Discord's info, else Encore's encore_id (0.9.36+; follows the
// clip through renames, moves and Replace original), else its size and date
const nameKey = (st, meta, tags) => (meta && meta.createdAt ? `d:${meta.createdAt}:${(meta.users || [])[0] || ''}`
  : tags && tags.encore_id ? `e:${tags.encore_id}` : `s:${st.size}:${Math.round(st.mtimeMs / 1000)}`);
async function titleOf(p) {
  try {
    const st = fs.statSync(p);
    const { e } = await fileFacts(p, path.basename(p), st);
    return names.all()[nameKey(st, e.meta, e.tags)] || null;
  } catch (err) { return null; }
}
const cleanTitle = t => String(t || '').replace(/[\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);

// ---------- making files ----------
// file names for what's made: the clip's name if it has one, else the original's name + "_trim"
const outName = (src, title) => (title ? safeName(title) : path.basename(src, path.extname(src)).replace(/_trim\d*$/, '') + '_trim');
// a fresh folder in temp for one file (clipboard copies keep a plain name that way)
function tempDir(tag) {
  const d = path.join(copyDir(), `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// list: [{ index, gain }] audio tracks to keep and how loud ([] = no audio). keepTracks: every audio
// track as it is, plus the file's own info (for replacing the original).
// ---------- effects: crop, zoom, blur, layers, added audio, volume points, fades ----------
// The editor saves them with the trim (edit.fx). Text, pictures, shapes and drawings arrive as
// full-frame transparent PNGs the editor drew itself (in userData/fx), so the export shows
// exactly what the preview did. Any effect means the whole clip is encoded (no smart cut).
const fxDir = () => { const d = path.join(app.getPath('userData'), 'fx'); fs.mkdirSync(d, { recursive: true }); return d; };
const fxFile = name => path.join(fxDir(), path.basename(String(name || '')));
const fxAllowed = new Set(); // added sound files the editor may read
const num = (v, a, b, d = a) => { v = Number(v); return Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : d; };
const box01 = b => ({ x: num(b && b.x, 0, 1, 0), y: num(b && b.y, 0, 1, 0), w: num(b && b.w, 0.01, 1, 1), h: num(b && b.h, 0.01, 1, 1) });
const OVERLAYS = ['text', 'image', 'draw', 'shape'];
function cleanFx(fx) {
  if (!fx || typeof fx !== 'object') return null;
  const out = { crop: null, layers: [], sounds: [], vpts: {}, fades: {}, cuts: {} };
  if (fx.crop) { const c = box01(fx.crop); if (c.w < 0.999 || c.h < 0.999) out.crop = c; }
  const vtracks = Array.isArray(fx.vtracks) ? fx.vtracks : [], atracks = Array.isArray(fx.atracks) ? fx.atracks : [];
  for (const l of Array.isArray(fx.layers) ? fx.layers : []) {
    if (!l || l.hidden || !['zoom', 'blur', ...OVERLAYS].includes(l.type)) continue;
    if (l.type !== 'zoom' && vtracks[l.track | 0] && vtracks[l.track | 0].hidden) continue; // zooms are on V1, which can't be hidden
    const L = { type: l.type, track: num(l.track, 0, 99, 0) | 0, start: num(l.start, 0, 1e6), end: num(l.end, 0, 1e6) };
    if (!(L.end > L.start)) continue;
    if (l.type === 'zoom') {
      Object.assign(L, { box: box01(l.box), ein: num(l.ein, 0, 30, 0), eout: num(l.eout, 0, 30, 0) });
      // steps: zoom on from where it is to another box, from time t over `ease`
      const steps = (Array.isArray(l.steps) ? l.steps : []).filter(st => st && st.box)
        .map(st => ({ t: num(st.t, 0, 1e6), ease: num(st.ease, 0, 10, 0.4), box: box01(st.box) }))
        .filter(st => st.t > L.start && st.t < L.end).sort((a, b) => a.t - b.t);
      if (steps.length) L.steps = steps;
    }
    else if (l.type === 'blur') Object.assign(L, { box: box01(l.box), strength: num(l.strength, 1, 10, 5) });
    else { if (!l.png || !fs.existsSync(fxFile(l.png))) continue; L.png = fxFile(l.png); }
    out.layers.push(L);
  }
  out.layers.sort((a, b) => a.track - b.track || (b.type === 'blur') - (a.type === 'blur')); // higher tracks on top; a track's blur under its drawn layers
  for (const s of Array.isArray(fx.sounds) ? fx.sounds : []) {
    if (!s || s.mute || !(num(s.vol, 0, 2, 1) > 0.001) || typeof s.path !== 'string' || !fs.existsSync(s.path)) continue;
    if (atracks[s.track | 0] && atracks[s.track | 0].mute) continue;
    const S = { key: 's:' + String(s.id), path: s.path, at: num(s.at, 0, 1e6), from: num(s.from, 0, 1e6), to: num(s.to, 0, 1e6), vol: num(s.vol, 0, 2, 1) };
    if (!(S.to > S.from)) continue;
    out.sounds.push(S);
    // its volume points are kept relative to where it starts
    if (Array.isArray(s.pts) && s.pts.length) out.vpts[S.key] = s.pts.map(p => [S.at + num(p && p[0], 0, 1e6), num(p && p[1], 0, 2, 1)]).sort((a, b) => a[0] - b[0]);
  }
  if (fx.vpts && typeof fx.vpts === 'object') {
    for (const [k, pts] of Object.entries(fx.vpts)) {
      if (!Array.isArray(pts) || !pts.length || k.startsWith('s:')) continue;
      out.vpts[k] = pts.map(p => [num(p && p[0], 0, 1e6), num(p && p[1], 0, 2, 1)]).sort((a, b) => a[0] - b[0]);
    }
  }
  // the clip's own sound rows cut into pieces: each plays from..to (clip time) at `at`
  if (fx.cuts && typeof fx.cuts === 'object') {
    for (const [k, c] of Object.entries(fx.cuts)) {
      if (!c || !Array.isArray(c.pieces) || k.startsWith('s:')) continue;
      out.cuts[k] = c.pieces.filter(p => p && !p.mute).map(p => ({ from: num(p.from, 0, 1e6), to: num(p.to, 0, 1e6), at: num(p.at, 0, 1e6), vol: num(p.vol, 0, 2, 1) }))
        .filter(p => p.to > p.from + 0.001 && p.vol > 0.001).sort((a, b) => a.at - b.at);
    }
  }
  const f = fx.fades || {};
  for (const k of ['vin', 'vout', 'ain', 'aout']) if (num(f[k], 0, 10, 0) > 0) out.fades[k] = num(f[k], 0, 10, 0);
  return out.crop || out.layers.length || out.sounds.length || Object.keys(out.vpts).length || Object.keys(out.fades).length || Object.keys(out.cuts).length ? out : null;
}
const f4 = n => String(Math.round(n * 10000) / 10000);
// a volume curve through the points (straight lines between them), on the export's own clock
function curveExpr(pts, off) {
  if (!pts || !pts.length) return null;
  const p = pts.map(([t, v]) => [t - off, v]);
  let e = f4(p[p.length - 1][1]);
  for (let i = p.length - 2; i >= 0; i--) {
    const [t1, v1] = p[i], [t2, v2] = p[i + 1];
    const seg = t2 - t1 > 1e-4 ? `${f4(v1)}+(${f4(v2 - v1)})*(t-(${f4(t1)}))/${f4(t2 - t1)}` : f4(v2);
    e = `if(lt(t,${f4(t2)}),${seg},${e})`;
  }
  return `if(lt(t,${f4(p[0][0])}),${f4(p[0][1])},${e})`;
}
// zooms: each eases in (smoothstep) over ein, holds, eases out over eout; rect = full frame to box.
// A zoom's steps move its box on to another one from time t over `ease` (smoothstep), the same way
// zoomBoxAt does in the editor: b = b*(1-u) + step*u, one step after another.
function zoomExpr(zooms, off) {
  const ss = (v, a, d) => (d > 0.001 ? `(clip((it-(${f4(v)}))/${f4(d)},0,1))` : `gte(it,${f4(v)})`);
  const terms = zooms.map(z => {
    const S = Math.max(0, z.start - off), E = z.end - off, half = (E - S) / 2;
    const a = Math.min(z.ein, half), b = Math.min(z.eout, half);
    const rin = a > 0.001 ? `clip((it-(${f4(S)}))/${f4(a)},0,1)` : `gte(it,${f4(S)})`;
    const rout = b > 0.001 ? `clip((${f4(E)}-it)/${f4(b)},0,1)` : `lt(it,${f4(E)})`;
    const u = `min(${rin},${rout})`;
    // the box, as expressions of time when there are steps
    const bx = { x: f4(z.box.x), y: f4(z.box.y), w: f4(z.box.w) };
    for (const st of z.steps || []) {
      const v = ss(st.t - off, 0, st.ease), us = st.ease > 0.001 ? `(${v}*${v}*(3-2*${v}))` : v;
      for (const k of ['x', 'y', 'w']) bx[k] = `((${bx[k]})*(1-${us})+${f4(st.box[k])}*${us})`;
    }
    return { e: `(${u})*(${u})*(3-2*(${u}))`, bx };
  });
  const sum = g => terms.map(t => `(${g(t.bx)})*${t.e}`).join('+');
  return { z: `1/(1-(${sum(b => `1-${b.w}`)}))`, x: `(${sum(b => b.x)})*iw`, y: `(${sum(b => b.y)})*ih` };
}
const even = n => Math.max(2, Math.floor(n / 2) * 2);
async function fxMake({ src, info, start, length, list, fx, target, out, progress, job, audioOnly, mark = ['-movflags', '+faststart'] }) {
  fx = fx || { crop: null, layers: [], sounds: [], vpts: {}, fades: {}, cuts: {} };
  const cuts = fx.cuts || {};
  const end = start + length, W = info.width || 1920, H = info.height || 1080, fps = info.fps || 30;
  let cw = even(W), ch = even(H), cx = 0, cy = 0;
  if (fx.crop) {
    cw = even(fx.crop.w * W); ch = even(fx.crop.h * H);
    cx = Math.max(0, Math.min(W - cw, Math.round(fx.crop.x * W))); cy = Math.max(0, Math.min(H - ch, Math.round(fx.crop.y * H)));
  }
  const inputs = [...av1In(info.codec), '-ss', start.toFixed(3), '-t', length.toFixed(3), '-i', src];
  let nIn = 1;
  const parts = [];
  let n = 0, cur = '[0:v]';
  const next = () => `[v${n++}]`;
  const seen = l => l.end > start && l.start < end;
  const en = l => `between(t,${f4(Math.max(0, l.start - start))},${f4(l.end - start)})`;
  // target size: the bitrate that fits, and a smaller picture when that's too few bits for it
  let vk = Math.round(Math.max(2000, sourceKbps(info) * (cw * ch) / (W * H))), ow = cw, oh = ch, ofps = fps;
  const hasAudio = list.length || fx.sounds.length;
  if (target && !audioOnly) {
    vk = Math.floor(target * 8 / 1000 / length * 0.93 - (hasAudio ? 160 : 0));
    if (vk < 150) throw new Error(`It's too long to fit in ${Math.round(target / 1048576)} MB. Trim it shorter first.`);
    const bpp = () => vk * 1000 / (ow * oh * ofps);
    for (const hh of [1080, 720, 480]) if (bpp() < 0.05 && oh > hh) { ow = even(cw * hh / ch); oh = hh; }
    if (bpp() < 0.05 && ofps > 60) ofps = 60;
    if (bpp() < 0.05 && ofps > 30) ofps = 30;
  }
  if (!audioOnly) {
    if (fx.crop) { const o = next(); parts.push(`${cur}crop=${cw}:${ch}:${cx}:${cy}${o}`); cur = o; }
    const zooms = fx.layers.filter(l => l.type === 'zoom' && seen(l));
    if (zooms.length) {
      const z = zoomExpr(zooms, start), o = next();
      parts.push(`${cur}zoompan=z='${z.z}':x='${z.x}':y='${z.y}':d=1:s=${cw}x${ch}:fps=${f4(fps)}${o}`); cur = o;
    }
    // blur boxes and drawn layers, bottom track first: a blur blurs everything under it
    for (const l of fx.layers.filter(x => x.type !== 'zoom' && seen(x))) {
      if (OVERLAYS.includes(l.type)) {
        inputs.push('-i', l.png);
        const s = next(), o = next();
        parts.push(`[${nIn++}:v]format=rgba,scale=${cw}:${ch}${s}`, `${cur}${s}overlay=0:0:enable='${en(l)}'${o}`); cur = o;
        continue;
      }
      const bw = even(l.box.w * cw), bh = even(l.box.h * ch);
      const bx = Math.max(0, Math.min(cw - bw, Math.round(l.box.x * cw))), by = Math.max(0, Math.min(ch - bh, Math.round(l.box.y * ch)));
      const r = Math.max(1, Math.min(Math.floor(Math.min(bw, bh) / 2) - 1, Math.round(l.strength * ch / 120)));
      const a = next(), b = next(), c = next(), o = next();
      parts.push(`${cur}split=2${a}${b}`, `${b}crop=${bw}:${bh}:${bx}:${by},boxblur=${r}:3${c}`, `${a}${c}overlay=${bx}:${by}:enable='${en(l)}'${o}`); cur = o;
    }
    const post = [];
    if (ow !== cw || oh !== ch) post.push(`scale=${ow}:${oh}:flags=lanczos`);
    if (ofps !== fps) post.push(`fps=${ofps}`);
    if (fx.fades.vin) post.push(`fade=t=in:st=0:d=${f4(Math.min(fx.fades.vin, length / 2))}`);
    if (fx.fades.vout) post.push(`fade=t=out:st=${f4(Math.max(0, length - fx.fades.vout))}:d=${f4(Math.min(fx.fades.vout, length / 2))}`);
    post.push('format=yuv420p');
    parts.push(`${cur}${post.join(',')}[vout]`);
  }
  // sound: the clip's tracks (each with its volume and points) and the added sounds, mixed
  const labels = [];
  list.forEach((s, i) => {
    const c = curveExpr(fx.vpts[s.key], start);
    const vol = c ? `volume='${f4(s.gain)}*(${c})':eval=frame` : `volume=${f4(s.gain)}`;
    const fmtA = `aresample=48000,${info.audio[s.index] && info.audio[s.index].channels === 'mono' ? 'pan=stereo|c0=c0|c1=c0,' : ''}aformat=sample_fmts=fltp:channel_layouts=stereo`;
    const pieces = cuts[s.key];
    if (!pieces) { parts.push(`[0:a:${s.index}]${fmtA},${vol}[a${i}]`); labels.push(`[a${i}]`); return; }
    // a cut row: each piece read on its own from the clip and put where it sits on the timeline
    pieces.forEach((p, j) => {
      const from = Math.max(start, p.at), to = Math.min(end, p.at + (p.to - p.from));
      if (to <= from + 0.01) return;
      inputs.push('-ss', (p.from + from - p.at).toFixed(3), '-t', (to - from).toFixed(3), '-i', src);
      const pv = Math.abs(p.vol - 1) > 0.001 ? `,volume=${f4(p.vol)}` : '';
      parts.push(`[${nIn++}:a:${s.index}]${fmtA},adelay=${Math.round((from - start) * 1000)}:all=1,${vol}${pv}[a${i}p${j}]`);
      labels.push(`[a${i}p${j}]`);
    });
  });
  fx.sounds.forEach((s, i) => {
    const from = Math.max(start, s.at), to = Math.min(end, s.at + (s.to - s.from));
    if (to <= from + 0.01) return;
    inputs.push('-ss', (s.from + from - s.at).toFixed(3), '-t', (to - from).toFixed(3), '-i', s.path);
    const c = curveExpr(fx.vpts[s.key], start);
    const vol = c ? `volume='${f4(s.vol)}*(${c})':eval=frame` : `volume=${f4(s.vol)}`;
    parts.push(`[${nIn++}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${Math.round((from - start) * 1000)}:all=1,${vol}[s${i}]`);
    labels.push(`[s${i}]`);
  });
  let alabel = null;
  if (labels.length) {
    const af = [];
    if (fx.fades.ain) af.push(`afade=t=in:st=0:d=${f4(Math.min(fx.fades.ain, length / 2))}`);
    if (fx.fades.aout) af.push(`afade=t=out:st=${f4(Math.max(0, length - fx.fades.aout))}:d=${f4(Math.min(fx.fades.aout, length / 2))}`);
    const mix = labels.length > 1 ? `amix=inputs=${labels.length}:duration=longest:normalize=0` : 'anull';
    // silence to the end (a cut or a late sound can end before the trim does); -t stops it there
    parts.push(`${labels.join('')}${[mix, 'apad', ...af].join(',')}[aout]`);
    alabel = '[aout]';
  }
  if (audioOnly && !alabel) throw new Error('All the audio is muted, so there is nothing to export.');
  const enc = audioOnly ? null : await pickEncoder();
  const vargs = (e, k) => {
    if (!target) return e.args(k);
    if (e.name === 'libx264') return ['-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${k}k`, '-maxrate', `${k}k`, '-bufsize', `${k * 2}k`, '-pix_fmt', 'yuv420p'];
    const a = e.args(k), i = a.indexOf('-maxrate');
    if (i >= 0) a[i + 1] = `${k}k`;
    return a;
  };
  const build = (e, k) => {
    const a = ['-y', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', ...inputs, '-filter_complex', parts.join(';')];
    if (!audioOnly) a.push('-map', '[vout]', ...vargs(e, k));
    if (alabel) a.push('-map', alabel, ...(audioOnly ? ['-c:a', 'libmp3lame', '-b:a', '192k'] : ['-c:a', 'aac', '-b:a', '160k']));
    else a.push('-an');
    a.push('-t', length.toFixed(3));
    if (!audioOnly) a.push(...mark);
    a.push(out);
    return a;
  };
  if (audioOnly) return runFfmpeg(build(null, 0), length, progress, job);
  let r = await runFfmpeg(build(enc, vk), length, progress, job);
  if (!r.ok && !r.cancelled && enc.name !== 'libx264') r = await runFfmpeg(build({ name: 'libx264', args: X264 }, vk), length, progress, job);
  // a little over the size: once more with less
  if (r.ok && target) {
    try {
      if (fs.statSync(out).size > target) {
        r = await runFfmpeg(build(enc, Math.floor(vk * 0.85)), length, progress, job);
        if (r.ok && fs.statSync(out).size > target) r = { ok: false, err: [`It came out over ${Math.round(target / 1048576)} MB. Try a shorter trim.`] };
      }
    } catch (e) { /* keep r */ }
  }
  return r;
}

// Backstage's marker on every video it makes: what the original was (type, recorder, game, date), so the
// new file shows under Edited and in the right place whatever it's called later. Written as named MP4
// tags (use_metadata_tags), read back by readMp4Tags.
async function markFor(src, what) {
  const args = ['-movflags', '+faststart+use_metadata_tags'];
  try {
    const st = fs.statSync(src), { e } = await fileFacts(src, path.basename(src), st);
    const lib = (await libFolders()).find(f => !f.missing && inside(f.path, src));
    const parts = lib ? path.relative(lib.path, src).split(path.sep) : [];
    const f = clipFacts(path.basename(src), st, e, parts.length > 1 ? parts[0] : null, lib && lib.kind);
    const tags = {
      backstage: f.kind === 'export' ? 'export' : what, backstage_kind: f.type || '', backstage_origin: f.origin || '',
      backstage_game: f.rawGame && f.rawGame !== 'Other' ? f.rawGame : '', backstage_date: String(Math.round(f.date)),
    };
    for (const [k, v] of Object.entries(tags)) if (v) args.push('-metadata', `${k}=${v}`);
  } catch (err) { args.push('-metadata', `backstage=${what}`); }
  return args;
}
async function makeFile({ src, info, start, length, audioOnly, list, out, progress, job, keepTracks, fx, target, mark }) {
  mark = audioOnly ? [] : mark || ['-movflags', '+faststart'];
  if (!keepTracks && (fx || target)) return fxMake({ src, info, start, length, list, fx, target, out, progress, job, audioOnly, mark });
  if (audioOnly) return runFfmpeg(audioArgs({ src, info, start, length, list, audioOnly, out }), length, progress, job);
  const end = start + length;
  const enc = await pickEncoder();
  // smart cut first: only the bits before the first and after the last keyframe are encoded
  const p = await smartcut.plan(src, info, start, end);
  if (p) {
    const work = tempDir('cut');
    const run = (args, len) => runFfmpeg(args, len, null, job);
    const a = keepTracks
      ? { inputs: ['-ss', start.toFixed(6), '-t', length.toFixed(6), '-i', src], maps: ['-map', '1:a?'], args: ['-c:a', 'copy', '-map_metadata', '1'] }
      : muxAudio({ src, info, start, length, list });
    try {
      const r = await smartcut.cut({ src, info, start, end, p, out, work, run, headArgs: enc.args(sourceKbps(info)), audio: a, progress: x => progress && progress(x), avIn: av1In(info.codec), extra: mark });
      if (r.cancelled || job.cancelled) return { ok: false, cancelled: true, err: [] };
      if (r.ok && await looksRight(out, length, p.head)) return { ...r, smart: true };
    } finally { fs.rm(work, { recursive: true, force: true }, () => {}); }
    fs.rmSync(out, { force: true }); // something was off: make it the normal way
  }
  const build = videoArgs => {
    const a = ['-y', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', ...av1In(info.codec),
      '-ss', start.toFixed(3), '-t', length.toFixed(3), '-i', src, '-map', '0:v:0', ...videoArgs];
    if (keepTracks) a.push('-map', '0:a?', '-c:a', 'copy', '-map_metadata', '0');
    else a.push(...audioArgs({ src, info, start, length, list, inline: true }));
    a.push(...mark, out);
    return a;
  };
  let r = await runFfmpeg(build(enc.args(sourceKbps(info))), length, progress, job);
  // the card's encoder refused this one (odd size, driver trouble): use the CPU
  if (!r.ok && !r.cancelled && enc.name !== 'libx264') r = await runFfmpeg(build(X264()), length, progress, job);
  return r;
}
// the audio part of an ffmpeg command for `list`; inline: the clip is input 0 already
function audioArgs({ src, info, start, length, list, audioOnly, out, inline }) {
  const a = inline ? [] : ['-y', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats',
    '-ss', start.toFixed(3), '-t', length.toFixed(3), '-i', src, '-vn'];
  if (!list.length) a.push('-an');
  else if (list.length === 1 && Math.abs(list[0].gain - 1) < 0.001) a.push('-map', `0:a:${list[0].index}`);
  else a.push(...mixArgs(info, list, 0));
  if (list.length) a.push(...(audioOnly ? ['-c:a', 'libmp3lame', '-b:a', '192k'] : ['-c:a', 'aac', '-b:a', '192k']));
  if (out) a.push(out);
  return a;
}
// everything becomes 48 kHz stereo so tracks can be mixed; mono is copied to both channels
function mixArgs(info, list, input) {
  const parts = list.map((s, i) => `[${input}:a:${s.index}]volume=${s.gain.toFixed(3)},aresample=48000,` +
    (info.audio[s.index].channels === 'mono' ? 'pan=stereo|c0=c0|c1=c0,' : '') + `aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
  if (list.length > 1) parts.push(list.map((_s, i) => `[a${i}]`).join('') + `amix=inputs=${list.length}:duration=longest:normalize=0[aout]`);
  return ['-filter_complex', parts.join(';'), '-map', list.length > 1 ? '[aout]' : '[a0]'];
}
// audio for the smart cut's final step (the joined video is input 0, the clip is input 1)
function muxAudio({ src, start, length, info, list }) {
  const inputs = ['-ss', start.toFixed(6), '-t', length.toFixed(6), '-i', src];
  if (!list.length) return { inputs: [], maps: [], args: ['-an'] };
  if (list.length === 1 && Math.abs(list[0].gain - 1) < 0.001) return { inputs, maps: ['-map', `1:a:${list[0].index}`], args: ['-c:a', 'aac', '-b:a', '192k'] };
  const m = mixArgs(info, list, 1);
  return { inputs, maps: m.slice(0, 2).concat(m.slice(2)), args: ['-c:a', 'aac', '-b:a', '192k'] };
}
// quick check of a smart cut: the right length, and the joins decode cleanly
async function looksRight(file, length, head) {
  try {
    const i = await ffInfo(file);
    if (!i.video || Math.abs(i.duration - length) > 0.25) return false;
    return await new Promise(resolve => {
      execFile(FFMPEG, ['-v', 'error', '-t', String(Math.min(length, head + 1.5)), '-i', file, '-map', '0:v:0', '-f', 'null', '-'],
        { windowsHide: true, timeout: 15000 }, (err, _o, stderr) => resolve(!err && !String(stderr || '').trim()));
    });
  } catch (e) { return false; }
}

// ---------- ready-made trims ----------
// Copy Video and dragging a card into Discord should feel instant, so trims are made ahead of time
// (when you stop changing one, hover its card or press on it) and kept for a while. A smart cut
// takes well under a second, so only the last few are kept.
const prepared = new Map(); // key -> { out, ready: Promise<result>, job, at }
const KEEP_PREPARED = 20;
const exportKey = o => JSON.stringify([editKey(o.path), Math.round(o.start * 1000), Math.round(o.end * 1000), o.sources || [], o.title || '', o.fx || null]);
function dropPrepared(forPath) {
  for (const [k, e] of prepared) {
    if (forPath && JSON.parse(k)[0] !== editKey(forPath)) continue;
    prepared.delete(k);
    e.job.cancelled = true;
    for (const c of e.job.kids || []) { try { c.kill(); } catch (err) { /* ignore */ } }
    e.ready.then(() => { try { fs.rmSync(path.dirname(e.out), { recursive: true, force: true }); } catch (err) { /* ignore */ } });
  }
}
function trimPrepared() {
  const old = [...prepared.entries()].sort((a, b) => b[1].at - a[1].at).slice(KEEP_PREPARED);
  for (const [k, e] of old) {
    prepared.delete(k);
    e.ready.then(() => { try { fs.rmSync(path.dirname(e.out), { recursive: true, force: true }); } catch (err) { /* ignore */ } });
  }
}
// what a clip's saved edit makes: { src, info, start, end, sources, title, untouched }
async function savedJob(src, o = {}) {
  const info = await probeVideo(src);
  const e = o.edit !== undefined ? o.edit : editFor(src);
  const start = Math.max(0, Number(o.start ?? (e && e.in) ?? 0));
  const end = Math.min(Number(o.end ?? (e && e.out) ?? info.duration), info.duration || Infinity);
  const audio = o.audio !== undefined ? o.audio : (e && e.audio) || {};
  const fx = cleanFx(o.fx !== undefined ? o.fx : e && e.fx);
  const groups = audioGroups(info);
  let sources;
  // volume points on the clip's own rows: every row is mixed on its own so each can follow its curve
  if (fx && (Object.keys(fx.vpts).some(k => !k.startsWith('s:')) || Object.keys(fx.cuts).length)) {
    sources = groups.map(g => ({ ...g, ...savedFor(g, audio) })).filter(g => !g.mute && g.vol > 0.001)
      .flatMap(g => g.idx.map(i => ({ index: i, gain: g.vol, key: g.key })));
  } else sources = sourcesFor(info, audio).map(x => ({ ...x, key: (groups.find(g => g.idx.includes(x.index)) || {}).key || '' }));
  sources = sources.filter(x => info.audio[x.index] && x.gain > 0.001);
  const title = await titleOf(src);
  const whole = start <= 0.01 && end >= info.duration - 0.01;
  const plainAudio = Object.values(audio).every(a => !a.mute && Math.abs((+a.vol || 1) - 1) < 0.001);
  return { info, start, end, sources, title, fx, untouched: whole && plainAudio && !fx };
}
// make (or reuse) the file for a trim; resolves to { ok, out }
function prepare(src, j) {
  const key = exportKey({ path: src, start: j.start, end: j.end, sources: j.sources, title: j.title, fx: j.fx });
  let e = prepared.get(key);
  if (e) { e.at = Date.now(); return e; }
  const dir = tempDir('prep'), out = path.join(dir, outName(src, j.title) + '.mp4');
  const job = { child: null, kids: new Set(), cancelled: false };
  e = { out, job, at: Date.now() };
  e.ready = markFor(src, 'export').then(mark => makeFile({ src, info: j.info, start: j.start, length: j.end - j.start, audioOnly: false, list: j.sources, out, progress: null, job, fx: j.fx, mark }))
    .then(r => { if (!r.ok) { prepared.delete(key); fs.rmSync(dir, { recursive: true, force: true }); } return { ...r, out }; });
  prepared.set(key, e);
  trimPrepared();
  return e;
}
// an untouched clip with a name: the same file under its new name, made instantly as a hard link
// (in a hidden folder on the same drive), or copied if the drive can't do links
async function namedOriginal(src, title) {
  const ext = path.extname(src);
  const root = (await libFolders()).find(f => !f.missing && inside(f.path, src));
  const dir = path.join(root ? root.path : path.dirname(src), '.clip-links', String(Date.now()));
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (IS_WIN) execFile('attrib', ['+h', path.dirname(dir)], { windowsHide: true }, () => {});
    const out = path.join(dir, safeName(title) + ext);
    fs.linkSync(src, out);
    return out;
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { /* ignore */ }
    const out = path.join(tempDir('named'), safeName(title) + ext);
    await fs.promises.copyFile(src, out);
    return out;
  }
}
const inside = (dir, p) => { const rel = path.relative(dir, p); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
// links older than a day go (they cost no space, but keep the folder tidy)
async function cleanLinks() {
  for (const f of await libFolders()) {
    const d = path.join(f.path, '.clip-links');
    let ents = [];
    try { ents = fs.readdirSync(d); } catch (e) { continue; }
    for (const n of ents) { try { if (Date.now() - fs.statSync(path.join(d, n)).mtimeMs > 24 * 3600 * 1000) fs.rmSync(path.join(d, n), { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  }
}
// the file to hand over for a clip as it's saved (trim, audio, name): the original, a named link,
// or a ready-made trim
async function fileFor(src, o) {
  const j = await savedJob(src, o);
  if (j.untouched) return { out: j.title ? await namedOriginal(src, j.title) : src, j };
  const e = prepare(src, j);
  const r = await e.ready;
  if (!r.ok) throw new Error(r.cancelled ? 'Cancelled.' : 'Making the clip failed: ' + (r.err || []).join(' | '));
  e.at = Date.now();
  return { out: e.out, j };
}

async function qtExport(o) {
  const { path: src, as, dest } = o;
  if (!allowed(src) || !fs.existsSync(src)) throw new Error("That clip isn't there anymore.");
  const audioOnly = as === 'audio';
  const t0 = Date.now();
  // Copy Video: the ready-made (or instantly made) file
  const target = Number(o.target) > 0 ? Math.min(4e9, Number(o.target)) : 0;
  if (!audioOnly && !target && (dest === 'clipboard' || dest === 'temp')) {
    const { out } = await fileFor(src, o);
    state.outputs.add(out);
    if (dest === 'clipboard') await copyFileToClipboard(out);
    return { out, size: fs.statSync(out).size, seconds: Math.round((Date.now() - t0) / 100) / 10 };
  }
  const j = await savedJob(src, o);
  const { info, start, end, sources: list, title, fx } = j;
  if (!(end > start)) throw new Error('Invalid start/end.');
  const length = end - start, ext = audioOnly ? '.mp3' : '.mp4';
  if (audioOnly && !list.length && !(fx && fx.sounds.length)) throw new Error('All the audio is muted, so there is nothing to export.');
  let out;
  if (dest === 'clipboard' || dest === 'temp') out = path.join(tempDir('copy'), outName(src, title) + ext);
  else if (dest === 'saveas') {
    const r = await dialog.showSaveDialog(win, {
      title: audioOnly ? 'Export audio as' : 'Export clip as',
      defaultPath: freeName(exportFolder(src), outName(src, title), ext),
      filters: audioOnly ? [{ name: 'MP3 audio', extensions: ['mp3'] }] : [{ name: 'MP4 video', extensions: ['mp4'] }],
    });
    if (r.canceled || !r.filePath) return { cancelled: true };
    out = path.extname(r.filePath) ? r.filePath : r.filePath + ext;
    if (samePath(out, src)) throw new Error('To overwrite the original, use Replace original in the Export menu.');
  } else out = freeName(exportFolder(src), outName(src, title), ext);

  const progress = p => win && !win.isDestroyed() && win.webContents.send('qt-progress', p);
  state.cancelled = false;
  const r = await makeFile({ src, info, start, length, audioOnly, list, out, progress, job: state, fx, target, mark: await markFor(src, 'export') });
  if (r.cancelled) { fs.rmSync(out, { force: true }); return { cancelled: true }; }
  if (!r.ok) { fs.rmSync(out, { force: true }); throw new Error('Export failed: ' + r.err.join(' | ')); }
  state.outputs.add(out);
  if (dest === 'clipboard') await copyFileToClipboard(out);
  return { out, size: fs.statSync(out).size, seconds: Math.round((Date.now() - t0) / 100) / 10, smart: !!r.smart };
}

// ---------- replace the original with the trimmed clip ----------
// Only the length changes: every audio track, Discord's clip info (game, people) and the dates stay,
// so the clip keeps its place in the library and its audio can still be changed later.
async function qtReplace(o) {
  const src = o.path;
  if (!allowed(src) || !fs.existsSync(src)) throw new Error("That clip isn't there anymore.");
  const info = await probeVideo(src);
  const start = Math.max(0, Number(o.start)), end = Math.min(Number(o.end), info.duration);
  if (!(end > start)) throw new Error('Invalid start/end.');
  if (start <= 0.01 && end >= info.duration - 0.01) throw new Error("It isn't trimmed, so there's nothing to replace.");
  const st = fs.statSync(src);
  const { e: facts } = await fileFacts(src, path.basename(src), st);
  const oldKey = nameKey(st, facts.meta, facts.tags);
  const box = await readDiscordBox(src, st.size);
  const tmp = path.join(path.dirname(src), '.' + path.basename(src, path.extname(src)) + '.replacing.mp4');
  const progress = p => win && !win.isDestroyed() && win.webContents.send('qt-progress', p);
  state.cancelled = false;
  const r = await makeFile({ src, info, start, length: end - start, audioOnly: false, list: [], out: tmp, progress, job: state, keepTracks: true, mark: await markFor(src, 'replaced') });
  if (!r.ok) { fs.rmSync(tmp, { force: true }); if (r.cancelled) return { cancelled: true }; throw new Error('Replacing failed: ' + r.err.join(' | ')); }
  try {
    // Discord's clip info goes back on the end, with the new length
    if (box) fs.appendFileSync(tmp, discordBoxWithLength(box, Math.round((end - start) * 1000)));
    closeFd(src);
    dropPrepared(src);
    fs.renameSync(tmp, src);
  } catch (e) { fs.rmSync(tmp, { force: true }); throw new Error("Couldn't replace the original: " + e.message); }
  // the dates go back to the original's (Windows' created date too)
  try { fs.utimesSync(src, st.atime, st.mtime); } catch (e) { /* ignore */ }
  if (IS_WIN) await powershell(`(Get-Item -LiteralPath ${psQuote(src)}).CreationTimeUtc = [DateTimeOffset]::FromUnixTimeMilliseconds(${Math.round(st.birthtimeMs)}).UtcDateTime`);
  // its name moves with it (the size changed), the trim is reset, the audio settings stay
  const nst = fs.statSync(src);
  const all = names.all(), newKey = nameKey(nst, facts.meta, facts.tags);
  if (all[oldKey] && newKey !== oldKey) { all[newKey] = all[oldKey]; delete all[oldKey]; names.save(); }
  const ka = kept.all();
  if (ka[oldKey] && newKey !== oldKey) { ka[newKey] = ka[oldKey]; delete ka[oldKey]; kept.save(); }
  const ed = editFor(src), newDur = (await ffInfo(src)).duration || end - start;
  setEdit(src, ed && ed.audio && Object.keys(ed.audio).length ? { in: 0, out: newDur, dur: newDur, audio: ed.audio } : null);
  // Settings > File names: the file takes the clip's name too
  let to = src;
  if (renameFiles() && all[newKey]) { try { to = await renameFile(src, all[newKey]); } catch (e) { /* keeps its name */ } }
  return { size: nst.size, duration: newDur, smart: !!r.smart, path: to, name: path.basename(to), url: pathToFileURL(to).href };
}

// ---------- the file takes the clip's name (Settings > File names, off by default) ----------
// What the old name told Backstage (NVIDIA's ".DVR", the date in NVIDIA's and Encore's names, the game in
// Discord's) is kept first (kept.json), and the saved edit and thumbnail follow the file. A clip open in
// the editor is renamed once the editor lets go of it (switching clips, closing it, quitting).
const renameFiles = () => readSettings().renameFiles === true;
const pendingNames = new Map(); // editKey(path) -> { p, title }
async function keepFacts(p) {
  const st = fs.statSync(p), { e } = await fileFacts(p, path.basename(p), st);
  const lib = (await libFolders()).find(f => !f.missing && inside(f.path, p));
  const parts = lib ? path.relative(lib.path, p).split(path.sep) : [];
  const f = clipFacts(path.basename(p), st, e, parts.length > 1 ? parts[0] : null, lib && lib.kind);
  const all = kept.all(), key = nameKey(st, e.meta, e.tags);
  all[key] = { kind: f.kind, type: f.type, origin: f.origin, date: Math.round(f.date), ...(f.fromName ? { game: f.rawGame } : {}) };
  kept.save();
}
function targetName(p, title) {
  const t = safeName(title).replace(/\.(mp4|mkv|mov|webm|m4v)$/i, '');
  const ext = path.extname(p), dir = path.dirname(p);
  if (!cleanTitle(title) || path.basename(p, ext) === t) return null;
  const to = path.join(dir, t + ext);
  return fs.existsSync(to) && !samePath(to, p) ? freeName(dir, t, ext) : to;
}
function moveNow(p, to) {
  closeFd(p);
  dropPrepared(p);
  fs.renameSync(p, to);
  const all = allEdits(), ek = editKey(p);
  if (all[ek]) { setEdit(to, all[ek]); setEdit(p, null); }
  // the thumbnail too (same size and date, new path)
  try {
    const st = fs.statSync(to), idx = loadIndex(), a = thumbKey(p, st), b = thumbKey(to, st);
    if (idx[a]) { idx[b] = idx[a]; delete idx[a]; saveIndexSoon(); }
    const jpg = path.join(thumbDir(), a + '.jpg');
    if (fs.existsSync(jpg)) fs.renameSync(jpg, path.join(thumbDir(), b + '.jpg'));
  } catch (e) { /* made again */ }
  if (opened.has(ek)) { opened.delete(ek); opened.add(editKey(to)); }
  return to;
}
async function renameFile(p, title) {
  if (!targetName(p, title)) return p;
  await keepFacts(p);
  const to = targetName(p, title);
  return to ? moveNow(p, to) : p;
}
// the editor let go of a clip: a rename waiting for it happens now
function renamePending(p) {
  const k = editKey(p), j = pendingNames.get(k);
  if (!j || qtFiles.has(k)) return;
  pendingNames.delete(k);
  try {
    const to = targetName(j.p, j.title);
    if (to && fs.existsSync(j.p)) { moveNow(j.p, to); if (win && !win.isDestroyed()) win.webContents.send('clip-moved', { from: j.p, to, name: path.basename(to), url: pathToFileURL(to).href }); }
  } catch (e) { log('rename failed: ' + e.message); }
}
// Discord's "uuid" box at the end of the clip: its bytes and where the JSON sits in it
async function readDiscordBox(p, size) {
  let fh;
  try { fh = await fs.promises.open(p, 'r'); } catch (e) { return null; }
  try {
    const h = Buffer.alloc(16);
    let pos = 0;
    for (let n = 0; n < 64 && pos + 8 <= size; n++) {
      if ((await fh.read(h, 0, 16, pos)).bytesRead < 8) break;
      let len = h.readUInt32BE(0);
      const type = h.toString('latin1', 4, 8);
      if (len === 1) len = Number(h.readBigUInt64BE(8)); else if (len === 0) len = size - pos;
      if (len < 8) break;
      if (type === 'uuid' && len < (8 << 20)) {
        const b = Buffer.alloc(len);
        await fh.read(b, 0, len, pos);
        const i = b.indexOf('{"'), j = b.lastIndexOf('}');
        if (i > 0 && j > i) { try { const json = JSON.parse(b.toString('utf8', i, j + 1)); if (json && json.type === 'clip') return { b, i, j, json }; } catch (e) { /* not Discord's */ } }
      }
      pos += len;
    }
  } catch (e) { /* unreadable */ } finally { try { await fh.close(); } catch (e) { /* ignore */ } }
  return null;
}
function discordBoxWithLength(box, ms) {
  const json = Buffer.from(JSON.stringify({ ...box.json, length: ms }), 'utf8');
  const out = Buffer.concat([box.b.subarray(0, box.i), json, box.b.subarray(box.j + 1)]);
  const large = box.b.readUInt32BE(0) === 1;
  if (large) out.writeBigUInt64BE(BigInt(out.length), 8); else out.writeUInt32BE(out.length, 0);
  return out;
}

// ---------- clip library ----------
// Browses the folders clips get saved to: NVIDIA's (one subfolder per game, "Desktop" when no
// game was running) and Discord's (flat; each clip carries Discord's own info - game, time,
// who was in the call, a thumbnail). Both are found on their own; the user can add or remove
// folders, and that list is saved in settings.json.

const LIB_EXT = new Set(['mp4', 'mkv', 'mov', 'webm', 'm4v']);
const NV_DATE = /(\d{4})\.(\d{2})\.(\d{2}) - (\d{2})\.(\d{2})\.(\d{2})/; // "Game 2026.10.27 - 15.36.33.06.DVR.mp4"
// NVIDIA's names always end the time with hundredths ("15.36.33.06"); Encore's don't ("Desktop 2026.10.31 - 21.26.52.mp4")
const NV_HUNDREDTHS = /\d{4}\.\d{2}\.\d{2} - \d{2}\.\d{2}\.\d{2}\.\d{2}/;
const looksEncore = n => NV_DATE.test(n) && !NV_HUNDREDTHS.test(n) && !/\.DVR(_trim\d*)?\.\w+$/i.test(n);
// "Destiny_2_<uuid>.mp4", or newer "Battlefield_6_1426258143645532160.mp4"
const DISCORD_NAME = /^(.*)_(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{17,20})(?=\.\w+$|_trim)/i;
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings() { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch (e) { return {}; } }
function writeSettings(s) { try { fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 1)); } catch (e) { /* ignore */ } }
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };

let nvidiaRoot; // undefined = not looked up yet
function nvidiaFolder() {
  if (nvidiaRoot !== undefined || !IS_WIN) return Promise.resolve(nvidiaRoot || null);
  return new Promise(resolve => {
    execFile('reg', ['query', 'HKCU\\Software\\NVIDIA Corporation\\Global\\ShadowPlay\\NVSPCAPS', '/v', 'DefaultPathW'],
      { windowsHide: true, timeout: 5000 }, (err, out) => {
        let p = null;
        const m = !err && String(out).match(/DefaultPathW\s+REG_BINARY\s+([0-9A-Fa-f]+)/);
        if (m) p = Buffer.from(m[1], 'hex').toString('utf16le').replace(/\0[\s\S]*$/, '').trim();
        nvidiaRoot = p && isDir(p) ? p : null;
        resolve(nvidiaRoot);
      });
  });
}

// Encore (the recorder made to pair with this app) keeps its save folder in its own settings file
function encoreFolder() {
  if (!IS_WIN) return null;
  try {
    const p = JSON.parse(fs.readFileSync(path.join(app.getPath('appData'), 'Encore', 'settings.json'), 'utf8').replace(/^\uFEFF/, '')).output_dir;
    if (typeof p === 'string' && p.trim() && isDir(p.trim())) return p.trim();
  } catch (e) { /* not installed */ }
  const d = path.join(app.getPath('videos'), 'Encore');
  return isDir(d) ? d : null;
}

// Discord keeps its clip folder setting in its own database, but its clip logs say where each
// clip was saved, so take the folder of the most recent one.
let discordRoot;
function discordFolder() {
  if (discordRoot !== undefined) return discordRoot;
  discordRoot = null;
  const found = [];
  for (const flavor of ['discord', 'discordptb', 'discordcanary']) {
    const dir = path.join(app.getPath('appData'), flavor, 'logs');
    let names = [];
    try { names = fs.readdirSync(dir).filter(n => /clips/i.test(n)); } catch (e) { continue; }
    for (const n of names) {
      try {
        const full = path.join(dir, n), st = fs.statSync(full);
        const fd = fs.openSync(full, 'r'), len = Math.min(st.size, 2 << 20), b = Buffer.alloc(len);
        fs.readSync(fd, b, 0, len, st.size - len); fs.closeSync(fd);
        const re = /(?:save clip:|metadata box to)\s+(.+?\.mp4)/g;
        let m, last = null;
        while ((m = re.exec(b.toString('utf8')))) last = m[1];
        if (last) found.push({ t: st.mtimeMs, dir: path.dirname(last.trim()) });
      } catch (e) { /* ignore */ }
    }
  }
  found.sort((a, b) => b.t - a.t);
  const hit = found.find(f => isDir(f.dir));
  if (hit) discordRoot = hit.dir;
  return discordRoot;
}

// ---------- where exports go ----------
// Next to the clip they come from (Nov 4, 2026; his call), so a clip and its edited copy sit together
// wherever you browse. Tests send them to their own folder (BACKSTAGE_EXPORTS) so fixtures stay clean.
// Before 1.49.0 they went into one folder of their own (next to NVIDIA's folder, named after the app,
// one subfolder per game): that folder stays in the library while it exists, as "Old exports".
async function oldExportsDir() {
  if (process.env.BACKSTAGE_EXPORTS) return process.env.BACKSTAGE_EXPORTS;
  const s = readSettings();
  if (s.exportDir) return s.exportDir;
  const nv = await nvidiaFolder(), base = nv ? path.dirname(nv) : app.getPath('videos');
  for (const n of [APP_NAME, ...OLD_NAMES]) if (isDir(path.join(base, safeName(n)))) return path.join(base, safeName(n));
  return null;
}
const safeName = n => String(n || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim().slice(0, 80) || 'Other';
const hasFiles = d => { try { return !!d && fs.readdirSync(d).length > 0; } catch (e) { return false; } };
function exportFolder(src) {
  const dir = process.env.BACKSTAGE_EXPORTS || path.dirname(src);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function libFolders() {
  if (process.env.BACKSTAGE_LIBRARY) {
    const l = process.env.BACKSTAGE_LIBRARY.split(path.delimiter).map(p => ({ path: p, kind: 'folder' }));
    const ex = process.env.BACKSTAGE_EXPORTS;
    if (hasFiles(ex)) l.push({ path: ex, kind: 'trimmed' });
    return l;
  }
  const nv = await nvidiaFolder(), dc = discordFolder(), enc = encoreFolder(), ex = await oldExportsDir();
  const kindOf = p => (nv && samePath(p, nv) ? 'nvidia' : dc && samePath(p, dc) ? 'discord' : enc && samePath(p, enc) ? 'encore' : 'folder');
  const s = readSettings();
  // a saved folder list has never seen Encore: add it once (taking it out later sticks)
  if (enc && !(s.encoreSeen && samePath(s.encoreSeen, enc))) {
    if (Array.isArray(s.folders) && !s.folders.some(p => samePath(p, enc))) s.folders = [...s.folders, enc];
    s.encoreSeen = enc;
    writeSettings(s);
  }
  const list = (Array.isArray(s.folders) ? s.folders : [nv, dc, enc].filter(Boolean)).filter(p => typeof p === 'string' && !(ex && samePath(p, ex)));
  const out = list.map(p => ({ path: p, kind: kindOf(p), missing: !isDir(p) }));
  // the old exports folder stays in the library while it's there (Remove takes it out for good)
  if (hasFiles(ex) && !s.oldExportsOff) out.push({ path: ex, kind: 'trimmed' });
  return out;
}
async function detectedFolders() {
  return [await nvidiaFolder(), discordFolder(), encoreFolder()].filter(Boolean);
}

// Some Discord clips store names with the bytes of "®", "™" etc. read the wrong way
// ("Call of DutyÂ® Black Ops 7"). Turn them back, using Windows' own code page (cp1252).
const CP1252 = { 0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f };
function fixText(s) {
  s = String(s || '');
  if (!/[\u00c2-\u00f4][\u0080-\u00bf\u0152-\u2122]/.test(s)) return s;
  const bytes = [];
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 0x100) bytes.push(c); else if (CP1252[c] !== undefined) bytes.push(CP1252[c]); else return s;
  }
  const t = Buffer.from(bytes).toString('utf8');
  return t.includes('\ufffd') ? s : t;
}
// a game's name without trademark signs ("Battlefield™ 6" -> "Battlefield 6")
const cleanGame = n => fixText(n).replace(/[\u00ae\u2122\u00a9]/g, '').replace(/\s+/g, ' ').trim();

// Discord names a clip after the window when it isn't a game: browser tabs ("Home - Netflix -
// Your Microsoft Edge - Microsoft Edge"), whole screens ("Screen 1"), apps. Those all go under Desktop,
// same as NVIDIA's Desktop folder.
const BROWSER_END = /(microsoft\W{0,3}edge|google\W{0,3}chrome|chromium|mozilla\W{0,3}firefox|firefox|opera(\W{0,3}gx)?|brave|vivaldi|arc|zen browser|librewolf)\W*$/i;
const NOT_GAMES = new Set(['desktop', 'unknown', 'other', 'discord', 'spotify', 'fileexplorer', 'explorer', 'windowsexplorer',
  'obs', 'obsstudio', 'steam', 'epicgameslauncher', 'battlenet', 'riotclient', 'visualstudiocode', 'code', 'notepad',
  'snippingtool', 'photos', 'mediaplayer', 'windowsmediaplayer', 'vlc', 'vlcmediaplayer', 'netflix', 'youtube', 'twitch',
  'crunchyroll', 'disney', 'hulu', 'primevideo', 'peacock', 'settings', 'taskmanager', 'nvidiaapp', 'geforceexperience',
  'microsoftedge', 'googlechrome', 'chrome', 'firefox', 'opera', 'operagx', 'brave', 'whatsapp', 'telegram', 'slack', 'zoom', 'teams', 'microsoftteams']);
function isDesktopName(name) {
  const n = String(name || '').trim();
  if (!n) return true;
  if (/^screen\s*\d*$/i.test(n)) return true;
  if (BROWSER_END.test(n) && /\s[-|–—]\s/.test(n)) return true;
  return NOT_GAMES.has(n.toLowerCase().replace(/\.exe$/, '').replace(/[^a-z0-9]+/g, ''));
}

// A Discord file name cut short from a browser tab's title ("(1) Caedrel - Twitch", "Netflix -
// Personal -", "Caedrel - Twitch - Y"): a "(N) " unread count in front, or a site's name after a dash.
const SITES = /\s-\s*(twitch|youtube|netflix|disney|crunchyroll|peacock|hulu|prime video|max|spotify|weverse|kick|personal|google|reddit|x|twitter|instagram|tiktok|discord|microsoft)\b/i;
const looksLikeTab = n => /^\(\d+\)\s/.test(n) || SITES.test(n) || /\s-\s*$/.test(n);

// NVIDIA names folders after the game with ":" dropped ("Call of Duty  Black Ops 6") or after
// the exe when it doesn't know the game ("peak.exe")
const gameName = folder => folder.replace(/\.exe$/i, '').replace(/\s{2,}/g, ': ').trim() || 'Other';
// What a clip is. kind = its badge: discord | replay (NVIDIA Instant Replay) | echo (Encore's replay) |
// recording | export (made by Backstage) | other. type = the top filter: clip | recording | null.
// Every recorder marks its files its own way (Discord's info box, NVIDIA's names, Encore's tags);
// a new recorder gets its own line here. Old exports are named "..._trim"; new ones carry Backstage's tags.
const typeOfKind = k => (k === 'discord' || k === 'replay' || k === 'echo' ? 'clip' : k === 'recording' ? 'recording' : null);
function clipKind(name, meta, tags, source) {
  const base = name.replace(/_trim\d*(?=\.\w+$)/i, '');
  if (meta || DISCORD_NAME.test(name)) return 'discord';
  if (/\.DVR\.\w+$/i.test(base)) return 'replay';
  if (source === 'encore' || (tags && tags.encore) || looksEncore(base)) return tags && tags.encore_kind === 'replay' ? 'echo' : 'recording';
  if (NV_DATE.test(base)) return 'recording';
  return 'other';
}
function classify(name, meta, tags, k, source) {
  tags = tags || {};
  const exported = tags.backstage === 'export' || source === 'trimmed' || /_trim\d*\.\w+$/i.test(name);
  const was = k && k.kind ? k.kind : clipKind(name, meta, tags, source);
  const kind = exported ? 'export' : was;
  // Backstage's marker (exports, replaced originals) says what the original was, wherever the file goes
  const marked = tags.backstage && (tags.backstage_kind === 'clip' || tags.backstage_kind === 'recording') ? tags.backstage_kind : null;
  const type = marked || (k && k.type) || typeOfKind(was);
  return { kind, type, edited: kind === 'export' || tags.backstage === 'replaced' };
}

// Discord, NVIDIA or Encore - also for trims, whose names keep the original's
function clipOrigin(name, meta, kind) {
  if (kind === 'discord' || meta || DISCORD_NAME.test(name)) return 'discord';
  if (kind === 'encore' || (kind !== 'nvidia' && looksEncore(name))) return 'encore';
  if (kind === 'nvidia' || NV_DATE.test(name) || /\.DVR(_trim\d*)?\.\w+$/i.test(name)) return 'nvidia';
  return null;
}

// Discord stores its clip info as JSON in a "uuid" box at the end of the mp4
async function readDiscordMeta(p, size) {
  let fh;
  try { fh = await fs.promises.open(p, 'r'); } catch (e) { return null; }
  try {
    const h = Buffer.alloc(16);
    let pos = 0;
    for (let n = 0; n < 64 && pos + 8 <= size; n++) {
      if ((await fh.read(h, 0, 16, pos)).bytesRead < 8) break;
      let len = h.readUInt32BE(0), hdr = 8;
      const type = h.toString('latin1', 4, 8);
      if (len === 1) { len = Number(h.readBigUInt64BE(8)); hdr = 16; } else if (len === 0) len = size - pos;
      if (len < hdr) break;
      if (type === 'uuid' && len < (8 << 20)) {
        const b = Buffer.alloc(len - hdr);
        await fh.read(b, 0, b.length, pos + hdr);
        const txt = b.toString('utf8'), i = txt.indexOf('{"');
        if (i >= 0) {
          const body = txt.slice(i, txt.lastIndexOf('}') + 1);
          try { const j = JSON.parse(body); if (j && j.type === 'clip') return j; } catch (e) { /* not Discord's */ }
        }
      }
      pos += len;
    }
  } catch (e) { /* unreadable */ } finally { try { await fh.close(); } catch (e) { /* ignore */ } }
  return null;
}

// Tags inside an MP4 (moov > udta > meta): the plain ones ffmpeg writes (©cmt "comment" etc.) and
// named ones (keys box, written with -movflags use_metadata_tags): Encore's encore_kind / encore_game,
// Backstage's own backstage_* marker. Small reads only: the box headers, then udta itself.
// Each recorder marks its files its own way; new ones get their tags read here.
async function readMp4Tags(p, size) {
  let fh;
  try { fh = await fs.promises.open(p, 'r'); } catch (e) { return null; }
  const head = Buffer.alloc(16);
  const box = async (pos, end) => {
    if (pos + 8 > end || (await fh.read(head, 0, 16, pos)).bytesRead < 8) return null;
    let len = head.readUInt32BE(0), hdr = 8;
    if (len === 1) { len = Number(head.readBigUInt64BE(8)); hdr = 16; } else if (len === 0) len = end - pos;
    if (len < hdr || pos + len > end) return null;
    return { type: head.toString('latin1', 4, 8), pos, len, hdr };
  };
  const tags = {};
  const parseMeta = b => {
    // a full box (version/flags) in MP4 files, a plain one in some QuickTime files
    let off = b.toString('latin1', 4, 8) === 'hdlr' ? 0 : 4;
    const keys = [];
    let ilst = null;
    while (off + 8 <= b.length) {
      const len = b.readUInt32BE(off), type = b.toString('latin1', off + 4, off + 8);
      if (len < 8 || off + len > b.length) break;
      if (type === 'keys') {
        const n = b.readUInt32BE(off + 12);
        let k = off + 16;
        for (let i = 0; i < n && k + 8 <= off + len; i++) { const kl = b.readUInt32BE(k); if (kl < 8) break; keys.push(b.toString('utf8', k + 8, k + kl)); k += kl; }
      } else if (type === 'ilst') ilst = [off + 8, off + len];
      off += len;
    }
    if (!ilst) return;
    for (let i = ilst[0]; i + 8 <= ilst[1];) {
      const len = b.readUInt32BE(i);
      if (len < 8 || i + len > ilst[1]) break;
      const idx = b.readUInt32BE(i + 4), four = b.toString('latin1', i + 4, i + 8);
      const name = idx >= 1 && idx <= keys.length ? keys[idx - 1] : four === '©cmt' ? 'comment' : null;
      // the value: a 'data' box (type, locale, then the text)
      if (name && len >= 24 && b.toString('latin1', i + 12, i + 16) === 'data') {
        const dl = b.readUInt32BE(i + 8);
        tags[name.toLowerCase()] = b.toString('utf8', i + 24, i + 8 + Math.min(dl, len - 8)).replace(/\0+$/, '');
      }
      i += len;
    }
  };
  try {
    let moov = null;
    for (let pos = 0, n = 0; n < 64; n++) { const b = await box(pos, size); if (!b) break; if (b.type === 'moov') { moov = b; break; } pos += b.len; }
    if (!moov) return tags;
    const end = moov.pos + moov.len;
    const read = async b => { const buf = Buffer.alloc(b.len - b.hdr); await fh.read(buf, 0, buf.length, b.pos + b.hdr); return buf; };
    for (let pos = moov.pos + moov.hdr, n = 0; n < 256; n++) {
      const b = await box(pos, end);
      if (!b) break;
      if (b.type === 'meta' && b.len < (1 << 20)) parseMeta(await read(b));
      if (b.type === 'udta' && b.len < (1 << 20)) {
        const u = await read(b);
        for (let i = 0; i + 8 <= u.length;) {
          const len = u.readUInt32BE(i);
          if (len < 8 || i + len > u.length) break;
          if (u.toString('latin1', i + 4, i + 8) === 'meta') parseMeta(u.subarray(i + 8, i + len));
          i += len;
        }
      }
      pos += b.len;
    }
  } catch (e) { /* unreadable: whatever was found */ } finally { try { await fh.close(); } catch (e) { /* ignore */ } }
  return tags;
}

const thumbDir = () => path.join(app.getPath('userData'), 'thumbs');
let thumbIndex = null, indexTimer = null;
function loadIndex() {
  if (!thumbIndex) { try { thumbIndex = JSON.parse(fs.readFileSync(path.join(thumbDir(), 'index.json'), 'utf8')); } catch (e) { thumbIndex = {}; } }
  return thumbIndex;
}
function saveIndexSoon() {
  clearTimeout(indexTimer);
  indexTimer = setTimeout(() => {
    try { fs.mkdirSync(thumbDir(), { recursive: true }); fs.writeFileSync(path.join(thumbDir(), 'index.json'), JSON.stringify(thumbIndex)); } catch (e) { /* ignore */ }
  }, 1000);
}
const thumbKey = (p, st) => require('crypto').createHash('sha1')
  .update(p.toLowerCase() + '|' + st.size + '|' + Math.round(st.mtimeMs)).digest('hex').slice(0, 20);

// What we know about a file without decoding it: Discord's info (read once, then cached).
async function fileFacts(full, name, st) {
  const idx = loadIndex(), key = thumbKey(full, st);
  let e = idx[key];
  if (!e || e.metaChecked === undefined) {
    e = e || {};
    e.metaChecked = true;
    const mayHaveMeta = /\.mp4$/i.test(name) && !NV_DATE.test(name);
    const j = mayHaveMeta ? await readDiscordMeta(full, st.size) : null;
    if (j) {
      e.meta = {
        app: typeof j.applicationName === 'string' ? j.applicationName : '',
        createdAt: Number(j.createdAt) || 0,
        users: Array.isArray(j.users) ? j.users.map(String) : [],
      };
      if (j.length > 0) e.duration = j.length / 1000;
      // Discord's own thumbnail saves generating one
      const m = typeof j.thumbnail === 'string' && j.thumbnail.match(/^data:image\/jpeg;base64,(.+)$/);
      if (m) {
        try {
          fs.mkdirSync(thumbDir(), { recursive: true });
          fs.writeFileSync(path.join(thumbDir(), key + '.jpg'), Buffer.from(m[1], 'base64'));
          e.thumbReady = true;
        } catch (err) { /* make one later */ }
      }
    }
    idx[key] = e;
    saveIndexSoon();
  }
  // the file's own tags (recorder and Backstage markers); older index entries get them once
  if (e.tagsV !== 2) { // 2: Encore 0.9.36's tags
    e.tagsV = 2;
    const t = /\.(mp4|m4v|mov)$/i.test(name) ? await readMp4Tags(full, st.size) : null;
    e.tags = {};
    // Encore's (its file contract: one-line values up to 200 characters, unknown tags ignored) and Backstage's own
    for (const k of ['encore_kind', 'encore_game', 'encore_id', 'backstage', 'backstage_kind', 'backstage_origin', 'backstage_game', 'backstage_date']) if (t && t[k]) e.tags[k] = String(t[k]).slice(0, 200);
    if (t && Object.keys(t).some(k => k.startsWith('encore_'))) e.tags.encore = '1'; // any encore_ tag: Encore made it (a recovered file has only encore_id)
    saveIndexSoon();
  }
  return { key, e };
}

// a clip's date, game, kind and recorder, from (in order) Discord's info, Backstage's and the recorder's
// tags inside the file, what was kept when Backstage renamed it, the folder, the file name
function clipFacts(name, st, e, folder, source) {
  const meta = e.meta || null, tags = e.tags || {}, k = kept.all()[nameKey(st, meta, tags)] || null;
  const base = name.replace(/_trim\d*(?=\.\w+$)/i, '');
  const nv = base.match(NV_DATE), dn = name.match(DISCORD_NAME);
  const own = Number(tags.backstage_date) || 0;
  const date = meta && meta.createdAt ? meta.createdAt : own || (k && k.date)
    || (nv ? new Date(+nv[1], +nv[2] - 1, +nv[3], +nv[4], +nv[5], +nv[6]).getTime() : st.mtimeMs);
  const named = tags.backstage_game || tags.encore_game || (k && k.game) || '';
  let game = meta && meta.app ? cleanGame(meta.app)
    : named ? cleanGame(named)
    : folder !== null && folder !== undefined ? gameName(folder)
    : dn ? dn[1].replace(/_/g, ' ').trim() : 'Other';
  const rawGame = game;
  if (game !== 'Other' && isDesktopName(game)) game = 'Desktop';
  const c = classify(name, meta, tags, k, source);
  const origin = tags.backstage_origin && SOURCES.has(tags.backstage_origin) ? tags.backstage_origin : (k && k.origin) || (tags.encore ? 'encore' : clipOrigin(base, meta, source));
  return { date, game, rawGame, fromName: !(meta && meta.app) && !named && (folder === null || folder === undefined) && !!dn, ...c, origin };
}
const SOURCES = new Set(['discord', 'nvidia', 'encore']);

async function scanFolder(root, kind, out, progress) {
  const walk = async (dir, folder, sub, depth) => {
    let ents;
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const d of ents) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (d.name.startsWith('.')) continue; // our own hidden folders (named copies)
        if (depth < 4) await walk(full, folder === null ? d.name : folder, folder === null ? '' : (sub ? sub + '/' : '') + d.name, depth + 1);
        continue;
      }
      if (!d.isFile() || !LIB_EXT.has(path.extname(d.name).slice(1).toLowerCase())) continue;
      let st;
      try { st = await fs.promises.stat(full); } catch (e) { continue; }
      const { e } = await fileFacts(full, d.name, st);
      progress();
      const meta = e.meta || null;
      const f = clipFacts(d.name, st, e, folder, kind);
      out.push({
        path: full, root, url: pathToFileURL(full).href, name: d.name, sub, date: f.date, size: st.size, mtime: Math.round(st.mtimeMs),
        source: kind, kind: f.kind, type: f.type, edited: f.edited, origin: f.origin, gameName: f.game, rawGame: f.rawGame, fromName: f.fromName,
        duration: e.error ? null : (e.duration || null), users: meta ? meta.users : [], edit: editFor(full),
        title: names.all()[nameKey(st, meta, e.tags)] || null,
      });
    }
  };
  await walk(root, null, '', 0);
}

let scanning = null;
async function scanLibrary() {
  const folders = await libFolders();
  const clipsOut = [];
  let n = 0;
  const progress = () => { if (++n % 100 === 0 && win && !win.isDestroyed()) win.webContents.send('lib-progress', n); };
  for (const f of folders) if (!f.missing) await scanFolder(f.path, f.kind, clipsOut, progress);
  // Discord cuts long game names short in file names ("Warhammer_40000_Da"); older clips have
  // nothing else, so match them to the full name newer clips carry
  const flat = x => x.toLowerCase().replace(/[^a-z0-9]+/g, '');
  // (the full names are compared before browser tabs etc. became "Desktop", so a cut-short tab title
  // finds its tab and goes to Desktop with it)
  const full = [...new Set(clipsOut.filter(c => !c.fromName && c.source !== 'nvidia').map(c => c.rawGame || c.gameName))];
  for (const c of clipsOut) {
    if (!c.fromName) continue;
    const f = flat(c.gameName);
    const hit = f.length >= 4 && full.find(n => flat(n).startsWith(f));
    if (hit) c.gameName = isDesktopName(hit) ? 'Desktop' : hit;
    else if (looksLikeTab(c.gameName)) c.gameName = 'Desktop';
  }
  for (const c of clipsOut) delete c.rawGame;
  // the same game from different folders ("Peak" and "peak.exe", NVIDIA and Discord, "Overwatch"
  // and "Overwatch 2") becomes one entry: by Discord's list of games when the name is in it, else
  // by its letters and numbers. Named after whichever spelling has the most clips.
  const idx = await Promise.race([loadGameIndex().catch(() => null), new Promise(r => setTimeout(() => r(null), 4000))]);
  const appOf = new Map();
  const keyOf = name => {
    const plain = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() || 'other';
    if (!idx || /^(desktop|other)$/i.test(name)) return plain;
    if (!appOf.has(name)) { let hit = null; for (const k of nameVariants(name)) { hit = idx.get(k); if (hit) break; } appOf.set(name, hit ? 'app:' + hit.id : plain); }
    return appOf.get(name);
  };
  const games = new Map();
  for (const c of clipsOut) {
    const key = keyOf(c.gameName);
    let g = games.get(key);
    if (!g) { g = { key, names: new Map(), count: 0, size: 0, latest: 0, latestPath: null }; games.set(key, g); }
    g.names.set(c.gameName, (g.names.get(c.gameName) || 0) + 1);
    g.count++; g.size += c.size;
    if (c.date > g.latest) { g.latest = c.date; g.latestPath = c.path; }
    c.game = key;
  }
  const list = [...games.values()].map(g => ({
    key: g.key, count: g.count, size: g.size, latest: g.latest, latestPath: g.latestPath,
    name: [...g.names.entries()].sort((a, b) => b[1] - a[1] || (/[A-Z]/.test(b[0][0]) - /[A-Z]/.test(a[0][0])))[0][0],
  })).sort((a, b) => b.latest - a.latest);
  const names = new Map(list.map(g => [g.key, g.name]));
  for (const c of clipsOut) c.gameName = names.get(c.game);
  watchFolders(folders.filter(f => !f.missing).map(f => f.path));
  // whoever saved most of the Discord clips here is the person using this PC
  const savers = new Map();
  for (const c of clipsOut) if (c.users && c.users[0]) savers.set(c.users[0], (savers.get(c.users[0]) || 0) + 1);
  const top = [...savers.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] >= 3) {
    const s = readSettings();
    if (s.discordId !== top[0]) { s.discordId = top[0]; writeSettings(s); }
  }
  return { folders, detected: await detectedFolders(), custom: Array.isArray(readSettings().folders), games: list, clips: clipsOut };
}

// thumbnails: one frame from about a third of the way in, cached by path + size + date
const thumbQueue = [], thumbJobs = new Map();
let thumbBusy = 0;
function libThumb(p) {
  if (thumbJobs.has(p)) return thumbJobs.get(p);
  const pr = new Promise(resolve => { thumbQueue.push({ p, resolve }); pumpThumbs(); });
  thumbJobs.set(p, pr);
  pr.then(() => thumbJobs.delete(p));
  return pr;
}
function pumpThumbs() {
  while (thumbBusy < 3 && thumbQueue.length) {
    const job = thumbQueue.pop(); // newest request first: that's what's on screen
    thumbBusy++;
    makeThumb(job.p).catch(() => ({ error: true })).then(r => { thumbBusy--; job.resolve(r); pumpThumbs(); });
  }
}
async function makeThumb(p) {
  const st = fs.statSync(p);
  const { key, e } = await fileFacts(p, path.basename(p), st);
  const file = path.join(thumbDir(), key + '.jpg');
  const url = () => pathToFileURL(file).href + '?' + key;
  if (e.error && e.errV === 2) return { error: true };
  if ((e.thumbReady || e.thumbMade) && e.duration && fs.existsSync(file)) return { duration: e.duration, url: url() };
  const info = await ffInfo(p);
  if (!info.video) { if (Date.now() - st.mtimeMs > 120000) { e.error = true; e.errV = 2; saveIndexSoon(); } return { error: true }; }
  delete e.error;
  const codec = (info.video.match(/^(\w+)/) || [])[1];
  e.duration = e.duration || info.duration || 0;
  if (!(e.thumbReady && fs.existsSync(file))) {
    fs.mkdirSync(thumbDir(), { recursive: true });
    const d = e.duration, t = d > 1 ? Math.min(d * 0.3, d - 0.5) : 0;
    const ok = await new Promise(resolve => {
      const c = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...av1In(codec), '-ss', t.toFixed(2), '-i', p,
        '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', file], { windowsHide: true });
      c.on('error', () => resolve(false));
      c.on('close', code => resolve(code === 0 && fs.existsSync(file)));
    });
    // a file that's still being written fails now but will work later, so don't remember that
    if (!ok) { if (Date.now() - st.mtimeMs > 120000) { e.error = true; e.errV = 2; saveIndexSoon(); } return { error: true, duration: e.duration }; }
    e.thumbMade = true;
  }
  saveIndexSoon();
  return { duration: e.duration, url: url() };
}

// ---------- game icons ----------
// Discord publishes the list of games it can detect, each with an icon. NVIDIA names its folders
// after the game, so most folders match a name (or alias) in that list. The list is refreshed
// weekly; icons are downloaded once and kept.
const iconDir = () => path.join(app.getPath('userData'), 'icons');
let gameIndex = null, gameIndexLoading = null;
const flatName = x => String(x).toLowerCase().replace(/[^a-z0-9]+/g, '');
async function loadGameIndex() {
  if (gameIndex) return gameIndex;
  if (gameIndexLoading) return gameIndexLoading;
  gameIndexLoading = (async () => {
    const file = path.join(app.getPath('userData'), 'games.json');
    let list = null;
    try {
      const st = fs.statSync(file);
      if (Date.now() - st.mtimeMs < 7 * 24 * 3600 * 1000) list = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) { /* not downloaded yet */ }
    if (!list) {
      try {
        const res = await net.fetch('https://discord.com/api/v9/applications/detectable');
        if (res.ok) {
          const all = await res.json();
          // keep only what's needed: about 1 MB instead of 13
          list = all.filter(a => a && a.icon_hash && a.name).map(a => [a.id, a.icon_hash, a.name, ...(a.aliases || [])]);
          fs.writeFileSync(file, JSON.stringify(list));
        }
      } catch (e) { /* offline */ }
      if (!list) { try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { list = []; } }
    }
    const idx = new Map();
    for (const [id, icon, ...names] of list) for (const n of names) { const k = flatName(n); if (k && !idx.has(k)) idx.set(k, { id, icon }); }
    gameIndex = idx;
    return idx;
  })();
  return gameIndexLoading;
}
// ways the same game gets written: "Modern Warfare 2 (2022)" / "Modern Warfare II", "Overwatch 2" / "Overwatch"
function nameVariants(name) {
  const roman = { ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7' };
  const out = new Set();
  const add = n => { const k = flatName(n); if (k.length >= 3) out.add(k); };
  const base = name.replace(/\.exe$/i, '').replace(/\s{2,}/g, ': ');
  const noParen = base.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  for (const n of [base, noParen, base.replace(/:/g, ''), noParen.replace(/:/g, '')]) {
    add(n);
    add(n.replace(/\b(ii|iii|iv|vi|vii)\b/gi, m => roman[m.toLowerCase()]));
    add(n.replace(/\b([2-7])\b/g, d => Object.keys(roman).find(k => roman[k] === d)));
    add(n.replace(/\s+\d+$/, ''));
  }
  return [...out];
}
const iconJobs = new Map();
async function gameIcon(name) {
  if (!name || /^(desktop|other)$/i.test(name)) return null;
  const idx = await loadGameIndex();
  let hit = null;
  for (const k of nameVariants(name)) { hit = idx.get(k); if (hit) break; }
  if (!hit) return null;
  const file = path.join(iconDir(), `${hit.id}-${hit.icon}.png`);
  if (fs.existsSync(file)) return pathToFileURL(file).href;
  if (!iconJobs.has(file)) {
    iconJobs.set(file, (async () => {
      try {
        const res = await net.fetch(`https://cdn.discordapp.com/app-icons/${hit.id}/${hit.icon}.png?size=128`);
        if (!res.ok) return null;
        fs.mkdirSync(iconDir(), { recursive: true });
        fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
        return pathToFileURL(file).href;
      } catch (e) { return null; } finally { setTimeout(() => iconJobs.delete(file), 60000); }
    })());
  }
  return iconJobs.get(file);
}

// new clips show up without a refresh
const watchers = new Map(); // folder -> fs.FSWatcher
let libTimer = null;
function watchFolders(list) {
  for (const [p, w] of watchers) if (!list.some(x => samePath(x, p))) { try { w.close(); } catch (e) { /* ignore */ } watchers.delete(p); }
  for (const p of list) {
    if ([...watchers.keys()].some(x => samePath(x, p))) continue;
    try {
      const w = fs.watch(p, { recursive: true }, () => {
        if (libTimer) return; // at most one refresh every 2 s, even while a recording is being written
        libTimer = setTimeout(() => { libTimer = null; if (win && !win.isDestroyed()) win.webContents.send('lib-changed'); }, 2000);
      });
      w.on('error', () => { /* folder went away */ });
      watchers.set(p, w);
    } catch (e) { /* not watchable */ }
  }
}
function inLibrary(p) {
  if (typeof p !== 'string') return false;
  for (const root of watchers.keys()) {
    const rel = path.relative(root, p);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true;
  }
  return false;
}
async function setFolders(list) {
  const s = readSettings();
  s.folders = list;
  writeSettings(s);
}

// ---------- IPC ----------

const wrap = fn => async (...a) => {
  try { return { ok: true, ...(await fn(...a)) }; }
  catch (e) { return { ok: false, error: e.message || String(e) }; }
};
// a clip the app may read and export: in the clip folders, or opened by the user
const allowed = p => typeof p === 'string' && (inLibrary(p) || opened.has(editKey(p)) || fxAllowed.has(editKey(p)));

// ---------- byte access for the player and the audio engine ----------
// The overlay decodes the clip itself (renderer/gpuplayer.mjs, engine.mjs) and asks for byte
// ranges. Only clips open in the overlay can be read.
const fds = new Map(); // path -> file descriptor
const readable = p => qtFiles.has(editKey(p)) || fxAllowed.has(editKey(p)); // open clips and the sounds added to them
function fdFor(p) {
  if (!readable(p)) throw new Error('Not an open file.');
  let fd = fds.get(p);
  if (fd === undefined) { fd = fs.openSync(p, 'r'); fds.set(p, fd); }
  return fd;
}
function closeFd(p) {
  for (const [k, fd] of fds) if (samePath(k, p)) { try { fs.closeSync(fd); } catch (e) { /* ignore */ } fds.delete(k); }
}
function closeUnusedFds() {
  for (const [p, fd] of fds) if (!readable(p)) { try { fs.closeSync(fd); } catch (e) { /* ignore */ } fds.delete(p); }
}
ipcMain.handle('file-size', (_e, p) => fs.fstatSync(fdFor(p)).size);
ipcMain.handle('read-range', (_e, p, start, end) => {
  const fd = fdFor(p);
  const len = Math.max(0, Math.min(end - start, 64 * 1024 * 1024));
  const b = Buffer.allocUnsafe(len);
  const n = fs.readSync(fd, b, 0, len, start);
  return new Uint8Array(b.buffer, b.byteOffset, n);
});

ipcMain.handle('qt-open', wrap(async (_e, p) => {
  if (!allowed(p) || !fs.existsSync(p)) throw new Error("That clip isn't there anymore.");
  const info = await probeVideo(p);
  qtFiles.add(editKey(p));
  return { info: { ...info, path: p, groups: audioGroups(info) }, edit: editFor(p), title: await titleOf(p) };
}));
ipcMain.handle('qt-close', (_e, p) => { qtFiles.delete(editKey(p)); closeUnusedFds(); renamePending(p); });
ipcMain.handle('qt-wave', wrap(async (_e, p, dur, buckets, tracks) => {
  if (!qtFiles.has(editKey(p))) throw new Error('Not open.');
  return { peaks: await waveform(p, dur, Math.max(50, Math.min(4000, buckets | 0)), tracks) };
}));
ipcMain.handle('qt-edit', wrap(async (_e, p, e) => { if (!allowed(p)) throw new Error('Not a library clip.'); setEdit(p, e); return {}; }));
ipcMain.handle('qt-export', wrap((_e, o) => qtExport(o || {})));
ipcMain.handle('qt-replace', wrap((_e, o) => qtReplace(o || {})));
// make a trim ahead of time (while editing, hovering a card): o = { path, start?, end?, audio? }
ipcMain.handle('qt-prepare', wrap(async (_e, o) => {
  const src = o && o.path;
  if (!allowed(src) || !fs.existsSync(src)) return {};
  const j = await savedJob(src, o);
  if (!j.untouched && j.end > j.start) prepare(src, j);
  return {};
}));
// ---------- effects: pictures, sounds and the editor's drawn layers ----------
ipcMain.handle('fx-png', wrap(async (_e, dataUrl) => {
  const m = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('Not a picture.');
  const b = Buffer.from(m[1], 'base64');
  const name = require('crypto').createHash('sha1').update(b).digest('hex') + '.png';
  const f = fxFile(name);
  if (!fs.existsSync(f)) fs.writeFileSync(f, b);
  return { name };
}));
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);
const SND_EXT = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus', 'wma']);
async function fxFileInfo(p) {
  const ext = path.extname(p).slice(1).toLowerCase();
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error("That file isn't there.");
  if (IMG_EXT.has(ext)) {
    const b = fs.readFileSync(p);
    const file = require('crypto').createHash('sha1').update(b).digest('hex') + '.' + ext;
    if (!fs.existsSync(fxFile(file))) fs.writeFileSync(fxFile(file), b);
    return { kind: 'image', name: path.basename(p), file, url: pathToFileURL(fxFile(file)).href };
  }
  if (SND_EXT.has(ext)) {
    const i = await ffInfo(p);
    if (!i.audio.length || !(i.duration > 0)) throw new Error('That file has no sound.');
    fxAllowed.add(editKey(p));
    return { kind: 'audio', name: path.basename(p, path.extname(p)), path: p, dur: i.duration };
  }
  throw new Error('Only pictures (png, jpg) and sounds (mp3, wav, m4a) can be added.');
}
ipcMain.handle('fx-pick', wrap(async (_e, kind) => {
  const image = kind === 'image';
  const r = await dialog.showOpenDialog(win, {
    title: image ? 'Add a picture' : 'Add audio',
    filters: image ? [{ name: 'Pictures', extensions: [...IMG_EXT] }] : [{ name: 'Sound', extensions: [...SND_EXT] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0]) return { cancelled: true };
  return fxFileInfo(r.filePaths[0]);
}));
ipcMain.handle('fx-file', wrap((_e, p) => fxFileInfo(String(p || ''))));
// added sounds saved with a clip: the editor may read them again (if they're still there)
ipcMain.handle('fx-allow', wrap(async (_e, list) => ({
  found: (Array.isArray(list) ? list : []).map(p => {
    const ok = typeof p === 'string' && SND_EXT.has(path.extname(p).slice(1).toLowerCase()) && fs.existsSync(p);
    if (ok) fxAllowed.add(editKey(p));
    return ok;
  }),
})));
ipcMain.handle('fx-wave', wrap(async (_e, p, dur, buckets) => {
  if (!fxAllowed.has(editKey(p))) throw new Error('Not an added sound.');
  return { peaks: await waveform(p, dur, Math.max(50, Math.min(4000, buckets | 0)), [0]) };
}));
// copy files to the clipboard: clips, or files the app just made
ipcMain.handle('copy-files', wrap(async (_e, list) => {
  const tmp = path.resolve(copyDir()).toLowerCase() + path.sep;
  const ok = (Array.isArray(list) ? list : []).filter(p => typeof p === 'string' && fs.existsSync(p) && (allowed(p) || state.outputs.has(p) || path.resolve(p).toLowerCase().startsWith(tmp)));
  if (!ok.length) throw new Error("Those clips aren't there anymore.");
  await copyFileToClipboard(ok.length === 1 ? ok[0] : ok);
  return {};
}));
// Copy Video for clips as they're saved (cards): their trims, audio and names
ipcMain.handle('copy-clips', wrap(async (_e, list) => {
  const outs = [];
  for (const p of (Array.isArray(list) ? list : [])) {
    if (!allowed(p) || !fs.existsSync(p)) continue;
    const { out } = await fileFor(p, {});
    state.outputs.add(out);
    outs.push(out);
  }
  if (!outs.length) throw new Error("Those clips aren't there anymore.");
  await copyFileToClipboard(outs.length === 1 ? outs[0] : outs);
  return { files: outs.map(o => ({ out: o, size: fs.statSync(o).size })) };
}));

// ---------- names ----------
ipcMain.handle('clip-rename', wrap(async (_e, p, title) => {
  if (!allowed(p) || !fs.existsSync(p)) throw new Error("That clip isn't there anymore.");
  const st = fs.statSync(p);
  const { e } = await fileFacts(p, path.basename(p), st);
  const all = names.all(), key = nameKey(st, e.meta, e.tags), t = cleanTitle(title);
  if (t) all[key] = t; else delete all[key];
  names.save();
  dropPrepared(p); // ready-made copies carry the old name
  pendingNames.delete(editKey(p));
  // Settings > File names: the file is renamed too (an open clip once the editor lets go of it)
  if (t && renameFiles() && targetName(p, t)) {
    await keepFacts(p);
    if (qtFiles.has(editKey(p))) { pendingNames.set(editKey(p), { p, title: t }); return { title: t, pending: true }; }
    const to = targetName(p, t);
    if (to) { moveNow(p, to); return { title: t, path: to, name: path.basename(to), url: pathToFileURL(to).href }; }
  }
  return { title: t || null };
}));
ipcMain.handle('person-name', wrap(async (_e, id, name) => {
  if (!/^\d{5,25}$/.test(String(id))) throw new Error('Unknown person.');
  const all = people.all(), t = cleanTitle(name).slice(0, 40);
  if (t) all[id] = t; else delete all[id];
  people.save();
  return { name: t || null };
}));

// ---------- dragging clips out (into Discord, a folder, ...) ----------
// The file has to exist the moment the drag starts, so it's made ahead (when the card is hovered
// or pressed); drag-ready answers right away with what's there.
const dragFiles = new Map(); // clip path -> { out, sig }
const dragSig = p => { try { const st = fs.statSync(p); return JSON.stringify([st.size, st.mtimeMs, editFor(p), names.all()]); } catch (e) { return ''; } };
ipcMain.handle('drag-prepare', wrap(async (_e, p) => {
  if (!allowed(p) || !fs.existsSync(p)) throw new Error("That clip isn't there anymore.");
  const sig = dragSig(p), have = dragFiles.get(editKey(p));
  if (have && have.sig === sig && fs.existsSync(have.out)) return { out: have.out };
  const { out } = await fileFor(p, {});
  dragFiles.set(editKey(p), { out, sig });
  return { out };
}));
ipcMain.on('drag-ready', (e, p) => {
  const have = allowed(p) && dragFiles.get(editKey(p));
  e.returnValue = have && have.sig === dragSig(p) && fs.existsSync(have.out) ? have.out : null;
});
ipcMain.on('drag-start', async (e, p, file, picture) => {
  // the clip itself (untouched, no name), or the file made for it
  const have = dragFiles.get(editKey(p));
  if (!allowed(p) || !fs.existsSync(file) || !(samePath(file, p) || (have && have.out === file))) return;
  let icon = null;
  // the card-like picture the window drew (at 2x, so it's sharp on high-DPI screens)
  if (typeof picture === 'string' && /^data:image\/png;base64,/.test(picture) && picture.length < 3e6) {
    try { const img = nativeImage.createEmpty(); img.addRepresentation({ scaleFactor: 2, dataURL: picture }); if (!img.isEmpty()) icon = img; } catch (err) { icon = null; }
  }
  if (!icon) try {
    const st = fs.statSync(p);
    const t = path.join(thumbDir(), thumbKey(p, st) + '.jpg');
    if (fs.existsSync(t)) icon = nativeImage.createFromPath(t).resize({ width: 96 });
  } catch (err) { /* use the app's icon */ }
  if (!icon || icon.isEmpty()) icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 48 });
  e.sender.startDrag({ file, icon });
});

ipcMain.handle('qt-encoder', wrap(async () => ({ name: (await pickEncoder()).name })));
ipcMain.handle('cancel', wrap(async () => {
  state.cancelled = true;
  for (const c of state.kids) { try { c.kill(); } catch (e) { /* ignore */ } }
  return {};
}));
ipcMain.handle('reveal', wrap(async (_e, p) => {
  if (!state.outputs.has(p) && !allowed(p)) throw new Error('Unknown file.');
  shell.showItemInFolder(p);
  return {};
}));

// ---------- opening files from outside the clip folders ----------
// A clip as the library lists it, for any video file (Open file, drag and drop, paste)
async function clipFor(p) {
  p = cleanPath(p);
  let st;
  try { st = fs.statSync(p); } catch (e) { throw new Error('File not found: ' + p); }
  if (!st.isFile()) throw new Error('That is not a file.');
  if (!VIDEO_EXT.includes(path.extname(p).slice(1).toLowerCase())) throw new Error(`${path.basename(p)} isn't a video the app can open.`);
  const { e } = await fileFacts(p, path.basename(p), st);
  const meta = e.meta || null;
  if (!inLibrary(p)) opened.add(editKey(p));
  const lib = (await libFolders()).find(f => !f.missing && inside(f.path, p));
  const f = clipFacts(path.basename(p), st, e, null, lib && lib.kind);
  return {
    path: p, root: lib ? lib.path : null, url: pathToFileURL(p).href, name: path.basename(p), sub: '', date: f.date, size: st.size,
    source: lib ? lib.kind : 'file', kind: f.kind, type: f.type, edited: f.edited, origin: f.origin,
    gameName: meta && meta.app ? cleanGame(meta.app) : f.fromName || f.game !== 'Other' ? f.game : lib ? '' : 'Opened file', game: '', duration: e.duration || null,
    users: meta ? meta.users : [], edit: editFor(p), title: names.all()[nameKey(st, meta, e.tags)] || null, external: !lib,
  };
}
ipcMain.handle('open-path', wrap(async (_e, p) => ({ clip: await clipFor(p) })));
ipcMain.handle('pick', wrap(async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Open a video clip',
    defaultPath: app.getPath('videos'),
    properties: ['openFile'],
    filters: [{ name: 'Video', extensions: VIDEO_EXT }, { name: 'All files', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePaths[0]) return { clip: null };
  return { clip: await clipFor(r.filePaths[0]) };
}));
ipcMain.handle('clipboard-file', wrap(async () => {
  const p = await clipboardPath();
  if (!p) throw new Error('No video on the clipboard. Copy a video file in File Explorer first.');
  return { clip: await clipFor(p) };
}));
ipcMain.handle('path-kind', (_e, p) => { try { const st = fs.statSync(cleanPath(p)); return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null; } catch (e) { return null; } });
ipcMain.handle('lib-add-folder-path', wrap(async (_e, p) => {
  p = cleanPath(p);
  if (!isDir(p)) throw new Error("That folder isn't there.");
  const cur = await libFolders();
  if (cur.some(f => samePath(f.path, p))) return { changed: false, already: true };
  await setFolders([...cur.filter(f => f.kind !== 'trimmed').map(f => f.path), p]);
  return { changed: true, added: p };
}));

ipcMain.handle('lib-scan', wrap(async () => {
  if (!scanning) scanning = scanLibrary().finally(() => { scanning = null; });
  return scanning;
}));
ipcMain.handle('game-icon', async (_e, name) => {
  try { return await gameIcon(String(name || '')); } catch (e) { return null; }
});
ipcMain.handle('lib-save-thumb', async (_e, p, dataUrl, duration) => {
  try {
    if (!allowed(p)) return null;
    const m = String(dataUrl || '').match(/^data:image\/jpeg;base64,(.+)$/);
    if (!m) return null;
    const st = fs.statSync(p);
    const { key, e } = await fileFacts(p, path.basename(p), st);
    const file = path.join(thumbDir(), key + '.jpg');
    fs.mkdirSync(thumbDir(), { recursive: true });
    fs.writeFileSync(file, Buffer.from(m[1], 'base64'));
    delete e.error;
    e.thumbMade = true;
    if (duration > 0 && !e.duration) e.duration = duration;
    saveIndexSoon();
    return { url: pathToFileURL(file).href + '?' + key, duration: e.duration };
  } catch (err) { return null; }
});
ipcMain.handle('lib-thumb', async (_e, p) => {
  if (!allowed(p)) return { error: true };
  try { return await libThumb(p); } catch (e) { return { error: true }; }
});
ipcMain.handle('lib-action', wrap(async (_e, action, p) => {
  if (action === 'copy' && Array.isArray(p)) {
    const list = p.filter(x => inLibrary(x) && fs.existsSync(x));
    if (!list.length) throw new Error("Those clips aren't there anymore.");
    await copyFileToClipboard(list);
    return {};
  }
  if (!(action === 'reveal-folder' ? inLibrary(p) : allowed(p)) || !fs.existsSync(p)) throw new Error("That clip isn't there anymore.");
  if (action === 'reveal') shell.showItemInFolder(p);
  else if (action === 'copy') await copyFileToClipboard(p);
  else if (action === 'reveal-folder') { if (!isDir(p)) throw new Error("That folder isn't there anymore."); shell.openPath(p); }
  else throw new Error('Unknown action.');
  return {};
}));
// ---------- deleting (always to the Recycle Bin, always after asking) ----------
function folderStats(dir) {
  const st = { videos: 0, other: 0, bytes: 0 };
  const walk = d => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        try { st.bytes += fs.statSync(full).size; } catch (err) { /* ignore */ }
        if (LIB_EXT.has(path.extname(e.name).slice(1).toLowerCase())) st.videos++; else st.other++;
      }
    }
  };
  walk(dir);
  return st;
}
const openIn = dir => [...qtFiles].some(k => samePath(k, dir) || inside(dir, k));
async function trashAll(list) {
  closeUnusedFds();
  const done = [], failed = [];
  for (const p of list) {
    try { await shell.trashItem(p); done.push(p); } catch (e) { failed.push(path.basename(p) + ': ' + (e.message || e)); }
  }
  return { trashed: done, failed };
}
// Settings > Deleting: 'recycle' (default) moves clips and game folders to the Recycle Bin,
// 'delete' removes them for good. The app always asks first with its own confirmation.
const deleteMode = () => (readSettings().deleteMode === 'delete' ? 'delete' : 'recycle');
async function deleteAll(list) {
  if (deleteMode() === 'recycle') return trashAll(list);
  closeUnusedFds();
  const done = [], failed = [];
  for (const p of list) {
    try { fs.rmSync(p, { recursive: true }); done.push(p); } catch (e) { failed.push(path.basename(p) + ': ' + (e.code === 'EBUSY' || e.code === 'EPERM' ? 'another app is using it' : e.message || e)); }
  }
  return { trashed: done, failed, permanent: true };
}
ipcMain.handle('lib-trash', wrap(async (_e, paths, confirmed) => {
  const list = (Array.isArray(paths) ? paths : [paths]).filter(p => inLibrary(p) && fs.existsSync(p) && fs.statSync(p).isFile());
  if (!list.length) throw new Error("Those clips aren't there anymore.");
  if (list.some(p => qtFiles.has(editKey(p)))) throw new Error('One of them is open. Close it first.');
  if (!confirmed) return { cancelled: true };
  return deleteAll(list);
}));
// a game's folder(s), e.g. "Peak" and "peak.exe" - only folders inside a clips folder, never
// the clips folder itself
ipcMain.handle('lib-folder-stats', wrap(async (_e, dirs) => {
  const list = (Array.isArray(dirs) ? dirs : []).filter(d => inLibrary(d) && isDir(d));
  const st = list.map(folderStats).reduce((a, b) => ({ videos: a.videos + b.videos, other: a.other + b.other, bytes: a.bytes + b.bytes }), { videos: 0, other: 0, bytes: 0 });
  return { ...st, folders: list.length };
}));
ipcMain.handle('lib-trash-folders', wrap(async (_e, dirs, label, confirmed) => {
  const list = (Array.isArray(dirs) ? dirs : []).filter(d => inLibrary(d) && isDir(d)); // never a clips folder itself (inLibrary)
  if (!list.length) throw new Error("That folder isn't there anymore.");
  if (list.some(openIn)) throw new Error('A clip from that folder is open. Close it first.');
  if (!confirmed) return { cancelled: true };
  return deleteAll(list);
}));
// NVIDIA makes a folder for every game it sees, clips or not
async function emptyFolders() {
  const out = [];
  for (const f of await libFolders()) {
    if (f.missing) continue;
    let ents = [];
    try { ents = fs.readdirSync(f.path, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue; // other apps' (and our) hidden folders
      const full = path.join(f.path, e.name), st = folderStats(full);
      if (!st.videos && !st.other) out.push(full);
    }
  }
  return out;
}
ipcMain.handle('lib-empty-folders', wrap(async () => ({ folders: await emptyFolders() })));
// Deletes a folder only if it holds nothing but (empty) folders; any file inside stops it untouched.
function removeEmptyTree(dir) {
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory() || e.isSymbolicLink()) throw new Error('not empty');
      walk(path.join(d, e.name));
    }
  };
  walk(dir); // checks the whole tree first, so nothing is half deleted
  const rm = d => { for (const e of fs.readdirSync(d)) rm(path.join(d, e)); fs.rmdirSync(d); };
  rm(dir);
}
ipcMain.handle('lib-trash-empty', wrap(async (_e, confirmed) => {
  const list = await emptyFolders();
  if (!list.length || !confirmed) return { deleted: [], failed: [] };
  const deleted = [], failed = [];
  for (const p of list) {
    try { removeEmptyTree(p); deleted.push(p); } catch (e) { failed.push(path.basename(p)); }
  }
  return { deleted, failed };
}));

ipcMain.handle('lib-add-folder', wrap(async () => {
  const cur = await libFolders();
  const r = await dialog.showOpenDialog(win, {
    title: 'Add a folder with clips', defaultPath: (cur[0] && cur[0].path) || app.getPath('videos'), properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return { changed: false };
  const p = r.filePaths[0];
  if (cur.some(f => samePath(f.path, p))) return { changed: false };
  await setFolders([...cur.map(f => f.path), p]);
  return { changed: true, added: p };
}));
ipcMain.handle('lib-remove-folder', wrap(async (_e, p) => {
  const ex = await oldExportsDir();
  if (ex && samePath(p, ex)) { const s = readSettings(); s.oldExportsOff = true; writeSettings(s); return { changed: true }; }
  const cur = await libFolders();
  await setFolders(cur.map(f => f.path).filter(x => !samePath(x, p)));
  return { changed: true };
}));
function dirSize(d) {
  let n = 0, files = 0;
  try { for (const f of fs.readdirSync(d)) { try { n += fs.statSync(path.join(d, f)).size; files++; } catch (e) { /* ignore */ } } } catch (e) { /* none yet */ }
  return { bytes: n, files };
}
ipcMain.on('app-name', e => { e.returnValue = APP_NAME; });
// running from source (the test copy) rather than the installed app
ipcMain.on('is-test', e => { e.returnValue = !app.isPackaged; });
// zoom and full screen (the app has no native menu, so these come from its own menu and keys)
ipcMain.handle('win', (_e, what) => {
  if (!win || win.isDestroyed()) return null;
  const wc = win.webContents, z = wc.getZoomLevel();
  if (what === 'zoom-in') wc.setZoomLevel(Math.min(4, z + 0.5));
  else if (what === 'zoom-out') wc.setZoomLevel(Math.max(-3, z - 0.5));
  else if (what === 'zoom-reset') wc.setZoomLevel(0);
  else if (what === 'fullscreen') win.setFullScreen(!win.isFullScreen());
  return { zoom: wc.getZoomLevel(), fullscreen: win.isFullScreen() };
});
ipcMain.handle('settings-get', wrap(async () => {
  const s = readSettings();
  return {
    version: app.getVersion(),
    discordIdDetected: s.discordId || null, discordIdManual: s.discordIdManual || null,
    folders: await libFolders(), detected: await detectedFolders(), custom: Array.isArray(s.folders),
    cache: dirSize(thumbDir()),
    updateMode: updateMode(), updates: !!updater, deleteMode: deleteMode(), editSave: s.editSave === 'auto' ? 'auto' : 'manual', renameFiles: s.renameFiles === true,
  };
}));
ipcMain.handle('settings-set', wrap(async (_e, patch) => {
  const s = readSettings();
  if (patch && 'discordIdManual' in patch) {
    const v = patch.discordIdManual == null ? '' : String(patch.discordIdManual).trim();
    if (v && !/^\d{15,22}$/.test(v)) throw new Error("That doesn't look like a Discord user ID (15-22 digits).");
    if (v) s.discordIdManual = v; else delete s.discordIdManual;
  }
  if (patch && UPDATE_MODES.includes(patch.updateMode)) s.updateMode = patch.updateMode;
  if (patch && ['recycle', 'delete'].includes(patch.deleteMode)) s.deleteMode = patch.deleteMode;
  if (patch && ['manual', 'auto'].includes(patch.editSave)) s.editSave = patch.editSave;
  if (patch && typeof patch.renameFiles === 'boolean') s.renameFiles = patch.renameFiles;
  writeSettings(s);
  if (patch && patch.updateMode) {
    sendUpdate();
    if (patch.updateMode === 'auto') downloadUpdate();
  }
  return {};
}));
ipcMain.handle('thumbs-clear', wrap(async () => {
  fs.rmSync(thumbDir(), { recursive: true, force: true });
  thumbIndex = {};
  return {};
}));
ipcMain.handle('lib-open-folder', wrap(async (_e, p) => {
  if (!(await libFolders()).some(f => samePath(f.path, p))) throw new Error('Unknown folder.');
  const err = await shell.openPath(p);
  if (err) throw new Error(err);
  return {};
}));
ipcMain.handle('lib-reset-folders', wrap(async () => {
  const s = readSettings(); delete s.folders; writeSettings(s);
  return { changed: true };
}));

// ---------- updates (from the GitHub releases) ----------
// Settings > Updates picks how: 'ask' (default: check, show what's new, download when asked),
// 'auto' (download in the background, install on the next restart) or 'off' (only Help > Check for
// Updates). Checks a few seconds after start and every 4 hours.
const upd = { state: 'idle', version: null, notes: null, size: 0, progress: 0, error: null, later: false };
let updater = null;
const UPDATE_MODES = ['ask', 'auto', 'off'];
const updateMode = () => (UPDATE_MODES.includes(readSettings().updateMode) ? readSettings().updateMode : 'ask');
function sendUpdate() { if (win && !win.isDestroyed()) win.webContents.send('update', { ...upd, mode: updateMode() }); }
const setUpd = patch => { Object.assign(upd, patch); sendUpdate(); };
const notesText = n => (typeof n === 'string' ? n : Array.isArray(n) ? n.map(x => x.note || '').join('\n') : '');
function downloadUpdate() {
  if (!updater || upd.state !== 'available') return;
  setUpd({ state: 'downloading', progress: 0, later: false });
  updater.downloadUpdate().catch(e => setUpd({ state: 'error', error: String(e && e.message || e).split('\n')[0] }));
}
function setupUpdates() {
  if (!app.isPackaged || process.env.BACKSTAGE_LIBRARY) return; // dev runs and tests don't update
  try { updater = require('electron-updater').autoUpdater; } catch (e) { return; }
  updater.autoDownload = false;          // downloads start from downloadUpdate() (right away in 'auto')
  updater.autoInstallOnAppQuit = true;   // only does something once an update is downloaded
  updater.fullChangelog = true;
  updater.on('checking-for-update', () => setUpd({ state: 'checking', error: null }));
  updater.on('update-not-available', () => setUpd({ state: 'none' }));
  updater.on('update-available', i => {
    const size = (i.files || []).reduce((n, f) => Math.max(n, f.size || 0), 0);
    setUpd({ state: 'available', version: i.version, notes: notesText(i.releaseNotes), size, later: readSettings().updateLater === i.version });
    if (updateMode() === 'auto') downloadUpdate();
  });
  updater.on('download-progress', p => setUpd({ progress: Math.round(p.percent || 0) }));
  updater.on('update-downloaded', i => {
    const s = readSettings(); s.whatsNew = { version: i.version, notes: notesText(i.releaseNotes) }; delete s.updateLater; writeSettings(s);
    setUpd({ state: 'ready', version: i.version, later: false });
  });
  updater.on('error', e => { log('update error:', String(e && e.message || e).split('\n')[0]); setUpd({ state: 'error', error: String(e && e.message || e).split('\n')[0] }); });
  const check = () => {
    if (updateMode() === 'off' || ['checking', 'downloading', 'ready'].includes(upd.state)) return;
    updater.checkForUpdates().catch(() => {});
  };
  setTimeout(check, 8000);
  setInterval(check, 4 * 3600 * 1000);
}
// links from the About box (only these sites)
ipcMain.handle('open-url', (_e, url) => {
  if (typeof url === 'string' && /^https:\/\/(github\.com|ffmpeg\.org)\//.test(url)) shell.openExternal(url);
});
ipcMain.handle('update-get', () => ({ ...upd, mode: updateMode(), current: app.getVersion(), enabled: !!updater }));
ipcMain.handle('update-check', async () => {
  if (!updater) return { ...upd, enabled: false };
  if (['downloading', 'ready'].includes(upd.state)) { sendUpdate(); return upd; }
  try { await updater.checkForUpdates(); } catch (e) { /* reported through 'error' */ }
  return upd;
});
ipcMain.handle('update-download', () => downloadUpdate());
// "Later": keep the button but make it quiet, also after a restart, until a newer version shows up
ipcMain.handle('update-later', () => {
  if (!upd.version) return;
  const s = readSettings(); s.updateLater = upd.version; writeSettings(s);
  setUpd({ later: true });
});
ipcMain.handle('update-install', () => { if (updater && upd.state === 'ready') setImmediate(() => updater.quitAndInstall(true, true)); });
// what's new: the notes of the version that was just installed, shown once
ipcMain.handle('whats-new', () => {
  const s = readSettings(), w = s.whatsNew;
  if (!w || w.version !== app.getVersion()) return null;
  delete s.whatsNew; writeSettings(s);
  return w;
});
// The changelog: every published release's notes (Markdown) from GitHub, newest first.
// Kept for 10 minutes; on failure the caller falls back to the notes the updater brought.
const RELEASES_REPO = 'EchoCR772/backstage';
let changelogCache = null;
ipcMain.handle('changelog', wrap(async () => {
  if (changelogCache && Date.now() - changelogCache.at < 10 * 60 * 1000) return { releases: changelogCache.list };
  // package.json's "build" section is stripped from the installed app, so the repo is named here
  const r = await net.fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=50`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Backstage' }, signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`GitHub said ${r.status}.`);
  const list = (await r.json()).filter(x => !x.draft && !x.prerelease)
    .map(x => ({ version: String(x.tag_name || '').replace(/^v/, ''), date: x.published_at, notes: x.body || '' }));
  changelogCache = { at: Date.now(), list };
  return { releases: list };
}));

// ---------- recording software reports (optional, always shown before sending) ----------
// For a clips folder the app doesn't detect by itself (OBS, SteelSeries, Medal...), the user can send
// how that software lays out its clips, so a later version can find it for everyone. Nothing is
// sent without the user seeing the exact text and clicking Send. The Windows username is replaced.
// ---------- reports (problems, and info about recording software the app doesn't know) ----------
// Sent to the app's report server: a small Cloudflare Worker (report-worker/ in the repository)
// that files each one as an issue in a private GitHub repository and later hands the replies back
// to the PC that sent it (it gives each report a key only that PC has). Nothing secret is in the app.
const REPORTS_URL = (process.env.BACKSTAGE_REPORT_URL || 'https://backstage-reports.echocr.workers.dev').replace(/\/+$/, '');
async function postReport(body) {
  if (!REPORTS_URL) throw new Error("Reports aren't switched on in this version yet.");
  const r = await net.fetch(REPORTS_URL + '/report', { method: 'POST', body: JSON.stringify({ app: APP_NAME, version: app.getVersion(), ...body }), headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20000) });
  let j = {};
  try { j = await r.json(); } catch (e) { /* not JSON */ }
  if (!r.ok) throw new Error(j.error || `Couldn't send it (${r.status}). Try again later.`);
  if (!Number.isInteger(j.number) || typeof j.key !== 'string') throw new Error("The report server's answer didn't make sense. Try again later.");
  const s = readSettings();
  s.reports = [...(Array.isArray(s.reports) ? s.reports : []), { n: j.number, key: j.key, kind: body.kind, title: String(body.title || '').slice(0, 90), at: Date.now(), state: 'open', replies: [], seen: 0 }];
  writeSettings(s);
  return j;
}
// what a problem report carries besides the person's own words (they see all of it first)
async function problemDetails() {
  const enc = await pickEncoder().catch(() => ({ name: 'unknown' }));
  const s = readSettings(), folders = await libFolders().catch(() => []);
  let gpu = '';
  try { const g = await app.getGPUInfo('basic'); gpu = (g.gpuDevice || []).map(d => `${d.vendorId.toString(16)}:${d.deviceId.toString(16)}${d.active ? ' (in use)' : ''}`).join(', '); } catch (e) { /* unknown */ }
  return {
    windows: `${os.version ? os.version() : 'Windows'} (${os.release()})`,
    gpu, encoder: enc.name,
    settings: [`folders: ${folders.map(f => f.kind).join(', ') || 'none'}`, `updates: ${s.updateMode || 'ask'}`, `deleting: ${s.deleteMode || 'recycle'}`].join('; '),
    log: anonymize(logTail(300)),
  };
}
const detailsText = d => [`App: ${APP_NAME} ${app.getVersion()}`, `Windows: ${d.windows}`, `Graphics: ${d.gpu || 'unknown'}`, `Video encoder: ${d.encoder}`, `Settings: ${d.settings}`, '', 'Log (the last few minutes):', d.log || '(empty)'].join('\n');
ipcMain.handle('problem-details', wrap(async () => { const d = await problemDetails(); return { text: detailsText(d), ready: !!REPORTS_URL }; }));
ipcMain.handle('problem-send', wrap(async (_e, o) => {
  const what = String((o && o.what) || '').trim().slice(0, 4000), doing = String((o && o.doing) || '').trim().slice(0, 2000);
  if (what.length < 5) throw new Error('Say what happened first.');
  const details = o && o.details ? await problemDetails() : null;
  const j = await postReport({ kind: 'problem', title: what.split('\n')[0].slice(0, 80), what: anonymize(what), doing: anonymize(doing), details });
  log(`problem report #${j.number} sent`);
  return { number: j.number };
}));
// replies to the reports this PC sent (comments on their issues; ones starting with // are private)
let checkingReports = null;
async function checkReports() {
  if (!REPORTS_URL) return { reports: [] };
  if (checkingReports) return checkingReports;
  checkingReports = (async () => {
    const s = readSettings(), list = Array.isArray(s.reports) ? s.reports : [];
    for (const r of list) {
      if (r.state === 'closed' && Date.now() - (r.checked || 0) < 7 * 24 * 3600 * 1000) continue;
      try {
        const res = await net.fetch(`${REPORTS_URL}/replies?n=${r.n}&key=${encodeURIComponent(r.key)}`, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) continue;
        const j = await res.json();
        r.state = j.state === 'closed' ? 'closed' : 'open';
        r.replies = (Array.isArray(j.replies) ? j.replies : []).map(x => ({ body: String(x.body || '').slice(0, 8000), at: x.at }));
        r.checked = Date.now();
      } catch (e) { /* offline: try again later */ }
    }
    const fresh = readSettings();
    fresh.reports = list;
    writeSettings(fresh);
    return { reports: list };
  })().finally(() => { checkingReports = null; });
  return checkingReports;
}
const unread = list => list.reduce((n, r) => n + Math.max(0, (r.replies || []).length - (r.seen || 0)), 0);
function watchReports() {
  if (!REPORTS_URL) return;
  const tick = async () => { const { reports } = await checkReports(); if (win && !win.isDestroyed()) win.webContents.send('reports', unread(reports)); };
  setTimeout(tick, 20000);
  setInterval(tick, 30 * 60 * 1000);
}
ipcMain.handle('reports-list', wrap(async (_e, refresh) => {
  const list = refresh ? (await checkReports()).reports : (readSettings().reports || []);
  return { reports: list.map(r => ({ n: r.n, kind: r.kind, title: r.title, at: r.at, state: r.state, replies: r.replies || [], unread: Math.max(0, (r.replies || []).length - (r.seen || 0)) })), ready: !!REPORTS_URL, unread: unread(list) };
}));
ipcMain.handle('reports-seen', wrap(async () => {
  const s = readSettings();
  for (const r of s.reports || []) r.seen = (r.replies || []).length;
  writeSettings(s);
  return {};
}));
const RECORDERS = [
  [/steelseries|moments/i, 'SteelSeries Moments'], [/\bobs\b|obs[- ]studio/i, 'OBS Studio'], [/medal/i, 'Medal'],
  [/outplayed|overwolf/i, 'Outplayed (Overwolf)'], [/radeon|relive|\bamd\b/i, 'AMD Adrenalin'], [/captures/i, 'Xbox Game Bar'],
  [/shadowplay|nvidia/i, 'NVIDIA'], [/steam/i, 'Steam'], [/bandicam/i, 'Bandicam'], [/insights|plays\.tv/i, 'Insights Capture'],
];
function anonymize(text) {
  let t = String(text);
  const home = os.homedir(), user = (() => { try { return os.userInfo().username; } catch (e) { return ''; } })();
  const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (home) t = t.replace(new RegExp(esc(home), 'gi'), '%USERPROFILE%');
  if (user && user.length >= 2) t = t.replace(new RegExp(esc(user), 'gi'), '%USERNAME%');
  return t;
}
async function buildReport(dir) {
  if (!isDir(dir)) throw new Error("That folder isn't there.");
  const videos = [], others = new Set(), subdirsWithVideos = new Set();
  const walk = (d, depth) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 3) walk(full, depth + 1); continue; }
      const ext = path.extname(e.name).slice(1).toLowerCase();
      if (VIDEO_EXT.includes(ext)) {
        let mtime = 0; try { mtime = fs.statSync(full).mtimeMs; } catch (er) { /* skip */ }
        videos.push({ full, rel: path.relative(dir, full), depth, mtime });
        if (depth > 0) subdirsWithVideos.add(path.relative(dir, full).split(path.sep)[0]);
      } else if (ext) others.add(ext);
    }
  };
  walk(dir, 0);
  if (!videos.length) throw new Error('There are no videos in that folder yet. Save a clip with it first.');
  videos.sort((a, b) => b.mtime - a.mtime);
  const atRoot = videos.filter(v => v.depth === 0).length;
  const layout = !subdirsWithVideos.size ? 'all videos directly in the folder'
    : atRoot ? 'some videos in subfolders, some directly in the folder' : `a subfolder per game (${subdirsWithVideos.size} subfolders)`;
  const lines = [
    `Folder: ${anonymize(dir)}`,
    `Layout: ${layout}`,
    `Videos: ${videos.length} (${[...new Set(videos.map(v => path.extname(v.full).slice(1).toLowerCase()))].join(', ')})`,
    'Example file names:',
    ...videos.slice(0, 3).map(v => '  ' + anonymize(v.rel)),
    `Other file types: ${others.size ? [...others].slice(0, 10).join(', ') : 'none'}`,
  ];
  try {
    const i = await ffInfo(videos[0].full);
    const v = i.video || '';
    const res = (v.match(/(\d{2,5}x\d{2,5})/) || [])[1] || '?', fps = (v.match(/([\d.]+) fps/) || [])[1];
    lines.push(`Newest video: ${(v.match(/^(\w+)/) || [])[1] || '?'}, ${res}${fps ? `, ${fps} fps` : ''}, ${Math.round(i.duration)} s`);
    lines.push(`Audio tracks: ${i.audio.length || 'none'}`);
    i.audio.forEach((t, n) => lines.push(`  ${n + 1}. ${[t.codec, t.channels, anonymize(t.title || t.handler || '')].filter(Boolean).join(', ')}`));
  } catch (e) { lines.push("Newest video: couldn't be read"); }
  const guess = (RECORDERS.find(([re]) => re.test(dir)) || [])[1] || '';
  return { recorder: guess, version: app.getVersion(), text: lines.join('\n') };
}
ipcMain.handle('report-build', wrap(async (_e, dir) => buildReport(cleanPath(dir))));
ipcMain.handle('report-send', wrap(async (_e, dir, recorder, text) => {
  // send exactly what was shown (re-anonymized in case it was edited)
  const name = anonymize(String(recorder || '').slice(0, 100)) || 'Unknown';
  await postReport({ kind: 'recorder', title: name, recorder: name, text: anonymize(String(text || '').slice(0, 20000)) });
  const s = readSettings();
  s.reportedFolders = [...new Set([...(s.reportedFolders || []), cleanPath(dir)])];
  writeSettings(s);
  return {};
}));
// the little "help add this" card: shown once per folder, until sent or closed
ipcMain.handle('report-card', wrap(async (_e, dir, action) => {
  const s = readSettings(), key = cleanPath(dir);
  const seen = [...(s.reportedFolders || []), ...(s.reportDismissed || [])].some(p => samePath(p, key));
  if (action === 'dismiss') { s.reportDismissed = [...new Set([...(s.reportDismissed || []), key])]; writeSettings(s); return {}; }
  return { show: !seen, reported: (s.reportedFolders || []).some(p => samePath(p, key)) };
}));
ipcMain.handle('report-folders', wrap(async () => {
  const s = readSettings();
  const list = (await libFolders()).filter(f => f.kind === 'folder' && !f.missing)
    .map(f => ({ path: f.path, reported: (s.reportedFolders || []).some(p => samePath(p, f.path)), guess: (RECORDERS.find(([re]) => re.test(f.path)) || [])[1] || '' }));
  return { folders: list };
}));

// ---------- window / lifecycle ----------

function argvFile(argv) {
  return argv.slice(app.isPackaged ? 1 : 2).find(a => !a.startsWith('--') && fs.existsSync(a) && fs.statSync(a).isFile());
}

function createWindow() {
  // size: last time's, else roomy enough for the library (sidebar + three cards a row), never
  // bigger than the screen
  const work = screen.getPrimaryDisplay().workAreaSize;
  const saved = readSettings().window || {};
  const onScreen = b => screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return b.x < a.x + a.width - 100 && b.x + b.width > a.x + 100 && b.y >= a.y - 10 && b.y < a.y + a.height - 100;
  });
  const size = {
    width: Math.min(saved.width || 1500, work.width), height: Math.min(saved.height || 920, work.height),
  };
  if (Number.isFinite(saved.x) && Number.isFinite(saved.y) && onScreen({ ...size, x: saved.x, y: saved.y })) { size.x = saved.x; size.y = saved.y; }
  win = new BrowserWindow({
    ...size, minWidth: 980, minHeight: 640,
    backgroundColor: '#0a090c',
    title: APP_NAME,
    // the test build (run from source) gets an orange T badge so it stands out in the taskbar
    icon: path.join(__dirname, 'build', app.isPackaged ? 'icon.png' : 'icon-test.png'),
    autoHideMenuBar: true,
    // the app draws its own title bar (like Discord's); Windows still draws the window buttons
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0a090c', symbolColor: '#b5b4b9', height: TITLE_H },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // keep timers and playback running when the window is covered or in the background,
      // so the audio engine and video stay in sync (Chromium would otherwise throttle them)
      backgroundThrottling: false,
    },
  });
  win.webContents.on('will-navigate', e => e.preventDefault());
  // mouse back/forward buttons (Windows sends them as app commands)
  win.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward') win.webContents.send('nav', 'back');
    else if (cmd === 'browser-forward') win.webContents.send('nav', 'forward');
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (saved.maximized) win.maximize();
  // remember size, position and maximized for next time
  let saveTimer = null;
  const remember = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win || win.isDestroyed() || win.isMinimized()) return;
      const s = readSettings();
      const b = win.isMaximized() ? (s.window || {}) : win.getBounds();
      s.window = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() };
      writeSettings(s);
    }, 400);
  };
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, remember);
  win.webContents.on('console-message', (e, level, message) => {
    const lv = typeof level === 'number' ? level : e.level, msg = typeof message === 'string' ? message : e.message;
    if (lv === 3 || lv === 'error') log('error (window):', String(msg).slice(0, 1500));
  });
  win.webContents.on('render-process-gone', (_e, d) => log('window crashed:', d && d.reason));
  log(`started ${APP_NAME} ${app.getVersion()} on Windows ${os.release()}${app.isPackaged ? '' : ' (test build)'}`);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // a video the app was started with (opened from Explorer)
  win.webContents.once('did-finish-load', () => { if (pendingOpen) { openInWindow(pendingOpen); pendingOpen = null; } });
}
const TITLE_H = 40;
let pendingOpen = null;
async function openInWindow(f) {
  try { const clip = await clipFor(f); if (win && !win.isDestroyed()) win.webContents.send('open', clip); } catch (e) { /* ignore */ }
}

// dev only: GPU engine test (tools/ isn't part of the installed app)
const engineTest = process.argv.includes('--engine-test');
if (engineTest) require('./tools/enginetest/main.js')();
const gotLock = engineTest || app.requestSingleInstanceLock();
if (engineTest) { /* the test sets up its own window */ } else if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', async (_e, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      // Windows often refuses to raise a window for another program's launch: pin it on top for a moment
      win.setAlwaysOnTop(true); win.show(); win.focus(); win.setAlwaysOnTop(false);
    }
    const f = argvFile(argv);
    if (f) openInWindow(f);
  });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    cleanCopies();
    const f = argvFile(process.argv);
    if (f) pendingOpen = f;
    createWindow();
    setTimeout(cleanLinks, 8000);
    setupUpdates();
    watchReports();
  });
  app.on('window-all-closed', () => app.quit());
}

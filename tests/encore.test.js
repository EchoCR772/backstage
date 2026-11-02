// Encore recordings (tracks named in handler_name): one row per track except Full mix, Full mix never
// mixed with the others, untouched export = Full mix only (plus the mic for the old layout, whose
// Full mix lacks it). Each track is a different tone, so exports can be checked by what they contain.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { launch, checker, OUT } = require('./helpers');
const FF = fs.existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : null;

const TONE = { 'Full mix': 440, Microphone: 1000, 'Desktop audio': 300, Spotify: 600, 'Microsoft Edge': 800 };
function make(file, tracks, comment) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) return;
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=6'];
  tracks.forEach(t => args.push('-f', 'lavfi', '-i', `sine=f=${TONE[t]}:d=6`));
  args.push('-map', '0');
  tracks.forEach((_, i) => args.push('-map', String(i + 1)));
  args.push('-c:v', 'libx264', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac');
  tracks.forEach((t, i) => args.push(`-metadata:s:a:${i}`, 'handler_name=' + t));
  if (comment) args.push('-metadata', 'comment=' + comment);
  execFileSync(FF, [...args, file]);
}
// loudness of one tone in the first audio track of a file (dB; about -91 when it isn't there)
const level = (file, hz) => {
  const r = require('child_process').spawnSync(FF, ['-hide_banner', '-i', file, '-map', '0:a:0', '-af', `bandpass=f=${hz}:width_type=h:w=60,bandpass=f=${hz}:width_type=h:w=60,bandpass=f=${hz}:width_type=h:w=60,volumedetect`, '-f', 'null', '-'], { encoding: 'utf8' });
  const m = String(r.stderr).match(/mean_volume: (-?[\d.]+) dB/);
  return m ? +m[1] : -99;
};
const audioCount = f => execFileSync('/usr/bin/ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', f]).toString().trim().split(/\s+/).filter(Boolean).length;

(async () => {
  const { check, done } = checker('encore');
  const lib = path.join(OUT, 'encorelib', 'enc');
  fs.rmSync(path.dirname(lib), { recursive: true, force: true });
  const files = {
    newer: path.join(lib, 'Desktop', 'Desktop 2026.10.31 - 14.53.58.mp4'),          // Encore 0.4.1: rec-format:2
    old: path.join(lib, 'Game A', 'Game A 2026.10.31 - 14.53.58.mp4'),             // 0.3.x: rec-format:1, no Desktop audio
    bare: path.join(lib, 'Game B', 'Game B 2026.10.31 - 14.53.58.mp4'),            // 0.4.0 or re-saved: no marker, names only
    noapps: path.join(lib, 'Game C', 'Game C 2026.10.31 - 14.53.58.mp4'),
  };
  make(files.newer, ['Full mix', 'Microphone', 'Desktop audio', 'Spotify', 'Microsoft Edge'], 'rec-format:2');
  make(files.old, ['Full mix', 'Microphone', 'Spotify', 'Microsoft Edge'], 'rec-format:1');
  make(files.bare, ['Full mix', 'Microphone', 'Desktop audio', 'Spotify', 'Microsoft Edge'], null);
  make(files.noapps, ['Full mix', 'Microphone', 'Desktop audio'], 'rec-format:2');
  const { app, w, errs } = await launch({ name: 'encore', library: [lib] });
  const rows = async f => (await w.evaluate(p => T.qtOpen(p), f)).info.groups.map(g => `${g.name}:${g.icon}`).join('|');
  const exp = (f, audio) => w.evaluate(([p, a]) => T.qtExport({ path: p, start: 1, end: 5, as: 'video', dest: 'save', audio: a }), [f, audio]);
  try {
    check(await rows(files.newer) === 'Microphone:mic|Spotify:speaker|Microsoft Edge:speaker', 'new layout: row per track, no Full mix / Desktop audio', await rows(files.newer));
    check(await rows(files.old) === 'Microphone:mic|Spotify:speaker|Microsoft Edge:speaker', 'old layout rows', await rows(files.old));
    check(await rows(files.bare) === 'Microphone:mic|Spotify:speaker|Microsoft Edge:speaker', 'no marker, names only', await rows(files.bare));
    check(await rows(files.noapps) === 'Microphone:mic|Desktop audio:speaker', 'no app tracks: Desktop audio gets a row', await rows(files.noapps));

    // the library labels them Encore (not NVIDIA) and the card shows the Encore icon
    const badges = await w.$$eval('.clip .ckind', els => els.map(e => ({ enc: !!e.querySelector('.csrc.encore'), nv: !!e.querySelector('.csrc.nvidia'), label: e.querySelector('.cklabel') && e.querySelector('.cklabel').textContent })));
    check(badges.length === 4 && badges.every(b => b.enc && !b.nv), 'Encore clips get the Encore badge, not NVIDIA', badges);

    // in the editor
    await w.click('.game:has-text("Desktop")'); await w.waitForTimeout(500);
    await w.click('.clip >> nth=0'); await w.waitForSelector('#qt.on', { timeout: 5000 }); await w.waitForTimeout(1500);
    check(await w.$$eval('.qt-arow .qt-anametext', e => e.map(x => x.textContent).join('|')) === 'Microphone|Spotify|Microsoft Edge', 'rows in the editor');
    // size preview: exact for the whole clip, an estimate once trimmed
    const sizeText = () => w.$eval('#qtsize', e => e.textContent);
    check(/^Size \d/.test(await sizeText()) && !/≈/.test(await sizeText()), 'whole clip shows its size', await sizeText());
    await w.fill('#qtin', '1'); await w.press('#qtin', 'Enter'); await w.fill('#qtout', '3'); await w.press('#qtout', 'Enter'); await w.waitForTimeout(400);
    const est = await sizeText(), m = est.match(/≈ ([\d.]+) (MB|GB) \(from ([\d.]+) (MB|GB)\)/);
    check(!!m && Math.abs(parseFloat(m[1]) / parseFloat(m[3]) - 1 / 3) < 0.05, 'trimmed clip shows about a third of the size (2 s of 6 s)', est);
    await w.click('.game.home'); await w.waitForTimeout(600);
    check(/≈ /.test(await w.$eval('.clip .csub', e => e.textContent)), 'trimmed card shows the estimated size', await w.$eval('.clip .csub', e => e.textContent));

    // untouched exports
    const a = await exp(files.newer, {});
    check(a.ok && audioCount(a.out) === 1, 'new layout untouched export works', a);
    if (a.ok) {
      check(level(a.out, 440) > -30, 'untouched new layout keeps Full mix', level(a.out, 440));
      check(level(a.out, 1000) < -42 && level(a.out, 600) < -42, 'untouched new layout is Full mix only (nothing mixed on top)', [level(a.out, 1000), level(a.out, 600)]);
    }
    const b = await exp(files.old, {});
    if (b.ok) {
      check(level(b.out, 440) > -30 && level(b.out, 1000) > -30, 'old layout untouched export adds the mic back to Full mix', [level(b.out, 440), level(b.out, 1000)]);
      check(level(b.out, 600) < -42, 'old layout: apps are not added twice', level(b.out, 600));
    } else check(false, 'old layout export', b);

    // touched: mute Spotify -> mic and the other app, nothing from Full mix
    const c = await exp(files.newer, { 'e:spotify': { mute: true, vol: 1 } });
    if (c.ok) {
      check(level(c.out, 600) < -42, 'muted app is gone', level(c.out, 600));
      check(level(c.out, 800) > -30 && level(c.out, 1000) > -30, 'other rows stay', [level(c.out, 800), level(c.out, 1000)]);
      check(level(c.out, 440) < -42, 'Full mix is not mixed in', level(c.out, 440));
    } else check(false, 'touched export', c);
  } finally {
    await app.close();
  }
  check(!errs.length, 'no page errors', errs);
  done();
})().catch(e => { console.error(e); process.exit(1); });

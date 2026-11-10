// Nov 10, 2026: speed parts in Edit, and the timeline on its own time. A Speed block on V1 plays that part
// of the clip faster or slower (eased in and out, the sound at its own pitch or muted); the timeline shows
// the time of the file it makes, so a slowed part takes more room; text and added sounds keep their length
// and what comes after moves along. Preview and export follow the same map (renderer/timemap.js).
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { launch, checker, gopLibrary, OUT } = require('./helpers');
const TimeMap = require('../renderer/timemap.js');
const FF = '/usr/bin/ffmpeg';

const dur = f => +execFileSync('/usr/bin/ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim();
const frames = f => +execFileSync('/usr/bin/ffprobe', ['-v', 'error', '-select_streams', 'v', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', f]).toString().trim();
// loudness (dB) of a stretch of a file, optionally of one tone
const level = (file, from, len, hz) => {
  const bp = hz ? `bandpass=f=${hz}:width_type=h:w=40,bandpass=f=${hz}:width_type=h:w=40,bandpass=f=${hz}:width_type=h:w=40,` : '';
  const r = spawnSync(FF, ['-hide_banner', '-ss', String(from), '-t', String(len), '-i', file, '-map', '0:a:0', '-af', bp + 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = String(r.stderr).match(/mean_volume: (-?[\d.]+) dB/);
  return m ? +m[1] : -99;
};
// every frame of a file, tiny and grey, to find which source frame each exported frame shows
const grey = f => {
  const b = spawnSync(FF, ['-v', 'error', '-i', f, '-vf', 'scale=64:36,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 }).stdout;
  const n = 64 * 36, out = [];
  for (let o = 0; o + n <= b.length; o += n) out.push(b.subarray(o, o + n));
  return out;
};
const bestMatch = (fr, src) => {
  let best = -1, bd = Infinity;
  src.forEach((s, i) => { let d = 0; for (let k = 0; k < fr.length; k++) { const x = fr[k] - s[k]; d += x * x; } if (d < bd) { bd = d; best = i; } });
  return best;
};

(async () => {
  const { check, done } = checker('speedparts');
  const lib = gopLibrary(); // one 12 s 640x360 clip at 30 fps, sound rows 440 Hz and 880 Hz
  const { app, w, errs } = await launch({ name: 'speedparts', library: lib });
  try {
    await w.evaluate(() => { T.settingsSet({ editSave: 'auto' }); L.editSave = 'auto'; });
    await w.click('#libgrid .clip >> nth=0'); await w.waitForSelector('#qt.on'); await w.waitForTimeout(1500);
    const src = await w.evaluate(() => window.qtActivePath());
    await w.keyboard.press('e'); await w.waitForTimeout(600);
    await w.evaluate(() => window.qtFx.setView(0, 16));

    // a text at clip time 6 (3 s long), then a speed part at 2..4
    await w.evaluate(() => window.qtApi.seekTo(6)); await w.waitForTimeout(150);
    await w.evaluate(() => window.qtFx.useAsset('text:title')); await w.waitForTimeout(200);
    const text0 = await w.evaluate(() => { const l = window.qtFx.state().layers.find(x => x.type === 'text'); return [l.start, l.end]; });
    check(Math.abs(text0[0] - 6) < 0.01 && Math.abs(text0[1] - 9) < 0.01, 'the text sits at 6 to 9 s', text0);
    await w.evaluate(() => window.qtFx.pickTab('effects')); await w.waitForTimeout(200);
    check(await w.$('#qtassets .as-tile >> text=Speed') !== null, 'the Effects tab has Speed');
    await w.evaluate(() => window.qtApi.seekTo(2)); await w.waitForTimeout(150);
    await w.click('#qtassets .as-tile >> text=Speed'); await w.waitForTimeout(400);
    const sp = await w.evaluate(() => window.qtFx.state().layers.find(x => x.type === 'speed'));
    check(sp && Math.abs(sp.start - 2) < 0.01 && Math.abs(sp.end - 4) < 0.01 && sp.rate === 0.5, 'a half-speed part from 2 to 4 s of the clip', sp);
    const half = TimeMap.build([sp], 1, 12);
    check(Math.abs(half.outDur - 13.665) < 0.01, 'the eased half-speed part adds about 1.7 s', half.outDur);
    check(await w.$eval('#etllen', e => e.textContent) === '0:' + half.outDur.toFixed(2).padStart(5, '0'), 'Edit shows the new length', await w.$eval('#etllen', e => e.textContent));
    check(await w.$eval('#qtlen', e => e.textContent) === '0:' + half.outDur.toFixed(2).padStart(5, '0'), 'and so does Trim', await w.$eval('#qtlen', e => e.textContent));
    // the block on V1 is as wide as the time it plays for
    const geo = await w.evaluate(() => { const b = document.querySelector('#qttracks .trow.v1 .trk-b.spb').getBoundingClientRect(), r = document.querySelector('.etl-ruler').getBoundingClientRect(); return { l: b.left - r.left, w: b.width, rw: r.width, view: window.qtFx.view() }; });
    const px = t => (t - geo.view.t0) / (geo.view.t1 - geo.view.t0) * geo.rw;
    check(Math.abs(geo.l - px(2)) < 2 && Math.abs(geo.w - (px(half.toOut(4)) - px(2))) < 2, 'the Speed block covers 2 s to where the part ends on the timeline', { geo, end: half.toOut(4) });
    check(await w.$eval('#qttracks .trk-b.spb', e => e.textContent).then(t => t.includes('0.5×')), 'it says 0.5×');
    // the text keeps its length and moves along with the clip moment it was on
    let text = await w.evaluate(() => { const l = window.qtFx.state().layers.find(x => x.type === 'text'); return [l.start, l.end]; });
    check(Math.abs(text[0] - half.toOut(6)) < 0.01 && Math.abs(text[1] - text[0] - 3) < 0.01, 'the text after the part moved along and kept its 3 s', { text, want: half.toOut(6) });

    // the preview: playing inside the part covers half as much of the clip
    await w.evaluate(() => window.qtApi.seekTo(2.5)); await w.waitForTimeout(200);
    await w.evaluate(() => window.qtApi.toggle()); await w.waitForTimeout(1000);
    const t1 = await w.evaluate(() => window.qtApi.t());
    await w.evaluate(() => window.qtApi.toggle());
    check(t1 > 2.75 && t1 < 3.25, 'a second of playing inside the half-speed part covers about half a second of the clip', t1);

    // export: the length, the frame rate, the pitch, and each frame at its moment
    const exp = () => w.evaluate(([p]) => T.qtExport({ path: p, start: 0, end: 12, as: 'video', dest: 'temp', audio: {}, fx: window.qtFx.state() }), [src]);
    const r1 = await exp();
    check(r1.ok && Math.abs(dur(r1.out) - half.outDur) < 0.12, 'the export lasts as long as the timeline', r1.ok ? [dur(r1.out), half.outDur] : r1.error);
    if (r1.ok) {
      check(Math.abs(frames(r1.out) - half.outDur * 30) <= 4, 'still 30 fps (frames repeated in the slow part)', frames(r1.out));
      const inPart = half.toOut(3);
      check(level(r1.out, inPart - 0.3, 0.6, 440) > -40 && level(r1.out, inPart - 0.3, 0.6, 220) < level(r1.out, inPart - 0.3, 0.6, 440) - 25, 'the slowed sound keeps its pitch', { a440: level(r1.out, inPart - 0.3, 0.6, 440), a220: level(r1.out, inPart - 0.3, 0.6, 220) });
      const E = grey(r1.out), S = grey(src);
      const got = [15, 62, 75, 90, 110, 130, 200, 380].filter(n => n < E.length).map(n => [n, bestMatch(E[n], S), Math.round(half.toClip(n / 30) * 30)]);
      check(got.every(([, a, b]) => Math.abs(a - b) <= 1), 'each exported frame is the clip frame for its moment on the timeline', got);
    }

    // 2x in Properties: shorter; the text follows
    await w.click('#qttracks .trk-b.spb'); await w.waitForTimeout(200);
    check(await w.$eval('#qtfxpropsh', e => e.textContent) === 'Speed', 'clicking the block shows its settings');
    await w.click('#qtfxprops .fx-chips .chip >> text="2×"'); await w.waitForTimeout(300);
    const fast = TimeMap.build([{ ...sp, rate: 2 }], 1, 12);
    text = await w.evaluate(() => { const l = window.qtFx.state().layers.find(x => x.type === 'text'); return [l.start, l.end]; });
    check(Math.abs(text[0] - fast.toOut(6)) < 0.01 && Math.abs(text[1] - text[0] - 3) < 0.01, 'at 2x the text moves back and keeps its length', { text, want: fast.toOut(6) });
    // muted, sudden edges
    await w.click('#qtfxprops .fx-chips .chip >> text=Mute'); await w.waitForTimeout(200);
    await w.click('#qtfxprops .fx-chips .chip >> text=Sudden'); await w.waitForTimeout(300);
    const st = await w.evaluate(() => window.qtFx.state().layers.find(x => x.type === 'speed'));
    check(st.rate === 2 && st.mute === true && st.ease === false, 'speed, mute and edges are saved on the part', st);
    const sudden = TimeMap.build([st], 1, 12);
    check(Math.abs(sudden.outDur - 11) < 0.01, 'a sudden 2s at 2x takes 1 s', sudden.outDur);
    const r2 = await exp();
    check(r2.ok && Math.abs(dur(r2.out) - 11) < 0.12, 'the export is 11 s', r2.ok ? dur(r2.out) : r2.error);
    if (r2.ok) {
      const quiet = level(r2.out, 2.15, 0.7), loud = level(r2.out, 5, 1);
      check(quiet < -60 && loud > -30, 'a muted part is silent, the rest still sounds', { quiet, loud });
    }

    // dragging the end of the block: the edge follows the pointer
    await w.evaluate(() => window.qtFx.setView(0, 12));
    const eg = await w.$eval('#qttracks .trk-b.spb .trk-eg.e', e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await w.mouse.move(eg.x, eg.y); await w.mouse.down(); await w.mouse.move(eg.x + 30, eg.y, { steps: 5 }); await w.mouse.move(eg.x + 60, eg.y, { steps: 5 });
    const edge = await w.$eval('#qttracks .trk-b.spb', e => e.getBoundingClientRect().right);
    await w.mouse.up(); await w.waitForTimeout(300);
    check(Math.abs(edge - (eg.x + 60)) < 6, 'the block\'s end follows the pointer while it is dragged', { edge, want: eg.x + 60 });
    const longer = await w.evaluate(() => window.qtFx.state().layers.find(x => x.type === 'speed'));
    check(longer.end > 4.5, 'the part is longer now', longer);
    const textAt = () => w.evaluate(() => window.qtFx.state().layers.find(x => x.type === 'text').start);
    const tLong = await textAt();
    check(Math.abs(tLong - TimeMap.build([longer], 1, 12).toOut(6)) < 0.01, 'the text moved along with the drag', tLong);
    // undo puts the part's end and the text back; redo does the drag again
    await w.keyboard.press('Control+z'); await w.waitForTimeout(400);
    const undone = await w.evaluate(() => window.qtFx.state().layers.find(x => x.type === 'speed').end);
    check(Math.abs(undone - 4) < 0.01 && Math.abs(await textAt() - sudden.toOut(6)) < 0.01, 'undo: the part ends at 4 s again and the text is back', [undone, await textAt()]);
    await w.keyboard.press('Control+Shift+z'); await w.waitForTimeout(400);
    check(Math.abs(await textAt() - tLong) < 0.01, 'redo: and back again', await textAt());

    // saved: the card shows the timeline's length; undo takes the part away and the text goes back to 6
    await w.click('.game.home'); await w.waitForTimeout(800);
    const want = TimeMap.build([longer], 1, 12).outDur;
    const card = await w.$eval('#libgrid .clip .cdur', e => e.textContent).catch(() => null);
    check(card === `0:${String(Math.round(want)).padStart(2, '0')}`, 'the card shows the length of the file it makes', { card, want });
    await w.click('#libgrid .clip >> nth=0'); await w.waitForSelector('#qt.on'); await w.waitForTimeout(1500);
    check(await w.evaluate(() => !!window.qtFx.state() && window.qtFx.state().layers.some(x => x.type === 'speed')), 'reopened with the speed part');
    check(!errs.length, 'no page errors', errs);
  } catch (e) { check(false, 'test crashed', e.stack); }
  await app.close();
  done();
})();

// Nov 10, 2026: Trim's Speed row. The whole trim plays and exports at 0.25x to 4x; the sound keeps its
// pitch; the length, the size estimate and the library card follow; the speed is saved with the clip
// and undo puts it back.
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { launch, checker, gopLibrary } = require('./helpers');
const FF = '/usr/bin/ffmpeg';

const dur = f => +execFileSync('/usr/bin/ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim();
// loudness of one tone (dB; about -91 when it isn't there)
const level = (file, hz) => {
  const r = spawnSync(FF, ['-hide_banner', '-i', file, '-map', '0:a:0', '-af', `bandpass=f=${hz}:width_type=h:w=40,bandpass=f=${hz}:width_type=h:w=40,bandpass=f=${hz}:width_type=h:w=40,volumedetect`, '-f', 'null', '-'], { encoding: 'utf8' });
  const m = String(r.stderr).match(/mean_volume: (-?[\d.]+) dB/);
  return m ? +m[1] : -99;
};

(async () => {
  const { check, done } = checker('speed');
  const lib = gopLibrary(); // one 12 s clip: two sound rows, 440 Hz and 880 Hz
  const { app, w, errs } = await launch({ name: 'speed', library: lib });
  const chips = () => w.$$eval('#qtspeed .chip', e => e.map(x => x.textContent + (x.classList.contains('on') ? '*' : '')).join(' '));
  try {
    await w.click('#libgrid .clip >> nth=0'); await w.waitForSelector('#qt.on'); await w.waitForTimeout(1500);
    const src = await w.evaluate(() => window.qtActivePath());
    check(await chips() === '0.25× 0.5× 1×* 1.5× 2× 4×', 'Trim has a Speed row at 1×', await chips());
    check(await w.$eval('#qtlen', e => e.textContent) === '0:12.00', 'length 12 s', await w.$eval('#qtlen', e => e.textContent));

    // 2x: half as long, the size estimate halves
    await w.click('#qtspeed .chip >> text=2×'); await w.waitForTimeout(300);
    check(await w.$eval('#qtlen', e => e.textContent) === '0:06.00', 'at 2× it lasts 6 s', await w.$eval('#qtlen', e => e.textContent));
    check(/≈/.test(await w.$eval('#qtsize', e => e.textContent)), 'the size becomes an estimate', await w.$eval('#qtsize', e => e.textContent));
    // the preview runs twice as fast
    await w.evaluate(() => window.qtApi.toggle()); await w.waitForTimeout(1500);
    const t = await w.evaluate(() => { const p = document.querySelector('#qtcur').textContent.split(':'); return +p[0] * 60 + +p[1]; });
    await w.evaluate(() => window.qtApi.toggle());
    check(t > 2.2 && t < 3.6, 'playing at 2× covers about 3 s of the clip in 1.5 s', t);

    // exports: the length follows the speed, the pitch doesn't
    const exp = s => w.evaluate(([p, s]) => T.qtExport({ path: p, start: 0, end: 12, as: 'video', dest: 'temp', audio: {}, speed: s }), [src, s]);
    const r2 = await exp(2);
    check(r2.ok && Math.abs(dur(r2.out) - 6) < 0.15, '2× export is 6 s', r2.ok ? dur(r2.out) : r2.error);
    if (r2.ok) {
      check(level(r2.out, 440) > -40 && level(r2.out, 1760) < level(r2.out, 440) - 25, '2×: still 440 Hz (not shifted up to 880/1760)', { a440: level(r2.out, 440), a1760: level(r2.out, 1760) });
      const frames = +execFileSync('/usr/bin/ffprobe', ['-v', 'error', '-select_streams', 'v', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', r2.out]).toString().trim();
      check(Math.abs(frames - 180) <= 3, '2×: the frame rate stays 30 fps (frames skipped)', frames);
    }
    const r5 = await exp(0.5);
    check(r5.ok && Math.abs(dur(r5.out) - 24) < 0.25, '0.5× export is 24 s', r5.ok ? dur(r5.out) : r5.error);
    if (r5.ok) check(level(r5.out, 440) > -40 && level(r5.out, 220) < level(r5.out, 440) - 25, '0.5×: still 440 Hz (not shifted down to 220)', { a440: level(r5.out, 440), a220: level(r5.out, 220) });
    const r4 = await exp(0.25);
    check(r4.ok && Math.abs(dur(r4.out) - 48) < 0.4, '0.25× export is 48 s (atempo in steps)', r4.ok ? dur(r4.out) : r4.error);

    // saved with the clip: the card shows the new length, reopening shows 2×, Copy makes the 2× file
    await w.click('.game.home'); await w.waitForTimeout(800);
    const cardLen = await w.$eval('#libgrid .clip .cdur', e => e.textContent).catch(() => null);
    check(cardLen === '0:06', 'the card shows the sped-up length', cardLen);
    await w.click('#libgrid .clip >> nth=0'); await w.waitForSelector('#qt.on'); await w.waitForTimeout(1500);
    check(await chips() === '0.25× 0.5× 1× 1.5× 2×* 4×', 'reopened at 2×', await chips());
    const copy = await w.evaluate(p => T.qtExport({ path: p, as: 'video', dest: 'temp' }), src);
    check(copy.ok && Math.abs(dur(copy.out) - 6) < 0.15, 'Copy (the saved edit) makes the 2× file', copy.ok ? dur(copy.out) : copy.error);
    // undo puts 1× back
    await w.click('#qtspeed .chip >> text=4×'); await w.waitForTimeout(600);
    await w.keyboard.press('Control+z'); await w.waitForTimeout(500);
    check(await chips() === '0.25× 0.5× 1× 1.5× 2×* 4×', 'undo puts the speed back', await chips());
    check(!errs.length, 'no page errors', errs);
  } catch (e) { check(false, 'test crashed', e.stack); }
  await app.close();
  done();
})();

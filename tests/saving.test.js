// Nov 10, 2026: a clip opened while its recorder is still saving it (Encore's empty placeholder, then a
// file with no index yet) shows "Still saving..." and loads by itself once it's done, with no fixed wait;
// clicking a clip that didn't load tries again. Encore tracks with no sound at all (every sample exactly 0)
// fold away under "N silent tracks" in the side panel and on Edit's timeline; a very quiet track and one
// that's silent until near the end are kept.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { launch, checker, gopLibrary, OUT } = require('./helpers');
const FF = '/usr/bin/ffmpeg';

// an Encore recording: Full mix, Microphone and four app tracks
function encoreClip(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const src = [
    ['Full mix', 'sine=f=440:d=6'],
    ['Microphone', 'sine=f=1000:d=6'],
    ['Discord', 'sine=f=600:d=6'],
    ['World of Warcraft', 'anullsrc=r=48000:cl=stereo:d=6'],                       // silent
    ['Spotify', 'sine=f=800:d=6,volume=0.002'],                                   // very quiet: about -60 dB
    ['World of Warcraft 2', 'anullsrc=r=48000:cl=stereo:d=5[s];sine=f=500:d=1[t];[s][t]concat=v=0:a=1'], // sound only in the last second
    ['Backstage', 'anullsrc=r=48000:cl=stereo:d=6'],                               // silent
  ];
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=6'];
  for (const [, s] of src) args.push('-f', 'lavfi', '-i', s);
  args.push('-map', '0');
  src.forEach((_, i) => args.push('-map', String(i + 1)));
  args.push('-c:v', 'libx264', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest');
  src.forEach(([n], i) => args.push(`-metadata:s:a:${i}`, 'handler_name=' + n));
  args.push('-metadata', 'comment=rec-format:2', '-movflags', '+faststart', file);
  execFileSync(FF, args);
}

(async () => {
  const { check, done } = checker('saving');
  const lib = gopLibrary();
  const src = fs.readdirSync(path.join(lib[0], 'Deadlock')).map(n => path.join(lib[0], 'Deadlock', n))[0];
  const root = path.join(OUT, 'savelib');
  fs.rmSync(root, { recursive: true, force: true });
  const enc = path.join(root, 'enc', 'World of Warcraft', 'World of Warcraft 2026.11.09 - 21.13.29.mp4');
  encoreClip(enc);
  const enc2 = path.join(root, 'enc', 'Desktop', 'Desktop 2026.11.09 - 22.00.00.mp4');
  encoreClip(enc2);
  const nv = path.join(root, 'nv', 'Peak');
  fs.mkdirSync(nv, { recursive: true });
  const { app, w, errs } = await launch({ name: 'saving', library: [path.join(root, 'enc'), path.join(root, 'nv')] });
  const msg = () => w.$eval('#qtmsg', e => e.textContent);
  try {
    // ---------- silent tracks worked out ahead for Encore cards on screen ----------
    const sfile = path.join(OUT, 'profile-saving', 'silence.json');
    const known = () => { try { return Object.values(JSON.parse(fs.readFileSync(sfile, 'utf8'))).filter(x => x.full).length; } catch (e) { return 0; } };
    for (let i = 0; i < 40 && known() < 2; i++) await w.waitForTimeout(250);
    check(known() >= 2, 'both Encore clips on screen are checked before anyone opens them', known());

    // ---------- a clip that's still being saved ----------
    const growing = path.join(nv, 'Peak 2026.11.10 - 10.00.00.01.DVR.mp4');
    fs.writeFileSync(growing, ''); // Encore's placeholder: an empty file under the final name
    await w.waitForFunction(() => L.data && L.data.clips.some(c => c.path.includes('10.00.00.01')), null, { timeout: 15000 });
    await w.click('.game:has-text("Peak")'); await w.waitForTimeout(500);
    await w.click('#libgrid .clip >> nth=0'); await w.waitForSelector('#qt.on');
    await w.waitForTimeout(900);
    check(/Still saving/.test(await msg()), 'an empty new file says "Still saving..."', await msg());
    check(await w.evaluate(() => !document.querySelector('#qtmsg').textContent.includes('No video')), 'not an error');
    // the recorder writes most of it, index still missing
    const full = fs.readFileSync(src);
    fs.writeFileSync(growing, full.subarray(0, Math.floor(full.length * 0.5)));
    await w.waitForTimeout(800);
    check(/Still saving/.test(await msg()), 'half-written (no index yet): still saving', await msg());
    check(await w.evaluate(() => !window.qtActivePath() || !document.querySelector('#qtaudio .qt-arow')), 'no sound rows yet');
    // done: it loads by itself, within a moment, without leaving and coming back
    const t0 = Date.now();
    fs.writeFileSync(growing, full);
    await w.waitForFunction(() => document.querySelectorAll('#qtaudio .qt-arow').length > 0 && !document.querySelector('#qtmsg').textContent, null, { timeout: 5000 }).catch(() => {});
    const took = Date.now() - t0;
    check(await w.evaluate(() => document.querySelectorAll('#qtaudio .qt-arow').length) === 2 && !(await msg()), 'it loads by itself once finished', { took, msg: await msg() });
    check(took < 2000, 'quickly (no fixed wait)', took);
    check(await w.evaluate(() => window.qtFx && document.querySelector('#qttot').textContent !== '0:00'), 'the clip has its length', await w.$eval('#qttot', e => e.textContent));

    // a clip that failed to open loads when clicked again (it used to need leaving and coming back)
    const broken = path.join(nv, 'Peak 2026.11.10 - 10.00.00.02.DVR.mp4');
    fs.writeFileSync(broken, full.subarray(0, Math.floor(full.length * 0.5)));
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(broken, old, old); // an old unreadable file is an error, not "still saving"
    await w.waitForFunction(() => L.list && L.list.some(c => c.path.includes('10.00.00.02')), null, { timeout: 15000 });
    await w.evaluate(() => { const c = L.list.find(x => x.path.includes('10.00.00.02')); window.openQuickTrim(c); });
    await w.waitForTimeout(1200);
    check(!/Still saving/.test(await msg()), 'an old unreadable file is not "still saving"', await msg());
    check(await w.evaluate(() => document.querySelectorAll('#qtaudio .qt-arow').length === 0), 'and it did not load');
    fs.writeFileSync(broken, full); fs.utimesSync(broken, old, old);
    await w.evaluate(() => { const c = L.list.find(x => x.path.includes('10.00.00.02')); window.openQuickTrim(c); });
    await w.waitForFunction(() => document.querySelectorAll('#qtaudio .qt-arow').length > 0, null, { timeout: 5000 }).catch(() => {});
    check(await w.evaluate(() => document.querySelectorAll('#qtaudio .qt-arow').length === 2), 'clicking it again loads it');
    await w.click('.game.home'); await w.waitForTimeout(500);

    // ---------- silent tracks ----------
    const sil = await w.evaluate(async p => { await T.qtOpen(p); return T.qtSilent(p, [1, 2, 3, 4, 5, 6]); }, enc);
    check(sil.ok && sil.silent.join() === '3,6', 'only the all-zero tracks count as silent (quiet and late tracks keep their row)', sil);
    await w.click('.game:has-text("World of Warcraft")'); await w.waitForTimeout(500);
    await w.click('#libgrid .clip >> nth=0'); await w.waitForSelector('#qt.on');
    // already known, so the rows open folded (no rows showing first, then folding)
    await w.waitForFunction(() => document.querySelectorAll('#qtaudio .qt-arow').length > 0, null, { timeout: 8000 }).catch(() => {});
    const firstRows = await w.$$eval('#qtaudio .qt-arow', e => e.length);
    check(firstRows === 4, 'it opens with the silent rows already folded', firstRows);
    await w.waitForFunction(() => document.querySelector('#qtaudio .qt-silentfold'), null, { timeout: 8000 }).catch(() => {});
    const rowsNow = () => w.$$eval('#qtaudio .qt-arow .qt-anametext', e => e.map(x => x.textContent));
    check((await rowsNow()).join('|') === 'Microphone|Discord|Spotify|World of Warcraft 2', 'silent rows are folded away', await rowsNow());
    check(await w.$eval('#qtaudio .qt-silentfold', e => e.textContent) === '2 silent tracks', 'under "2 silent tracks"', await w.$eval('#qtaudio .qt-silentfold', e => e.textContent).catch(() => null));
    await w.click('#qtaudio .qt-silentfold'); await w.waitForTimeout(200);
    check((await rowsNow()).join('|') === 'Microphone|Discord|Spotify|World of Warcraft 2|World of Warcraft|Backstage', 'opening the fold shows them', await rowsNow());
    check(await w.$$eval('#qtaudio .qt-arow.silent', e => e.length) === 2, 'marked as silent');
    // Edit's timeline follows the fold
    await w.keyboard.press('e'); await w.waitForTimeout(700);
    const trows = () => w.$$eval('#qttracks .trow.c', e => e.map(x => x.dataset.key));
    check((await trows()).length === 6, 'unfolded: all 6 sound rows on the timeline', await trows());
    await w.click('#qtaudio .qt-silentfold'); await w.waitForTimeout(300);
    check((await trows()).join('|') === 'e:microphone|e:discord|e:spotify|e:world of warcraft 2', 'folded: the silent rows leave the timeline', await trows());
    // remembered: the second look doesn't decode again
    const t1 = Date.now();
    const again = await w.evaluate(p => T.qtSilent(p, [1, 2, 3, 4, 5, 6]), enc);
    check(again.silent.join() === '3,6' && Date.now() - t1 < 300, 'the result is remembered', Date.now() - t1);
    // a clip nothing has checked yet: opening it proves the silent tracks from the AAC frames on the way
    // (no decoding), so its rows are built folded at once; only the tracks it can't settle are decoded
    await w.click('.game.home'); await w.waitForTimeout(400);
    const enc3 = path.join(root, 'enc', 'World of Warcraft', 'World of Warcraft 2026.11.09 - 23.00.00.mp4');
    fs.copyFileSync(enc, enc3);
    const fresh = await w.evaluate(async p => { const t = performance.now(); const r = await T.qtOpen(p); return { ms: performance.now() - t, silent: r.silent, unsure: r.unsure }; }, enc3);
    check(fresh.silent && fresh.silent.join() === '3,6', 'opening a new clip already knows its silent tracks', fresh);
    check(fresh.unsure && fresh.unsure.join() === '1,2,4,5', 'the tracks with sound (or too quiet to prove) are left to the full check', fresh);
    await w.waitForTimeout(400); // silence.json is written 200 ms after a change
    const st3 = JSON.parse(fs.readFileSync(sfile, 'utf8'));
    const e3 = Object.entries(st3).find(([k]) => k.includes('23.00.00'));
    check(e3 && e3[1].fast && !('1' in e3[1].tracks), 'nothing was decoded for that answer', e3 && e3[1]);
    await w.waitForFunction(() => L.list && L.list.some(c => c.path.includes('23.00.00')), null, { timeout: 15000 });
    const seen = await w.evaluate(async () => {
      const c = L.list.find(x => x.path.includes('23.00.00'));
      const counts = [];
      let on = true;
      const watch = () => { counts.push(document.querySelectorAll('#qtaudio .qt-arow').length + (document.querySelector('#qtaudio .qt-silentfold') ? 100 : 0)); if (on) requestAnimationFrame(watch); };
      requestAnimationFrame(watch);
      window.openQuickTrim(c);
      await new Promise(r => setTimeout(r, 3000));
      on = false;
      return counts;
    });
    const shown = seen.filter(n => n > 0);
    check(shown.length && shown.every(n => n === 104), 'the rows show folded from the first frame they appear, and stay that way', [...new Set(seen)]);
    // the proof on its own: frames that carry no sound data
    const { provenSilent } = require(path.join(__dirname, '..', 'silence.js'));
    const proof = await provenSilent(enc);
    check(proof && proof.map(v => v === true ? 1 : 0).join('') === '0001001', 'the proof finds exactly the all-zero tracks', proof);
    check(await w.evaluate(p => T.silenceFirst(p), enc3), 'a card can be moved to the front of the background check');

    // a Discord or NVIDIA clip never gets a fold (only Encore clips are checked)
    await w.click('.game.home'); await w.waitForTimeout(400);
    await w.click('.game:has-text("Peak")'); await w.waitForTimeout(400);
    await w.click('#libgrid .clip >> nth=0'); await w.waitForSelector('#qt.on'); await w.waitForTimeout(1500);
    check(!(await w.$('#qtaudio .qt-silentfold')), 'other clips have no fold');
    check(!errs.length, 'no page errors', errs);
  } catch (e) { check(false, 'test crashed', e.stack); }
  await app.close();
  done();
})();

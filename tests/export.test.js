// Exports: smart cut (frame count, length, clean decode), names on exported and copied files,
// files ready for dragging, and Replace original (keeps tracks, Discord's info, dates and the name).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { launch, checker, gopLibrary, OUT, FIX } = require('./helpers');
const FFPROBE = fs.existsSync('/usr/bin/ffprobe') ? '/usr/bin/ffprobe' : null;
const probe = f => JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-count_packets', '-show_entries', 'stream=codec_type,nb_read_packets:stream_tags=handler_name:format=duration', '-of', 'json', f]).toString());
const cleanDecode = f => { try { execFileSync('/usr/bin/ffmpeg', ['-v', 'error', '-i', f, '-f', 'null', '-'], { stdio: 'pipe' }); return ''; } catch (e) { return String(e.stderr).slice(0, 300); } };

(async () => {
  const { check, done } = checker('export');
  // a copy of a Discord clip to replace (never the fixture itself)
  const dcDir = path.join(OUT, 'replacelib', 'dc');
  fs.rmSync(path.dirname(dcDir), { recursive: true, force: true });
  fs.mkdirSync(dcDir, { recursive: true });
  const dcClip = path.join(dcDir, 'Deadlock_80b668e2-c44e-46cd-afa6-7a9f042a2d6a.mp4');
  fs.copyFileSync(path.join(FIX, 'dc', path.basename(dcClip)), dcClip);
  const old = new Date(2026, 8, 1, 12, 0, 0);
  fs.utimesSync(dcClip, old, old);
  // Discord clips without Discord's info, named after browser tabs (cut short) or a game
  const tabDir = path.join(OUT, 'replacelib', 'tabs');
  fs.mkdirSync(tabDir, { recursive: true });
  const plain = path.join(FIX, 'nv', 'Desktop', 'Desktop 2026.10.27 - 15.36.33.06.DVR.mp4');
  for (const n of ['(1)_Caedrel_-_Twitch_1392674718011621376.mp4', 'Caedrel_-_Twitch_-_P_1393419228584869888.mp4', 'Netflix_-_Personal_-_1393419228584869887.mp4', 'REPO_1393419228584869889.mp4']) fs.copyFileSync(plain, path.join(tabDir, n));
  const { app, w, errs, ud, ex } = await launch({ name: 'export', library: [...gopLibrary(), dcDir, tabDir] });
  const statusText = () => w.$eval('#qtstatus', e => e.textContent);
  const setTrim = async (a, b) => { await w.fill('#qtin', a); await w.press('#qtin', 'Enter'); await w.fill('#qtout', b); await w.press('#qtout', 'Enter'); await w.waitForTimeout(300); };
  const waitStatus = re => w.waitForFunction(r => new RegExp(r).test(document.getElementById('qtstatus').textContent), re.source, { timeout: 30000 });
  try {
    const games = await w.$$eval('.game .gname', e => e.map(x => x.textContent));
    check(games.includes('Desktop') && games.includes('REPO') && !games.some(g => /Caedrel|Netflix/.test(g)), 'browser tab names go to Desktop', games);
    await w.click('.game:has-text("Deadlock")'); await w.waitForTimeout(400);
    await w.click('.clip:has(.csrc.nvidia)'); await w.waitForSelector('#qt.on'); await w.waitForTimeout(1500);
    check(await w.$$eval('.qt-arow .qt-anametext', e => e.map(x => x.textContent).join('|')) === 'Game / Desktop|Microphone', 'NVIDIA separate tracks');

    // smart cut export: exact frames, length, clean joins
    await setTrim('2.5', '9.3');
    const r1 = await w.evaluate(() => T.qtExport({ path: window.qtActivePath(), start: 2.5, end: 9.3, as: 'video', dest: 'save', audio: {} }));
    check(r1.ok && r1.smart, 'smart cut was used', r1);
    if (r1.ok && FFPROBE) {
      const p = probe(r1.out);
      const v = p.streams.find(s => s.codec_type === 'video'), a = p.streams.filter(s => s.codec_type === 'audio');
      check(+v.nb_read_packets === 204, 'smart cut has exactly the frames of the trim', v.nb_read_packets);
      check(Math.abs(+p.format.duration - 6.8) < 0.08, 'length', p.format.duration);
      check(a.length === 1, 'one mixed audio track', a.length);
      check(cleanDecode(r1.out) === '', 'decodes cleanly', cleanDecode(r1.out));
    }

    // a name: used for exports and copies
    await w.click('#qttitle'); await w.fill('#qttitlein', 'Clutch'); await w.press('#qttitlein', 'Enter'); await w.waitForTimeout(500);
    await w.click('#qtsave'); await waitStatus(/Exported.*Clutch|Couldn't/);
    check(fs.readdirSync(ex, { recursive: true }).map(String).some(f => /Clutch\.mp4$/.test(f)), 'export uses the name');
    await w.click('#qtcopy'); await waitStatus(/Copied|Couldn't/);
    check(/Clutch\.mp4/.test(await statusText()), 'copy uses the name', await statusText());

    // untouched + named: an instant hard link with the name
    await w.click('#qtreset'); await w.waitForTimeout(400);
    await w.click('#qtcopy'); await waitStatus(/Copied|Couldn't/);
    // a hard link next to the clip, or (on drives that can't do links) a copy
    const ldir = path.join(gopLibrary()[0], '.clip-links');
    const links = fs.existsSync(ldir) ? fs.readdirSync(ldir, { recursive: true }).map(String) : [];
    check(links.some(f => /Clutch\.mp4$/.test(f)) || /Clutch\.mp4/.test(await statusText()), 'named copy of the untouched clip (link or copy)', links);

    // dragging out: the file is ready after a hover/press
    const nvClip = await w.evaluate(() => window.qtActivePath());
    await setTrim('1', '3');
    await w.click('.game.home'); await w.waitForTimeout(800);
    const ready = await w.evaluate(async p => { await T.dragPrepare(p); return T.dragReady(p); }, nvClip);
    check(!!ready && /Clutch\.mp4$/.test(ready) && fs.existsSync(ready), 'drag file is ready, named', ready);

    // Replace original on the Discord clip: tracks, Discord info, dates and the name stay
    await w.click('.clip:has(.csrc.discord)'); await w.waitForSelector('#qt.on'); await w.waitForTimeout(1500);
    await w.click('#qttitle'); await w.fill('#qttitlein', 'Keeper'); await w.press('#qttitlein', 'Enter'); await w.waitForTimeout(500);
    const before = FFPROBE ? probe(dcClip) : null;
    await setTrim('1', '5');
    await w.click('#qtsavemenu'); await w.waitForTimeout(200);
    await w.click('#ctxmenu >> text=Replace original');
    await w.waitForSelector('.modal-ov.on .mbtn.danger');
    check(!/Shift/.test(await w.$eval('.modal-ov.on .modal', e => e.textContent)), 'no Shift hint in the Replace dialog');
    await w.click('.modal-ov.on .mbtn.danger');
    await waitStatus(/Original replaced|Couldn't/);
    check(/Original replaced/.test(await statusText()), 'replaced', await statusText());
    if (FFPROBE) {
      const p = probe(dcClip);
      check(Math.abs(+p.format.duration - 4) < 0.1, 'new length', p.format.duration);
      const tags = s => s.streams.filter(x => x.codec_type === 'audio').map(x => (x.tags || {}).handler_name).join(',');
      check(tags(p) === tags(before), 'every audio track kept with its label', [tags(before), tags(p)]);
      check(cleanDecode(dcClip) === '', 'replaced file decodes cleanly', cleanDecode(dcClip));
    }
    const tail = fs.readFileSync(dcClip).subarray(-4000).toString('latin1');
    check(/"applicationName": ?"Deadlock"/.test(tail) && /"length": ?4000/.test(tail), "Discord's clip info kept, with the new length", tail.slice(tail.indexOf('{"'), tail.indexOf('{"') + 120));
    check(Math.abs(fs.statSync(dcClip).mtimeMs - old.getTime()) < 2000, 'modified date kept', fs.statSync(dcClip).mtime);
    check(await w.$eval('#qttitletext', e => e.textContent) === 'Keeper', 'name kept after replacing');
    check(/^0:04\.0\d$/.test(await w.$eval('#qtlen', e => e.textContent)), 'trim reset to the new whole clip', await w.$eval('#qtlen', e => e.textContent));
    check(!fs.readdirSync(dcDir).some(f => f.startsWith('.')), 'no leftovers next to the clip', fs.readdirSync(dcDir));
    check(!errs.length, 'no page errors', errs);
  } catch (err) { check(false, 'test crashed: ' + err.message); } finally { await app.close(); done(); }
})();

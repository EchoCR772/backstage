// The Nov 3 round of Edit tools: volume and mute for a selected sound row or piece (Properties and
// right-click), crop shapes / lock / sides, zoom steps (preview math and export agree), the razor
// and brush cursors, and the home page's virtual grid (few cards on the page, a click right after
// scrolling opens the card).
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { launch, checker, gopLibrary, bigLibrary, OUT } = require('./helpers');
const FF = '/usr/bin/ffmpeg';
function level(f, t) {
  const out = spawnSync(FF, ['-hide_banner', '-ss', String(t), '-t', '0.8', '-i', f, '-af', 'volumedetect', '-f', 'null', '-']).stderr.toString();
  const m = /mean_volume: (-?[\d.]+|-inf) dB/.exec(out);
  return m ? (m[1] === '-inf' ? -200 : +m[1]) : null;
}
// how alike two pictures are (PSNR, dB): frame t of the export vs a crop of the source scaled up
function psnr(out, src, t, crop) {
  const r = spawnSync(FF, ['-hide_banner', '-ss', String(t), '-i', out, '-ss', String(t), '-i', src, '-filter_complex',
    `[1:v]crop=${crop},scale=640:360,format=yuv420p[b];[0:v]format=yuv420p[a];[a][b]psnr`, '-frames:v', '1', '-f', 'null', '-']).stderr.toString();
  const m = /average:([\d.]+|inf)/.exec(r);
  return m ? (m[1] === 'inf' ? 99 : +m[1]) : 0;
}

(async () => {
  const { check, done } = checker('tools');
  const lib = gopLibrary();
  const src = path.join(lib[0], 'Deadlock', 'Deadlock 2026.10.20 - 20.10.10.01.DVR.mp4');
  let { app, w, errs } = await launch({ name: 'tools', library: lib });
  const fx = () => w.evaluate(() => window.qtFx.state());
  const rect = sel => w.$eval(sel, e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, l: r.left, t: r.top, w: r.width, h: r.height }; });
  try {
    await w.evaluate(async () => { await T.settingsSet({ editSave: 'auto' }); L.editSave = 'auto'; });
    await w.click('#libgrid .clip >> nth=0'); await w.waitForSelector('#qt.on'); await w.waitForTimeout(1500);
    await w.keyboard.press('e'); await w.waitForTimeout(600);
    const keys = await w.$$eval('#qttracks .trow.c', e => e.map(r => r.dataset.key));

    // ---- a sound row: click it, its volume and mute are in Properties; right-click mutes ----
    const a1 = await rect(`#qttracks .trow.c[data-key="${keys[0]}"] .trk-b.cb`);
    await w.mouse.click(a1.x, a1.y); await w.waitForTimeout(300);
    check(await w.$$eval('#qtfxprops .fx-vol input[type=range]', e => e.length) === 1, 'a selected sound row shows its volume in Properties');
    await w.$eval('#qtfxprops .fx-vol input[type=range]', e => { e.value = 50; e.oninput(); e.onchange(); });
    await w.waitForTimeout(400);
    check(await w.$eval('#qtaudio .qt-arow .qt-avol', e => e.textContent) === '50%', 'its volume shows in the side panel too', await w.$eval('#qtaudio .qt-arow .qt-avol', e => e.textContent));
    await w.mouse.click(a1.x, a1.y, { button: 'right' }); await w.waitForTimeout(200);
    check(/Mute/.test(await w.$eval('#ctxmenu', e => e.innerText)) && /Volume/.test(await w.$eval('#ctxmenu', e => e.innerText)), 'right-clicking a sound row offers Mute and Volume');
    await w.click('#ctxmenu >> text=Mute'); await w.waitForTimeout(300);
    check(await w.$eval(`#qttracks .trow.c[data-key="${keys[0]}"]`, e => e.classList.contains('muted')), 'Mute from the menu mutes the row');
    await w.mouse.click(a1.x, a1.y, { button: 'right' }); await w.waitForTimeout(200);
    await w.click('#ctxmenu >> text=Unmute'); await w.waitForTimeout(300);
    // the side panel's volume-points button selects that row
    await w.evaluate(() => window.qtFx.select(null)); await w.waitForTimeout(100);
    await w.click('#qtaudio .qt-arow >> nth=0 >> .qt-apts'); await w.waitForTimeout(300);
    check(await w.evaluate(() => window.qtFx.selectedId() === 'row:' + document.querySelector('#qttracks .trow.c').dataset.key) && /Double-click the row/.test(await w.$eval('#qtfxprops', e => e.textContent)), 'the volume points button selects that row and says how to add points');

    // ---- a piece: its own volume and mute, in the export too ----
    await w.evaluate(([a, b]) => window.qtFx.setState({ cuts: {
      [a]: { free: false, pieces: [{ id: 'q1', from: 0, to: 6, at: 0, vol: 0.25 }, { id: 'q2', from: 6, to: 12, at: 6 }] },
      [b]: { free: false, pieces: [{ id: 'q3', from: 0, to: 12, at: 0, mute: true }] },
    } }), keys);
    await w.waitForTimeout(400);
    await w.evaluate(() => window.qtFx.select('q1')); await w.waitForTimeout(200);
    check(await w.$$eval('#qtfxprops .fx-vol input', e => e.length) === 1 && await w.$eval('#qtfxprops .fx-vol input', e => +e.value) === 25, 'a piece shows its own volume');
    check(await w.$eval('#qttracks .trk-b[data-id="q3"]', e => e.classList.contains('off')), 'a muted piece looks off');
    const r = await w.evaluate(() => T.qtExport({ path: window.qtActivePath(), start: 0, end: 12, as: 'audio', dest: 'temp', audio: {}, fx: window.qtFx.state() }));
    if (r.ok) {
      const quiet = level(r.out, 2), full = level(r.out, 8);
      check(full - quiet > 9 && full - quiet < 15, 'a piece at 25% is about 12 dB quieter in the export (the muted row is left out)', [quiet, full]);
    } else check(false, 'export with piece volumes', r.error);

    // ---- crop: shapes, lock, sides ----
    await w.evaluate(() => window.qtFx.setState(null)); await w.waitForTimeout(300);
    await w.evaluate(() => window.qtFx.useAsset('fx:crop')); await w.waitForTimeout(300);
    const chips = await w.$$eval('#qtfxprops .fx-chips .chip', e => e.map(x => x.textContent));
    check(chips.join() === 'Free,Original,16:9,9:16,1:1,4:3,3:4,4:5,21:9', 'crop shapes are named in Properties', chips);
    await w.click('#qtfxprops .fx-chips .chip >> text=9:16'); await w.waitForTimeout(300);
    let c = (await fx()).crop;
    check(c && Math.abs(c.w * 640 / (c.h * 360) - 9 / 16) < 0.01, 'picking 9:16 makes a 9:16 crop', c);
    check(await w.$$eval('.fx-cropbox .fx-edge', e => e.length) === 4, 'the crop has handles on its sides too');
    // a side with the shape locked: still 9:16
    let e = await rect('.fx-cropbox .fx-edge.e');
    await w.mouse.move(e.x, e.y); await w.mouse.down(); await w.mouse.move(e.x - 40, e.y, { steps: 4 }); await w.mouse.up(); await w.waitForTimeout(300);
    c = (await fx()).crop;
    check(c && Math.abs(c.w * 640 / (c.h * 360) - 9 / 16) < 0.02, 'dragging a side with the lock keeps the shape', c && c.w * 640 / (c.h * 360));
    // Free: a side changes the shape; Shift keeps it
    await w.click('#qtfxprops .fx-chips .chip >> text=Free'); await w.waitForTimeout(200);
    const r0 = (await fx()).crop; e = await rect('.fx-cropbox .fx-edge.e');
    await w.mouse.move(e.x, e.y); await w.mouse.down(); await w.mouse.move(e.x + 40, e.y, { steps: 4 }); await w.mouse.up(); await w.waitForTimeout(300);
    c = (await fx()).crop;
    check(c && c.w > r0.w + 0.02 && Math.abs(c.h - r0.h) < 1e-6, 'unlocked, a side only moves that side', [r0, c]);
    const ratio0 = c.w / c.h; e = await rect('.fx-cropbox .fx-edge.s');
    await w.keyboard.down('Shift'); await w.mouse.move(e.x, e.y); await w.mouse.down(); await w.mouse.move(e.x, e.y - 30, { steps: 4 }); await w.mouse.up(); await w.keyboard.up('Shift'); await w.waitForTimeout(300);
    c = (await fx()).crop;
    check(c && Math.abs(c.w / c.h - ratio0) < 0.02, 'Shift keeps the shape while unlocked', [ratio0, c && c.w / c.h]);
    check(await w.$eval('.qt-edit', e => getComputedStyle(e).cursor.startsWith('url(')), 'the crop tool has its own cursor, not a crosshair');
    await w.click('#qtfxprops .btn >> text=Done'); await w.waitForTimeout(300);

    // ---- the razor and the brush ----
    await w.keyboard.press('c'); await w.waitForTimeout(100);
    check(await w.$eval('#qttracks .trk-l', e => getComputedStyle(e).cursor.startsWith('url(')), 'C picks the razor, which has a blade cursor');
    check(await w.$$eval('#qttools', e => e.length) === 0, 'no toolbar under the video');
    await w.keyboard.press('v');
    await w.evaluate(() => window.qtFx.setState(null)); await w.waitForTimeout(300);
    await w.evaluate(() => window.qtFx.useAsset('fx:draw')); await w.waitForTimeout(300);
    const ed = await rect('.qt-edit');
    await w.mouse.move(ed.x, ed.y); await w.mouse.move(ed.x + 5, ed.y + 5); await w.waitForTimeout(100);
    const br = await w.$eval('.fx-brush', e => ({ shown: !e.hidden, w: e.getBoundingClientRect().width }));
    check(br.shown && Math.abs(br.w - 0.008 * ed.h) < 2 && await w.$eval('.qt-edit', e => getComputedStyle(e).cursor === 'none'), 'the brush is a circle the size of the stroke', [br, 0.008 * ed.h]);
    await w.keyboard.press('Escape'); await w.keyboard.press('Escape');

    // ---- zoom steps: the export shows each step's box ----
    await w.evaluate(() => window.qtFx.setState({ layers: [{ id: 'z1', type: 'zoom', track: 0, start: 1, end: 11, ein: 0, eout: 0, box: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
      steps: [{ t: 5, ease: 0, box: { x: 0.375, y: 0.375, w: 0.25, h: 0.25 } }] }] }));
    await w.waitForTimeout(400);
    check(await w.$$eval('#qttracks .trk-zs', e => e.length) === 1, 'a step shows as a diamond on its zoom');
    await w.evaluate(() => window.qtFx.select('z1')); await w.waitForTimeout(200);
    check(/Step 2/.test(await w.$eval('#qtfxprops', e => e.textContent)), 'Properties lists the steps');
    const zv = await w.evaluate(() => T.qtExport({ path: window.qtActivePath(), start: 0, end: 12, as: 'video', dest: 'temp', audio: {}, fx: window.qtFx.state() }));
    if (zv.ok) {
      const s1 = psnr(zv.out, src, 3, '320:180:160:90'), s2 = psnr(zv.out, src, 7.5, '160:90:240:135'), wrong = psnr(zv.out, src, 7.5, '320:180:160:90');
      check(s1 > 22 && s2 > 22 && wrong < s2 - 5, 'the export zooms to step 1 and then on to step 2', [s1, s2, wrong]);
    } else check(false, 'export with zoom steps', zv.error);
    // Add Step at Playhead: a tighter box in the same spot
    await w.evaluate(() => window.qtFx.setState({ layers: [{ id: 'z2', type: 'zoom', track: 0, start: 1, end: 11, ein: 0.3, eout: 0.3, box: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 } }] }));
    await w.evaluate(() => window.qtFx.select('z2')); await w.waitForTimeout(200);
    const v1 = await rect('#qttracks .trow.v1 .trk-l'); const view = await w.evaluate(() => window.qtFx.view());
    await w.mouse.click(v1.l + (6 - view.t0) / (view.t1 - view.t0) * v1.w, v1.t + v1.h - 8); await w.waitForTimeout(200);
    await w.evaluate(() => window.qtFx.select('z2')); await w.waitForTimeout(200);
    await w.click('#qtfxprops .btn >> text=Add Step at Playhead'); await w.waitForTimeout(400);
    const z2 = (await fx()).layers[0];
    check(z2.steps && z2.steps.length === 1 && Math.abs(z2.steps[0].box.w - 0.45) < 0.01 && Math.abs(z2.steps[0].box.x + z2.steps[0].box.w / 2 - 0.5) < 0.01, 'Add Step zooms in further on the same spot', z2.steps);
    // moving the zoom takes its steps along
    const zb = await rect('#qttracks .trk-b.zb');
    await w.mouse.move(zb.x - 40, zb.y); await w.mouse.down(); await w.mouse.move(zb.x - 10, zb.y, { steps: 5 }); await w.mouse.up(); await w.waitForTimeout(300);
    const z3 = (await fx()).layers[0];
    check(Math.abs((z3.steps[0].t - z3.start) - (z2.steps[0].t - z2.start)) < 0.01 && z3.start !== z2.start, 'moving a zoom moves its steps with it', [z2.start, z3.start, z2.steps[0].t, z3.steps[0].t]);
    check(await w.$eval('#qtassets', e => [...e.querySelectorAll('*')].every(x => !/\.\.\.$/.test(x.textContent.trim()))), 'asset tiles have no "..." in their names');
  } catch (err) { check(false, 'test crashed: ' + (err.stack || err.message).slice(0, 500)); } finally {
    await app.close();
  }
  check(!errs.length, 'no page errors', errs);

  // ---- the home page: a virtual grid ----
  ({ app, w, errs } = await launch({ name: 'tools-home', library: bigLibrary(120) }));
  try {
    await w.waitForTimeout(3000);
    const n = await w.$$eval('#libgrid .clip', e => e.length);
    check(n > 0 && n < 60, 'only the cards near the screen are on the page', n);
    await w.evaluate(() => { const s = document.getElementById('libscroll'); s.scrollTop = s.scrollHeight; }); await w.waitForTimeout(400);
    const last = await w.evaluate(() => L.list[L.list.length - 1].path);
    check(await w.evaluate(p => [...document.querySelectorAll('#libgrid .clip')].some(e => e._clip.path === p), last), 'the last clip is there at the bottom');
    check(await w.$$eval('#libgrid .clip.loading', e => e.length) === 0, 'cards that scroll in don\'t fade in');
    await w.evaluate(() => { document.getElementById('libscroll').scrollTop = 3000; }); await w.waitForTimeout(40);
    const b = await w.evaluate(() => { const el = [...document.querySelectorAll('#libgrid .clip')].find(x => { const r = x.getBoundingClientRect(); return r.top > 150 && r.bottom < innerHeight; }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await w.mouse.click(b.x, b.y);
    check(await w.waitForSelector('#qt.on', { timeout: 4000 }).then(() => true, () => false), 'a card clicked right after scrolling opens');
  } catch (err) { check(false, 'home test crashed: ' + (err.stack || err.message).slice(0, 500)); } finally {
    await app.close();
  }
  check(!errs.length, 'no page errors (home)', errs);
  done();
})();

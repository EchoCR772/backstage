// Cutting the clip's own sound in Edit (report #2): the razor on a sound row, Shift+click for every
// row, deleting a piece (silence), linked pieces stay in step, Unlink / Link to Video, Restore Whole
// Row, the video row only explains, and the export plays each piece where it sits.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { launch, checker, gopLibrary } = require('./helpers');
const FF = '/usr/bin/ffmpeg';
// loudness (dB) of 0.8 s of a file's sound from t
function level(f, t) {
  const out = require('child_process').spawnSync(FF, ['-hide_banner', '-ss', String(t), '-t', '0.8', '-i', f, '-af', 'volumedetect', '-f', 'null', '-']).stderr.toString();
  const m = /mean_volume: (-?[\d.]+|-inf) dB/.exec(out);
  return m ? (m[1] === '-inf' ? -200 : +m[1]) : null;
}

(async () => {
  const { check, done } = checker('cuts');
  const lib = gopLibrary();
  const { app, w, errs } = await launch({ name: 'cuts', library: lib });
  const fx = () => w.evaluate(() => window.qtFx.state());
  const cuts = async () => ((await fx()) || {}).cuts || {};
  const lane = key => w.$eval(`#qttracks .trow.c[data-key="${key}"] .trk-l`, e => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width }; });
  // where clip time t is on the timeline lanes
  const xAt = async (t, l) => { const v = await w.evaluate(() => window.qtFx.view()); return l.x + (t - v.t0) / (v.t1 - v.t0) * l.w; };
  try {
    await w.evaluate(async () => { await T.settingsSet({ editSave: 'auto' }); L.editSave = 'auto'; });
    await w.click('#libgrid .clip >> nth=0'); await w.waitForSelector('#qt.on'); await w.waitForTimeout(1500);
    await w.keyboard.press('e'); await w.waitForTimeout(600);
    await w.evaluate(() => window.qtFx.setView(0, 12)); await w.waitForTimeout(200);
    const keys = await w.$$eval('#qttracks .trow.c', e => e.map(r => r.dataset.key));
    check(keys.length === 2, 'the clip has two sound rows', keys);
    const [k1, k2] = keys;

    // the video row can't be cut yet: a hint, nothing changes
    await w.keyboard.press('c'); await w.waitForTimeout(100);
    const v1 = await w.$eval('#qttracks .trow.v1 .trk-l', e => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width }; });
    await w.mouse.click(await xAt(3, v1), v1.y); await w.waitForTimeout(300);
    check(/can't be cut yet/.test(await w.$eval('#qtstatus', e => e.textContent)) && Object.keys(await cuts()).length === 0, 'razor on the video explains instead of doing nothing', await w.$eval('#qtstatus', e => e.textContent));

    // razor on A1: just that row splits in two
    let l1 = await lane(k1);
    await w.mouse.click(await xAt(4, l1), l1.y); await w.waitForTimeout(400);
    let c = await cuts();
    check(c[k1] && c[k1].pieces.length === 2 && !c[k2], 'razor on A1 cuts only A1', c);
    check(c[k1] && c[k1].pieces.some(p => Math.abs(p.from - 4) < 0.15 && Math.abs(p.at - p.from) < 1e-6), 'the cut is where it was clicked and stays in step', c[k1] && c[k1].pieces);
    check(await w.$$eval(`#qttracks .trow.c[data-key="${k1}"] .trk-b.pc`, e => e.length) === 2, 'A1 shows two pieces');

    // Shift+click cuts every sound row
    l1 = await lane(k1);
    await w.keyboard.down('Shift'); await w.mouse.click(await xAt(6, l1), l1.y); await w.keyboard.up('Shift'); await w.waitForTimeout(400);
    c = await cuts();
    check(c[k1] && c[k1].pieces.length === 3 && c[k2] && c[k2].pieces.length === 2, 'Shift+click cuts all the sound rows', c);

    // select mode: dragging a linked piece only moves the playhead
    await w.keyboard.press('v'); await w.waitForTimeout(100);
    l1 = await lane(k1);
    const mid = await xAt(5, l1);
    await w.mouse.move(mid, l1.y); await w.mouse.down(); await w.mouse.move(mid + 80, l1.y, { steps: 5 }); await w.mouse.up(); await w.waitForTimeout(400);
    c = await cuts();
    check(c[k1].pieces.every(p => Math.abs(p.at - p.from) < 1e-6), 'a linked piece stays in step when dragged', c[k1].pieces);

    // its end can still be shortened
    const piece = (await cuts())[k1].pieces.find(p => Math.abs(p.from - 4) < 0.15);
    const endX = await w.$eval(`#qttracks .trk-b[data-id="${piece.id}"] .trk-eg.e`, e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await w.mouse.move(endX.x, endX.y); await w.mouse.down(); await w.mouse.move(endX.x - 30, endX.y, { steps: 4 }); await w.mouse.up(); await w.waitForTimeout(400);
    const shorter = (await cuts())[k1].pieces.find(p => p.id === piece.id);
    check(shorter && shorter.to < piece.to - 0.1 && Math.abs(shorter.at - shorter.from) < 1e-6, 'dragging a piece end shortens it, still in step', [piece, shorter]);

    // Delete leaves silence: the piece is gone
    await w.click(`#qttracks .trk-b[data-id="${piece.id}"]`); await w.waitForTimeout(200);
    check(await w.$eval('#qtfxpropsh', e => e.textContent) === 'Audio' && /Linked to the video/.test(await w.$eval('#qtfxprops', e => e.textContent)), 'a piece shows its properties');
    await w.keyboard.press('Delete'); await w.waitForTimeout(400);
    c = await cuts();
    check(c[k1].pieces.length === 2 && !c[k1].pieces.some(p => p.id === piece.id), 'Delete removes the piece', c[k1].pieces);

    // undo brings it back
    await w.waitForTimeout(400);
    await w.keyboard.press('Control+z'); await w.waitForTimeout(600);
    check((await cuts())[k1].pieces.length === 3, 'undo brings the piece back', (await cuts())[k1].pieces.length);

    // Unlink from Video: now a piece slides
    const last = (await cuts())[k1].pieces.sort((a, b) => b.from - a.from)[0];
    const lb = await w.$eval(`#qttracks .trk-b[data-id="${last.id}"]`, e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await w.mouse.click(lb.x, lb.y, { button: 'right' }); await w.waitForTimeout(200);
    await w.click('#ctxmenu >> text=Unlink from Video'); await w.waitForTimeout(400);
    check((await cuts())[k1].free === true && await w.$$eval(`#qttracks .trow.c[data-key="${k1}"] .trk-unl`, e => e.length) === 1, 'Unlink from Video marks the row unlinked');
    // make room before the second piece, then slide it left
    const ps = (await cuts())[k1].pieces.sort((a, b) => a.from - b.from);
    await w.click(`#qttracks .trk-b[data-id="${ps[0].id}"]`); await w.waitForTimeout(150);
    await w.keyboard.press('Delete'); await w.waitForTimeout(400);
    const lb2 = await w.$eval(`#qttracks .trk-b[data-id="${ps[1].id}"]`, e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await w.mouse.move(lb2.x, lb2.y); await w.mouse.down(); await w.mouse.move(lb2.x - 60, lb2.y, { steps: 6 }); await w.mouse.up(); await w.waitForTimeout(400);
    let moved = (await cuts())[k1].pieces.find(p => p.id === ps[1].id);
    check(moved && moved.at < moved.from - 0.2 && Math.abs(moved.to - moved.from - (ps[1].to - ps[1].from)) < 1e-6, 'an unlinked piece slides in time (same sound, new place)', moved);
    // another row stays linked
    check(!(await cuts())[k2].free, 'unlinking is per row');

    // Link to Video puts it back in step
    const lb3 = await w.$eval(`#qttracks .trk-b[data-id="${ps[1].id}"]`, e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await w.mouse.click(lb3.x, lb3.y, { button: 'right' }); await w.waitForTimeout(200);
    await w.click('#ctxmenu >> text=Link to Video'); await w.waitForTimeout(400);
    moved = (await cuts())[k1].pieces.find(p => p.id === ps[1].id);
    check(moved && Math.abs(moved.at - moved.from) < 1e-6 && !(await cuts())[k1].free, 'Link to Video puts it back in step', moved);

    // Restore Whole Row undoes every cut on that row
    await w.mouse.click(lb3.x, lb3.y, { button: 'right' }); await w.waitForTimeout(200);
    await w.click('#ctxmenu >> text=/Restore Whole/'); await w.waitForTimeout(400);
    c = await cuts();
    check(!c[k1] && c[k2], 'Restore Whole Row takes that row back to one block', Object.keys(c));
    check(await w.$$eval(`#qttracks .trow.c[data-key="${k1}"] .trk-b.cb`, e => e.length) === 1, 'the row shows its whole block again');

    // Ctrl+K with nothing selected cuts every sound row at the playhead
    const v1b = await w.$eval('#qttracks .trow.v1 .trk-l', e => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width }; });
    await w.mouse.click(await xAt(2, v1b), v1b.y); await w.waitForTimeout(200);
    await w.keyboard.press('Escape'); await w.waitForTimeout(100);
    const before2 = (await cuts())[k2].pieces.length;
    await w.keyboard.press('Control+k'); await w.waitForTimeout(400);
    c = await cuts();
    check(c[k1] && c[k1].pieces.length === 2 && c[k2].pieces.length === before2 + 1, 'Ctrl+K with nothing selected cuts every sound row at the playhead', c);
    // the export: A1 plays 0-4 and 6-8 moved to 9-11; A2 (880 Hz) is cut away entirely
    await w.evaluate(([a, b]) => window.qtFx.setState({ cuts: {
      [a]: { free: true, pieces: [{ id: 'p1', from: 0, to: 4, at: 0 }, { id: 'p2', from: 6, to: 8, at: 9 }] },
      [b]: { free: false, pieces: [] },
    } }), [k1, k2]);
    await w.waitForTimeout(500);
    check(await w.$$eval('#qttracks .trk-b.pc', e => e.length) === 2, 'setState draws the pieces');
    const r = await w.evaluate(() => T.qtExport({ path: window.qtActivePath(), start: 0, end: 12, as: 'audio', dest: 'temp', audio: {}, fx: window.qtFx.state() }));
    check(r.ok, 'audio export with cut rows works', r.error);
    if (r.ok) {
      const a = level(r.out, 1.1), gap = level(r.out, 5.5), slid = level(r.out, 9.6), after = level(r.out, 11.2);
      check(a !== null && a > -30, 'the first piece is heard', a);
      check(gap !== null && gap < -60, 'the cut-away part is silent', gap);
      check(slid !== null && slid > -30, 'the slid piece is heard where it was moved to', slid);
      check(after !== null && after < -60, 'nothing after it', after);
    }
    const rv = await w.evaluate(() => T.qtExport({ path: window.qtActivePath(), start: 0, end: 12, as: 'video', dest: 'temp', audio: {}, fx: window.qtFx.state() }));
    check(rv.ok && rv.size > 10000, 'video export with cut rows works', rv.ok ? rv.size : rv.error);
    if (rv.ok) check(level(rv.out, 5.5) < -60 && level(rv.out, 1.1) > -30, 'the video export has the same sound');
    // the pieces are saved with the clip
    await w.waitForTimeout(800);
    check(await w.evaluate(k => { const e = L.data.clips.find(c => c.path === window.qtActivePath()).edit; return !!(e && e.fx && e.fx.cuts && e.fx.cuts[k] && e.fx.cuts[k].pieces.length === 2); }, k1), 'the cuts are saved with the clip');
    // opening and leaving clips quickly: closing mid-decode reports nothing (report #2's log had
    // "Uncaught (in promise) InputDisposedError")
    for (let i = 0; i < 6; i++) {
      await w.click('.game.home'); await w.waitForTimeout(60);
      await w.click("#libgrid .clip >> nth=0"); await w.waitForTimeout(90 + i * 25);
    }
    await w.waitForTimeout(1500);
  } catch (err) { check(false, 'test crashed: ' + (err.stack || err.message).slice(0, 500)); } finally {
    await app.close();
  }
  check(!errs.length, 'no page errors', errs);
  done();
})();

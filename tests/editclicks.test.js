// Nov 10, 2026, his round on Edit: one click on the picture plays even with something selected (it used
// to only deselect); clicking or dragging on the timeline while playing keeps playing; double-clicking a
// sound row adds a volume point (the timeline captures the pointer, so the event came from the timeline
// itself and nothing happened); a block's edge dragged into its neighbour stops against it instead of
// short of it (it used to refuse the move, so only a pixel-perfect drag closed the gap).
const { launch, checker, gopLibrary } = require('./helpers');
const TimeMap = require('../renderer/timemap.js');

(async () => {
  const { check, done } = checker('editclicks');
  const { app, w, errs } = await launch({ name: 'editclicks', library: gopLibrary() });
  const playing = async () => { const a = await w.evaluate(() => window.qtApi.t()); await w.waitForTimeout(500); return (await w.evaluate(() => window.qtApi.t())) - a > 0.2; };
  const rect = sel => w.$eval(sel, e => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; });
  try {
    await w.evaluate(() => { T.settingsSet({ editSave: 'auto' }); L.editSave = 'auto'; });
    await w.click('#libgrid .clip >> nth=0'); await w.waitForSelector('#qt.on'); await w.waitForTimeout(1500);
    await w.keyboard.press('e'); await w.waitForTimeout(600);
    await w.evaluate(() => window.qtFx.setView(0, 12));
    // two texts on V2: 2..5 and 6..9
    await w.evaluate(() => window.qtFx.setState({ layers: [
      { id: 'ta', type: 'text', track: 0, start: 2, end: 5, text: 'A', x: 0.5, y: 0.2, size: 0.08, color: '#fff' },
      { id: 'tb', type: 'text', track: 0, start: 6, end: 9, text: 'B', x: 0.5, y: 0.2, size: 0.08, color: '#fff' },
      { id: 's1', type: 'speed', track: 0, start: 1, end: 2, rate: 2 }, { id: 's2', type: 'speed', track: 0, start: 7, end: 8, rate: 2 },
    ] }));
    await w.waitForTimeout(300);
    await w.evaluate(() => window.qtFx.setView(0, 12)); await w.waitForTimeout(200);

    // 1. something selected, one click on an empty part of the picture plays
    await w.click('#qttracks .trk-b[data-id="tb"]'); await w.waitForTimeout(200);
    await w.evaluate(() => window.qtApi.seekTo(9.5)); await w.waitForTimeout(200);
    const v = await rect('#qtedit');
    await w.mouse.click(v.l + v.w * 0.1, v.t + v.h * 0.9); await w.waitForTimeout(200);
    check(await playing(), 'one click on the picture plays, with a block selected');
    check(await w.evaluate(() => window.qtFx.selectedId()) === null, 'and lets go of the block');

    // 2. playing, a click on the ruler and on empty timeline keeps playing from there
    const ru = await rect('.etl-ruler');
    await w.mouse.click(ru.l + ru.w * 3 / 12, ru.t + ru.h / 2); await w.waitForTimeout(250);
    const t2 = await w.evaluate(() => window.qtApi.t());
    check(t2 > 2.9 && t2 < 3.8, 'a click on the ruler moves the playhead there', t2);
    check(await playing(), 'and it keeps playing');
    const a1 = await rect('#qttracks .trow.c .trk-l');
    await w.mouse.click(a1.l + a1.w * 0.5 / 12, a1.t + a1.h / 2); await w.waitForTimeout(250);
    const t3 = await w.evaluate(() => window.qtApi.t());
    check(t3 > 0.4 && t3 < 1.2, 'a click on a sound row moves the playhead there', t3);
    check(await playing(), 'and it keeps playing too');
    await w.evaluate(() => window.qtApi.toggle()); await w.waitForTimeout(200);
    check(!(await playing()), 'paused again');

    // 5. double-clicking a sound row adds a volume point there
    const key = await w.$eval('#qttracks .trow.c', e => e.dataset.key);
    await w.mouse.dblclick(ru.l + ru.w * 4 / 12, a1.t + a1.h / 2); await w.waitForTimeout(300);
    const pts = await w.evaluate(k => (window.qtFx.state().vpts || {})[k] || [], key);
    const at4 = TimeMap.build([{ type: 'speed', start: 1, end: 2, rate: 2 }, { type: 'speed', start: 7, end: 8, rate: 2 }], 1, 12).toClip(await w.evaluate(() => { const v = window.qtFx.view(); return v.t0 + (v.t1 - v.t0) * 4 / 12; })); // clip time under the click
    check(pts.length === 1 && Math.abs(pts[0][0] - at4) < 0.05, 'double-clicking a sound row adds a volume point where clicked', [pts, at4]);

    // 3. an edge dragged fast past its neighbour stops against it
    const drag = async (sel, dx) => {
      const g = await rect(sel);
      await w.mouse.move(g.l + g.w / 2, g.t + g.h / 2); await w.mouse.down();
      await w.mouse.move(g.l + g.w / 2 + dx, g.t + g.h / 2, { steps: 2 }); await w.mouse.up(); await w.waitForTimeout(250);
    };
    await drag('#qttracks .trk-b[data-id="ta"] .trk-eg.e', a1.w * 3 / 12);
    let ta = await w.evaluate(() => window.qtFx.state().layers.find(l => l.id === 'ta'));
    check(Math.abs(ta.end - 6) < 0.001, "a text's end dragged past the next one stops right at it", ta.end);
    await drag('#qttracks .trk-b[data-id="tb"] .trk-eg.s', -a1.w * 4 / 12);
    const tb = await w.evaluate(() => window.qtFx.state().layers.find(l => l.id === 'tb'));
    check(Math.abs(tb.start - 6) < 0.001 && Math.abs(tb.end - 9) < 0.001, "the next one's start can't go into it either", [tb.start, tb.end]);
    await drag('#qttracks .trk-b[data-id="s1"] .trk-eg.e', a1.w * 9 / 12);
    const s1 = await w.evaluate(() => window.qtFx.state().layers.find(l => l.id === 's1'));
    check(Math.abs(s1.end - 7) < 0.005, "a speed part's end stops at the next speed part", s1.end);
    // the Clip panel is gone (crop and fades are in Effects); a fade has its own settings
    await w.keyboard.press('Escape'); await w.waitForTimeout(150);
    check(await w.$eval('#qtfxpropsh', e => e.textContent) === 'Clip' && !(await w.$('#qtfxprops .fx-chips')), 'nothing selected: no Crop or Fade rows, just a hint', await w.$eval('#qtfxprops', e => e.textContent));
    await w.evaluate(() => window.qtFx.pickTab('effects')); await w.waitForTimeout(150);
    await w.click('#qtassets .as-tile >> text=Fade in'); await w.waitForTimeout(250);
    const fades = () => w.evaluate(() => (window.qtFx.state() || {}).fades || {});
    check((f => f.vin === 0.5 && f.ain === 0.5 && Object.keys(f).length === 2)(await fades()) && await w.$eval('#qtfxpropsh', e => e.textContent) === 'Fade in', 'the Fade in tile adds picture and sound fades and shows its settings', await fades());
    await w.click('#qtfxprops .chip >> text=Sound'); await w.waitForTimeout(150);
    await w.click('#qtfxprops .chip >> text=1 s'); await w.waitForTimeout(150);
    check(JSON.stringify(await fades()) === '{"vin":1}', 'Sound off and 1 s: only the picture fades in, over a second', await fades());
    await w.click('#qtassets .as-tile >> text=Fade in'); await w.waitForTimeout(150);
    check(JSON.stringify(await fades()) === '{"vin":1}' && await w.$eval('#qtfxpropsh', e => e.textContent) === 'Fade in', 'clicking the tile again opens it (doesn\'t remove it)', await fades());
    await w.keyboard.press('Delete'); await w.waitForTimeout(150);
    check(JSON.stringify(await fades()) === '{}', 'Delete removes it', await fades());
    check(!errs.length, 'no page errors', errs);
  } catch (e) { check(false, 'test crashed', e.stack); }
  await app.close();
  done();
})();

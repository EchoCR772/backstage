// Effects: Trim and Edit, the Edit timeline (V1 = the clip with its zooms, layers above, no runaway
// tracks), undo/redo, split/duplicate, trimming on V1, the asset panel, timeline zoom, the clip list
// as cards that go with the sidebar, and exports with crop, zoom, blur, a filled shape,
// an added sound with volume points and fades (the right size, clean, the shape really in the picture),
// and Export under a size.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { launch, checker, gopLibrary, OUT } = require('./helpers');
const FF = '/usr/bin/ffmpeg', FP = '/usr/bin/ffprobe';
const probe = f => JSON.parse(execFileSync(FP, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', f]).toString());
const clean = f => { try { execFileSync(FF, ['-v', 'error', '-i', f, '-f', 'null', '-'], { stdio: 'pipe' }); return ''; } catch (e) { return String(e.stderr).slice(0, 300); } };
const pixel = (f, t, x, y) => { const b = execFileSync(FF, ['-v', 'error', '-ss', String(t), '-i', f, '-frames:v', '1', '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']); return [...b.subarray(0, 3)]; };

(async () => {
  const { check, done } = checker('effects');
  const lib = gopLibrary();
  const song = path.join(OUT, 'song.mp3');
  if (!fs.existsSync(song)) execFileSync(FF, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=300:d=20', '-c:a', 'libmp3lame', song]);
  const { app, w, errs, ex } = await launch({ name: 'effects', library: lib });
  const fx = () => w.evaluate(() => window.qtFx.state());
  try {
    // Edit saves as you go for most of this test (Settings > Saving edits); manual saving is checked at the end
    await w.evaluate(async () => { await T.settingsSet({ editSave: 'auto' }); L.editSave = 'auto'; });
    await w.click('#libgrid .clip >> nth=0'); await w.waitForSelector('#qt.on'); await w.waitForTimeout(1500);
    // Trim: no timeline tracks, the clip list is the library's cards
    check(await w.$eval('.qt-box', e => e.classList.contains('trim')), 'an untouched clip opens in Trim');
    check(await w.$eval('#qtetl', e => getComputedStyle(e).display === 'none'), 'Trim has no Edit timeline');
    check(await w.$$eval('#qtcliplist .clip.on', e => e.length) === 1, 'clip list shows the open clip as a card');
    check(await w.$eval('#qtcliplist .clip', e => getComputedStyle(e.querySelector('.hbar')).display === 'none'), 'its cards have no seek bar');
    await w.keyboard.press('t'); await w.waitForTimeout(200);
    check((await fx()) === null, 'tool keys do nothing in Trim');

    // Edit: V2 (layers), V1 (the clip), A1.. (its sounds), one track for added sounds
    await w.keyboard.press('e'); await w.waitForTimeout(500);
    check(await w.$eval('.qt-box', e => e.classList.contains('edit')), 'E goes to Edit');
    const rows = await w.$$eval('#qttracks .trow', e => e.map(r => r.querySelector('.trk-name').textContent));
    check(rows[0] === 'V2' && rows[1] === 'V1' && rows[2] === 'A1' && rows.length >= 4, 'Edit timeline rows', rows);

    // text at the playhead on V2, a zoom on V1 (the clip), a second text at the same time: V3
    await w.keyboard.press('t'); await w.waitForTimeout(300);
    await w.keyboard.press('Escape');
    await w.keyboard.press('z'); await w.waitForTimeout(300);
    await w.keyboard.press('Escape');
    let f = await fx();
    const txt = f.layers.find(l => l.type === 'text'), zm = f.layers.find(l => l.type === 'zoom');
    check(txt && zm && txt.track === 0 && txt.end - txt.start <= 3.01, 'text goes on V2 at the playhead', txt);
    check(await w.$$eval('#qttracks .trow.v1 .trk-b.zb', e => e.length) === 1 && await w.$$eval('#qttracks .trow.v', e => e.length) === 1, 'zoom sits on V1, no new layer track');
    await w.keyboard.press('t'); await w.waitForTimeout(300); await w.keyboard.press('Escape'); await w.keyboard.press('Escape');
    f = await fx();
    check(f.layers.filter(l => l.type === 'text').map(l => l.track).sort().join() === '0,1' && await w.$$eval('#qttracks .trow.v', e => e.length) === 2, 'a second text at the same time gets V3');

    // dragging the top block far up adds no tracks (it was making endless ones)
    const top = await w.$eval('#qttracks .trow.v .trk-b', e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await w.mouse.move(top.x, top.y); await w.mouse.down();
    for (let i = 1; i <= 12; i++) { await w.mouse.move(top.x, top.y - i * 30); await w.waitForTimeout(16); }
    const during = await w.$$eval('#qttracks .trow.v', e => e.length);
    await w.mouse.up(); await w.waitForTimeout(300);
    check(during <= 2 && await w.$$eval('#qttracks .trow.v', e => e.length) === 2, 'dragging up past the top makes no new tracks', during);

    // undo / redo
    await w.waitForTimeout(400);
    const n0 = (await fx()).layers.length;
    await w.keyboard.press('Control+z'); await w.waitForTimeout(500);
    check((await fx()).layers.length === n0 - 1, 'undo removes the last one', (await fx()).layers.length);
    await w.keyboard.press('Control+Shift+z'); await w.waitForTimeout(500);
    check((await fx()).layers.length === n0, 'redo brings it back', (await fx()).layers.length);

    // split a text at the playhead, duplicate the zoom (another zoom on V1, never overlapping)
    const tid = (await fx()).layers.find(l => l.type === 'text' && l.track === 0).id;
    await w.evaluate(id => window.qtFx.select(id), tid); await w.waitForTimeout(200);
    await w.evaluate(() => document.getElementById('etlffwd').click()); await w.evaluate(() => document.getElementById('etlffwd').click()); await w.waitForTimeout(200);
    await w.keyboard.press('Control+k'); await w.waitForTimeout(400);
    f = await fx();
    const texts = f.layers.filter(l => l.type === 'text' && l.track === 0).sort((a, b) => a.start - b.start);
    check(texts.length === 2 && Math.abs(texts[0].end - texts[1].start) < 1e-6, 'split makes two blocks that meet', texts.map(t => [t.start, t.end]));
    const zid = f.layers.find(l => l.type === 'zoom').id;
    await w.evaluate(id => window.qtFx.select(id), zid); await w.waitForTimeout(200);
    await w.keyboard.press('Control+d'); await w.waitForTimeout(400);
    f = await fx();
    const zs = f.layers.filter(l => l.type === 'zoom').sort((a, b) => a.start - b.start);
    check(zs.length === 2 && zs[1].start >= zs[0].end - 1e-6, 'duplicate zoom goes after it on V1', zs.map(z => [z.start, z.end]));
    await w.keyboard.press('Escape');

    // V1's left edge moves the trim
    const tin0 = await w.$eval('#qtin', e => e.value);
    const edge = await w.$eval('#qttracks .trow.v1 .trk-eg.ts', e => { const r = e.getBoundingClientRect(); return { x: r.left + 3, y: r.top + r.height / 2 }; });
    await w.mouse.move(edge.x, edge.y); await w.mouse.down(); await w.mouse.move(edge.x + 40, edge.y, { steps: 5 }); await w.mouse.up(); await w.waitForTimeout(400);
    check(await w.$eval('#qtin', e => e.value) !== tin0, 'dragging V1\'s edge trims the clip', [tin0, await w.$eval('#qtin', e => e.value)]);
    await w.click('#qtreset'); await w.waitForTimeout(300);

    // the asset panel: Shapes > Filled box adds a filled box
    await w.click('#edittabs [data-tab="shapes"]'); await w.waitForTimeout(150);
    await w.click('#qtassets .as-tile[data-shape="rectf"]'); await w.waitForTimeout(300);
    check((await fx()).layers.some(l => l.type === 'shape' && l.fill), 'asset panel adds a filled box');
    // zooming the timeline narrows the view
    await w.evaluate(() => { const z = document.getElementById('etlzoom'); z.value = 60; z.dispatchEvent(new Event('input')); });
    const v = await w.evaluate(() => window.qtFx.view());
    check(v.t1 - v.t0 < 6, 'the zoom slider zooms the timeline', v);
    await w.keyboard.press('Escape');

    // a clip with effects opens straight in Edit; back to Trim with the button
    await w.click('#qttrim-btn'); await w.waitForTimeout(300);
    check(await w.$eval('.qt-box', e => e.classList.contains('trim')) && await w.$eval('#qtedit-btn', e => e.classList.contains('has')), 'Back to Trim; Edit shows the clip has effects');
    await w.waitForTimeout(400);
    await w.click('.game.home'); await w.waitForTimeout(500);
    check(await w.$eval('#qt', e => e.hidden), 'Home goes back to the big cards');
    await w.click('#libgrid .clip >> nth=0'); await w.waitForSelector('#qt.on'); await w.waitForTimeout(1500);
    check(await w.$eval('.qt-box', e => e.classList.contains('edit')), 'the clip with effects reopens in Edit');
    // the clip list goes with the sidebar
    await w.click('#qttrim-btn'); await w.keyboard.press('Control+b'); await w.waitForTimeout(300);
    check(await w.$eval('.qt-box', e => e.classList.contains('mini')) && await w.$eval('#libside', e => e.classList.contains('collapsed')), 'collapsing the sidebar narrows the clip list');
    await w.keyboard.press('Control+b'); await w.waitForTimeout(200);
    await w.keyboard.press('e'); await w.waitForTimeout(300);

    // export with everything: crop 1:1, zoom, blur, a filled magenta box over the middle, a sound
    // with volume points, fades
    const r0 = await w.evaluate(async p => (await T.fxFile(p)), song);
    check(r0.ok && r0.kind === 'audio' && r0.dur > 19, 'a sound file can be added', r0);
    check(await w.evaluate(p => T.fileSize(p).then(n => n > 0, () => false), song), 'the preview can read an added sound');
    await w.evaluate(s => window.qtFx.setState({
      crop: { x: 0.21875, y: 0, w: 0.5625, h: 1 },
      layers: [
        { id: 'z1', type: 'zoom', track: 0, start: 2, end: 5, box: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, ein: 0.3, eout: 0.3 },
        { id: 'b1', type: 'blur', track: 0, start: 6, end: 9, box: { x: 0, y: 0, w: 0.4, h: 0.4 }, strength: 6 },
        { id: 's1', type: 'shape', track: 1, start: 0, end: 12, shape: 'rect', fill: true, color: '#ff00ff', stroke: 0.008, box: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } },
      ],
      sounds: [{ id: 'a1', track: 0, path: s.path, name: 'song', dur: s.dur, at: 1, from: 2, to: 8, vol: 0.8, mute: false, pts: [[0, 0], [1, 1]] }],
      vpts: {}, fades: { vin: 0.5, aout: 0.5 }, vtracks: [{}, {}], atracks: [{}],
    }), r0);
    await w.waitForTimeout(800);
    check(await w.$$eval('#qtlevels canvas', e => e.length) >= 0 && await w.evaluate(() => getComputedStyle(document.getElementById('qtview')).overflow) === 'hidden', 'preview frame is the crop');
    await w.click('#qtsave');
    await w.waitForFunction(() => /Exported|Couldn't/.test(document.getElementById('qtstatus').textContent), null, { timeout: 120000 });
    const st = await w.$eval('#qtstatus', e => e.textContent);
    check(/Exported/.test(st), 'export with effects works', st);
    const outF = fs.readdirSync(ex, { recursive: true }).map(String).filter(x => x.endsWith('.mp4')).map(x => path.join(ex, x)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    if (outF) {
      const p = probe(outF), v = p.streams.find(s => s.codec_type === 'video');
      check(v && v.width === 360 && v.height === 360, 'cropped to 1:1 (360x360)', v && [v.width, v.height]);
      check(Math.abs(+p.format.duration - 12) < 0.15, 'whole length', p.format.duration);
      check(p.streams.some(s => s.codec_type === 'audio'), 'has sound');
      check(clean(outF) === '', 'decodes cleanly', clean(outF));
      const px = pixel(outF, 10.5, 180, 180);
      check(px[0] > 200 && px[1] < 60 && px[2] > 200, 'the magenta box is burned into the middle of the picture', px);
      const first = pixel(outF, 0.02, 180, 180);
      check(first[0] < 90 && first[2] < 90, 'fade in starts from black', first);
    } else check(false, 'export file found');

    // Export under a size: 1 MB for a 12 s clip
    const r1 = await w.evaluate(() => T.qtExport({ path: window.qtActivePath(), start: 0, end: 12, as: 'video', dest: 'temp', audio: {}, fx: window.qtFx.state(), target: 1048576 }));
    check(r1.ok && r1.size <= 1048576, 'export under a size fits', r1.ok ? r1.size : r1.error);
    // Replace original refuses picture effects
    check(await w.evaluate(() => window.qtFx.hasVisual()), 'picture effects count as visual');

    // manual saving (the default): Cancel and Save Changes, and a warning when leaving unsaved
    const top0 = await w.$eval('.qt-head', e => { const r = e.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)]; });
    const left0 = await w.$eval('#qtclips', e => e.offsetWidth);
    await w.evaluate(async () => { await T.settingsSet({ editSave: 'manual' }); L.editSave = 'manual'; window.qtSaveModeChanged(); });
    await w.click('#qtsave-btn'); await w.waitForTimeout(600); // nothing changed yet: back to Trim
    check(await w.$eval('.qt-box', e => e.classList.contains('trim')), 'Save Changes goes back to Trim');
    const top1 = await w.$eval('.qt-head', e => { const r = e.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)]; });
    check(top0.join() === top1.join() && await w.$eval('#qtclips', e => e.offsetWidth) === left0, 'header and left panel stay put between Edit and Trim', [top0, top1, left0]);
    const saved = JSON.stringify(await fx());
    await w.keyboard.press('e'); await w.waitForTimeout(400);
    check(await w.$eval('#qtcancel-btn', e => e.offsetParent !== null) && await w.$eval('#qtsave-btn', e => e.offsetParent !== null) && await w.$eval('#qttrim-btn', e => e.offsetParent === null), 'manual Edit shows Cancel and Save Changes');
    await w.keyboard.press('t'); await w.waitForTimeout(200); await w.keyboard.press('Escape'); await w.keyboard.press('Escape'); await w.waitForTimeout(500);
    check(await w.$eval('#qtsave-btn', e => e.classList.contains('dirty')), 'Save Changes shows there are unsaved changes');
    check(await w.evaluate(() => JSON.stringify(L.data.clips.find(c => c.path === window.qtActivePath()).edit.fx)) === saved, 'the change is not saved yet');
    await w.click('#qtcancel-btn'); await w.waitForSelector('.modal-ov.on');
    check(/Discard/.test(await w.$eval('.modal-ov h2', e => e.textContent)), 'Cancel warns that changes will be discarded');
    await w.click('.modal-ov .mbtn.danger'); await w.waitForTimeout(700);
    check(JSON.stringify(await fx()) === saved && await w.$eval('.qt-box', e => e.classList.contains('trim')), 'discarding puts the clip back and goes to Trim');
    // leaving with unsaved changes asks: Keep Editing stays, Save Changes keeps them
    await w.keyboard.press('e'); await w.waitForTimeout(400);
    await w.keyboard.press('t'); await w.waitForTimeout(200); await w.keyboard.press('Escape'); await w.keyboard.press('Escape'); await w.waitForTimeout(500);
    await w.click('.game.home'); await w.waitForSelector('.modal-ov.on');
    check(/Unsaved/.test(await w.$eval('.modal-ov h2', e => e.textContent)), 'leaving with unsaved changes asks first');
    await w.click('.modal-ov .mbtn >> text=Keep Editing'); await w.waitForTimeout(400);
    check(!(await w.$eval('#qt', e => e.hidden)), 'Keep Editing stays in the editor');
    await w.click('.game.home'); await w.waitForSelector('.modal-ov.on');
    await w.click('.modal-ov .mbtn.primary'); await w.waitForTimeout(1000);
    check(await w.$eval('#qt', e => e.hidden), 'Save Changes there leaves');
    check(await w.evaluate(() => (L.data.clips[0].edit.fx.layers || []).length) === JSON.parse(saved).layers.length + 1, 'and the change was saved');
  } catch (err) { check(false, 'test crashed: ' + (err.stack || err.message).slice(0, 500)); } finally {
    await app.close();
  }
  check(!errs.length, 'no page errors', errs);
  done();
})();

// Fixes from his test-build round on Nov 2, 2026: Discard after playing in Edit, the editor's clip list
// picking up a newly saved clip, a clip that was still being written getting its picture once it's done,
// drawing carrying on after undo, Edit's full transport bar and its icons, tooltips below the title bar,
// and V1's pictures staying put while the timeline scrolls.
const fs = require('fs');
const path = require('path');
const { launch, checker, gopLibrary, OUT } = require('./helpers');

(async () => {
  const { check, done } = checker('fixes');
  const lib = gopLibrary();
  const src = fs.readdirSync(path.join(lib[0], 'Deadlock')).map(n => path.join(lib[0], 'Deadlock', n))[0];
  // a second folder where clips appear while the app is open
  const extra = path.join(OUT, 'fixlib', 'nv');
  fs.rmSync(path.join(OUT, 'fixlib'), { recursive: true, force: true });
  fs.mkdirSync(path.join(extra, 'Peak'), { recursive: true });
  const { app, w, errs } = await launch({ name: 'fixes', library: [lib[0], extra] });
  const fx = () => w.evaluate(() => window.qtFx.state());
  const shown = sel => w.$eval(sel, e => e.offsetParent !== null).catch(() => false);
  try {
    // a clip that's still being written (no index at the end yet): no picture; once it's finished, it gets one
    const growing = path.join(extra, 'Peak', 'Peak 2026.11.02 - 10.00.00.01.DVR.mp4');
    const full = fs.readFileSync(src);
    fs.writeFileSync(growing, full.subarray(0, Math.floor(full.length * 0.4)));
    await w.waitForFunction(() => L.data && L.data.clips.some(c => c.path.includes('10.00.00.01')), null, { timeout: 15000 });
    const card = () => w.evaluate(() => { const el = [...document.querySelectorAll('#libgrid .clip')].find(x => x._clip.path.includes('10.00.00.01')); return el ? { img: !!el.querySelector(':scope > img'), err: el.querySelector('.ph').textContent } : null; });
    await w.waitForFunction(() => { const el = [...document.querySelectorAll('#libgrid .clip')].find(x => x._clip.path.includes('10.00.00.01')); return el && !el.classList.contains('loading'); }, null, { timeout: 15000 }).catch(() => {});
    check(!(await card()).img, 'a half-written clip has no picture yet', await card());
    fs.writeFileSync(growing, full);
    await w.waitForFunction(() => { const el = [...document.querySelectorAll('#libgrid .clip')].find(x => x._clip.path.includes('10.00.00.01')); return el && el.querySelector(':scope > img'); }, null, { timeout: 15000 }).catch(() => {});
    check((await card()).img, 'it gets its picture once it\'s finished', await card());

    // open the Deadlock clip in Edit (manual saving, the default)
    await w.evaluate(async () => { await T.settingsSet({ editSave: 'manual' }); L.editSave = 'manual'; });
    await w.click('.game:has-text("Deadlock")'); await w.waitForTimeout(400);
    await w.click('#libgrid .clip >> nth=0'); await w.waitForSelector('#qt.on'); await w.waitForTimeout(1500);
    await w.keyboard.press('e'); await w.waitForTimeout(700);

    // the transport bar in Edit: the same buttons as Trim, and the jump buttons don't look like frame steps
    check((await w.$$eval('.etl-transport button', e => e.map(b => b.id))).join() === 'etlmarkin,etlfback,etltostart,etlback,etlplay,etlfwd,etltoend,etlffwd,etlmarkout', 'Edit has the full transport bar');
    check(await shown('#etlloop'), 'and the loop button');
    check(await w.evaluate(() => ICONS.toStart !== ICONS.frameBack && ICONS.toEnd !== ICONS.frameFwd), 'jump and frame step have different icons');
    await w.evaluate(() => window.qtApi.seek(5)); await w.waitForTimeout(200);
    await w.click('#etltostart'); await w.waitForTimeout(200);
    check(await w.$eval('#etlcur', e => e.textContent).then(t => /^0:00\.00/.test(t)), 'jump to the trim start works in Edit', await w.$eval('#etlcur', e => e.textContent));

    // tooltips under the title bar go below their button, not under Windows' buttons
    const help = await w.$('.qt-side .ibtn >> nth=2');
    await help.hover(); await w.waitForTimeout(700);
    const tipTop = await w.$eval('#tip', e => e.hidden ? -1 : e.getBoundingClientRect().top);
    check(tipTop >= 40, 'tooltips of the buttons at the top right show below them', tipTop);
    await w.mouse.move(700, 400);

    // playing in Edit doesn't count as a change, and Discard after playing puts things back
    await w.click('#etlplay'); await w.waitForTimeout(600); await w.click('#etlplay'); await w.waitForTimeout(200);
    check(!(await w.evaluate(() => window.qtDirty())), 'playing is not an unsaved change');
    await w.evaluate(() => window.qtFx.useAsset('shape:rect')); await w.waitForTimeout(400);
    await w.click('#etlplay'); await w.waitForTimeout(600); await w.click('#etlplay'); await w.waitForTimeout(300);
    check(await w.evaluate(() => window.qtDirty()), 'adding a box is');
    await w.click('.game.home'); await w.waitForSelector('.modal-ov.on');
    await w.click('.modal-ov .mbtn:has-text("Discard")'); await w.waitForTimeout(800);
    check(await w.$eval('#qt', e => e.hidden), 'Discard after playing closes the editor');
    const saved = await w.evaluate(() => (L.data.clips.find(c => c.path.includes('Deadlock')).edit || {}).fx || null);
    check(!saved || !(saved.layers || []).length, 'and the box is gone', saved);

    // back in: the clip list picks up a clip saved while the editor is open
    await w.click('.game:has-text("Deadlock")').catch(() => {}); await w.waitForTimeout(300);
    await w.click('.game.allclips'); await w.waitForTimeout(300);
    await w.click('#libgrid .clip:has-text("Deadlock") >> nth=0').catch(async () => { await w.click('#libgrid .clip >> nth=0'); });
    await w.waitForSelector('#qt.on'); await w.waitForTimeout(1200);
    const n0 = await w.evaluate(() => L.list.length);
    fs.copyFileSync(src, path.join(extra, 'Peak', 'Peak 2026.11.02 - 11.00.00.01.DVR.mp4'));
    await w.waitForFunction(n => L.list.length > n, n0, { timeout: 15000 }).catch(() => {});
    check(await w.evaluate(() => L.list.length) > n0 && await w.evaluate(() => window.qtIsOpen()), 'a new clip shows up in the editor\'s list', [n0, await w.evaluate(() => L.list.length)]);
    check(await w.$$eval('#qtcliplist .clip', e => e.some(x => x._clip.path.includes('11.00.00.01'))), 'with its card');

    // drawing carries on after undo
    await w.keyboard.press('e'); await w.waitForTimeout(700);
    const cv = await w.$eval('#qtcanvas', e => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    const stroke = async dy => { await w.mouse.move(cv.x + cv.w * 0.3, cv.y + cv.h * dy); await w.mouse.down(); await w.mouse.move(cv.x + cv.w * 0.6, cv.y + cv.h * dy, { steps: 6 }); await w.mouse.up(); await w.waitForTimeout(350); };
    const strokes = async () => ((await fx()) || { layers: [] }).layers.filter(l => l.type === 'draw').reduce((n, l) => n + l.strokes.length, 0);
    await w.evaluate(() => window.qtFx.useAsset('fx:draw')); await w.waitForTimeout(200);
    await stroke(0.3); await stroke(0.5);
    await w.keyboard.press('Control+z'); await w.waitForTimeout(400);
    await stroke(0.7);
    check(await strokes() === 2, 'after Ctrl+Z the next stroke still draws', await strokes());
    await w.click('#qtundo'); await w.waitForTimeout(300); await w.click('#qtundo'); await w.waitForTimeout(300); await w.click('#qtundo'); await w.waitForTimeout(300);
    await stroke(0.4);
    check(await strokes() === 1, 'even with everything undone', await strokes());
    await w.keyboard.press('Escape'); await w.keyboard.press('Escape');

    // V1's pictures: decoded once, then kept while the view scrolls (no blank, no reshuffle)
    await w.evaluate(() => { const z = document.getElementById('etlzoom'); z.value = 70; z.dispatchEvent(new Event('input')); });
    await w.waitForFunction(() => window.qtFx.thumbCount() > 0, null, { timeout: 10000 }).catch(() => {});
    await w.waitForTimeout(1500);
    const kept = await w.evaluate(() => window.qtFx.thumbCount());
    check(kept > 0, 'V1 pictures decode', kept);
    const v = await w.evaluate(() => window.qtFx.view());
    const lit = () => w.evaluate(() => { const c = document.querySelector('.trk-thumbs'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n / (d.length / 4); });
    const before = await lit();
    await w.evaluate(s => window.qtFx.setView(s.t0 + (s.t1 - s.t0) * 0.1, s.t1 + (s.t1 - s.t0) * 0.1), v);
    await w.waitForTimeout(30);
    const after = await lit();
    check(before > 0.5 && after > 0.5, 'right after scrolling the pictures are still there', [before, after]);
    check(await w.evaluate(() => window.qtFx.thumbCount()) >= kept, 'the decoded pictures are kept');

    // the update dialog's fallback notes (the updater's HTML copy): no &gt; showing, lists kept
    const notes = await w.evaluate(() => mdNodes('<h2>Fixes</h2>\n<ul>\n<li>Help &gt; Changelog works &amp; shows <strong>every</strong> version</li>\n<li>It&#39;s quicker</li>\n</ul>').map(n => [n.tagName, n.textContent]));
    check(JSON.stringify(notes) === JSON.stringify([['H4', 'Fixes'], ['UL', 'Help > Changelog works & shows every versionIt\'s quicker']]), 'update notes from HTML read like the Markdown ones', notes);
    check(await w.evaluate(() => mdNodes('- a > b & c').map(n => n.textContent).join()) === 'a > b & c', 'plain Markdown notes are left as they are');
  } catch (err) { check(false, 'test crashed: ' + (err.stack || err.message).slice(0, 500)); } finally {
    await app.close();
  }
  check(!errs.length, 'no page errors', errs);
  done();
})();

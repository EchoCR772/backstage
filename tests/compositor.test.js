// 1.51.0: with WebGPU, Edit's whole picture is drawn by the player's compositor in one canvas the size
// of the view: the clip's crop and zoom, blur boxes, texts, pictures, shapes and drawings. Checked
// against ffmpeg's own frame of the clip (PSNR), and that nothing goes into the page's levels.
// Always runs with software WebGPU (SwiftShader); the 2D path is covered by the other tests.
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { launch, checker, gopLibrary, OUT } = require('./helpers');
const { check, done } = checker('compositor');

const FF = fs.existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : 'ffmpeg';
const TMP = path.join(OUT, 'compositor');

const size = f => execFileSync(FF.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f]).toString().trim().split(',').map(Number);
// PSNR (rgb) of picture a against b cropped (x, y, w, h in 0..1 of b) and scaled to a's size
function psnrOf(a, b, crop) {
  const [w, h] = size(a);
  const c = crop ? `crop=iw*${crop.w}:ih*${crop.h}:iw*${crop.x}:ih*${crop.y},` : '';
  const r = require('child_process').spawnSync(FF, ['-hide_banner', '-i', a, '-i', b, '-lavfi', `[1:v]${c}scale=${w}:${h}:flags=bicubic,format=rgb24[r];[0:v]format=rgb24[s];[s][r]psnr`, '-f', 'null', '-']);
  const m = String(r.stderr).match(/average:([\d.]+|inf)/);
  return m ? (m[1] === 'inf' ? 99 : +m[1]) : 0;
}
// the pixels of a PNG (rgb24), with its size
function pixels(png) {
  const [w, h] = size(png);
  const buf = execFileSync(FF, ['-v', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 << 20 });
  return { w, h, at: (x, y) => { const i = (Math.round(y) * w + Math.round(x)) * 3; return [buf[i], buf[i + 1], buf[i + 2]]; } };
}
// how many sharp steps between neighbouring pixels a region has (colour bars, the moving line): blur leaves none
function busy(px, b) {
  let n = 0;
  for (let y = Math.ceil(b.y * px.h) + 2; y < (b.y + b.h) * px.h - 3; y++) for (let x = Math.ceil(b.x * px.w) + 2; x < (b.x + b.w) * px.w - 3; x++) {
    const p = px.at(x, y), q = px.at(x + 1, y), r = px.at(x, y + 1);
    if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 90 || Math.abs(p[0] - r[0]) + Math.abs(p[1] - r[1]) + Math.abs(p[2] - r[2]) > 90) n++;
  }
  return n;
}

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const lib = gopLibrary();
  const src = path.join(lib[0], 'Deadlock', 'Deadlock 2026.10.20 - 20.10.10.01.DVR.mp4');
  const srcFrame = t => { const f = path.join(TMP, `src-${t}.png`); execFileSync(FF, ['-v', 'error', '-y', '-ss', String(t), '-i', src, '-frames:v', '1', f]); return f; };
  const { app, w, errs } = await launch({ name: 'compositor', library: lib, gpu: true });
  const shot = async name => {
    await w.waitForTimeout(400);
    const f = path.join(TMP, name + '.png');
    const r = await w.$eval('#qtview', e => { const b = e.getBoundingClientRect(); return { x: b.left + 1, y: b.top + 1, width: b.width - 2, height: b.height - 2 }; });
    await w.screenshot({ path: f, clip: r });
    return f;
  };
  const inner = 1; // the screenshot leaves out the view's 1 px edge (its outline and rounded corners)
  try {
    await w.evaluate(async () => { await T.settingsSet({ editSave: 'auto' }); L.editSave = 'auto'; });
    await w.click('#libgrid .clip >> nth=0');
    await w.waitForSelector('#qt.on');
    await w.waitForFunction(() => document.getElementById('qtstage').dataset.renderer, null, { timeout: 15000 });
    await w.waitForTimeout(1200);
    check(await w.$eval('#qtstage', e => e.dataset.renderer) === 'webgpu', 'the player runs on WebGPU', await w.$eval('#qtstage', e => e.dataset.renderer));
    await w.keyboard.press('e'); await w.waitForTimeout(600);
    await w.evaluate(() => window.qtApi.seekTo(4)); await w.waitForTimeout(600);

    // the canvas is the view, at the screen's pixels
    const geo = await w.evaluate(() => { const c = document.getElementById('qtcanvas'), v = document.getElementById('qtview').getBoundingClientRect(), r = c.getBoundingClientRect();
      return { cw: c.width, ch: c.height, vw: v.width, vh: v.height, l: r.left - v.left, t: r.top - v.top, rw: r.width, rh: r.height, dpr: devicePixelRatio }; });
    check(Math.abs(geo.rw - geo.vw) < 1 && Math.abs(geo.rh - geo.vh) < 1 && geo.l === 0 && geo.t === 0, 'the canvas covers the view exactly', geo);
    check(Math.abs(geo.cw - geo.vw * geo.dpr) <= 1 && Math.abs(geo.ch - geo.vh * geo.dpr) <= 1, 'the canvas has the view\'s own pixels (not the clip\'s 640x360)', geo);
    const crop0 = { x: inner / geo.vw, y: inner / geo.vh, w: 1 - 2 * inner / geo.vw, h: 1 - 2 * inner / geo.vh };
    const p0 = psnrOf(await shot('plain'), srcFrame(4), crop0);
    check(p0 > 21, 'the plain picture matches the clip', p0);

    // a zoom on the bottom-right quarter: the view shows that quarter, sampled from the clip itself
    await w.evaluate(() => window.qtFx.setState({ layers: [{ id: 'z1', type: 'zoom', track: 0, start: 0, end: 12, box: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, ein: 0, eout: 0 }], sounds: [], vpts: {}, fades: {}, vtracks: [{}], atracks: [] }));
    await w.evaluate(() => { window.qtFx.select(null); window.qtApi.seekTo(4); }); await w.waitForTimeout(600);
    const q = { x: 0.5 + 0.5 * crop0.x, y: 0.5 + 0.5 * crop0.y, w: 0.5 * crop0.w, h: 0.5 * crop0.h };
    const pz = psnrOf(await shot('zoom'), srcFrame(4), q), pzWrong = psnrOf(path.join(TMP, 'zoom.png'), srcFrame(4), { x: 0, y: 0, w: q.w, h: q.h });
    check(pz > 21 && pz > pzWrong + 8, 'the zoom shows the right quarter (redrawn while paused)', [pz, pzWrong]);
    check(await w.$$eval('#qtlevels > *', e => e.length) === 0, 'nothing is drawn in the page itself');

    // a crop to 1:1: the view takes its shape and shows that part
    await w.evaluate(() => window.qtFx.setState({ crop: { x: 0.21875, y: 0, w: 0.5625, h: 1 }, layers: [], sounds: [], vpts: {}, fades: {}, vtracks: [{}], atracks: [] }));
    await w.evaluate(() => { window.qtFx.select(null); window.qtApi.seekTo(4); }); await w.waitForTimeout(600);
    const vr = await w.$eval('#qtview', e => { const b = e.getBoundingClientRect(); return b.width / b.height; });
    check(Math.abs(vr - 1) < 0.02, 'the view is square for a 1:1 crop', vr);
    const vb = await w.$eval('#qtview', e => { const b = e.getBoundingClientRect(); return { w: b.width, h: b.height }; });
    const pc = psnrOf(await shot('crop'), srcFrame(4), { x: 0.21875 + 0.5625 * inner / vb.w, y: inner / vb.h, w: 0.5625 * (1 - 2 * inner / vb.w), h: 1 - 2 * inner / vb.h });
    check(pc > 21, 'the crop shows the right part', pc);

    // a blur box (track 1) under a magenta box (track 2): the box is drawn, the blur softens what's under it
    const blurBox = { x: 0.05, y: 0.1, w: 0.4, h: 0.4 };
    await w.evaluate(() => window.qtFx.setState({ layers: [], sounds: [], vpts: {}, fades: {}, vtracks: [{}], atracks: [] }));
    await w.evaluate(() => { window.qtFx.select(null); window.qtApi.seekTo(4); }); await w.waitForTimeout(600);
    const before = pixels(await shot('noblur'));
    await w.evaluate(b => window.qtFx.setState({
      layers: [
        { id: 'b1', type: 'blur', track: 0, start: 0, end: 12, box: b, strength: 6 },
        { id: 's1', type: 'shape', track: 1, start: 0, end: 12, shape: 'rect', fill: true, color: '#ff00ff', stroke: 0.008, box: { x: 0.6, y: 0.4, w: 0.2, h: 0.2 } },
      ], sounds: [], vpts: {}, fades: {}, vtracks: [{}, {}], atracks: [],
    }), blurBox);
    await w.evaluate(() => { window.qtFx.select(null); window.qtApi.seekTo(4); }); await w.waitForTimeout(600);
    const after = pixels(await shot('blur'));
    const mid = after.at(after.w * 0.7, after.h * 0.5);
    check(mid[0] > 200 && mid[1] < 60 && mid[2] > 200, 'the magenta box is drawn by the compositor', mid);
    const b0 = busy(before, blurBox), b1 = busy(after, blurBox), outside = busy(after, { x: 0.55, y: 0.7, w: 0.4, h: 0.25 }), outside0 = busy(before, { x: 0.55, y: 0.7, w: 0.4, h: 0.25 });
    check(b0 > 100 && b1 < b0 * 0.1, 'the blur box softens the picture under it (no sharp edges left)', [b0, b1]);
    check(outside0 > 50 && Math.abs(outside - outside0) <= outside0 * 0.1, 'outside the blur box nothing changes', [outside0, outside]);
    check(await w.$$eval('#qtlevels > *', e => e.length) === 0, 'no blur boxes or level canvases in the page');

    // playing keeps drawing, with the overlays on every frame
    await w.keyboard.press('Space'); await w.waitForTimeout(1500); await w.keyboard.press('Space'); await w.waitForTimeout(500);
    const playShot = pixels(await shot('played'));
    const mid2 = playShot.at(playShot.w * 0.7, playShot.h * 0.5);
    check(mid2[0] > 200 && mid2[1] < 60 && mid2[2] > 200, 'after playing, the box is still there', mid2);

    // drawing: the stroke in progress is on the ink canvas, the GPU gets it when the mouse is let go;
    // two strokes right after each other are two undo steps
    await w.evaluate(() => window.qtFx.setState({ layers: [], sounds: [], vpts: {}, fades: {}, vtracks: [{}], atracks: [] }));
    await w.evaluate(() => { window.qtFx.select(null); window.qtApi.seekTo(4); }); await w.waitForTimeout(400);
    const vb2 = await w.$eval('#qtview', e => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; });
    const strokes = async () => ((await w.evaluate(() => window.qtFx.state())) || { layers: [] }).layers.filter(l => l.type === 'draw').reduce((n, l) => n + l.strokes.length, 0);
    await w.evaluate(() => window.qtFx.useAsset('fx:draw')); await w.waitForTimeout(300);
    await w.mouse.move(vb2.x + vb2.w * 0.2, vb2.y + vb2.h * 0.3); await w.mouse.down();
    await w.mouse.move(vb2.x + vb2.w * 0.7, vb2.y + vb2.h * 0.3, { steps: 8 });
    const mid3 = await w.evaluate(() => { const c = document.querySelector('.fx-ink'); return c && !c.hidden && c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v); });
    check(mid3, 'while drawing, the stroke shows on the ink canvas');
    await w.mouse.up();
    await w.mouse.move(vb2.x + vb2.w * 0.2, vb2.y + vb2.h * 0.6); await w.mouse.down();
    await w.mouse.move(vb2.x + vb2.w * 0.7, vb2.y + vb2.h * 0.6, { steps: 8 }); await w.mouse.up();
    await w.waitForTimeout(600);
    check(await w.$eval('.fx-ink', e => e.hidden), 'once let go, the ink canvas is cleared (the GPU draws it)');
    check(await strokes() === 2, 'two strokes', await strokes());
    await w.keyboard.press('Control+z');
    await w.waitForFunction(() => (window.qtFx.state() || { layers: [] }).layers.filter(l => l.type === 'draw').reduce((n, l) => n + l.strokes.length, 0) < 2, null, { timeout: 5000 }).catch(() => {});
    await w.waitForTimeout(300);
    check(await strokes() === 1, 'two quick strokes are two undo steps', await strokes());
    check(!errs.length, 'no page errors', errs);
  } finally { await app.close(); }
  done();
})().catch(e => { console.log('FAIL compositor\n  - ' + (e.stack || e)); process.exitCode = 1; });

// One-off check of the test build on Cristian's PC (real GPU, real clips), run while he's away.
// Uses a COPY of his profile in %TEMP%\bs-check-profile and exports to %TEMP%\bs-check-exports:
// his installed app, his real settings/edits and his clip folders are only read, never written.
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const TEMP = process.env.TEMP;
const { _electron } = require(path.join(TEMP, 'bs-pw', 'node_modules', 'playwright-core'));
const ROOT = path.resolve(__dirname, '..');
const UD = path.join(TEMP, 'bs-check-profile'), EX = path.join(TEMP, 'bs-check-exports'), OUT = path.join(TEMP, 'bs-check.txt');
const FF = require(path.join(ROOT, 'node_modules', 'ffmpeg-static'));
fs.writeFileSync(OUT, '');
const log = (...a) => fs.appendFileSync(OUT, a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
const shot = (w, name) => w.screenshot({ path: path.join(TEMP, `bs-check-${name}.png`) }).catch(e => log('shot failed', name, String(e).slice(0, 120)));

function level(f, t) {
  const r = spawnSync(FF, ['-hide_banner', '-ss', String(t), '-t', '0.8', '-i', f, '-af', 'volumedetect', '-f', 'null', '-']).stderr.toString();
  const m = /mean_volume: (-?[\d.]+|-inf) dB/.exec(r); return m ? (m[1] === '-inf' ? -200 : +m[1]) : null;
}
function psnr(out, src, tOut, tSrc, crop, W, H) {
  const r = spawnSync(FF, ['-hide_banner', '-ss', String(tOut), '-i', out, '-ss', String(tSrc), '-i', src, '-filter_complex',
    `[1:v]crop=${crop},scale=${W}:${H},format=yuv420p[b];[0:v]scale=${W}:${H},format=yuv420p[a];[a][b]psnr`, '-frames:v', '1', '-f', 'null', '-']).stderr.toString();
  const m = /average:([\d.]+|inf)/.exec(r); return m ? (m[1] === 'inf' ? 99 : +m[1]) : 0;
}

(async () => {
  fs.rmSync(UD, { recursive: true, force: true });
  fs.cpSync(path.join(process.env.APPDATA, 'Backstage'), UD, { recursive: true, filter: s => !/\\(Cache|Code Cache|GPUCache|DawnCache|DawnGraphiteCache|DawnWebGPUCache|logs|Crashpad)(\\|$)/i.test(s) });
  fs.rmSync(EX, { recursive: true, force: true }); fs.mkdirSync(EX, { recursive: true });
  const app = await _electron.launch({ executablePath: require(path.join(ROOT, 'node_modules', 'electron')), args: [ROOT, '--user-data-dir=' + UD], env: { ...process.env, BACKSTAGE_EXPORTS: EX } });
  const w = await app.firstWindow();
  const errs = [];
  w.on('pageerror', e => errs.push(String(e.stack || e).slice(0, 300)));
  w.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 300)); });
  const t0 = Date.now();
  try {
    await w.waitForFunction(() => typeof L !== 'undefined' && L.data && document.querySelectorAll('#libgrid .clip').length > 0, null, { timeout: 120000 });
    log('library ready ms', Date.now() - t0);
    await w.evaluate(async () => { await T.settingsSet({ editSave: 'auto' }); L.editSave = 'auto'; });
    const lib = await w.evaluate(() => { const k = {}; for (const c of L.data.clips) k[c.source] = (k[c.source] || 0) + 1; return { clips: L.data.clips.length, shown: L.list.length, kinds: k, viewport: [innerWidth, innerHeight] }; });
    log('library', lib);
    await w.waitForTimeout(4000);
    await shot(w, 'home');

    // ---- home grid: scroll speed on the real GPU, real pictures ----
    for (const step of process.env.ONLY ? [] : [300, 120]) {
      const r = await w.evaluate(async step => {
        const sc = document.getElementById('libscroll'); sc.scrollTop = 0; await new Promise(r => setTimeout(r, 300));
        const lt = []; const po = new PerformanceObserver(l => { for (const e of l.getEntries()) lt.push(Math.round(e.duration)); }); po.observe({ entryTypes: ['longtask'] });
        const t0 = performance.now(); let frames = 0, worstFrame = 0, last = t0;
        while (sc.scrollTop + sc.clientHeight < sc.scrollHeight - 5 && frames < 600) { sc.scrollTop += step; frames++; await new Promise(r => requestAnimationFrame(r)); const n = performance.now(); worstFrame = Math.max(worstFrame, n - last); last = n; }
        const ms = performance.now() - t0; await new Promise(r => setTimeout(r, 300)); po.disconnect();
        return { step, frames, fps: Math.round(frames / ms * 1000), worstFrameMs: Math.round(worstFrame), longtasks: lt.length, longtaskMs: lt.reduce((a, b) => a + b, 0), cardsOnPage: document.querySelectorAll('#libgrid .clip').length };
      }, step);
      log('scroll', r);
    }
    // click right after a fast scroll
    await w.evaluate(() => { const s = document.getElementById('libscroll'); s.scrollTop = Math.floor(s.scrollHeight / 2); });
    await w.waitForTimeout(40);
    const b = await w.evaluate(() => { const el = [...document.querySelectorAll('#libgrid .clip')].find(x => { const r = x.getBoundingClientRect(); return r.top > 150 && r.bottom < innerHeight; }); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    if (b) { await w.mouse.click(b.x, b.y); log('click right after scrolling opens', await w.waitForSelector('#qt.on', { timeout: 6000 }).then(() => true, () => false)); }
    await w.click('.game.home').catch(() => {}); await w.waitForTimeout(800);

    // ---- one clip of each kind: open, Edit, cut, zoom steps, exports ----
    const picks = await w.evaluate(only => {
      const by = k => L.data.clips.filter(c => c.source === k && c.size > (k === 'discord' ? 20e6 : 3e6) && c.size < 400e6).sort((a, b) => b.date - a.date)[0] || L.data.clips.find(c => c.source === k);
      return (only ? [only] : ['nvidia', 'discord', 'encore']).map(k => { const c = by(k); return c ? { kind: k, path: c.path, name: c.name, dur: c.duration } : null; }).filter(Boolean);
    }, process.env.ONLY || null);
    log('clips picked', picks.map(p => [p.kind, p.name, p.dur]));
    for (const p of picks) {
      const tag = p.kind;
      const dims = spawnSync(FF, ['-hide_banner', '-i', p.path]).stderr.toString().match(/Video:.*?(\d{3,5})x(\d{3,5})/);
      const W = dims ? +dims[1] : 1920, H = dims ? +dims[2] : 1080;
      const dm = spawnSync(FF, ['-hide_banner', '-i', p.path]).stderr.toString().match(/Duration: (\d+):(\d+):([\d.]+)/);
      if (dm) p.dur = +dm[1] * 3600 + +dm[2] * 60 + +dm[3];
      log(tag, 'size', [W, H], 'length', p.dur);
      try {
        await w.evaluate(path => { const c = L.data.clips.find(x => x.path === path); openClip(c); }, p.path);
        await w.waitForSelector('#qt.on', { timeout: 10000 });
        await w.waitForFunction(() => document.getElementById('qtstage').dataset.renderer, null, { timeout: 20000 }).catch(() => {});
        await w.waitForTimeout(1500);
        const info = await w.evaluate(() => ({ renderer: document.getElementById('qtstage').dataset.renderer, rows: [...document.querySelectorAll('#qtaudio .qt-arow .qt-anametext')].map(e => e.textContent) }));
        log(tag, 'opened', info);
        await w.keyboard.press('e'); await w.waitForTimeout(800);
        const keys = await w.$$eval('#qttracks .trow.c', e => e.map(r => r.dataset.key));
        const dur = await w.evaluate(() => window.qtFx.view().t1);
        // a real razor click on A1 at the middle of the view
        await w.keyboard.press('r');
        const lane = await w.$eval('#qttracks .trow.c .trk-l', e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }).catch(() => null);
        if (lane) { await w.mouse.click(lane.x, lane.y); await w.waitForTimeout(400); }
        await w.keyboard.press('v');
        const cuts = await w.evaluate(() => (window.qtFx.state() || {}).cuts || {});
        log(tag, 'razor on A1', { rows: keys.length, cutRows: Object.keys(cuts).length, pieces: Object.values(cuts).map(c => c.pieces.length) });
        // play a moment with the cut (the engine plays pieces) and watch for errors
        await w.keyboard.press('Space'); await w.waitForTimeout(1500); await w.keyboard.press('Space');
        // export: A1 silent from 2 to 4 s of a 6 s stretch, other rows untouched
        const s0 = Math.max(0, Math.min(5, (p.dur || 10) - 7));
        if (keys.length) {
          await w.evaluate(([k, s0, D]) => window.qtFx.setState({ cuts: { [k]: { free: false, pieces: [{ id: 'a', from: 0, to: s0 + 2, at: 0 }, { id: 'b', from: s0 + 4, to: D, at: s0 + 4 }] } } }), [keys[0], s0, p.dur || dur]);
          await w.waitForTimeout(400);
          const solo = keys.slice(1); // mute the other rows for the check, so only A1 is heard
          const r = await w.evaluate(([s0, solo]) => { const audio = {}; for (const k of solo) audio[k] = { mute: true, vol: 1 }; return T.qtExport({ path: window.qtActivePath(), start: s0, end: s0 + 6, as: 'audio', dest: 'temp', audio, fx: window.qtFx.state() }); }, [s0, solo]);
          if (r.ok) log(tag, 'audio export with a cut', { size: r.size, before: level(r.out, 0.6), inGap: level(r.out, 2.6), after: level(r.out, 4.6), lengthOk: !!r.size });
          else log(tag, 'audio export FAILED', r.error);
        }
        // zoom steps on the real picture: step 1 = middle half, step 2 = middle quarter
        await w.evaluate(([s0]) => { window.qtFx.setState({ layers: [{ id: 'z', type: 'zoom', track: 0, start: s0 + 0.5, end: s0 + 5.5, ein: 0, eout: 0, box: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, steps: [{ t: s0 + 3, ease: 0, box: { x: 0.375, y: 0.375, w: 0.25, h: 0.25 } }] }] }); }, [s0]);
        await w.waitForTimeout(600);
        await w.evaluate(() => window.qtFx.select('z')); await w.waitForTimeout(300);
        await shot(w, tag + '-zoom');
        const rv = await w.evaluate(([s0]) => T.qtExport({ path: window.qtActivePath(), start: s0, end: s0 + 6, as: 'video', dest: 'temp', audio: {}, fx: window.qtFx.state() }), [s0]);
        if (rv.ok) {
          const c1 = `${W / 2}:${H / 2}:${W / 4}:${H / 4}`, c2 = `${W / 4}:${H / 4}:${W * 3 / 8}:${H * 3 / 8}`;
          log(tag, 'zoom steps export', { size: rv.size, step1: psnr(rv.out, p.path, 1.5, s0 + 1.5, c1, 640, Math.round(640 * H / W)), step2: psnr(rv.out, p.path, 4, s0 + 4, c2, 640, Math.round(640 * H / W)), step2vsWrongBox: psnr(rv.out, p.path, 4, s0 + 4, c1, 640, Math.round(640 * H / W)) });
        } else log(tag, 'video export FAILED', rv.error);
        // crop: 9:16 chip, a side drag with the lock, then the brush circle
        await w.evaluate(() => window.qtFx.setState(null)); await w.waitForTimeout(300);
        await w.evaluate(() => window.qtFx.useAsset('fx:crop')); await w.waitForTimeout(300);
        await w.click('#qtfxprops .fx-chips .chip >> text=9:16'); await w.waitForTimeout(300);
        const e = await w.$eval('.fx-cropbox .fx-edge.e', e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
        await w.mouse.move(e.x, e.y); await w.mouse.down(); await w.mouse.move(e.x - 50, e.y, { steps: 5 }); await w.mouse.up(); await w.waitForTimeout(300);
        await shot(w, tag + '-crop');
        const crop = await w.evaluate(() => window.qtFx.state().crop);
        const ratio = crop ? (crop.w * W) / (crop.h * H) : null;
        log(tag, 'crop 9:16 after a locked side drag', { ratio: ratio && Math.round(ratio * 1000) / 1000, want: 0.5625 });
        await w.click('#qtfxprops .btn >> text=Done').catch(() => {});
        await w.evaluate(() => window.qtFx.setState(null)); await w.waitForTimeout(200);
        await w.keyboard.press('d'); await w.waitForTimeout(300);
        const ed = await w.$eval('.qt-edit', e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: r.height }; });
        await w.mouse.move(ed.x, ed.y); await w.mouse.move(ed.x + 8, ed.y + 6); await w.waitForTimeout(150);
        log(tag, 'brush', await w.$eval('.fx-brush', (e, h) => ({ shown: !e.hidden, size: Math.round(e.getBoundingClientRect().width), want: Math.round(0.008 * h) }), ed.h));
        await shot(w, tag + '-brush');
        await w.keyboard.press('Escape'); await w.keyboard.press('Escape');
        await w.evaluate(() => window.qtFx.setState(null));
        await w.click('.game.home').catch(() => {}); await w.waitForTimeout(800);
      } catch (err) { log(tag, 'CRASH', String(err.stack || err).slice(0, 400)); await w.click('.game.home').catch(() => {}); }
    }
  } catch (err) { log('CRASH', String(err.stack || err).slice(0, 400)); }
  log('page errors', errs);
  try { log('app log tail', fs.readFileSync(path.join(UD, 'logs', 'app.log'), 'utf8').split('\n').filter(Boolean).slice(-12)); } catch (e) { log('no app log'); }
  await w.evaluate(() => { window.qtDirty = () => false; }).catch(() => {});
  await app.close().catch(() => {});
  log('DONE');
})();

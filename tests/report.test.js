// Reports, through a local stand-in for the report server (report-worker/):
// "Help add recording software" (the card beside a newly added folder, the preview of exactly what is
// sent with the username replaced, closing the card for good, the Settings section), and
// Help > Report a Problem with the log attached, and replies showing in Help > My Reports.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { launch, checker, OUT, FIX } = require('./helpers');

(async () => {
  const { check, done } = checker('report');
  // a fake "SteelSeries Moments" folder with a subfolder per game, and a plain one
  const root = path.join(OUT, 'replib');
  fs.rmSync(root, { recursive: true, force: true });
  const ss = path.join(root, 'SteelSeries Moments'), other = path.join(root, 'Captures2');
  const clip = (() => { for (const g of fs.readdirSync(path.join(FIX, 'nv'))) { const d = path.join(FIX, 'nv', g); if (!fs.statSync(d).isDirectory()) continue; const f = fs.readdirSync(d).find(x => /\.mp4$/i.test(x)); if (f) return path.join(d, f); } })();
  for (const [d, n] of [[path.join(ss, 'Valorant'), 'Valorant_2026-10-30_21-14-02.mp4'], [path.join(ss, 'Deadlock'), 'Deadlock_2026-10-29_20-01-10.mp4'], [other, 'clip.mp4']]) {
    fs.mkdirSync(d, { recursive: true }); fs.copyFileSync(clip, path.join(d, n));
  }
  // stand-in for the report server: files reports, gives replies to the right key only
  const got = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', c => (b += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url === '/report') { got.push(JSON.parse(b)); res.end(JSON.stringify({ number: got.length, key: 'key' + got.length })); return; }
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/replies' && u.searchParams.get('key') === 'key' + u.searchParams.get('n')) {
        res.end(JSON.stringify({ state: u.searchParams.get('n') === '2' ? 'closed' : 'open', replies: u.searchParams.get('n') === '2' ? [{ body: 'Fixed in the **next** version.', at: new Date().toISOString() }] : [] }));
        return;
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  process.env.BACKSTAGE_REPORT_URL = `http://127.0.0.1:${srv.address().port}`;
  process.env.HOME = path.resolve(OUT, '..', '..', '..'); // so the folder sits under "your user folder"

  const run = await launch({ name: 'report', library: [path.join(FIX, 'nv'), ss, other] });
  try {
    const { w } = run;
    // a folder was just added -> the card shows beside its row
    await w.evaluate(d => folderAdded({ ok: true, changed: true, added: d }), ss);
    await w.waitForSelector('.rcard.on', { timeout: 5000 });
    const card = await w.evaluate(() => { const c = document.querySelector('.rcard'), r = c.getBoundingClientRect(), s = document.querySelector('#libside').getBoundingClientRect(); return { left: r.left, side: s.right, text: c.textContent }; });
    check(card.left > card.side && /Help add this recording software/.test(card.text) && /See what's sent/.test(card.text), 'card beside the sidebar', card);
    check(await w.$eval('#folderbox', e => e.classList.contains('open')), 'Folders panel opens to show the folder');

    // the preview
    await w.click('.rcard >> text=See what\'s sent');
    await w.waitForSelector('.modal.report .report-pre', { timeout: 10000 });
    const pv = await w.evaluate(() => ({ name: document.querySelector('.modal.report .modal-in').value, pre: document.querySelector('.report-pre').textContent, all: document.querySelector('.modal.report').textContent }));
    check(pv.name === 'SteelSeries Moments', 'recording software guessed from the folder', pv.name);
    check(/Layout: a subfolder per game \(2 subfolders\)/.test(pv.pre) && /Valorant_2026-10-30_21-14-02\.mp4/.test(pv.pre), 'layout and example files', pv.pre);
    check(/%USERPROFILE%/.test(pv.pre) && !pv.pre.includes(process.env.HOME), 'user folder replaced', pv.pre.split('\n')[1]);
    check(/Audio tracks: (\d+|none)/.test(pv.pre) && /App version/.test(pv.all) && /%USERNAME%/.test(pv.all), 'audio tracks, version and the privacy note shown');
    await w.click('.modal.report .mbtn.primary'); await w.waitForTimeout(1200);
    check(got.length === 1, 'sent once', got.length);
    const sent = got[0] || {};
    check(sent.kind === 'recorder' && sent.recorder === 'SteelSeries Moments' && /^\d+\.\d+\.\d+$/.test(sent.version || '') && sent.text === pv.pre, 'sent exactly what was shown', Object.keys(sent));
    check(!JSON.stringify(got[0] || '').includes(process.env.HOME), 'no user folder in what was sent');
    check(!(await w.$('.modal.report')), 'preview closes after sending');
    check(await w.evaluate(async d => (await T.reportCard(d)).show, ss) === false, 'no card again for a folder already sent');

    // closing the card is for good
    await w.evaluate(d => reportCard(d), other);
    await w.waitForSelector('.rcard.on', { timeout: 5000 });
    await w.click('.rcard .rc-x'); await w.waitForTimeout(400);
    check(!(await w.$('.rcard.on')), 'card closes');
    check(await w.evaluate(async d => (await T.reportCard(d)).show, other) === false, 'closed card stays closed');

    // Settings section
    await w.keyboard.press('Control+Comma'); await w.waitForTimeout(800);
    const rows = await w.$$eval('.setsec', ss2 => { const s = ss2.find(x => x.querySelector('h3').textContent === 'Help add recording software'); return s ? [...s.querySelectorAll('.setrow')].map(r => r.innerText.replace(/\s+/g, ' ')) : null; });
    check(rows && rows.length === 3 && rows.some(r => /SteelSeries Moments .*Sent · send again/.test(r)) && rows.some(r => /Send info/.test(r)), 'Settings lists the folders and what was sent', rows);
    await w.keyboard.press('Escape'); await w.waitForTimeout(400);

    // Help > Report a Problem: what happened, the log and PC details (seen first), then sent
    await w.evaluate(() => problemBox());
    await w.waitForSelector('.modal.report .report-ta', { timeout: 5000 });
    await w.waitForFunction(() => !/Loading/.test(document.querySelector('.report-pre').textContent), null, { timeout: 15000 });
    const pre2 = await w.$eval('.report-pre', e => e.textContent);
    check(/App: Backstage/.test(pre2) && /Log \(the last few minutes\)/.test(pre2) && /started Backstage/.test(pre2) && !pre2.includes(process.env.HOME), 'what is sent: version, PC details and the log, without the user folder', pre2.slice(0, 300));
    await w.fill('.modal.report .report-ta >> nth=0', 'The export button did nothing');
    await w.fill('.modal.report .report-ta >> nth=1', 'Exporting a Discord clip');
    await w.click('.modal.report .mbtn.primary'); await w.waitForTimeout(1500);
    const p2 = got[1] || {};
    check(p2.kind === 'problem' && p2.what === 'The export button did nothing' && p2.doing === 'Exporting a Discord clip' && p2.details && /started Backstage/.test(p2.details.log || ''), 'problem report sent with the log', Object.keys(p2));
    check(!(await w.$('.modal.report')), 'report box closes after sending');
    // replies show in My Reports (and only the report they belong to)
    await w.evaluate(() => reportsBox());
    await w.waitForSelector('.modal.reports .rep', { timeout: 8000 });
    const reps = await w.$$eval('.modal.reports .rep', es => es.map(e => e.innerText.replace(/\s+/g, ' ')));
    check(reps.length === 2 && /Fixed in the next version/.test(reps[0]) && /Closed/.test(reps[0]) && /No reply yet/.test(reps[1]), 'My Reports shows the reply under the right report', reps);
    check(!run.errs.length, 'no page errors', run.errs);
  } catch (err) { check(false, 'test crashed: ' + err.message); } finally { await run.app.close(); srv.close(); done(); }
})();

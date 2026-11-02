// The editor's clip list: library cards sized for the column (no seek bar), virtual scrolling (only
// the cards near view exist, the rest is space), the games in the sidebar filter it while editing,
// and the back-to-top arrow.
const { launch, checker, bigLibrary } = require('./helpers');

(async () => {
  const { check, done } = checker('cliplist');
  const { app, w, errs } = await launch({ name: 'cliplist', library: bigLibrary(64) });
  const count = () => w.$$eval('#qtcliplist .clip', e => e.length);
  try {
    await w.waitForTimeout(1200);
    await w.click('#libgrid .clip >> nth=0'); await w.waitForSelector('#qt.on'); await w.waitForTimeout(1500);
    const n0 = await count();
    check(n0 > 0 && n0 < 30, 'only the cards near view exist', n0);
    check(await w.$eval('#qtcliplist .clip.on', e => getComputedStyle(e.querySelector('.hbar')).display === 'none' && !!e.querySelector('.cact .cbtn') && !!e.querySelector('.cfile').textContent), 'cards keep ⋯ and the file name, no seek bar');
    const space = await w.$eval('#qtcliplist .qc-space', e => e.offsetHeight);
    const rowH = await w.$eval('#qtcliplist .clip', e => e.offsetHeight);
    check(space > rowH * 60, 'the list is as long as 64 cards', [space, rowH]);
    // scroll to the bottom: the last clip is there, still only a handful of cards
    await w.evaluate(() => { const b = document.getElementById('qtcliplist'); b.scrollTop = b.scrollHeight; }); await w.waitForTimeout(400);
    const lastPath = await w.evaluate(() => L.list[L.list.length - 1].path);
    check(await w.$$eval('#qtcliplist .clip', (e, p) => e.some(x => x._clip.path === p), lastPath), 'scrolled to the end shows the last clip');
    check(await count() < 30, 'still only the cards near view', await count());
    check(await w.$eval('.qt-listwrap .totop', e => e.classList.contains('show')), 'back-to-top arrow shows once scrolled');
    await w.click('.qt-listwrap .totop'); await w.waitForFunction(() => document.getElementById('qtcliplist').scrollTop < 5, null, { timeout: 4000 }).catch(() => {});
    check(await w.$eval('#qtcliplist', e => e.scrollTop) < 5, 'back to top');
    // a card far down opens in the editor
    await w.evaluate(() => { const b = document.getElementById('qtcliplist'); b.scrollTop = b.scrollHeight / 2; }); await w.waitForTimeout(400);
    const mid = await w.$eval('#qtcliplist .clip:not(.on)', e => e._clip.path);
    await w.evaluate(p => [...document.querySelectorAll('#qtcliplist .clip')].find(x => x._clip.path === p).click(), mid); await w.waitForTimeout(1200);
    check(await w.evaluate(() => window.qtActivePath()) === mid, 'clicking a card in the list opens it');
    // the sidebar's games filter the list while editing
    await w.click('.game:has-text("Peak")'); await w.waitForTimeout(600);
    check(!(await w.$eval('#qt', e => e.hidden)), 'picking a game stays in the editor');
    check(await w.$$eval('#qtcliplist .clip', e => e.every(x => x._clip.gameName === 'Peak')) && await w.$eval('#qtclipstitle', e => e.textContent) === 'Peak', 'the list shows that game');
    check(await w.$eval('#qtcliplist .qc-space', e => e.offsetHeight) < space / 3, 'the list is that game\'s length');
    await w.click('.game:has-text("Peak")'); await w.waitForTimeout(600);
    check(await w.evaluate(() => L.game) === 'all' && await w.$$eval('#qtcliplist .clip', e => new Set(e.map(x => x._clip.gameName)).size > 1), 'picking it again goes back to all clips');
    await w.click('.game.home'); await w.waitForTimeout(500);
    check(await w.$eval('#qt', e => e.hidden), 'Home goes back to the library');
  } catch (err) { check(false, 'test crashed: ' + (err.stack || err.message).slice(0, 500)); } finally {
    await app.close();
  }
  check(!errs.length, 'no page errors', errs);
  done();
})();

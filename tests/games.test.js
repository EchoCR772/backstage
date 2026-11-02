// Finding a game: the sidebar's search and sort (Recent / Alphabetical, remembered), and in Edit the
// sidebar holding Edit's tabs (Clips, Text, Shapes, Audio, Effects) with the Clips tab's game picker.
const { launch, checker, bigLibrary } = require('./helpers');

(async () => {
  const { check, done } = checker('games');
  const { app, w, errs } = await launch({ name: 'games', library: bigLibrary(64) });
  const names = () => w.$$eval('#games .game .gname', e => e.map(x => x.textContent));
  const shown = sel => w.$eval(sel, e => e.offsetParent !== null).catch(() => false);
  try {
    await w.evaluate(async () => { await T.settingsSet({ editSave: 'auto' }); L.editSave = 'auto'; });
    // search
    check((await names()).length === 4, 'four games listed', await names());
    check(await shown('#gsearchin') && !(await shown('#gsearchbtn')), 'the open sidebar has a search box (no button)');
    await w.click('#gsearchin'); await w.waitForTimeout(150);
    check(await w.evaluate(() => document.activeElement.id) === 'gsearchin', 'clicking the box focuses it');
    await w.keyboard.type('pe'); await w.waitForTimeout(200);
    check((await names()).join() === 'Peak', 'typing narrows the games', await names());
    await w.fill('#gsearchin', 'd2'); await w.waitForTimeout(200);
    check((await names()).join() === 'Destiny 2', 'first letters of the words find a game', await names());
    await w.fill('#gsearchin', 'zzz'); await w.waitForTimeout(200);
    check((await names()).length === 0 && await shown('#games .gempty'), 'no match says so');
    check(await shown('#sidefixed .allclips') && await shown('#sidefixed .home'), 'Home and All clips stay while searching');
    await w.keyboard.press('Escape'); await w.waitForTimeout(200);
    check((await names()).length === 4 && await w.$eval('#gsearchin', e => e.value) === '' && await shown('#gsearchin'), 'Esc clears the search, the box stays');

    // sort
    const recent = await w.evaluate(() => {
      const m = new Map();
      for (const c of L.data.clips) m.set(c.gameName, Math.max(m.get(c.gameName) || 0, c.date));
      return [...m].sort((a, b) => b[1] - a[1]).map(x => x[0]);
    });
    check((await names()).join() === recent.join(), 'Recent: newest clip first', [await names(), recent]);
    await w.click('#gsortbtn'); await w.waitForTimeout(150);
    check(await w.$eval('#ctxmenu', e => e.offsetWidth) < 190, 'the sort menu is only as wide as its words', await w.$eval('#ctxmenu', e => e.offsetWidth));
    await w.click('#ctxmenu button:has-text("Alphabetical")'); await w.waitForTimeout(200);
    check((await names()).join() === 'Deadlock,Desktop,Destiny 2,Peak', 'Alphabetical', await names());
    check(await w.evaluate(() => JSON.parse(localStorage.getItem('library')).gameSort) === 'alpha', 'the sort is remembered');

    // the collapsed rail: same rows, search opens the sidebar
    const topOpen = await w.$eval('#games .game', e => Math.round(e.getBoundingClientRect().top));
    await w.click('#sidetoggle'); await w.waitForTimeout(300);
    const topRail = await w.$eval('#games .game', e => Math.round(e.getBoundingClientRect().top));
    check(topOpen === topRail, 'games sit at the same height open and collapsed', [topOpen, topRail]);
    check(await shown('#gsearchbtn') && !(await shown('#gsearchin')), 'the rail has the search button');
    await w.click('#gsearchbtn'); await w.waitForTimeout(300);
    check(!(await w.$eval('#libside', e => e.classList.contains('collapsed'))) && await w.evaluate(() => document.activeElement.id) === 'gsearchin', 'search in the collapsed rail opens the sidebar');
    await w.keyboard.press('Escape');
    await w.click('#sidetoggle'); await w.waitForTimeout(300);

    // Edit: the sidebar holds Edit's tabs
    const homeTop = await w.$eval('#sidefixed .home', e => Math.round(e.getBoundingClientRect().top));
    await w.click('#libgrid .clip >> nth=0'); await w.waitForSelector('#qt.on'); await w.waitForTimeout(1200);
    check(await shown('#games .game') && !(await shown('#edittabs .etab')), 'Trim keeps the games in the sidebar');
    await w.keyboard.press('e'); await w.waitForTimeout(700);
    check(!(await shown('#games .game')) && !(await shown('#gamesbar')) && !(await shown('#sidefixed .allclips')), 'Edit hides the games, search and All clips');
    check((await w.$$eval('#edittabs .etab', e => e.filter(x => x.offsetParent).map(x => x.dataset.tab))).join() === 'clips,text,shapes,audio,effects', 'Edit\'s tabs are in the sidebar');
    check(await shown('#sidefixed .home') && await w.$eval('#sidefixed .home', e => Math.round(e.getBoundingClientRect().top)) === homeTop && await shown('#folderbtn'), 'Home and Folders stay in place');
    check(await w.$eval('#edittabs .etab.on .elabel', e => e.offsetParent !== null), 'collapsed rail shows labels under the tabs');
    check(!(await w.$('#qtatabs')), 'no tabs row above the panel');
    const lay = await w.evaluate(() => ({ tl: document.getElementById('qtetl').getBoundingClientRect(), side: document.getElementById('libside').getBoundingClientRect() }));
    check(Math.round(lay.tl.left) === 0 && Math.abs(lay.side.bottom - lay.tl.top) <= 1, 'the timeline runs the full width and the sidebar stops above it', [lay.tl.left, lay.side.bottom, lay.tl.top]);
    check(await w.$eval('#edittabs', e => e.scrollHeight <= e.clientHeight), 'all five tabs fit above the timeline');

    // the Clips tab: picker + list
    await w.click('#edittabs [data-tab="clips"]'); await w.waitForTimeout(500);
    check(await shown('#qtgamepick') && await w.$$eval('#qtcliplist .clip', e => e.length) > 0, 'Clips shows the game picker and the clip list');
    check(await w.$eval('#qtgamepick .gname', e => e.textContent) === 'All clips', 'the picker shows All clips');
    await w.click('#qtgamepick'); await w.waitForSelector('#gpicker');
    check(await w.$$eval('#gpicker .gp-row', e => e.length) === 5, 'All clips and four games in the picker');
    check(await w.$$eval('#gpicker .gp-row .gname', e => e.map(x => x.textContent).slice(1).join()) === 'Deadlock,Desktop,Destiny 2,Peak', 'the picker uses the same sort');
    await w.keyboard.type('pea'); await w.waitForTimeout(150);
    check(await w.$$eval('#gpicker .gp-row', e => e.length) === 1, 'typing narrows the picker');
    await w.keyboard.press('Enter'); await w.waitForTimeout(600);
    check(!(await w.$('#gpicker')) && await w.evaluate(() => L.game) !== 'all' && await w.$$eval('#qtcliplist .clip', e => e.every(x => x._clip.gameName === 'Peak')), 'Enter picks the game and filters the list');
    check(await w.$eval('#qtgamepick .gname', e => e.textContent) === 'Peak', 'the picker shows the game');
    await w.click('#qtgamepick'); await w.waitForSelector('#gpicker');
    await w.keyboard.press('Escape'); await w.waitForTimeout(150);
    check(!(await w.$('#gpicker')) && await w.evaluate(() => window.qtIsOpen()), 'Esc closes the picker, not the editor');
    await w.click('#qtgamepick'); await w.waitForSelector('#gpicker');
    await w.click('#gpicker .gp-row:has-text("All clips")'); await w.waitForTimeout(400);
    check(await w.evaluate(() => L.game) === 'all', 'picking All clips');

    // clicking the open tab folds the panel away; another tab opens it
    const w0 = await w.$eval('.qt-main', e => e.offsetWidth);
    await w.click('#edittabs [data-tab="clips"]'); await w.waitForTimeout(400);
    check(!(await shown('#qtclips')) && await w.$eval('.qt-main', e => e.offsetWidth) > w0 && !(await w.$('#edittabs .etab.on')), 'clicking the open tab folds the panel');
    await w.click('#edittabs [data-tab="text"]'); await w.waitForTimeout(400);
    check(await shown('#qtclips') && await w.$eval('#qtassets .as-title', e => e.textContent) === 'Text' && await w.$eval('.qt-main', e => e.offsetWidth) === w0, 'another tab opens it again');
    check(await w.evaluate(() => JSON.parse(localStorage.getItem('fxTab'))) === 'text', 'the tab is remembered');

    // back to Trim: the games come back
    await w.click('#qttrim-btn'); await w.waitForTimeout(500);
    check(await shown('#games .game') && !(await shown('#edittabs .etab')), 'Trim brings the games back');
    await w.keyboard.press('e'); await w.waitForTimeout(500);
    await w.keyboard.press('Control+w'); await w.waitForTimeout(500);
    check(await w.$eval('#qt', e => e.hidden) && await shown('#games .game') && !(await w.evaluate(() => document.body.classList.contains('editlevel'))), 'closing from Edit brings the games back');
  } catch (err) { check(false, 'test crashed: ' + (err.stack || err.message).slice(0, 500)); } finally {
    await app.close();
  }
  check(!errs.length, 'no page errors', errs);
  done();
})();

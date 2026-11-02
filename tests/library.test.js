// Library and window: card controls, right-click menu, rename from the menu, folder filter, games
// sidebar, tabs (open, switch, Ctrl+Tab, back/forward, prev/next clip), settings overlay, and
// scrolling (no previews start mid-scroll, every card has its picture, refreshes don't rebuild cards).
const { launch, checker, bigLibrary } = require('./helpers');

(async () => {
  const { check, done } = checker('library');
  let run = await launch({ name: 'library' });
  try {
    const { w } = run;
    const b = await w.$eval('.clip >> nth=0', e => { const x = e.getBoundingClientRect(); return { x: x.x + x.width / 2, y: x.y + x.height / 2 }; });
    await w.mouse.move(b.x, b.y); await w.waitForTimeout(800);
    check(await w.$eval('.clip >> nth=0', e => [...e.querySelectorAll('.hbtn')].map(x => x.innerText.trim()).join('|')) === 'Trim|Copy Video', 'card buttons');
    const lens = await w.$$eval('#libgrid .clip', els => els.map(e => [e._clip.name, e.querySelector('.cdur').textContent]));
    check(lens.every(([n, l]) => /^\d+:\d\d$/.test(l)), 'every card shows its length', lens.filter(([n, l]) => !/^\d+:\d\d$/.test(l)));
    check(await w.$$eval('#libgrid .clip', els => els.every(e => e.querySelector('.cfile').textContent === e._clip.name && e._clip.name)), 'every card shows its file name');
    check(await w.$eval('#libname', e => e.textContent) === 'All clips', 'library tab name');

    // right-click menu and rename
    await w.mouse.click(b.x, b.y, { button: 'right' }); await w.waitForTimeout(300);
    const menu = await w.$$eval('#ctxmenu button', els => els.map(e => e.innerText));
    check(menu.join('|') === 'Copy Video|Edit|Rename|Show in Folder|Delete', 'right-click menu', menu);
    await w.click('#ctxmenu >> text=Rename'); await w.waitForTimeout(300);
    await w.fill('.modal-in', 'Best clip'); await w.keyboard.press('Enter'); await w.waitForTimeout(800);
    check(await w.$eval('.clip >> nth=0', e => e.querySelector('.ctitle').textContent) === 'Best clip', 'rename from the menu');

    // any menu: clicking its button again closes it; clicking outside only closes it
    await w.hover('.clip >> nth=0'); await w.waitForTimeout(300);
    await w.click('.clip >> nth=0 >> .cact .cbtn >> nth=0'); await w.waitForTimeout(250);
    check(await w.$eval('#ctxmenu', e => !e.hidden), 'card ... opens its menu');
    await w.click('.clip >> nth=0 >> .cact .cbtn >> nth=0'); await w.waitForTimeout(250);
    check(await w.$eval('#ctxmenu', e => e.hidden), 'clicking ... again closes the menu');
    await w.click('.clip >> nth=0 >> .cact .cbtn >> nth=0'); await w.waitForTimeout(250);
    await w.mouse.click(b.x, b.y); await w.waitForTimeout(600);
    check(await w.$eval('#ctxmenu', e => e.hidden) && await w.$eval('#qt', e => e.hidden), 'clicking the card with a menu open only closes the menu');
    await w.click('#appmenu'); await w.waitForTimeout(200);
    await w.click('#appmenu'); await w.waitForTimeout(250);
    check(await w.$eval('#ctxmenu', e => e.hidden), 'clicking ☰ again closes the app menu');

    // NEW: clips saved since the view was last left; opening one clears it
    await w.evaluate(() => { L.newSince = 1; L.viewKey = viewKey(); renderGrid(); });
    const news = await w.$$eval('#libgrid .clip .cnew', e => e.length);
    check(news > 1, 'NEW badges', news);
    check(await w.$eval('.month', e => e.textContent) !== '', 'month sections');
    await w.click('.clip >> nth=1'); await w.waitForSelector('#qt.on'); await w.waitForTimeout(600);
    await w.click('.game.home'); await w.waitForTimeout(600);
    check(await w.$$eval('#libgrid .clip .cnew', e => e.length) === news - 1, 'opening a clip clears its NEW');
    await w.evaluate(() => { L.newSince = Date.now(); renderGrid(); });

    // folders: untick "nv" -> only the Discord-style clips; games follow
    await w.click('#folderbtn'); await w.waitForTimeout(400);
    check(await w.$eval('#folderbox', e => e.classList.contains('open')), 'folders panel opens');
    const before = await w.$$eval('#libgrid .clip', e => e.length);
    await w.click('.frow:has-text("nv")'); await w.waitForTimeout(600);
    const after = await w.$$eval('#libgrid .clip', els => els.map(e => e._clip.root.split(/[\\/]/).pop()));
    check(after.length < before && after.every(r => r === 'dc'), 'only the chosen folder', after);
    check(await w.$eval('#foldertext', e => e.textContent) === 'dc', 'folder button label', await w.$eval('#foldertext', e => e.textContent));
    check(await w.$eval('#folderlist', e => e.lastElementChild.classList.contains('fadd') && /Add folder/.test(e.lastElementChild.textContent)), 'Add folder row under the folders');
    await w.click('.frow:has-text("dc")', { button: 'right' }); await w.waitForTimeout(200);
    const fmenu = await w.$$eval('#ctxmenu button', els => els.map(e => e.innerText));
    check(fmenu.includes('Open in File Explorer') && fmenu.includes('Remove from Library'), 'right-click a folder: Remove from Library', fmenu);
    await w.keyboard.press('Escape'); await w.waitForTimeout(200);
    check(await w.$eval('#testbadge', e => !e.hidden && e.textContent === 'Test build') && /Test build/.test(await w.title()), 'test copy is labelled');
    const games = await w.$$eval('.game .gname', e => e.map(x => x.textContent));
    check(!games.includes('Peak') && games.includes('Deadlock'), 'games without clips there are hidden', games);
    await w.click('.frow:has-text("dc")'); await w.waitForTimeout(300);
    check(await w.$eval('#foldertext', e => e.textContent) === 'dc', 'the last folder stays on');
    await w.click('.frow:has-text("nv")'); await w.waitForTimeout(500);

    // the editor: next clip, the title bar's name closes it, back/forward
    await w.click('.game:has-text("Destiny 2")'); await w.waitForTimeout(500);
    check(await w.$eval('#libname', e => e.textContent) === 'Destiny 2', 'title bar follows the game');
    await w.evaluate(() => { window.__cards = [...document.querySelectorAll('#libgrid .clip')]; });
    await w.click('.game:has-text("Destiny 2")'); await w.waitForTimeout(500);
    check(await w.$eval('#libname', e => e.textContent) === 'All clips', 'clicking the game you are on goes back to all clips');
    await w.evaluate(() => { window.__cards = [...document.querySelectorAll('#libgrid .clip')]; });
    await w.click('.game:has-text("All clips")'); await w.waitForTimeout(400);
    check(await w.evaluate(() => [...document.querySelectorAll('#libgrid .clip')].every(c => window.__cards.includes(c))), 'clicking All clips again changes nothing');
    // back/forward follows games but not the folder checkboxes
    await w.click('.game:has-text("Destiny 2")'); await w.waitForTimeout(400);
    const folderText = await w.$eval('#foldertext', e => e.textContent);
    // untick the folder that doesn't hold Destiny 2's clips, so the game stays
    const other = await w.evaluate(() => { const g = L.data.clips.find(c => c.gameName === 'Destiny 2'); return liveFolders().find(f => f.kind !== 'trimmed' && !samePathR(f.path, g.root)).path; });
    const otherName = require('path').basename(other);
    await w.click(`.frow:has-text("${otherName}")`); await w.waitForTimeout(400);
    const ticked = await w.$eval('#foldertext', e => e.textContent);
    await w.click('#navback'); await w.waitForTimeout(500);
    check(await w.evaluate(() => L.game) === 'all' && await w.$eval('#foldertext', e => e.textContent) === ticked && ticked !== folderText, 'Back goes to the previous game and leaves the folder checkboxes alone', [ticked, folderText]);
    await w.click('#navfwd'); await w.waitForTimeout(500);
    check(await w.$eval('#libname', e => e.textContent) === 'Destiny 2', 'Forward goes to the game again');
    await w.click(`.frow:has-text("${otherName}")`); await w.waitForTimeout(400); // tick it again
    await w.click('.game:has-text("All clips")'); await w.waitForTimeout(400);
    await w.click('.game:has-text("Destiny 2")'); await w.waitForTimeout(500);
    await w.click('.clip >> nth=0'); await w.waitForSelector('#qt.on'); await w.waitForTimeout(1000);
    const first = await w.evaluate(() => window.qtActivePath());
    await w.click('#qtcliplist .clip:not(.on) >> nth=0'); await w.waitForTimeout(1200);
    const second = await w.evaluate(() => window.qtActivePath());
    check(second !== first, 'next clip', [first, second]);
    check(await w.$$eval('#tabs .cliptab', t => t.length) === 0, 'no tabs');
    await w.click('#libtab'); await w.waitForTimeout(500);
    check(await w.$eval('#qt', e => e.hidden), 'the title closes the editor');
    await w.click('.clip >> nth=1'); await w.waitForSelector('#qt.on'); await w.waitForTimeout(800);
    await w.click('.game:has-text("All clips")'); await w.waitForTimeout(500);
    check(!(await w.$eval('#qt', e => e.hidden)) && await w.evaluate(() => L.game) === 'all', 'clicking a game in the sidebar while editing filters the clip list, staying in the editor');
    await w.click('.game.home'); await w.waitForTimeout(500);
    check(await w.$eval('#qt', e => e.hidden), 'Home goes back to the library');
    await w.click('#navback'); await w.waitForTimeout(600);
    check(await w.$eval('#qt', e => e.hidden), 'back skips closed clips');

    // dragging a card out: main starts a drag with the clip's file (untouched clip: the clip itself)
    await run.app.evaluate(({ BrowserWindow }) => { const wc = BrowserWindow.getAllWindows()[0].webContents; global.__drags = []; wc.startDrag = o => global.__drags.push(o.file); });
    await w.evaluate(() => { const el = [...document.querySelectorAll('#libgrid .clip')].find(x => !x._clip.edit && !x._clip.title); el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true })); window.__dragged = el._clip.path; });
    await w.waitForTimeout(500);
    const drags = await run.app.evaluate(() => global.__drags);
    check(drags.length === 1 && drags[0] === await w.evaluate(() => window.__dragged), 'dragging an untouched card starts a drag of the clip', drags);
    // clicking the game you're on goes back to all clips; clicking All clips again does nothing
    if (await w.evaluate(() => L.game !== 'all')) { await w.click('.game:has-text("All clips")'); await w.waitForTimeout(400); }
    await w.click('.game:has-text("Destiny 2")'); await w.waitForTimeout(400);
    await w.click('.game:has-text("Destiny 2")'); await w.waitForTimeout(400);
    check(await w.$eval('#libname', e => e.textContent) === 'All clips', 'clicking the current game shows all clips', await w.$eval('#libname', e => e.textContent));
    const before2 = await w.evaluate(() => { window.__cards = [...document.querySelectorAll('#libgrid .clip')]; return window.__cards.length; });
    await w.click('.game:has-text("All clips")'); await w.waitForTimeout(400);
    check(await w.evaluate(() => [...document.querySelectorAll('#libgrid .clip')].every(x => window.__cards.includes(x))) && before2 > 0, 'clicking All clips again leaves the cards alone');

    // settings is an overlay; Escape closes it
    await w.click('#appmenu'); await w.waitForTimeout(200); await w.hover('#ctxmenu >> text=File'); await w.waitForTimeout(200); await w.click('#ctxsub >> text=Settings'); await w.waitForTimeout(500);
    check(await w.$eval('#setov', e => !e.hidden && /Clip folders/.test(e.textContent)), 'settings overlay');
    await w.keyboard.press('Escape'); await w.waitForTimeout(400);
    check(await w.$eval('#setov', e => e.hidden), 'Escape closes settings');

    // updates: Ask first by default; switching modes is saved
    await w.keyboard.press('Control+Comma'); await w.waitForTimeout(500);
    const modes = await w.$$eval('.setsec:has(h3:text-is("Updates")) .setopt', els => els.map(e => [e.querySelector('.setname').textContent, e.classList.contains('on')]));
    check(JSON.stringify(modes) === JSON.stringify([['Ask first', true], ['Automatic', false], ['Off', false]]), 'update modes, Ask first by default', modes);
    await w.click('.setsec:has(h3:text-is("Updates")) .setopt:has-text("Automatic")'); await w.waitForTimeout(400);
    check(await w.evaluate(async () => (await T.settingsGet()).updateMode) === 'auto', 'update mode saved');
    await w.click('.setopt:has-text("Ask first")'); await w.waitForTimeout(400);
    await w.keyboard.press('Escape'); await w.waitForTimeout(300);

    // an update is found: soft button -> what's new + size -> Later makes it quiet -> Download
    await w.evaluate(() => showUpdate({ state: 'available', mode: 'ask', version: '9.9.9', size: 150 * 1048576, later: false, notes: '## New\n- **Faster** exports\n- Fixed `drag`' }));
    check(await w.$eval('#updbtn', e => !e.hidden && e.textContent.trim() === 'Update available' && !e.classList.contains('quiet')), 'Update available button');
    await w.click('#updbtn'); await w.waitForSelector('.modal.upd'); await w.waitForTimeout(1500);
    const box = await w.$eval('.modal.upd', e => ({ sub: e.querySelector('.updsub').textContent, items: [...e.querySelectorAll('li')].map(l => l.textContent), btns: [...e.querySelectorAll('.mbtn')].map(b => b.textContent), bold: !!e.querySelector('li strong') }));
    check(/9\.9\.9/.test(box.sub) && /150\.0 MB/.test(box.sub) && box.btns.join('|') === 'Later|Download', 'update dialog: version, size, Later / Download', box);
    check(box.items.length >= 2, 'update dialog shows the changelog', box.items);
    await w.click('.modal.upd >> text=Later'); await w.waitForTimeout(300);
    await w.evaluate(() => showUpdate({ ...upd, later: true }));
    check(await w.$eval('#updbtn', e => !e.hidden && e.classList.contains('quiet')), 'Later makes the button quiet');
    await w.evaluate(() => showUpdate({ ...upd, state: 'downloading', progress: 40 }));
    check(await w.$eval('#updtext', e => e.textContent) === 'Downloading 40%', 'download progress in the button');
    await w.evaluate(() => showUpdate({ ...upd, state: 'ready' }));
    check(await w.$eval('#updtext', e => e.textContent) === 'Restart to update' && await w.$eval('#updbtn', e => !e.classList.contains('quiet')), 'Restart to update');
    await w.evaluate(() => showUpdate({ ...upd, state: 'downloading', mode: 'auto' }));
    check(await w.$eval('#updbtn', e => e.hidden), 'automatic downloads stay out of the way');
    await w.evaluate(() => showUpdate({ state: 'none' }));
    await w.click('#appmenu'); await w.waitForTimeout(200); await w.hover('#ctxmenu >> text=Help'); await w.waitForTimeout(200);
    const help = await w.$$eval('#ctxsub button', els => els.map(e => e.innerText.split('\n')[0]));
    check(help.includes('Changelog') && help.includes('Check for Updates...'), 'Help menu: Changelog', help);
    await w.keyboard.press('Escape'); await w.waitForTimeout(200);
    check(!run.errs.length, 'no page errors (cards)', run.errs);
  } catch (err) { check(false, 'test crashed: ' + err.message); } finally { await run.app.close(); }

  run = await launch({ name: 'library-big', library: bigLibrary() });
  try {
    const { w } = run;
    await w.waitForFunction(() => [...document.querySelectorAll('#libgrid .clip')].every(c => c.querySelector(':scope > img')), null, { timeout: 30000 }).catch(() => {});
    check(await w.evaluate(() => [...document.querySelectorAll('#libgrid .clip')].filter(c => !c.querySelector(':scope > img')).length) === 0, 'every card has its picture');
    await w.evaluate(() => { window.__v = 0; new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeName === 'VIDEO') window.__v++; }).observe(document.getElementById('libgrid'), { childList: true, subtree: true }); });
    await w.mouse.move(700, 500);
    for (let i = 0; i < 20; i++) { await w.mouse.wheel(0, 300); await w.waitForTimeout(50); }
    check(await w.evaluate(() => window.__v) === 0, 'no previews start while scrolling');
    await w.waitForTimeout(400);
    const c = await w.evaluate(() => { const els = [...document.querySelectorAll('#libgrid .clip')].filter(x => { const b = x.getBoundingClientRect(); return b.top > 100 && b.bottom < 900; }); const b = els[0].getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
    await w.mouse.move(c.x, c.y); await w.waitForTimeout(250); await w.mouse.wheel(0, -120); await w.waitForTimeout(600); await w.mouse.move(c.x + 3, c.y + 3); await w.waitForTimeout(1200);
    check(await w.evaluate(() => window.__v) >= 1, 'card under the mouse previews after scrolling stops');
    // a library refresh (a new clip saved, say) keeps the existing cards instead of rebuilding them
    await w.evaluate(() => { window.__old = [...document.querySelectorAll('#libgrid .clip')]; L.sig = ''; loadLibrary(); });
    await w.waitForTimeout(1500);
    const kept = await w.evaluate(() => { const now = [...document.querySelectorAll('#libgrid .clip')]; return { same: now.filter(x => window.__old.includes(x)).length, total: now.length, loading: now.filter(x => x.classList.contains('loading')).length }; });
    check(kept.same === kept.total && kept.total > 0 && kept.loading === 0, 'refresh keeps the cards', kept);
    check(!run.errs.length, 'no page errors (scrolling)', run.errs);
  } catch (err) { check(false, 'test crashed: ' + err.message); } finally { await run.app.close(); done(); }
})();

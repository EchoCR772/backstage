// The editor end to end: open, play, trim with keys and typed times, playhead stays inside the
// selection, a row per person, mute, export video/audio, copy (made ahead), menus, saved trim,
// card length, card copy, transport buttons, click-to-pause, rename from the title.
const fs = require('fs');
const path = require('path');
const { launch, checker, openDiscordClip } = require('./helpers');

(async () => {
  const gpu = process.argv.includes('--gpu');
  const { check, done } = checker('overlay' + (gpu ? ' (webgpu)' : ''));
  const { app, w, errs, ud, ex } = await launch({ name: 'overlay', gpu });
  const statusText = () => w.$eval('#qtstatus', e => e.textContent);
  try {
    await openDiscordClip(w);
    check(await w.$eval('#qtstage', e => e.dataset.renderer) === (gpu ? 'webgpu' : '2d'), 'player renderer', await w.$eval('#qtstage', e => e.dataset.renderer));
    const rows = await w.$$eval('.qt-arow .qt-anametext', els => els.map(e => e.textContent));
    check(rows.join('|') === 'Game / Desktop|You|Person 2', 'Discord audio rows: one per person', rows);
    check(await w.$eval('#qttitletext', e => e.textContent).then(t => /^Clip from /.test(t)), 'title before naming');
    check(await w.$eval('#qtsub', e => /Destiny_2_.*\.mp4/.test(e.textContent)), 'file name in the subtext');

    await w.keyboard.press('Space'); await w.waitForTimeout(1200); await w.keyboard.press('Space');
    const played = await w.$eval('#qtcur', e => e.textContent);
    check(played !== '0:00.00', 'playback advances', played);
    // clicking the picture plays and pauses
    await w.click('#qtstage'); await w.waitForTimeout(400);
    check(await w.$eval('#qtplay .ico', e => e.dataset.ico) === 'pause', 'click the picture plays');
    await w.click('#qtstage'); await w.waitForTimeout(200);
    check(await w.$eval('#qtplay .ico', e => e.dataset.ico) === 'play', 'click again pauses');

    // trim 1s..4s: start with the keyboard, end by typing it
    await w.keyboard.press('Home'); await w.keyboard.press('Shift+ArrowRight'); await w.keyboard.press('i');
    await w.fill('#qtout', '0:04'); await w.press('#qtout', 'Enter');
    await w.waitForTimeout(500);
    check(await w.$eval('#qtlen', e => e.textContent) === '0:03.00', 'trim length', await w.$eval('#qtlen', e => e.textContent));
    // frame keys
    await w.keyboard.press('Home'); await w.keyboard.press('.'); await w.keyboard.press('.'); await w.keyboard.press(','); await w.waitForTimeout(200);
    check(await w.$eval('#qtcur', e => e.textContent) === '0:01.03', 'frame step with , and .', await w.$eval('#qtcur', e => e.textContent));
    // transport: jump to the end and start of the trim
    await w.click('#qttoend'); await w.waitForTimeout(200);
    check(await w.$eval('#qtcur', e => e.textContent) === '0:03.97', 'jump to trim end', await w.$eval('#qtcur', e => e.textContent));
    await w.click('#qttostart'); await w.waitForTimeout(200);
    check(await w.$eval('#qtcur', e => e.textContent) === '0:01.00', 'jump to trim start', await w.$eval('#qtcur', e => e.textContent));

    // clicking left of the selection keeps the playhead at the selection start
    await w.click('#qtfwd'); await w.waitForTimeout(200);
    const lane = await w.$eval('#qtlane', e => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y }; });
    await w.mouse.click(lane.x + 2, lane.y + 85); await w.waitForTimeout(300);
    check(await w.$eval('#qtcur', e => e.textContent) === '0:01.00', 'playhead trapped in selection', await w.$eval('#qtcur', e => e.textContent));

    // export with the game audio muted
    await w.click('.qt-amute >> nth=0'); await w.waitForTimeout(400);
    await w.click('#qtsave');
    await w.waitForFunction(() => /Exported|Couldn't/i.test(document.getElementById('qtstatus').textContent), null, { timeout: 30000 });
    check(/^Exported.*_trim\.mp4/.test(await statusText()), 'export video', await statusText());
    check(await w.$$eval('#qtstatus .qt-done button', b => b.map(x => x.textContent).join()) === 'Show in folder', 'confirmation has Show in folder');
    await w.click('.qt-amute >> nth=0'); await w.waitForTimeout(300);

    // export audio from the "..." menu
    await w.click('#qtmore'); await w.waitForTimeout(200);
    await w.click('#ctxmenu >> text=Export Audio File');
    await w.waitForFunction(() => /\.mp3|Couldn't/.test(document.getElementById('qtstatus').textContent), null, { timeout: 30000 });
    check(/^Exported.*_trim\.mp3/.test(await statusText()), 'export audio', await statusText());

    // copy: the trimmed clip is made in the background, so this should be near-instant
    await w.waitForTimeout(3000);
    const t0 = Date.now();
    await w.click('#qtcopy');
    await w.waitForFunction(() => /Copied|Couldn't/i.test(document.getElementById('qtstatus').textContent), null, { timeout: 30000 });
    const ms = Date.now() - t0;
    check(/^Copied/.test(await statusText()), 'copy video', await statusText());
    check(ms < 1500, 'copy uses the ready-made clip (fast)', ms);

    // menus: arrow next to Copy Video, arrow next to Export; clicking again closes
    await w.click('#qtcopymenu'); await w.waitForTimeout(200);
    check(await w.$eval('#ctxmenu', m => !m.hidden && m.innerText === 'Copy under 20 MB (Discord)\nCopy Audio'), 'copy arrow menu');
    await w.click('#qtcopymenu'); await w.waitForTimeout(200);
    check(await w.$eval('#ctxmenu', m => m.hidden), 'copy arrow closes on second click');
    await w.click('#qtsavemenu'); await w.waitForTimeout(200);
    check(await w.$eval('#ctxmenu', m => m.innerText) === 'Export as...\nExport under 20 MB (Discord)\nExport audio as...\nReplace original', 'export arrow menu', await w.$eval('#ctxmenu', m => m.innerText));
    await w.keyboard.press('Escape'); await w.waitForTimeout(200);
    check(await w.$eval('#ctxmenu', m => m.hidden) && await w.$eval('#qt', q => q.classList.contains('on')), 'Escape closes the menu, not the editor');

    // the editor is a page beside the games sidebar, with the clip list
    const page = await w.evaluate(() => ({ qt: document.getElementById('qt').getBoundingClientRect().left, side: document.getElementById('libside').getBoundingClientRect().right, items: document.querySelectorAll('#qtcliplist .clip').length, on: document.querySelectorAll('#qtcliplist .clip.on').length }));
    check(Math.abs(page.qt - page.side) < 2 && page.items > 0 && page.on === 1, 'editor page sits beside the sidebar with the clip list', page);

    // close: the trim is saved and the card shows the trimmed length
    await w.keyboard.press('Escape'); await w.waitForTimeout(400);
    check(!(await w.$eval('#qt', e => e.hidden)), 'Escape does not leave the editor');
    await w.click('.game.home'); await w.waitForTimeout(800);
    check(await w.$eval('#qt', e => e.hidden), 'editor closes');
    const card = await w.$eval('.clip:has(.csrc.discord) >> nth=0', e => ({ len: e.querySelector('.cdur').textContent, edit: e._clip.edit, dur: e._clip.duration }));
    check(card.len === '0:03', 'card shows trimmed length', card);
    const edits = JSON.parse(fs.readFileSync(path.join(ud, 'edits.json'), 'utf8'));
    const e = Object.values(edits)[0] || {};
    check(e.in === 1 && e.out === 4, 'edits.json has the trim', e);
    await w.click('.clip:has(.csrc.discord) >> nth=0'); await w.waitForSelector('#qt.on'); await w.waitForTimeout(1200);
    check(await w.$eval('#qtlen', e2 => e2.textContent) === '0:03.00', 'trim restored on reopen');

    // rename from the title: the tab, the title and the card follow; the file keeps its name
    await w.click('#qttitle'); await w.waitForTimeout(150);
    await w.fill('#qttitlein', 'Nice shot'); await w.press('#qttitlein', 'Enter'); await w.waitForTimeout(600);
    check(await w.$eval('#qttitletext', x => x.textContent) === 'Nice shot', 'renamed title');
    await w.click('.game.home'); await w.waitForTimeout(600);
    check(await w.$eval('.clip:has(.csrc.discord) >> nth=0', x => x.querySelector('.ctitle').textContent) === 'Nice shot', 'card shows the name');
    check(fs.existsSync(path.join(ud, 'names.json')), 'names saved');

    // Copy Video on a trimmed, named card: made first, under its name
    const b = await w.$eval('.clip:has(.csrc.discord) >> nth=0', el => { const x = el.getBoundingClientRect(); return { x: x.x + x.width / 2, y: x.y + x.height / 2 }; });
    await w.mouse.move(b.x, b.y); await w.waitForTimeout(500);
    await w.click('.clip:has(.csrc.discord) >> nth=0 >> .hbtn.primary'); await w.waitForTimeout(4000);
    check(/Copied/.test(await w.$eval('#libtoast', t => t.textContent)), 'card copy of a trimmed clip', await w.$eval('#libtoast', t => t.textContent));

    const files = fs.readdirSync(ex, { recursive: true }).map(String);
    check(files.some(f => /_trim\.mp4$/.test(f)) && files.some(f => /_trim\.mp3$/.test(f)), 'files in the exports folder', files);
    check(!errs.length, 'no page errors', errs);
  } catch (err) { check(false, 'test crashed: ' + err.message); } finally { await app.close(); done(); }
})();

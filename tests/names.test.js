// 1.49.0 round (Nov 4): the filters above the cards (All, Clips, Recordings, Edited; clicking the one
// that's on turns it off; the sidebar's games follow), clip types per recorder (NVIDIA's .DVR, Encore's
// encore_kind / encore_game tags, Discord), exports saved next to their clip with Backstage's marker,
// and Settings > File names: renaming a clip renames its file (an open clip once it's closed), keeping
// what the old name said, and Replace original.
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { launch, checker, gopLibrary, OUT, FIX } = require('./helpers');
const { check, done } = checker('names');

const FF = fs.existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : 'ffmpeg';
const tagsOf = f => {
  const out = execFileSync(FF.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', f]).toString();
  return JSON.parse(out).format.tags || {};
};

(async () => {
  // a small library of its own (exports land next to the clips, so never the fixtures)
  const root = path.join(OUT, 'nameslib');
  fs.rmSync(root, { recursive: true, force: true });
  const gop = path.join(gopLibrary()[0], 'Deadlock', 'Deadlock 2026.10.20 - 20.10.10.01.DVR.mp4');
  const put = (rel, from = gop) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.copyFileSync(from, f); return f; };
  const dvr = put('nv/Deadlock/Deadlock 2026.10.20 - 20.10.10.01.DVR.mp4');
  const rec = put('nv/Deadlock/Deadlock 2026.10.21 - 21.00.00.02.mp4');
  const echo = path.join(root, 'enc/Desktop/Desktop 2026.11.02 - 15.59.43.mp4');
  fs.mkdirSync(path.dirname(echo), { recursive: true });
  // Encore 0.9.36's tags (Auri's "Encore's files, for Backstage")
  const encTags = ['-metadata', 'comment=rec-format:2', '-metadata', 'encore_kind=replay', '-metadata', 'encore_source=game', '-metadata', 'encore_game=Valorant',
    '-metadata', 'encore_game_exe=VALORANT-Win64-Shipping.exe', '-metadata', 'encore_id=0f8c2b9e-41d3-4a7e-9c1b-5e2d7f9a3c10', '-metadata', 'encore_version=0.9.36'];
  execFileSync(FF, ['-v', 'error', '-y', '-i', gop, '-map', '0', '-c', 'copy', ...encTags, '-movflags', '+faststart+use_metadata_tags', echo]);
  // recovered after a crash: only encore_id and encore_version, any name
  const recovered = path.join(root, 'enc/Recovered/rescued.mp4');
  fs.mkdirSync(path.dirname(recovered), { recursive: true });
  execFileSync(FF, ['-v', 'error', '-y', '-i', gop, '-map', '0', '-c', 'copy', '-metadata', 'encore_id=7d1e0a52-9a8b-4c1d-8e2f-3b4c5d6e7f80', '-metadata', 'encore_version=0.9.36', '-movflags', '+faststart+use_metadata_tags', recovered]);
  const encRec = path.join(root, 'enc/Desktop/Desktop 2026.11.02 - 16.00.00.mp4');
  execFileSync(FF, ['-v', 'error', '-y', '-i', gop, '-map', '0', '-c', 'copy', '-metadata', 'comment=rec-format:2', '-movflags', '+faststart', encRec]);
  const dc = put('dc/Destiny_2_d62c0819-d443-4b69-9822-439a547bba0e.mp4', path.join(FIX, 'dc', 'Destiny_2_d62c0819-d443-4b69-9822-439a547bba0e.mp4'));

  const { app, w, errs } = await launch({ name: 'names', library: ['nv', 'enc', 'dc'].map(x => path.join(root, x)), ownExports: false });
  const facts = () => w.evaluate(() => L.data.clips.map(c => ({ name: c.name, path: c.path, kind: c.kind, type: c.type, edited: !!(c.edited || c.edit), game: c.gameName, date: c.date, title: c.title, edit: c.edit })));
  const by = (list, f) => list.find(c => c.name === path.basename(f));
  const reload = async () => { await w.evaluate(() => { L.dirty = true; return loadLibrary(); }); await w.waitForTimeout(500); };
  try {
    // types per recorder
    let f = await facts();
    check(by(f, dvr) && by(f, dvr).kind === 'replay' && by(f, dvr).type === 'clip', 'NVIDIA .DVR is a clip (Instant Replay)', by(f, dvr));
    check(by(f, rec) && by(f, rec).kind === 'recording' && by(f, rec).type === 'recording', 'NVIDIA without .DVR is a recording', by(f, rec));
    check(by(f, echo) && by(f, echo).kind === 'echo' && by(f, echo).type === 'clip' && by(f, echo).game === 'Valorant', "Encore's encore_kind=replay is a clip, encore_game its game", by(f, echo));
    check(by(f, encRec) && by(f, encRec).kind === 'recording' && by(f, encRec).game === 'Desktop', 'Encore without the tag is a recording', by(f, encRec));
    check(by(f, dc) && by(f, dc).kind === 'discord' && by(f, dc).type === 'clip', 'Discord clips are clips', by(f, dc));
    const rc = await w.evaluate(n => { const c = L.data.clips.find(x => x.name === n); return c && { kind: c.kind, type: c.type, origin: c.origin }; }, path.basename(recovered));
    check(rc && rc.kind === 'recording' && rc.type === 'recording' && rc.origin === 'encore', 'a recovered Encore file (only encore_id) is an Encore recording', rc);
    const badge = await w.$eval(`#libgrid .clip:has(.cfile:text-is("${path.basename(echo)}")) .cklabel`, e => e.textContent);
    check(badge === 'Echo', "Encore's replays are badged Echo", badge);

    // the filters: only the ones that pick out some of the clips
    const chips = () => w.$$eval('#libkinds .chip', e => e.map(x => x.textContent + (x.classList.contains('on') ? '*' : '')).join());
    check(await chips() === 'All*,Clips,Recordings', 'filters: All, Clips, Recordings (nothing edited yet)', await chips());
    await w.click('#libkinds .chip >> text=Clips'); await w.waitForTimeout(500);
    const types = await w.evaluate(() => [...new Set(L.list.map(c => c.type))].join());
    check(types === 'clip' && await chips() === 'All,Clips*,Recordings', 'Clips shows only clips', types);
    const games = () => w.$$eval('#games .game .gname', e => e.map(x => x.textContent).sort().join());
    check(await games() === 'Deadlock,Destiny 2,Valorant', 'the games follow the filter (Desktop has only a recording)', await games());
    // clicking it again turns it off; clicking All while on All moves nothing
    await w.click('#libkinds .chip >> text=Clips'); await w.waitForTimeout(500);
    check(await w.evaluate(() => L.kind) === 'all' && await chips() === 'All*,Clips,Recordings', 'clicking the filter that is on turns it off');
    check((await games()).includes('Desktop'), 'all the games are back');
    await w.waitForTimeout(1500);
    await w.$eval('#libgrid .clip', e => { e.dataset.mark = '1'; });
    await w.click('#libkinds .chip >> text=All'); await w.waitForTimeout(300);
    check(await w.$$eval('#libgrid .clip[data-mark="1"]', e => e.length) === 1 && !(await w.$$eval('#libgrid .clip.loading', e => e.length)), 'All while on All: the cards stay (no fade)');

    // export: next to the clip, with Backstage's marker
    const x = await w.evaluate(p => T.qtExport({ path: p, start: 1, end: 4, as: 'video', dest: 'save', audio: {} }), dvr);
    check(x.ok && path.dirname(x.out) === path.dirname(dvr) && fs.existsSync(x.out), 'Export saves next to the clip', x);
    const t = x.ok ? tagsOf(x.out) : {};
    check(t.backstage === 'export' && t.backstage_kind === 'clip' && t.backstage_origin === 'nvidia' && t.backstage_game === 'Deadlock' && Number(t.backstage_date) > 0, "the export carries Backstage's marker", t);
    // renamed outside Backstage it's still known
    const moved = path.join(path.dirname(dvr), 'my favourite.mp4');
    if (x.ok) fs.renameSync(x.out, moved);
    await reload();
    f = await facts();
    const ex = by(f, moved);
    check(ex && ex.kind === 'export' && ex.type === 'clip' && ex.edited && ex.game === 'Deadlock' && ex.date === by(f, dvr).date, 'an export is Edited, a clip, in its game, dated like its clip (whatever its name)', ex);
    check(await chips() === 'All*,Clips,Recordings,Edited', 'the Edited filter shows up', await chips());
    await w.click('#libkinds .chip >> text=Edited'); await w.waitForTimeout(500);
    check((await w.evaluate(() => L.list.map(c => c.name).join())) === 'my favourite.mp4', 'Edited shows the export');
    check(await w.$eval('#libgrid .clip .cklabel', e => e.textContent) === 'Export', 'its badge says Export');
    await w.click('#libkinds .chip >> text=Edited'); await w.waitForTimeout(300);

    // Settings > File names
    await w.keyboard.press('Control+Comma'); await w.waitForTimeout(500);
    const secs = await w.$$eval('.setsec h3', e => e.map(x => x.textContent));
    check(secs.includes('File names') && !secs.includes('Trimmed clips'), 'Settings has File names, no Trimmed clips', secs);
    await w.click('.setsec:has(h3:text-is("File names")) .setopt:has-text("Rename the files too")'); await w.waitForTimeout(300);
    check(await w.evaluate(async () => (await T.settingsGet()).renameFiles) === true, 'turning it on is saved');
    await w.keyboard.press('Escape'); await w.waitForTimeout(300);

    // renaming renames the file; the edit and what the name said (.DVR, the date) stay with it
    const d0 = by(f, dvr).date;
    await w.evaluate(p => T.qtEdit(p, { in: 1, out: 5, dur: 12, audio: {} }), dvr);
    const r = await w.evaluate(async p => { const c = L.data.clips.find(x => x.path === p); await setClipTitle(c, 'Big play'); return { path: c.path, name: c.name }; }, dvr);
    const big = path.join(path.dirname(dvr), 'Big play.mp4');
    check(r.path === big && fs.existsSync(big) && !fs.existsSync(dvr), 'Rename renames the file', r);
    await reload();
    f = await facts();
    const b = by(f, big);
    check(b && b.kind === 'replay' && b.type === 'clip' && b.date === d0 && b.title === 'Big play' && b.edit && b.edit.in === 1, 'still an Instant Replay with its date, name and trim', b);

    // a clip open in the editor is renamed once it's closed
    await w.evaluate(p => T.qtOpen(p), rec);
    const r2 = await w.evaluate(p => T.renameClip(p, 'Long session'), rec);
    check(r2.ok && r2.pending && fs.existsSync(rec), 'an open clip keeps its file until it is closed', r2);
    await w.evaluate(p => T.qtClose(p), rec); await w.waitForTimeout(500);
    const long = path.join(path.dirname(rec), 'Long session.mp4');
    check(fs.existsSync(long) && !fs.existsSync(rec), 'closing it renames the file', fs.readdirSync(path.dirname(rec)));
    check(await w.evaluate(p => L.data.clips.some(c => c.path === p), long), 'the library follows the new path right away');

    // Replace original on a named clip: renamed first, the replaced file keeps its type and date
    const d1 = by(f, encRec).date;
    await w.evaluate(async p => { const c = L.data.clips.find(x => x.path === p); await setClipTitle(c, 'Desk test'); }, encRec);
    const desk = path.join(path.dirname(encRec), 'Desk test.mp4');
    const rp = await w.evaluate(p => T.qtReplace({ path: p, start: 2, end: 6 }), desk);
    check(rp.ok && fs.existsSync(desk) && tagsOf(desk).backstage === 'replaced', 'Replace original marks the file', rp);
    await reload();
    f = await facts();
    const dk = by(f, desk);
    check(dk && dk.kind === 'recording' && dk.edited && dk.date === d1 && dk.title === 'Desk test', 'the replaced clip is Edited, still a recording, same date and name', dk);

    // an Encore clip's name follows its encore_id, even when the file is renamed and moved outside Backstage
    await w.evaluate(async p => { const c = L.data.clips.find(x => x.path === p); await setClipTitle(c, 'Ace'); }, echo);
    const ace = path.join(path.dirname(echo), 'Ace.mp4'), elsewhere = path.join(root, 'enc/Recovered/somewhere else.mp4');
    check(fs.existsSync(ace), 'the Encore clip was renamed', fs.readdirSync(path.dirname(echo)));
    if (fs.existsSync(ace)) { fs.renameSync(ace, elsewhere); const t1 = new Date(Date.now() - 3600e3); fs.utimesSync(elsewhere, t1, t1); } // a new date too: only encore_id still matches
    await reload();
    f = await facts();
    const ac = by(f, elsewhere);
    check(ac && ac.title === 'Ace' && ac.kind === 'echo' && ac.game === 'Valorant', "renamed and moved outside Backstage, it keeps its name (encore_id)", ac);

    // turned off: renaming leaves the file alone
    await w.evaluate(() => T.settingsSet({ renameFiles: false }));
    await w.evaluate(p => T.renameClip(p, 'Clutch'), dc);
    check(fs.existsSync(dc), 'with the setting off the file keeps its name');
    check(!errs.length, 'no page errors', errs);
  } catch (err) { check(false, 'test crashed: ' + err.message); } finally { await app.close(); done(); }
})();

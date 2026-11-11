// 1.51.0: Encore clips join the same game from other recorders by their program (encore_game_exe),
// matched against the programs in Discord's list of games, even when the names don't match. A
// program not in the list, or an old games.json without programs, falls back to the name.
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { launch, checker, gopLibrary, OUT } = require('./helpers');
const { check, done } = checker('exegroup');

const FF = fs.existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : 'ffmpeg';

// Discord's list as main.js keeps it (games.json, format 2): id, icon, programs joined with |, names
const LIST = { v: 2, games: [
  ['111', 'aaaa', 'cod.exe|bootstrapper.exe', 'Call of Duty®: Black Ops 7', 'Call of Duty Black Ops 7'],
  ['222', 'bbbb', 'valorant-win64-shipping.exe', 'VALORANT'],
  ['333', 'cccc', '', 'Peak'],
] };

(async () => {
  const root = path.join(OUT, 'exelib');
  fs.rmSync(root, { recursive: true, force: true });
  const gop = path.join(gopLibrary()[0], 'Deadlock', 'Deadlock 2026.10.20 - 20.10.10.01.DVR.mp4');
  const put = rel => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.copyFileSync(gop, f); return f; };
  const enc = (rel, game, exe, id) => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    execFileSync(FF, ['-v', 'error', '-y', '-i', gop, '-map', '0', '-c', 'copy', '-metadata', 'comment=rec-format:2', '-metadata', 'encore_kind=replay',
      '-metadata', 'encore_source=game', '-metadata', 'encore_game=' + game, ...(exe ? ['-metadata', 'encore_game_exe=' + exe] : []),
      '-metadata', 'encore_id=' + id, '-metadata', 'encore_version=0.9.38', '-movflags', '+faststart+use_metadata_tags', f]);
    return f;
  };
  put('nv/Call of Duty Black Ops 7/Call of Duty Black Ops 7 2026.11.01 - 20.00.00.01.DVR.mp4');
  put('nv/VALORANT/VALORANT 2026.11.01 - 21.00.00.01.DVR.mp4');
  // Encore calls it something else, but the program is the same
  const cod = enc('enc/Black Ops 7/Black Ops 7 2026.11.02 - 20.00.00.mp4', 'Black Ops 7', 'cod.exe', '11111111-1111-4111-8111-111111111111');
  // a program written with its case kept, as Encore writes it
  const val = enc('enc/Valorant/Valorant 2026.11.02 - 21.00.00.mp4', 'Valorant Beta', 'VALORANT-Win64-Shipping.exe', '22222222-2222-4222-8222-222222222222');
  // a program the list doesn't have: grouped by name
  const odd = enc('enc/Indie/Indie Thing 2026.11.02 - 22.00.00.mp4', 'Indie Thing', 'indie.exe', '33333333-3333-4333-8333-333333333333');
  // no program at all (before 0.9.36 had none): by name, which here matches Peak
  const peak = enc('enc/Peak/Peak 2026.11.02 - 23.00.00.mp4', 'PEAK', '', '44444444-4444-4444-8444-444444444444');
  const library = ['nv', 'enc'].map(x => path.join(root, x));

  const groups = w => w.evaluate(() => L.data.clips.map(c => ({ name: c.name, game: c.game, gameName: c.gameName })));
  const by = (list, f) => list.find(c => c.name === path.basename(f)) || {};
  const same = (list, f, game) => list.filter(c => c.gameName === game).map(c => c.name).includes(path.basename(f));

  // 1) the new format
  let ud = path.join(OUT, 'profile-exegroup');
  fs.rmSync(ud, { recursive: true, force: true });
  fs.mkdirSync(ud, { recursive: true });
  fs.writeFileSync(path.join(ud, 'games.json'), JSON.stringify(LIST));
  let { app, w, errs } = await launch({ name: 'exegroup', library, keepProfile: true });
  try {
    const g = await groups(w);
    check(by(g, cod).game === 'app:111', "an Encore clip joins the game by its program though the name differs", by(g, cod));
    check(same(g, cod, 'Call of Duty Black Ops 7'), 'and shows under the NVIDIA clips\' game name', by(g, cod));
    check(by(g, val).game === 'app:222', "the program is matched whatever its case", by(g, val));
    check(by(g, odd).game === 'indie thing' && by(g, odd).gameName === 'Indie Thing', 'a program not in the list: grouped by its name', by(g, odd));
    check(by(g, peak).game === 'app:333', 'no program: grouped by its name as before', by(g, peak));
    const side = await w.$$eval('#games .game', e => e.map(x => x.textContent.trim()));
    check(side.filter(t => /Black Ops/.test(t)).length === 1, 'one Black Ops entry in the sidebar', side);
    check(!errs.length, 'no page errors', errs);
  } finally { await app.close(); }

  // 2) an old games.json (plain list, no programs) is downloaded again; offline it's still used, by name
  const gj = path.join(ud, 'games.json');
  fs.writeFileSync(gj, JSON.stringify(LIST.games.map(([id, icon, , ...names]) => [id, icon, ...names])));
  ({ app, w, errs } = await launch({ name: 'exegroup', library, keepProfile: true }));
  try {
    const g = await groups(w);
    const now = JSON.parse(fs.readFileSync(gj, 'utf8'));
    if (Array.isArray(now)) { // offline: the old list
      check(by(g, cod).game === 'black ops 7', 'old games.json offline: by name (Black Ops 7 on its own)', by(g, cod));
      check(by(g, peak).game === 'app:333', 'old games.json offline: names still match', by(g, peak));
    } else { // online: Discord's real list, with programs
      check(now.v === 2 && now.games.length > 1000, 'old games.json is downloaded again in the new format', now.v);
      check(/^app:/.test(by(g, cod).game), "with Discord's real list, cod.exe is a game", by(g, cod));
      const wow = now.games.find(x => x[3] === 'World of Warcraft');
      check(wow && !wow[2].split('|').includes('wow.exe'), "a program two games share (wow.exe, also Classic's) is left out", wow && wow[2]);
    }
    check(!errs.length, 'no page errors (old list)', errs);
  } finally { await app.close(); }
  done();
})().catch(e => { console.log('FAIL exegroup\n  - ' + (e.stack || e)); process.exitCode = 1; });

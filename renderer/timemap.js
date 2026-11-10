// The timeline's own time. A clip plays at its own speed except in speed parts (Edit's Speed blocks on V1),
// and the whole trim can have a speed too (Trim's Speed row). The map turns clip time into timeline time
// (the time of the file that gets made) and back. Shared by the editor (a plain script, window.TimeMap),
// the sound engine and the export in main (require), so all three agree to the sample.
//
// A part runs at its own speed, eased in and out at its edges (EASE_STEPS steps over at most EASE clip
// seconds each side, the speed moving evenly in octaves), so a slow-down doesn't jolt. Its sound keeps its
// pitch; a muted part plays silent (added sounds still play).
(function (root) {
  'use strict';
  const RATES = [0.25, 0.5, 0.75, 1.5, 2, 3, 4];
  const EASE = 0.3, EASE_STEPS = 4;

  // speed parts from the effects' layers (type 'speed', clip time), tidied: known speeds, inside the clip,
  // sorted, not overlapping
  function parts(layers, dur) {
    const out = [];
    for (const l of Array.isArray(layers) ? layers : []) {
      if (!l || l.type !== 'speed' || !RATES.includes(+l.rate)) continue;
      const s = Math.max(0, +l.start || 0), e = Math.min(dur, +l.end || 0);
      if (!(e > s + 0.01)) continue;
      out.push({ start: s, end: e, rate: +l.rate, mute: !!l.mute, ease: l.ease !== false });
    }
    out.sort((a, b) => a.start - b.start);
    return out.filter((p, i) => i === 0 || p.start >= out[i - 1].end - 1e-6);
  }

  // segs: [{ c0, c1, o0, rate, mute }] cover clip time 0..dur; rate = clip seconds per timeline second
  function build(layers, base, dur) {
    base = base > 0 ? +base : 1;
    dur = Math.max(0, +dur || 0);
    const ps = parts(layers, dur), raw = [];
    let c = 0;
    const push = (c1, rate, mute) => { if (c1 > c + 1e-9) { raw.push({ c0: c, c1, rate, mute }); c = c1; } };
    for (const p of ps) {
      push(p.start, base, false);
      const len = p.end - p.start, r = p.ease ? Math.min(EASE, len / 4) : 0;
      // eased: the speed steps from 1x to the part's speed, evenly in octaves (and back at the end)
      const step = k => base * Math.pow(p.rate, (k + 0.5) / EASE_STEPS);
      if (r > 0.004) for (let k = 0; k < EASE_STEPS; k++) push(p.start + r * (k + 1) / EASE_STEPS, step(k), p.mute);
      push(p.end - (r > 0.004 ? r : 0), base * p.rate, p.mute);
      if (r > 0.004) for (let k = EASE_STEPS - 1; k >= 0; k--) push(p.end - r * k / EASE_STEPS, step(k), p.mute);
    }
    push(dur, base, false);
    if (!raw.length) raw.push({ c0: 0, c1: dur, rate: base, mute: false });
    let o = 0;
    for (const s of raw) { s.o0 = o; o += (s.c1 - s.c0) / s.rate; s.o1 = o; }
    const segs = raw;
    const identity = segs.length === 1 && segs[0].rate === 1;
    const sig = identity ? '1' : segs.map(s => `${s.c1.toFixed(4)}:${s.rate}:${s.mute ? 1 : 0}`).join('|');
    const segAtC = t => { let lo = 0, hi = segs.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (t < segs[m].c1) hi = m; else lo = m + 1; } return segs[lo]; };
    const segAtO = t => { let lo = 0, hi = segs.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (t < segs[m].o1) hi = m; else lo = m + 1; } return segs[lo]; };
    return {
      segs, dur, outDur: o, identity, sig, parts: ps,
      toOut: t => { if (identity) return t; const s = segAtC(t); return s.o0 + (t - s.c0) / s.rate; },
      toClip: t => { if (identity) return t; const s = segAtO(t); return s.c0 + (t - s.o0) * s.rate; },
      rateAt: t => segAtC(t).rate,
      muteAt: t => segAtC(t).mute,
      // the pieces of clip time a..b, each with its speed: [{ c0, c1, o0, rate, mute }]
      between(a, b) {
        const out = [];
        for (const s of segs) {
          const x = Math.max(a, s.c0), y = Math.min(b, s.c1);
          if (y > x + 1e-9) out.push({ c0: x, c1: y, o0: s.o0 + (x - s.c0) / s.rate, rate: s.rate, mute: s.mute });
        }
        return out;
      },
    };
  }
  const api = { RATES, EASE, build, parts };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.TimeMap = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

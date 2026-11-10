// Time-stretching for the preview: audio played faster or slower without changing its pitch.
// WSOLA: the output is built from overlapping windows of the input, taken `rate` times further apart
// than they're laid down; each window is nudged (within SEARCH samples) to where it lines up best
// with the end of the previous one, so the sound joins without the echo of plain overlap-add.
// Streaming: push() takes the next decoded samples and returns whatever output is finished.
const W = 1536, H = W / 2, SEARCH = 256, DEC = 4;
const WIN = new Float32Array(W);
for (let i = 0; i < W; i++) WIN[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / W);

export class Stretcher {
  constructor(channels, rate) {
    this.ch = channels;
    this.rate = rate;
    this.buf = Array.from({ length: channels }, () => new Float32Array(0)); // input not yet used up
    this.base = 0;   // input index of buf[*][0]
    this.pos = 0;    // where the next window should be taken from (input index, before nudging)
    this.prev = -1;  // where the last window was taken from
    this.tail = Array.from({ length: channels }, () => new Float32Array(H)); // second half of the last window
  }
  // input sample (summed over channels) at absolute index i
  mono(i) { let s = 0; for (let c = 0; c < this.ch; c++) s += this.buf[c][i - this.base]; return s; }
  push(chans) {
    const n = chans[0].length;
    for (let c = 0; c < this.ch; c++) {
      const b = new Float32Array(this.buf[c].length + n);
      b.set(this.buf[c]); b.set(chans[c], this.buf[c].length);
      this.buf[c] = b;
    }
    const have = this.base + this.buf[0].length;
    const out = Array.from({ length: this.ch }, () => []);
    for (;;) {
      const p = Math.round(this.pos);
      if (p + SEARCH + W > have || (this.prev >= 0 && this.prev + H + W > have)) break;
      let c0 = p;
      if (this.prev >= 0) {
        // where the last window would naturally have gone on; find the nearby start that matches it best
        const nat = this.prev + H, lo = Math.max(this.base, p - SEARCH), hi = p + SEARCH;
        let best = -Infinity, at = p;
        for (let d = lo; d <= hi; d += 2) {
          let s = 0;
          for (let k = 0; k < H; k += DEC) s += this.mono(d + k) * this.mono(nat + k);
          if (s > best) { best = s; at = d; }
        }
        for (let d = Math.max(lo, at - 1); d <= Math.min(hi, at + 1); d++) {
          let s = 0;
          for (let k = 0; k < H; k += DEC) s += this.mono(d + k) * this.mono(nat + k);
          if (s > best) { best = s; at = d; }
        }
        c0 = at;
      }
      for (let c = 0; c < this.ch; c++) {
        const b = this.buf[c], o = c0 - this.base, f = new Float32Array(H), t = this.tail[c];
        for (let k = 0; k < H; k++) { f[k] = t[k] + b[o + k] * WIN[k]; t[k] = b[o + H + k] * WIN[H + k]; }
        out[c].push(f);
      }
      this.prev = c0;
      this.pos += H * this.rate;
      // drop input that can't be needed any more
      const keep = Math.min(Math.round(this.pos) - SEARCH, this.prev + H) - this.base;
      if (keep > 4096) { for (let c = 0; c < this.ch; c++) this.buf[c] = this.buf[c].slice(keep); this.base += keep; }
    }
    return out.map(parts => {
      const r = new Float32Array(parts.length * H);
      parts.forEach((f, i) => r.set(f, i * H));
      return r;
    });
  }
}

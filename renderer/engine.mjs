// Live audio preview engine.
//
// Each audio track of the clip (and any added audio file) is decoded separately with
// Mediabunny (WebCodecs) and played through its own GainNode into one master GainNode, all
// scheduled against the AudioContext clock. Every track shares that one clock, so they stay
// sample-aligned with each other, and mutes/volume changes apply instantly. The <video>
// element is muted and follows this clock (see syncVideo in app.js).

import { Input, ALL_FORMATS, CustomSource, AudioBufferSink } from './vendor/mediabunny.min.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const LEAD = 0.03;      // seconds between asking to play and the first scheduled sample
const AHEAD = 1.0;      // how far ahead of the playhead each track is decoded and queued
let ctx = null;
let listen = null;        // listening volume: only what you hear, never the export
let listenLevel = 1;
let knownLatency = 0.04; // typical until the real value is known
function getCtx() {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    listen = ctx.createGain();
    listen.gain.value = listenLevel;
    listen.connect(ctx.destination);
  }
  return ctx;
}
function setListen(v) {
  listenLevel = v;
  if (listen) listen.gain.setTargetAtTime(v, ctx.currentTime, 0.012);
}

class Session {
  constructor() {
    this.ctx = getCtx();
    this.master = this.ctx.createGain();
    this.master.connect(listen);
    this.tracks = new Map();   // key -> { sink, gain }
    this.inputs = [];
    this.playing = false;
    this.pos = 0;              // clip time at startCtx (or the paused position)
    this.startCtx = 0;
    this.gen = 0;              // bumped on every stop so stale decode loops quit
    this.nodes = new Set();
    this.closed = false;
  }

  // specs: [{ key, path, index, offset?, from?, to? }]; reader: { size(path), read(path, start, end) }
  // An added sound plays file time `from`..`to`; file time = clip time + offset.
  static async open(specs, reader) {
    const s = new Session();
    s.reader = reader;
    s.byPath = new Map();
    try {
      for (const sp of specs) await s.add(sp);
    } catch (e) {
      s.close();
      throw e;
    }
    return s;
  }
  async add(sp) {
    let entry = this.byPath.get(sp.path);
    if (!entry) {
      const reader = this.reader;
      const input = new Input({
        formats: ALL_FORMATS,
        source: new CustomSource({
          getSize: () => reader.size(sp.path),
          read: (a, b) => reader.read(sp.path, a, b),
          prefetchProfile: 'fileSystem',
        }),
      });
      this.inputs.push(input);
      entry = { tracks: await input.getAudioTracks() };
      this.byPath.set(sp.path, entry);
    }
    const tr = entry.tracks[sp.index || 0];
    if (this.closed || !tr || !(await tr.canDecode())) return false;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.master);
    const t = { sink: new AudioBufferSink(tr), gain, offset: sp.offset || 0, from: sp.from ?? null, to: sp.to ?? null };
    this.tracks.set(sp.key, t);
    if (this.playing) this.pump(t, this.gen, Math.max(0, this.time));
    return true;
  }
  remove(key) {
    const t = this.tracks.get(key);
    if (!t) return;
    t.dead = true;
    try { t.gain.disconnect(); } catch (e) { /* ignore */ }
    this.tracks.delete(key);
  }
  // where an added sound sits changed: play on from here with the new placement
  setWindow(key, w) {
    const t = this.tracks.get(key);
    if (!t) return;
    Object.assign(t, w);
    if (this.playing) { const at = this.audible; this.playing = false; this.halt(); this.play(at); }
  }

  has(key) { return this.tracks.has(key); }
  // short exponential ramps so mutes and slider moves don't click
  setGain(key, v) { const t = this.tracks.get(key); if (t) t.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.012); }
  setMaster(v) { this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.012); }

  // How long a sample takes from being scheduled to reaching the speakers. outputLatency only
  // becomes known once audio is flowing, so remember the last real value and use it from then on.
  get latency() {
    const out = this.ctx.outputLatency || 0;
    if (out > 0) knownLatency = (this.ctx.baseLatency || 0) + out;
    return knownLatency;
  }
  // clip time of the sample being handed to the output right now
  get time() { return this.playing ? this.ctx.currentTime - this.startCtx + this.pos : this.pos; }
  // clip time of what is actually coming out of the speakers (latency fixed per play() so the
  // estimate doesn't jump mid-playback)
  get audible() { return this.playing ? this.time - this.lat : this.pos; }

  // Start so that clip time `pos` is heard right now - i.e. in step with a video that starts
  // playing from `pos` at the same moment. The first few tens of milliseconds of audio (the
  // scheduling lead plus the output latency) are skipped to make that possible.
  // `videoLag`: how far behind its own start the video picture runs (about one frame); the
  // audio is held back by that much so both line up from the first frame.
  async play(pos, videoLag = 0) {
    if (this.closed) return;
    if (this.playing && Math.abs(this.audible - pos) < 0.03) return; // already there
    if (this.ctx.state !== 'running') await this.ctx.resume();
    this.halt();
    this.lat = this.latency;
    const skip = LEAD + this.lat - videoLag;
    this.pos = pos + skip;
    this.startCtx = this.ctx.currentTime + LEAD;
    this.playing = true;
    const gen = this.gen;
    for (const t of this.tracks.values()) this.pump(t, gen, Math.max(0, this.pos));
  }
  pause() {
    if (!this.playing) return;
    this.pos = this.audible;
    this.playing = false;
    this.halt();
  }
  seek(pos) { if (this.playing) this.play(pos); else this.pos = pos; }
  halt() {
    this.gen++;
    for (const n of this.nodes) { try { n.stop(); } catch (e) { /* already stopped */ } }
    this.nodes.clear();
  }

  async pump(t, gen, pos) {
    const off = t.offset || 0, from = t.from, to = t.to;
    const fpos = Math.max(from ?? 0, pos + off);
    if (to != null && fpos >= to) return;
    try {
      for await (const { buffer, timestamp } of t.sink.buffers(fpos)) {
        if (gen !== this.gen || t.dead) return;
        if (to != null && timestamp >= to) return;
        // only the part of the buffer inside the sound's window
        const skip = from != null && timestamp < from ? from - timestamp : 0;
        const len = (to != null ? Math.min(buffer.duration, to - timestamp) : buffer.duration) - skip;
        if (len <= 0) continue;
        const when = this.startCtx + (timestamp + skip - off - this.pos);
        const now = this.ctx.currentTime;
        const node = this.ctx.createBufferSource();
        node.buffer = buffer;
        node.connect(t.gain);
        if (when >= now) node.start(when, skip, len);
        else if (now - when < len) node.start(now, skip + now - when, len - (now - when)); // late: skip what already passed
        else { node.disconnect(); continue; }
        this.nodes.add(node);
        node.onended = () => this.nodes.delete(node);
        while (gen === this.gen && timestamp - off - this.time > AHEAD) await sleep(60);
        if (gen !== this.gen) return;
      }
    } catch (e) {
      console.warn('audio track stopped:', e);
    }
  }

  close() {
    this.closed = true;
    this.playing = false;
    this.halt();
    try { this.master.disconnect(); } catch (e) { /* ignore */ }
    for (const i of this.inputs) { try { i.dispose(); } catch (e) { /* ignore */ } }
  }
}

window.ClipAudio = { Session, setListen };
window.dispatchEvent(new Event('clipaudio-ready'));

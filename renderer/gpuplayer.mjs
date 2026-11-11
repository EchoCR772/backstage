// Video player for the quick-trim overlay, built on the graphics card:
// the clip is decoded with WebCodecs (the GPU's video decoder, through Mediabunny) and each frame
// is drawn with WebGPU straight from the decoder's output. Playback follows a clock supplied by
// the caller (the audio engine), so picture and sound stay together.
// Without WebGPU the same frames are drawn with a 2D canvas; if WebCodecs can't decode the file
// at all, open() throws and the caller falls back to a plain <video>.
import { Input, ALL_FORMATS, CustomSource, VideoSampleSink } from './vendor/mediabunny.min.mjs';

const T = window.trimmer;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The compositor (WebGPU): the editor's whole picture in one canvas the size of the view. The clip's
// visible part (crop and zoom) is sampled at the view's own size (several taps when shown at under
// half its size, so a 4K clip doesn't shimmer), then each video track bottom first: its blur boxes (a Gaussian kept inside
// the box, like the export's boxblur on the cropped box), then its texts, pictures, shapes and
// drawings (drawn by fx.mjs on a 2D canvas, uploaded once per change). A blur needs what's under it
// as a texture, so with blur boxes the work happens in an offscreen texture copied to the canvas at
// the end; without, straight in the canvas.
const SHADER = /* wgsl */`
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vfull(@builtin(vertex_index) i: u32) -> VOut {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var o: VOut;
  o.pos = vec4f(p[i], 0, 1);
  o.uv = vec2f((p[i].x + 1) * 0.5, 1 - (p[i].y + 1) * 0.5);
  return o;
}
struct VU { rect: vec4f, taps: vec2f, step: vec2f };
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var vid: texture_external;
@group(0) @binding(2) var<uniform> vu: VU;
@fragment fn fvideo(i: VOut) -> @location(0) vec4f {
  let base = vu.rect.xy + i.uv * vu.rect.zw;
  let nx = i32(vu.taps.x);
  let ny = i32(vu.taps.y);
  var c = vec4f(0);
  for (var y = 0; y < ny; y++) {
    for (var x = 0; x < nx; x++) {
      let o = (vec2f(f32(x), f32(y)) + 0.5 - vu.taps * 0.5) * vu.step;
      c += textureSampleBaseClampToEdge(vid, samp, base + o);
    }
  }
  return vec4f((c / f32(nx * ny)).rgb, 1);
}
@fragment fn fvideo1(i: VOut) -> @location(0) vec4f {
  return vec4f(textureSampleBaseClampToEdge(vid, samp, vu.rect.xy + i.uv * vu.rect.zw).rgb, 1);
}
`;
const SHADER2 = /* wgsl */`
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vfull(@builtin(vertex_index) i: u32) -> VOut {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var o: VOut;
  o.pos = vec4f(p[i], 0, 1);
  o.uv = vec2f((p[i].x + 1) * 0.5, 1 - (p[i].y + 1) * 0.5);
  return o;
}
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
@fragment fn fcopy(i: VOut) -> @location(0) vec4f { return textureSampleLevel(tex, samp, i.uv, 0); }
// box: x0, y0, x1, y1 in pixels; dir (1,0) or (0,1); n taps each side, spaced to cover 3 sigma
struct BU { box: vec4f, dir: vec2f, sigma: f32, n: f32 };
@group(0) @binding(2) var<uniform> bu: BU;
@fragment fn fblur(i: VOut) -> @location(0) vec4f {
  let sz = vec2f(textureDimensions(tex));
  let n = i32(bu.n);
  let gap = bu.sigma * 3.0 / bu.n;
  var sum = vec4f(0);
  var ws = 0.0;
  for (var k = -n; k <= n; k++) {
    let d = f32(k) * gap;
    let w = exp(-0.5 * d * d / (bu.sigma * bu.sigma));
    let q = clamp(i.pos.xy + bu.dir * d, bu.box.xy + 0.5, bu.box.zw - 0.5);
    sum += w * textureSampleLevel(tex, samp, q / sz, 0);
    ws += w;
  }
  return sum / ws;
}
// a blur box shrunk by s (dir.x) before blurring: n x n taps (bilinear, so about 2s x 2s pixels) per
// small pixel, only from inside the box (in full-size pixels)
@fragment fn fdown(i: VOut) -> @location(0) vec4f {
  let sz = vec2f(textureDimensions(tex));
  let s = bu.dir.x;
  let n = i32(bu.n);
  var c = vec4f(0);
  for (var y = 0; y < n; y++) {
    for (var x = 0; x < n; x++) {
      let o = ((vec2f(f32(x), f32(y)) + 0.5) / bu.n - 0.5) * s;
      let q = clamp(i.pos.xy * s + o, bu.box.xy + 0.5, bu.box.zw - 0.5);
      c += textureSampleLevel(tex, samp, q / sz, 0);
    }
  }
  return c / f32(n * n);
}
// and back to full size (box in small pixels)
@fragment fn fup(i: VOut) -> @location(0) vec4f {
  let sz = vec2f(textureDimensions(tex));
  let q = clamp(i.pos.xy / bu.dir.x, bu.box.xy + 0.5, bu.box.zw - 0.5);
  return textureSampleLevel(tex, samp, q / sz, 0);
}
`;
const WORK = 'rgba8unorm';

// one GPU device for the whole app
let gpu = null;
function getGpu() {
  if (!gpu) {
    gpu = (async () => {
      if (!navigator.gpu) return null;
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return null;
      const device = await adapter.requestDevice();
      device.lost.then(() => { gpu = null; });
      const format = navigator.gpu.getPreferredCanvasFormat();
      const m1 = device.createShaderModule({ code: SHADER }), m2 = device.createShaderModule({ code: SHADER2 });
      const pipe = (module, entry, fmt, blend) => device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vfull' },
        fragment: { module, entryPoint: entry, targets: [{ format: fmt, ...(blend ? { blend } : {}) }] },
      });
      const over = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } };
      return {
        device, format,
        // into the work texture (when there's a blur to do) or straight into the canvas
        // (video1: one sample per pixel, the usual case)
        video: pipe(m1, 'fvideo', WORK), video1: pipe(m1, 'fvideo1', WORK), blur: pipe(m2, 'fblur', WORK), down: pipe(m2, 'fdown', WORK), up: pipe(m2, 'fup', WORK), over: pipe(m2, 'fcopy', WORK, over), copy: pipe(m2, 'fcopy', format),
        videoC: pipe(m1, 'fvideo', format), video1C: pipe(m1, 'fvideo1', format), overC: pipe(m2, 'fcopy', format, over),
        sampler: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
      };
    })().catch(() => null);
  }
  return gpu;
}

let painters = 0;
class Painter {
  static async for(canvas) {
    const p = new Painter();
    p.canvas = canvas;
    p.id = ++painters;
    const g = await getGpu();
    if (g) {
      try {
        p.ctx = canvas.getContext('webgpu');
        p.ctx.configure({ device: g.device, format: g.format, alphaMode: 'opaque' });
        p.g = g;
        p.view = null; // { w, h, rect } from fx.mjs; null = the whole clip at the canvas's size
        p.levels = []; // [{ blurs: [{ box, sigma }], tex }]
        p.ubufs = [];
        return p;
      } catch (e) { /* fall through to 2D */ }
    }
    p.ctx2d = canvas.getContext('2d');
    return p;
  }
  get kind() { return this.g ? 'webgpu' : '2d'; }
  draw(frame) {
    if (!this.g) { this.ctx2d.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height); return; }
    // kept for redrawing while paused (a zoom, crop or text changing)
    if (this.frame) this.frame.close();
    this.frame = frame.clone();
    this.render();
  }
  // what to show: the canvas size in pixels and the clip's visible rectangle (0..1 of the clip)
  setView(w, h, rect) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    const v = this.view;
    if (v && v.w === w && v.h === h && v.rect.x === rect.x && v.rect.y === rect.y && v.rect.w === rect.w && v.rect.h === rect.h) return;
    this.view = { w, h, rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h } };
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; this.render(); return; } // resizing blanks the canvas
    this.later();
  }
  // the tracks above the clip, bottom first: blur boxes (0..1 of the view, sigma in pixels) and a
  // canvas of the view's size with the track's drawn layers (or null)
  setLevels(list) {
    const { device } = this.g;
    // a canvas already uploaded keeps its texture
    const had = new Map(this.levels.filter(l => l.canvas).map(l => [l.canvas, l.tex]));
    this.levels = list.map(l => {
      const c = l.canvas && l.canvas.width && l.canvas.height ? l.canvas : null;
      let tex = c ? had.get(c) : null;
      if (c && tex) had.delete(c);
      else if (c) {
        // reuse a texture of the right size that's going away (drawing changes one track many times a second)
        const spare = [...had].find(([k, t]) => t.width === c.width && t.height === c.height && !list.some(x => x.canvas === k));
        if (spare) { tex = spare[1]; had.delete(spare[0]); }
        else tex = device.createTexture({ size: [c.width, c.height], format: WORK, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
        device.queue.copyExternalImageToTexture({ source: c }, { texture: tex, premultipliedAlpha: true }, [c.width, c.height]);
      }
      return { blurs: l.blurs || [], canvas: c, tex };
    });
    for (const t of had.values()) t.destroy();
    this.later();
  }
  // while playing the next video frame draws the change (once per frame, not twice); paused, now
  later() { if (!this.live) this.render(); }
  work(w, h) {
    if (this.wk && this.wk.w === w && this.wk.h === h) return this.wk;
    if (this.wk) { this.wk.a.destroy(); this.wk.b.destroy(); }
    const mk = () => this.g.device.createTexture({ size: [w, h], format: WORK, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
    this.wk = { w, h, a: mk(), b: mk() };
    return this.wk;
  }
  // the shrunk copies of a blur box (two, for the two directions), by size
  small(w, h) {
    if (this.sm && this.sm.w === w && this.sm.h === h) return this.sm;
    if (this.sm) { this.sm.a.destroy(); this.sm.b.destroy(); }
    const mk = () => this.g.device.createTexture({ size: [w, h], format: WORK, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
    this.sm = { w, h, a: mk(), b: mk() };
    return this.sm;
  }
  uniform(i, data) {
    let b = this.ubufs[i];
    if (!b) b = this.ubufs[i] = this.g.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.g.device.queue.writeBuffer(b, 0, new Float32Array(data));
    return b;
  }
  render() {
    if (!this.g || !this.frame) return;
    try { this.renderNow(); } catch (e) { /* a lost device: the next clip gets a new one */ }
  }
  renderNow() {
    const { device, sampler } = this.g, f = this.frame;
    const W = this.canvas.width, H = this.canvas.height;
    const rect = this.view ? this.view.rect : { x: 0, y: 0, w: 1, h: 1 };
    const blurs = this.levels.some(l => l.blurs.length);
    const { a, b } = blurs ? this.work(W, H) : { a: this.ctx.getCurrentTexture(), b: null };
    const P = blurs ? this.g : { video: this.g.videoC, video1: this.g.video1C, over: this.g.overC };
    const enc = device.createCommandEncoder();
    let ub = 0;
    const pass = (target, load, pipeline, entries, scissor) => {
      const ps = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: load ? 'load' : 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
      ps.setPipeline(pipeline);
      ps.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
      if (scissor) ps.setScissorRect(...scissor);
      ps.draw(3);
      ps.end();
    };
    // the clip: a linear sample already averages 2x2 pixels, so more taps only when it's shown at
    // under half its size (a 4K or 1440p clip in the editor), up to 3x3
    const fw = f.displayWidth || W, fh = f.displayHeight || H;
    const rx = rect.w * fw / W, ry = rect.h * fh / H;
    const tx = Math.min(3, Math.max(1, Math.ceil(rx / 2 - 0.01))), ty = Math.min(3, Math.max(1, Math.ceil(ry / 2 - 0.01)));
    pass(a, false, tx * ty > 1 ? P.video : P.video1, [
      { binding: 0, resource: sampler }, { binding: 1, resource: device.importExternalTexture({ source: f }) },
      { binding: 2, resource: { buffer: this.uniform(ub++, [rect.x, rect.y, rect.w, rect.h, tx, ty, rect.w / W / tx, rect.h / H / ty]) } },
    ]);
    for (const l of this.levels) {
      for (const bl of l.blurs) {
        const x0 = Math.max(0, Math.round(bl.box.x * W)), y0 = Math.max(0, Math.round(bl.box.y * H));
        const x1 = Math.min(W, Math.round((bl.box.x + bl.box.w) * W)), y1 = Math.min(H, Math.round((bl.box.y + bl.box.h) * H));
        if (x1 - x0 < 2 || y1 - y0 < 2 || !(bl.sigma > 0.3)) continue;
        // like the browser's own blur: shrink the box so sigma is 3 to 6 small pixels, blur that with
        // taps one pixel apart, then scale it back up (smooth at any strength, and cheap)
        const k = Math.max(1, Math.floor(bl.sigma / 3)), sg = bl.sigma / k, n = Math.ceil(sg * 3);
        const sc = [x0, y0, x1 - x0, y1 - y0];
        const ent = (src, u) => [{ binding: 0, resource: sampler }, { binding: 1, resource: src.createView() }, { binding: 2, resource: { buffer: this.uniform(ub++, u) } }];
        if (k === 1) {
          pass(b, false, this.g.blur, ent(a, [x0, y0, x1, y1, 1, 0, sg, n]), sc);
          pass(a, true, this.g.blur, ent(b, [x0, y0, x1, y1, 0, 1, sg, n]), sc);
          continue;
        }
        const sw = Math.ceil(W / k), sh = Math.ceil(H / k), sm = this.small(sw, sh);
        const s0x = Math.floor(x0 / k), s0y = Math.floor(y0 / k), s1x = Math.min(sw, Math.ceil(x1 / k)), s1y = Math.min(sh, Math.ceil(y1 / k));
        const ssc = [s0x, s0y, s1x - s0x, s1y - s0y], sb = [x0 / k, y0 / k, x1 / k, y1 / k];
        pass(sm.a, false, this.g.down, ent(a, [x0, y0, x1, y1, k, 0, 0, Math.min(4, Math.ceil(k / 2))]), ssc);
        pass(sm.b, false, this.g.blur, ent(sm.a, [...sb, 1, 0, sg, n]), ssc);
        pass(sm.a, false, this.g.blur, ent(sm.b, [...sb, 0, 1, sg, n]), ssc);
        pass(a, true, this.g.up, ent(sm.a, [...sb, k, 0, 0, 0]), sc);
      }
      if (l.tex) pass(a, true, P.over, [{ binding: 0, resource: sampler }, { binding: 1, resource: l.tex.createView() }]);
    }
    if (blurs) pass(this.ctx.getCurrentTexture(), false, this.g.copy, [{ binding: 0, resource: sampler }, { binding: 1, resource: a.createView() }]);
    device.queue.submit([enc.finish()]);
    this.drawn = (this.drawn || 0) + 1;
  }
  close() {
    if (this.frame) { this.frame.close(); this.frame = null; }
    for (const l of this.levels || []) if (l.tex) l.tex.destroy();
    this.levels = [];
    if (this.wk) { this.wk.a.destroy(); this.wk.b.destroy(); this.wk = null; }
    if (this.sm) { this.sm.a.destroy(); this.sm.b.destroy(); this.sm = null; }
    for (const b of this.ubufs || []) b.destroy();
    this.ubufs = [];
  }
}

export class GpuPlayer {
  static async open(path, canvas) {
    const input = new Input({
      formats: ALL_FORMATS,
      source: new CustomSource({ getSize: () => T.fileSize(path), read: (a, b) => T.readRange(path, a, b), prefetchProfile: 'fileSystem' }),
    });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track || !(await track.canDecode())) throw new Error("This video can't be decoded on the graphics card.");
      const p = new GpuPlayer();
      p.input = input;
      p.track = track;
      p.width = track.displayWidth;
      p.height = track.displayHeight;
      canvas.width = p.width;
      canvas.height = p.height;
      p.painter = await Painter.for(canvas);
      p.seekSink = new VideoSampleSink(track);
      p.gen = 0;
      p.queue = [];
      p.want = null;
      p.seeking = false;
      return p;
    } catch (e) {
      try { input.dispose(); } catch (err) { /* ignore */ }
      throw e;
    }
  }

  get renderer() { return this.painter.kind; }
  // the compositor (WebGPU only): fx.mjs hands it the view and the tracks above the clip
  get compositor() { return this.painter.g ? this.painter : null; }

  // show the frame at time t; while one is being found, newer requests replace older ones
  async show(t) {
    this.want = t;
    if (this.seeking) return;
    this.seeking = true;
    try {
      while (this.want !== null) {
        const at = this.want;
        this.want = null;
        const s = await this.seekSink.getSample(at);
        if (s && this.want === null && !this.playing) {
          const f = s.toVideoFrame();
          this.painter.draw(f);
          f.close();
        }
        if (s) s.close();
      }
    } catch (e) { /* a frame that fails to decode just isn't shown */ } finally { this.seeking = false; }
  }

  // play from `from`, showing whichever frame is due according to clock()
  play(clock, from) {
    this.stop();
    const gen = ++this.gen;
    this.playing = true;
    this.painter.live = true;
    this.want = null;
    const sink = new VideoSampleSink(this.track);
    const queue = this.queue = [];
    let ended = false;
    (async () => {
      try {
        for await (const s of sink.samples(Math.max(0, from))) {
          if (gen !== this.gen) { s.close(); return; }
          queue.push(s);
          while (queue.length >= 8 && gen === this.gen) await new Promise(r => { this.wake = r; });
          if (gen !== this.gen) return;
        }
      } catch (e) { /* stop decoding; the last frame stays up */ }
      ended = true;
    })();
    const tick = () => {
      if (gen !== this.gen) return;
      const t = clock();
      let freed = false;
      while (queue.length > 1 && queue[1].timestamp <= t) { queue.shift().close(); freed = true; }
      if (freed && this.wake) { const w = this.wake; this.wake = null; w(); }
      const s = queue[0];
      if (s && s.timestamp <= t + 0.004 && !s._shown) {
        const f = s.toVideoFrame();
        this.painter.draw(f);
        f.close();
        s._shown = true;
        this.lastShown = s.timestamp;
      }
      if (!ended || queue.length) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  stop() {
    this.gen++;
    this.playing = false;
    if (this.painter.live) { this.painter.live = false; this.painter.render(); } // the last view and tracks
    if (this.wake) { const w = this.wake; this.wake = null; w(); } // let the decode loop see it's stopped and end
    for (const s of this.queue) s.close();
    this.queue = [];
  }

  // small pictures across the clip for the timeline; calls draw(i, sample) as each is decoded
  async thumbnails(times, draw) {
    const sink = new VideoSampleSink(this.track);
    const gen = this.gen;
    let i = 0;
    try {
      for await (const s of sink.samplesAtTimestamps(times)) {
        if (this.closed) { if (s) s.close(); return; }
        if (s) { draw(i, s); s.close(); }
        i++;
        if (gen !== this.gen && this.playing) await sleep(30); // give playback room
      }
    } catch (e) {
      if (this.closed) return; // closing disposes the input mid-decode (InputDisposedError): nothing to report
      throw e;
    }
  }

  close() {
    this.closed = true;
    this.stop();
    this.painter.close && this.painter.close();
    try { this.input.dispose(); } catch (e) { /* ignore */ }
  }
}

// Fallback with the same shape, for files WebCodecs can't decode: a plain <video> that follows
// the clock (muted; the audio engine plays the sound).
export class ElementPlayer {
  static async open(url, video) {
    const p = new ElementPlayer();
    p.v = video;
    video.muted = true;
    video.src = url;
    await new Promise((resolve, reject) => {
      video.addEventListener('loadedmetadata', resolve, { once: true });
      video.addEventListener('error', () => reject(new Error("This video can't be played.")), { once: true });
    });
    p.width = video.videoWidth; p.height = video.videoHeight;
    p.gen = 0;
    return p;
  }
  get renderer() { return 'video'; }
  show(t) { if (!this.playing) this.v.currentTime = t; }
  play(clock, from) {
    const gen = ++this.gen;
    this.playing = true;
    this.v.currentTime = from;
    this.v.play().catch(() => {});
    const tick = () => {
      if (gen !== this.gen) return;
      const diff = this.v.currentTime - clock();
      if (Math.abs(diff) > 0.15) this.v.currentTime = clock();
      else this.v.playbackRate = Math.abs(diff) > 0.03 ? (diff > 0 ? 0.97 : 1.03) : 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  stop() { this.gen++; this.playing = false; this.v.pause(); this.v.playbackRate = 1; }
  async thumbnails() { /* the plain player doesn't make timeline pictures */ }
  close() { this.stop(); this.v.removeAttribute('src'); this.v.load(); }
}

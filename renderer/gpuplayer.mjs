// Video player for the quick-trim overlay, built on the graphics card:
// the clip is decoded with WebCodecs (the GPU's video decoder, through Mediabunny) and each frame
// is drawn with WebGPU straight from the decoder's output. Playback follows a clock supplied by
// the caller (the audio engine), so picture and sound stay together.
// Without WebGPU the same frames are drawn with a 2D canvas; if WebCodecs can't decode the file
// at all, open() throws and the caller falls back to a plain <video>.
import { Input, ALL_FORMATS, CustomSource, VideoSampleSink } from './vendor/mediabunny.min.mjs';

const T = window.trimmer;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SHADER = /* wgsl */`
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vfull(@builtin(vertex_index) i: u32) -> VOut {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var o: VOut;
  o.pos = vec4f(p[i], 0, 1);
  o.uv = vec2f((p[i].x + 1) * 0.5, 1 - (p[i].y + 1) * 0.5);
  return o;
}
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var vid: texture_external;
@fragment fn fvideo(i: VOut) -> @location(0) vec4f { return textureSampleBaseClampToEdge(vid, samp, i.uv); }
`;

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
      const module = device.createShaderModule({ code: SHADER });
      const pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vfull' },
        fragment: { module, entryPoint: 'fvideo', targets: [{ format }] },
      });
      const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
      return { device, format, pipeline, sampler };
    })().catch(() => null);
  }
  return gpu;
}

class Painter {
  static async for(canvas) {
    const p = new Painter();
    p.canvas = canvas;
    const g = await getGpu();
    if (g) {
      try {
        p.ctx = canvas.getContext('webgpu');
        p.ctx.configure({ device: g.device, format: g.format, alphaMode: 'opaque' });
        p.g = g;
        return p;
      } catch (e) { /* fall through to 2D */ }
    }
    p.ctx2d = canvas.getContext('2d');
    return p;
  }
  get kind() { return this.g ? 'webgpu' : '2d'; }
  draw(frame) {
    if (!this.g) { this.ctx2d.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height); return; }
    const { device, pipeline, sampler } = this.g;
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    const bind = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: sampler }, { binding: 1, resource: device.importExternalTexture({ source: frame }) }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
    device.queue.submit([enc.finish()]);
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

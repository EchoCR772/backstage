// Smart cut: a trim that's ready in a fraction of a second at the original quality.
// Only the bit from the start point to the next keyframe is re-encoded (at most a second or so
// for NVIDIA and Discord clips); everything after it is copied as it is. The two pieces are joined
// as MPEG-TS (which carries the codec settings inside the stream, so the re-encoded piece and the
// copied piece can each have their own) and then put back into an mp4 with the audio.
// If anything about the result looks off, the caller falls back to a normal full encode.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

let mbLoading = null;
const mediabunny = () => mbLoading || (mbLoading = import(pathToFileURL(path.join(__dirname, 'renderer', 'vendor', 'mediabunny.min.mjs')).href));

// Plan how to cut [start, end): which whole GOPs can be copied (from the first keyframe at or after
// the start to the last keyframe before the end) and how much has to be encoded on either side.
// Times are on the same timeline ffmpeg uses. Returns null when a smart cut isn't possible or
// isn't worth it (then the caller encodes it all).
async function plan(file, info, start, end) {
  if (!/^h264/i.test(info.codec || '')) return null; // the encoded pieces have to match the copied part
  const frame = 1 / (info.fps || 30);
  let mb, fd;
  try {
    mb = await mediabunny();
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const source = new mb.StreamSource({
      getSize: () => size,
      read: (a, b) => { const buf = Buffer.alloc(b - a); const n = fs.readSync(fd, buf, 0, b - a, a); return new Uint8Array(buf.buffer, buf.byteOffset, n); },
    });
    const input = new mb.Input({ source, formats: mb.ALL_FORMATS });
    const v = await input.getPrimaryVideoTrack();
    if (!v || v.codec !== 'avc') return null;
    const sink = new mb.EncodedPacketSink(v);
    const meta = { metadataOnly: true };
    // copied from the first keyframe at or after the start...
    const a0 = await sink.getKeyPacket(start + frame / 2, meta);
    if (!a0) return null;
    const a = Math.abs(a0.timestamp - start) < frame / 2 ? a0 : await sink.getNextKeyPacket(a0, meta);
    if (!a) return null;
    // ...up to the last keyframe before the end. A copy can't stop between keyframes cleanly, so the
    // last bit is encoded too - unless the end is right on a keyframe, or it's the end of the clip.
    const atEnd = end >= (info.duration || Infinity) - frame / 2;
    const b = atEnd ? null : await sink.getKeyPacket(end + frame / 2, meta);
    const copyFrom = a.timestamp, copyTo = atEnd ? end : b.timestamp;
    if (!(copyTo - copyFrom >= 0.5)) return null; // short trims: nothing much to copy
    if (copyFrom - start > 5 || end - copyTo > 5) return null; // keyframes far apart: a normal encode is as quick
    // how many packets the copied part has (whole GOPs, so counting in decode order is exact)
    let frames = 0;
    for await (const _p of sink.packets(a, b || undefined, meta)) frames++; // eslint-disable-line no-unused-vars
    if (!frames) return null;
    return { copyFrom, copyTo, frames, head: Math.max(0, copyFrom - start), tail: Math.max(0, end - copyTo) };
  } catch (e) { return null; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) { /* ignore */ } } }
}

// Make the video of [start, end) into `out` (MPEG-TS pieces in `work`), then mux with the audio
// args from the caller. run(args, length) runs ffmpeg and resolves { ok, err, cancelled }.
// headArgs(kbps): video encoder args for the re-encoded head. audio: { inputs, args } built by the
// caller for the final mux (its inputs come after the video input, so they're numbered from 1).
async function cut({ src, info, start, end, p, out, work, run, headArgs, audio, progress, avIn = [], extra = [] }) {
  fs.mkdirSync(work, { recursive: true });
  const length = end - start, frame = 1 / (info.fps || 30);
  const quiet = ['-y', '-hide_banner', '-loglevel', 'error'];
  // re-encoded pieces (before the first copied keyframe, after the last one), matched to the original
  const encode = async (from, len, offset, name) => {
    const f = path.join(work, name);
    // frames from `from` (a quarter frame early, so a frame whose time is a hair before it isn't lost)
    const r = await run([...quiet, ...avIn, '-ss', Math.max(0, from - frame / 4).toFixed(6), '-i', src, '-t', Math.max(0.001, len).toFixed(6),
      '-map', '0:v:0', '-fps_mode', 'passthrough', ...headArgs, '-bf', '0', '-profile:v', 'high', '-an', '-output_ts_offset', offset.toFixed(6), '-f', 'mpegts', f], len);
    return r;
  };
  // the three pieces don't depend on each other, so they're made at the same time
  const mid = path.join(work, 'mid.ts');
  const jobs = [];
  if (p.head > frame / 2) jobs.push(encode(start, p.head, 0, 'head.ts'));
  // the middle is copied as it is (whole GOPs, counted exactly), on the clip's own timeline shifted to the trim
  jobs.push(run([...quiet, '-copyts', '-ss', (p.copyFrom + 0.0005).toFixed(6), '-i', src, '-frames:v', String(p.frames),
    '-map', '0:v:0', '-c', 'copy', '-avoid_negative_ts', 'disabled', '-output_ts_offset', (-start).toFixed(6),
    '-bsf:v', 'h264_mp4toannexb', '-an', '-f', 'mpegts', mid], p.copyTo - p.copyFrom));
  if (p.tail > frame / 2) jobs.push(encode(p.copyTo, p.tail, p.copyTo - start, 'tail.ts'));
  const done = await Promise.all(jobs);
  const bad = done.find(r => !r.ok);
  if (bad) return bad;
  const parts = [p.head > frame / 2 && path.join(work, 'head.ts'), mid, p.tail > frame / 2 && path.join(work, 'tail.ts')].filter(Boolean);
  if (progress) progress(0.5);
  return run([...quiet, '-progress', 'pipe:1', '-nostats', '-i', 'concat:' + parts.join('|'), ...audio.inputs,
    '-map', '0:v:0', ...audio.maps, '-c:v', 'copy', ...audio.args, ...(extra.includes('-movflags') ? extra : [...extra, '-movflags', '+faststart']), out], length);
}

module.exports = { plan, cut };

// Proving an AAC track silent without decoding it.
//
// An AAC-LC frame whose every channel has max_sfb = 0 carries no spectral data at all, so the decoder
// can only output exact zeros for it (and the overlap it hands the next frame is zero too). If every
// frame of a track is like that, the decoded track is exactly 0 from start to end: the same answer a
// full decode gives, from a few kilobytes of the file instead of the whole thing.
//
// Anything the parser isn't sure of (another codec, SBR, a frame with spectral bands, pulse or TNS
// data, a channel layout from a PCE, a fragmented file) makes the track "unknown", never "silent":
// unknown tracks go through the full decode. So this can only ever speed an answer up, not change it.
'use strict';
const fs = require('fs');

const GAP = 16 << 10; // read through gaps this small (a moment's tracks sit together between video frames)

class Bits {
  constructor(b) { this.b = b; this.p = 0; this.n = b.length * 8; }
  left() { return this.n - this.p; }
  read(k) {
    if (k > this.left()) throw new Error('short');
    let v = 0;
    for (let i = 0; i < k; i++, this.p++) v = (v << 1) | ((this.b[this.p >> 3] >> (7 - (this.p & 7))) & 1);
    return v >>> 0;
  }
  skip(k) { if (k > this.left()) throw new Error('short'); this.p += k; }
  align() { this.p = (this.p + 7) & ~7; }
}

// ics_info: true when the channel (or the pair sharing it) has no scalefactor bands
function emptyIcsInfo(r) {
  r.read(1); // ics_reserved_bit
  const seq = r.read(2);
  r.read(1); // window_shape
  if (seq === 2) { // eight short windows
    const maxSfb = r.read(4);
    r.read(7); // scale_factor_grouping
    return maxSfb === 0;
  }
  const maxSfb = r.read(6);
  if (r.read(1)) return false; // predictor data: not AAC-LC
  return maxSfb === 0;
}
function emptyIcs(r, common) {
  r.read(8); // global_gain
  if (!common && !emptyIcsInfo(r)) return false;
  // section and scalefactor data are empty with no bands
  if (r.read(1)) return false; // pulse data
  if (r.read(1)) return false; // TNS data
  if (r.read(1)) return false; // gain control (AAC SSR)
  return true; // no spectral data
}
// one raw_data_block: true only when it can only decode to zeros
function silentFrame(buf) {
  try {
    const r = new Bits(buf);
    let channels = 0;
    for (let n = 0; n < 64; n++) {
      const id = r.read(3);
      if (id === 7) return channels > 0; // ID_END
      if (id === 0 || id === 3) { // SCE, LFE
        r.read(4);
        if (!emptyIcs(r, false)) return false;
        channels++;
      } else if (id === 1) { // CPE
        r.read(4);
        const common = r.read(1);
        if (common) {
          if (!emptyIcsInfo(r)) return false;
          if (r.read(2) === 3) return false; // ms_mask_present 3 is reserved
          // the M/S mask has one bit per band: none
        }
        if (!emptyIcs(r, common === 1)) return false;
        if (!emptyIcs(r, common === 1)) return false;
        channels += 2;
      } else if (id === 4) { // DSE: data only, never sound
        r.read(4);
        const align = r.read(1);
        let count = r.read(8);
        if (count === 255) count += r.read(8);
        if (align) r.align();
        r.skip(count * 8);
      } else if (id === 6) { // FIL: plain fill only (SBR or other extensions could make sound)
        let count = r.read(4);
        if (count === 15) count += r.read(8) - 1;
        if (count > 0) {
          const type = r.read(4);
          if (type !== 0 && type !== 1) return false; // EXT_FILL, EXT_FILL_DATA
          r.skip(count * 8 - 4);
        }
      } else return false; // CCE, PCE
    }
    return false;
  } catch (e) { return false; }
}

// ---------- MP4 ----------
function boxes(b, from, to) {
  const out = [];
  for (let o = from; o + 8 <= to;) {
    let len = b.readUInt32BE(o), hdr = 8;
    if (len === 1) { if (o + 16 > to) break; len = Number(b.readBigUInt64BE(o + 8)); hdr = 16; } else if (len === 0) len = to - o;
    if (len < hdr || o + len > to) break;
    out.push({ type: b.toString('latin1', o + 4, o + 8), at: o, start: o + hdr, end: o + len });
    o += len;
  }
  return out;
}
const child = (b, box, type) => boxes(b, box.start, box.end).find(x => x.type === type);
const path = (b, box, ...types) => types.reduce((x, t) => x && child(b, x, t), box);

// The AudioSpecificConfig inside esds: AAC-LC with 1 to 7 channels and no SBR/PS signalled.
function plainLc(b, esds) {
  let o = esds.start + 4;
  const end = esds.end;
  const desc = () => {
    const tag = b[o++];
    let len = 0;
    for (let i = 0; i < 4; i++) { const c = b[o++]; len = (len << 7) | (c & 0x7f); if (!(c & 0x80)) break; }
    return { tag, len, at: o };
  };
  try {
    let d = desc();
    if (d.tag !== 3) return false;
    o += 2;
    const fl = b[o++];
    if (fl & 0x80) o += 2;
    if (fl & 0x40) o += 1 + b[o];
    if (fl & 0x20) o += 2;
    d = desc();
    if (d.tag !== 4 || b[o] !== 0x40) return false; // MPEG-4 audio
    o += 13;
    d = desc();
    if (d.tag !== 5 || d.at + d.len > end) return false;
    const r = new Bits(b.subarray(d.at, d.at + d.len));
    if (r.read(5) !== 2) return false; // AAC-LC only
    if (r.read(4) === 15) r.read(24);
    const ch = r.read(4);
    if (ch < 1 || ch > 7) return false; // 0 = layout from a PCE
    r.read(1); // frameLengthFlag
    if (r.read(1)) return false; // dependsOnCoreCoder
    if (r.read(1)) return false; // extensionFlag
    // a sync extension after it (ffmpeg always writes one) must say "no SBR"
    if (r.left() >= 16 && r.read(11) === 0x2b7) {
      const ext = r.read(5);
      if (ext !== 5 || r.read(1) !== 0) return false;
    }
    return true;
  } catch (e) { return false; }
}

// Sample positions from stbl: [{ off, size }] in decoding order, or null.
function samples(b, stbl) {
  const stsz = child(b, stbl, 'stsz'), stsc = child(b, stbl, 'stsc');
  const stco = child(b, stbl, 'stco'), co64 = child(b, stbl, 'co64');
  if (!stsz || !stsc || !(stco || co64)) return null;
  const fixed = b.readUInt32BE(stsz.start + 4), count = b.readUInt32BE(stsz.start + 8);
  const size = i => fixed || b.readUInt32BE(stsz.start + 12 + i * 4);
  if (!fixed && stsz.start + 12 + count * 4 > stsz.end) return null;
  const co = stco || co64, nChunks = b.readUInt32BE(co.start + 4);
  const chunk = i => co64 ? Number(b.readBigUInt64BE(co.start + 8 + i * 8)) : b.readUInt32BE(co.start + 8 + i * 4);
  if (co.start + 8 + nChunks * (co64 ? 8 : 4) > co.end) return null;
  const nSc = b.readUInt32BE(stsc.start + 4);
  if (stsc.start + 8 + nSc * 12 > stsc.end || !nSc) return null;
  const out = [];
  let s = 0;
  for (let e = 0; e < nSc; e++) {
    const first = b.readUInt32BE(stsc.start + 8 + e * 12) - 1, per = b.readUInt32BE(stsc.start + 12 + e * 12);
    const last = e + 1 < nSc ? b.readUInt32BE(stsc.start + 20 + e * 12) - 1 : nChunks;
    for (let c = first; c < last && c < nChunks; c++) {
      let off = chunk(c);
      for (let k = 0; k < per && s < count; k++, s++) { const z = size(s); out.push({ off, size: z }); off += z; }
    }
  }
  return s === count ? out : null;
}

// Every audio track of an MP4, in order (index = ffmpeg's 0:a:N): true when proven silent, null when
// it has to be decoded to know. Reads the index (moov) and the audio frames only.
async function provenSilent(file) {
  let fh;
  try { fh = await fs.promises.open(file, 'r'); } catch (e) { return null; }
  try {
    const size = (await fh.stat()).size, head = Buffer.alloc(16);
    let moov = null;
    for (let pos = 0, n = 0; n < 64 && pos + 8 <= size; n++) {
      if ((await fh.read(head, 0, 16, pos)).bytesRead < 8) break;
      let len = head.readUInt32BE(0), hdr = 8;
      if (len === 1) { len = Number(head.readBigUInt64BE(8)); hdr = 16; } else if (len === 0) len = size - pos;
      if (len < hdr || pos + len > size) break;
      if (head.toString('latin1', 4, 8) === 'moov') { moov = { pos, len }; break; }
      pos += len;
    }
    if (!moov || moov.len > 64 << 20) return null;
    const b = Buffer.alloc(moov.len);
    await fh.read(b, 0, moov.len, moov.pos);
    const top = { start: 8, end: b.length };
    if (child(b, top, 'mvex')) return null; // fragmented: samples aren't in the index
    const tracks = [];
    for (const trak of boxes(b, top.start, top.end).filter(x => x.type === 'trak')) {
      const mdia = child(b, trak, 'mdia'), hdlr = mdia && child(b, mdia, 'hdlr');
      if (!hdlr || b.toString('latin1', hdlr.start + 8, hdlr.start + 12) !== 'soun') continue;
      const stbl = path(b, mdia, 'minf', 'stbl'), stsd = stbl && child(b, stbl, 'stsd');
      let ok = false, list = null;
      if (stsd && b.readUInt32BE(stsd.start + 4) === 1) {
        const entry = boxes(b, stsd.start + 8, stsd.end)[0];
        if (entry && entry.type === 'mp4a') {
          const ver = b.readUInt16BE(entry.start + 8);
          const esds = boxes(b, entry.start + 28 + (ver === 1 ? 16 : ver === 2 ? 36 : 0), entry.end).find(x => x.type === 'esds');
          ok = !!esds && plainLc(b, esds);
        }
        if (ok) list = samples(b, stbl);
      }
      tracks.push(ok && list && list.length ? list : null);
    }
    const result = tracks.map(t => (t ? true : null));
    // check these frames ([off, size, track]): reads runs of nearby frames, several at once
    const check = async list => {
      list.sort((x, y) => x[0] - y[0]);
      const runs = [];
      for (let i = 0; i < list.length;) {
        let j = i, end = list[i][0] + list[i][1];
        while (j + 1 < list.length && list[j + 1][0] - end <= GAP && list[j + 1][0] + list[j + 1][1] - list[i][0] <= 1 << 20) {
          j++; end = Math.max(end, list[j][0] + list[j][1]);
        }
        runs.push([i, j, end]);
        i = j + 1;
      }
      let next = 0;
      const worker = async () => {
        while (next < runs.length && result.includes(true)) {
          const [i, j, end] = runs[next++];
          let need = false;
          for (let k = i; k <= j && !need; k++) need = result[list[k][2]] === true;
          if (!need) continue;
          const at = list[i][0], buf = Buffer.allocUnsafe(end - at);
          const got = (await fh.read(buf, 0, buf.length, at)).bytesRead;
          for (let k = i; k <= j; k++) {
            const [off, sz, t] = list[k];
            if (result[t] !== true) continue;
            if (off - at + sz > got || !sz || !silentFrame(buf.subarray(off - at, off - at + sz))) result[t] = null;
          }
        }
      };
      await Promise.all(Array.from({ length: 8 }, worker));
    };
    const frames = (from, to) => {
      const out = [];
      tracks.forEach((t, i) => { if (t && result[i] === true) for (let s = from; s < Math.min(to, t.length); s++) out.push([t[s].off, t[s].size, i]); });
      return out;
    };
    // a track with sound nearly always shows it in its first frames: rule those out first, so the
    // full pass only reads the tracks that may be silent
    const FIRST = 96;
    await check(frames(0, FIRST));
    if (result.includes(true)) await check(frames(FIRST, Infinity));
    return result;
  } catch (e) { return null; } finally { try { await fh.close(); } catch (e) { /* ignore */ } }
}

module.exports = { provenSilent, silentFrame };

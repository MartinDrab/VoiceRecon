// Headers of the audio files that are read piece by piece (see media.js): how the audio is encoded
// and where it is in the file. No imports, so test/ui.test.js can run it in Node.

const text = (bytes, at, n) => String.fromCharCode(...bytes.subarray(at, at + n));

/** The boxes inside bytes[start, end) of an MP4 file: [{ type, start, end }] with start at the payload. */
function boxes(bytes, start, end) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  for (let pos = start; pos + 8 <= end;) {
    let size = view.getUint32(pos);
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) break;
    out.push({ type: text(bytes, pos + 4, 4), start: pos + header, end: pos + size });
    pos += size;
  }
  return out;
}

const child = (bytes, box, type) => (box ? boxes(bytes, box.start, box.end).find((b) => b.type === type) : undefined);

/** An MPEG-4 descriptor at `at`: { tag, start, end } (start at its payload). */
function descriptor(bytes, at) {
  let size = 0;
  let i = at + 1;
  for (let n = 0; n < 4; n++) {
    const b = bytes[i++];
    size = (size << 7) | (b & 0x7f);
    if (!(b & 0x80)) break;
  }
  return { tag: bytes[at], start: i, end: i + size };
}

/** The AAC decoder configuration (AudioSpecificConfig) in an 'esds' box, or null. */
function aacConfig(bytes, esds) {
  let d = descriptor(bytes, esds.start + 4); // after version and flags
  if (d.tag !== 0x03) return null; // ES_Descriptor
  const flags = bytes[d.start + 2]; // after ES_ID: stream dependence, URL, OCR stream
  let at = d.start + 3;
  if (flags & 0x80) at += 2;
  if (flags & 0x40) at += 1 + bytes[at];
  if (flags & 0x20) at += 2;
  d = descriptor(bytes, at);
  if (d.tag !== 0x04 || bytes[d.start] !== 0x40) return null; // DecoderConfigDescriptor of MPEG-4 audio
  at = d.start + 13;
  const info = descriptor(bytes, at);
  return info.tag === 0x05 && info.end <= bytes.length ? bytes.slice(info.start, info.end) : null;
}

/** The first 'esds' box anywhere inside bytes[start, end) (QuickTime files wrap it in a 'wave' box). */
function findEsds(bytes, start, end) {
  for (const box of boxes(bytes, start, end)) {
    if (box.type === 'esds') return box;
    if (box.type === 'wave') {
      const inner = findEsds(bytes, box.start, box.end);
      if (inner) return inner;
    }
  }
  return null;
}

/**
 * The first audio track of an MP4, M4A or MOV file, from the payload of its 'moov' box: the AAC
 * decoder settings (for WebCodecs) and, for every encoded frame, its place in the file and its
 * start time. Null when there is no AAC track, or the file is fragmented (no sample table).
 * @param {Uint8Array} moov
 * @returns {{ codec: string, description: Uint8Array, sampleRate: number, channels: number,
 *   duration: number, offsets: Float64Array, sizes: Uint32Array, starts: Float64Array } | null}
 */
export function parseMp4Audio(moov) {
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  for (const trak of boxes(moov, 0, moov.length).filter((b) => b.type === 'trak')) {
    const mdia = child(moov, trak, 'mdia');
    const hdlr = child(moov, mdia, 'hdlr');
    if (!hdlr || text(moov, hdlr.start + 8, 4) !== 'soun') continue;
    const mdhd = child(moov, mdia, 'mdhd');
    const stbl = child(moov, child(moov, mdia, 'minf'), 'stbl');
    const stsd = child(moov, stbl, 'stsd');
    const stsz = child(moov, stbl, 'stsz');
    const stsc = child(moov, stbl, 'stsc');
    const stts = child(moov, stbl, 'stts');
    const stco = child(moov, stbl, 'stco') || child(moov, stbl, 'co64');
    if (!mdhd || !stsd || !stsz || !stsc || !stts || !stco) return null;

    const v1 = moov[mdhd.start] === 1;
    const timescale = view.getUint32(mdhd.start + (v1 ? 20 : 12));
    const length = v1 ? Number(view.getBigUint64(mdhd.start + 24)) : view.getUint32(mdhd.start + 16);

    // The sample entry: 'mp4a' with channel count and rate; QuickTime versions 1 and 2 add fields.
    const entry = stsd.start + 8;
    const entryEnd = entry + view.getUint32(entry);
    if (text(moov, entry + 4, 4) !== 'mp4a') return null;
    const version = view.getUint16(entry + 16);
    const channels = view.getUint16(entry + 24);
    const sampleRate = view.getUint32(entry + 32) >>> 16;
    const esds = findEsds(moov, entry + 36 + (version === 1 ? 16 : version === 2 ? 36 : 0), entryEnd);
    const description = esds && aacConfig(moov, esds);
    if (!description || !description.length) return null;
    let objectType = description[0] >> 3;
    if (objectType === 31) objectType = 32 + (((description[0] & 7) << 3) | (description[1] >> 5));

    // Where each frame is: sizes (stsz), chunk offsets (stco/co64), frames per chunk (stsc).
    const fixedSize = view.getUint32(stsz.start + 4);
    const count = view.getUint32(stsz.start + 8);
    if (!count) return null;
    const sizes = new Uint32Array(count);
    for (let i = 0; i < count; i++) sizes[i] = fixedSize || view.getUint32(stsz.start + 12 + 4 * i);
    const chunks = view.getUint32(stco.start + 4);
    const wide = stco.type === 'co64'; // 64-bit offsets, in files over 4 GB
    const chunkOffset = (c) => (wide ? Number(view.getBigUint64(stco.start + 8 + 8 * c)) : view.getUint32(stco.start + 8 + 4 * c));
    const runs = view.getUint32(stsc.start + 4);
    const offsets = new Float64Array(count);
    let sample = 0;
    for (let r = 0; r < runs && sample < count; r++) {
      const firstChunk = view.getUint32(stsc.start + 8 + 12 * r) - 1;
      const perChunk = view.getUint32(stsc.start + 12 + 12 * r);
      const nextChunk = r + 1 < runs ? view.getUint32(stsc.start + 8 + 12 * (r + 1)) - 1 : chunks;
      for (let c = firstChunk; c < nextChunk && sample < count; c++) {
        let at = chunkOffset(c);
        for (let k = 0; k < perChunk && sample < count; k++) {
          offsets[sample] = at;
          at += sizes[sample++];
        }
      }
    }
    if (sample < count) return null;

    // When each frame starts (stts: runs of frames with the same duration).
    const starts = new Float64Array(count);
    let time = 0;
    sample = 0;
    const entries = view.getUint32(stts.start + 4);
    for (let e = 0; e < entries; e++) {
      const n = view.getUint32(stts.start + 8 + 8 * e);
      const delta = view.getUint32(stts.start + 12 + 8 * e);
      for (let k = 0; k < n && sample < count; k++) {
        starts[sample++] = time / timescale;
        time += delta;
      }
    }
    for (; sample < count; sample++) starts[sample] = time / timescale;

    return {
      codec: `mp4a.40.${objectType}`,
      description,
      sampleRate,
      channels,
      duration: length / timescale,
      offsets,
      sizes,
      starts,
    };
  }
  return null;
}

/**
 * Where the samples of a WAV file are, from its first bytes (64 KB is plenty), or null when it is
 * not a WAV file that can be read piece by piece (PCM 8/16/24/32-bit or float 32/64-bit).
 * @param {Uint8Array} head
 * @param {number} fileSize
 * @returns {{ float: boolean, bits: number, channels: number, sampleRate: number, blockAlign: number,
 *   dataStart: number, dataBytes: number } | null}
 */
export function parseWavHeader(head, fileSize) {
  if (head.length < 12 || text(head, 0, 4) !== 'RIFF' || text(head, 8, 4) !== 'WAVE') return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let fmt = null;
  for (let pos = 12; pos + 8 <= head.length;) {
    const id = text(head, pos, 4);
    const size = view.getUint32(pos + 4, true);
    const start = pos + 8;
    if (id === 'fmt ' && start + 16 <= head.length) {
      let format = view.getUint16(start, true);
      if (format === 0xfffe && start + 26 <= head.length) format = view.getUint16(start + 24, true); // WAVE_FORMAT_EXTENSIBLE
      fmt = {
        float: format === 3,
        pcm: format === 1,
        channels: view.getUint16(start + 2, true),
        sampleRate: view.getUint32(start + 4, true),
        bits: view.getUint16(start + 14, true),
      };
    } else if (id === 'data') {
      if (!fmt || !fmt.channels || !fmt.sampleRate) return null;
      const ok = (fmt.pcm && [8, 16, 24, 32].includes(fmt.bits)) || (fmt.float && [32, 64].includes(fmt.bits));
      if (!ok) return null;
      const blockAlign = (fmt.bits / 8) * fmt.channels;
      const rest = fileSize - start;
      // Streamed files may leave the size at 0 or at the maximum: the rest of the file is the data.
      const bytes = size > 0 && size <= rest ? size : rest;
      return {
        float: fmt.float,
        bits: fmt.bits,
        channels: fmt.channels,
        sampleRate: fmt.sampleRate,
        blockAlign,
        dataStart: start,
        dataBytes: bytes - (bytes % blockAlign),
      };
    }
    pos = start + size + (size & 1);
  }
  return null;
}

// Converts audio to another sample rate piece by piece, for files too long to convert at once.
// Windowed-sinc low-pass filter (Blackman window, kernel precomputed for 256 fractional phases):
// the same design as resample() in src/audio.js and pcm-worklet.js, so 44.1/48 kHz audio is
// converted without aliasing. No imports, so test/ui.test.js can run it in Node.

const PHASES = 256;
const ZERO_CROSSINGS = 8;

export class Resampler {
  /**
   * @param {number} fromRate
   * @param {number} toRate
   */
  constructor(fromRate, toRate) {
    this.ratio = fromRate / toRate;
    this.fed = 0; // input samples so far
    this.made = 0; // output samples so far
    if (this.ratio === 1) return;
    const fc = 0.45 / Math.max(1, this.ratio); // cutoff in cycles per input sample
    this.half = Math.ceil(ZERO_CROSSINGS / (2 * fc));
    this.taps = 2 * this.half;
    /** @type {Float32Array[]} */
    this.table = [];
    for (let p = 0; p <= PHASES; p++) {
      const phase = p / PHASES;
      const k = new Float32Array(this.taps);
      let sum = 0;
      for (let j = 0; j < this.taps; j++) {
        const x = j - this.half + 1 - phase;
        const s = x === 0 ? 1 : Math.sin(2 * Math.PI * fc * x) / (2 * Math.PI * fc * x);
        const w = (x + this.half) / (2 * this.half);
        k[j] = s * (0.42 - 0.5 * Math.cos(2 * Math.PI * w) + 0.08 * Math.cos(4 * Math.PI * w));
        sum += k[j];
      }
      for (let j = 0; j < this.taps; j++) k[j] /= sum;
      this.table.push(k);
    }
    this.buffer = new Float32Array(0); // input still needed by coming outputs
    this.offset = 0; // input index of buffer[0]
  }

  /**
   * Feeds input samples; returns the output samples that can be computed so far.
   * @param {Float32Array} input
   * @returns {Float32Array}
   */
  push(input) {
    this.fed += input.length;
    if (this.ratio === 1) {
      this.made += input.length;
      return input.slice();
    }
    const buf = new Float32Array(this.buffer.length + input.length);
    buf.set(this.buffer);
    buf.set(input, this.buffer.length);
    this.buffer = buf;
    return this.compute(this.fed, false);
  }

  /** The remaining output, as if the input continued with silence. */
  flush() {
    if (this.ratio === 1) return new Float32Array(0);
    return this.compute(this.fed, true);
  }

  /** Outputs up to (end of input) or, at the end, as many as the whole input makes (floor(fed / ratio)). */
  compute(end, final) {
    const { ratio, half, taps, table, offset } = this;
    const buf = this.buffer;
    const last = final ? Math.floor(this.fed / ratio) : Infinity;
    const out = new Float32Array(Math.max(0, Math.ceil((end - offset) / ratio) + 1));
    const size = buf.length;
    let made = this.made;
    let n = 0;
    while (made < last && n < out.length) {
      const pos = made * ratio;
      const i0 = Math.floor(pos);
      const from = i0 - half + 1 - offset; // first input of the window, in buf
      if (!final && from + taps > size) break; // needs input that has not arrived yet
      const k = table[Math.round((pos - i0) * PHASES)];
      let acc = 0;
      if (from >= 0 && from + taps <= size) {
        for (let j = 0; j < taps; j++) acc += buf[from + j] * k[j];
      } else {
        for (let j = 0; j < taps; j++) {
          const i = from + j; // before the first or after the last sample: silence
          if (i >= 0 && i < size) acc += buf[i] * k[j];
        }
      }
      out[n++] = acc;
      made++;
    }
    this.made = made;
    // Input before the next output's window is no longer needed.
    const keep = Math.max(0, Math.floor(made * ratio) - half + 1 - offset);
    if (keep > 0) {
      this.buffer = buf.slice(Math.min(keep, buf.length));
      this.offset += Math.min(keep, buf.length);
    }
    return out.subarray(0, n);
  }
}

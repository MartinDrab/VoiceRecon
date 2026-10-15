// AudioWorklet: converts microphone audio to 16 kHz mono 16-bit PCM in 100 ms chunks.
// Resampling uses a windowed-sinc low-pass filter (Blackman window, precomputed for 64
// fractional phases) so that frequencies above 8 kHz do not fold back into the speech band.

const TARGET_RATE = 16000;
const CHUNK = 1600;
const PHASES = 64;
const ZERO_CROSSINGS = 8;

function buildKernel(ratio) {
  const fc = 0.45 / Math.max(1, ratio); // cutoff in cycles per input sample
  const half = Math.ceil(ZERO_CROSSINGS / (2 * fc));
  const taps = 2 * half;
  const table = [];
  for (let p = 0; p < PHASES; p++) {
    const phase = p / PHASES;
    const k = new Float32Array(taps);
    let sum = 0;
    for (let j = 0; j < taps; j++) {
      const x = j - half + 1 - phase; // distance from the output position
      const s = x === 0 ? 1 : Math.sin(2 * Math.PI * fc * x) / (2 * Math.PI * fc * x);
      const w = (x + half) / (2 * half); // 0..1 across the window
      const blackman = 0.42 - 0.5 * Math.cos(2 * Math.PI * w) + 0.08 * Math.cos(4 * Math.PI * w);
      k[j] = s * blackman;
      sum += k[j];
    }
    for (let j = 0; j < taps; j++) k[j] /= sum; // unity gain at DC
    table.push(k);
  }
  return { half, taps, table };
}

class Pcm16kProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.kernel = this.ratio === 1 ? null : buildKernel(this.ratio);
    const half = this.kernel ? this.kernel.half : 0;
    this.input = new Float32Array(half); // zero history before the first sample
    this.pos = half;
    this.out = new Int16Array(CHUNK);
    this.outLen = 0;
    this.sumSq = 0;
  }

  emit(v) {
    const s = Math.max(-1, Math.min(1, v));
    this.out[this.outLen++] = s < 0 ? s * 32768 : s * 32767;
    this.sumSq += s * s;
    if (this.outLen === CHUNK) {
      const level = Math.sqrt(this.sumSq / CHUNK);
      this.port.postMessage({ pcm: this.out, level }, [this.out.buffer]);
      this.out = new Int16Array(CHUNK);
      this.outLen = 0;
      this.sumSq = 0;
    }
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels.length) return true;
    const n = channels[0].length;

    // mix down to mono and append to the pending input
    const merged = new Float32Array(this.input.length + n);
    merged.set(this.input);
    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c];
      for (let i = 0; i < n; i++) merged[this.input.length + i] += ch[i] / channels.length;
    }

    if (!this.kernel) {
      for (let i = 0; i < n; i++) this.emit(merged[i]);
      this.input = new Float32Array(0);
      return true;
    }

    const { half, taps, table } = this.kernel;
    let pos = this.pos;
    while (Math.floor(pos) + half + 1 < merged.length) {
      const i0 = Math.floor(pos);
      let p = Math.round((pos - i0) * PHASES);
      let base = i0 - half + 1;
      if (p === PHASES) {
        p = 0;
        base++;
      }
      const k = table[p];
      let acc = 0;
      for (let j = 0; j < taps; j++) acc += merged[base + j] * k[j];
      this.emit(acc);
      pos += this.ratio;
    }
    // keep enough history for the filter
    const drop = Math.max(0, Math.floor(pos) - half);
    this.input = merged.slice(drop);
    this.pos = pos - drop;
    return true;
  }
}

registerProcessor('pcm16k', Pcm16kProcessor);

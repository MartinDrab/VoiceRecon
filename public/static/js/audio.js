// Browser audio helpers: microphone capture as 16 kHz PCM, file decoding, WAV encoding.

export const SAMPLE_RATE = 16000;

/**
 * Captures the microphone and delivers 100 ms chunks of 16 kHz mono Int16 PCM.
 * onChunk(Int16Array), onLevel(rms 0..1)
 */
export class MicCapture {
  constructor({ onChunk, onLevel } = {}) {
    this.onChunk = onChunk;
    this.onLevel = onLevel;
    this.ctx = null;
    this.stream = null;
  }

  static supported() {
    return Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.AudioWorkletNode);
  }

  async start() {
    if (!MicCapture.supported()) {
      throw new Error(window.isSecureContext
        ? 'This browser cannot record audio.'
        : 'The microphone is only available over HTTPS or on localhost.');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    try {
      this.ctx = new AudioContext();
      await this.ctx.audioWorklet.addModule('/static/js/pcm-worklet.js');
      const source = this.ctx.createMediaStreamSource(this.stream);
      const node = new AudioWorkletNode(this.ctx, 'pcm16k');
      node.port.onmessage = (e) => {
        if (this.onChunk) this.onChunk(e.data.pcm);
        if (this.onLevel) this.onLevel(e.data.level);
      };
      // Route through a muted gain so the graph is pulled without echoing the microphone.
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      source.connect(node).connect(mute).connect(this.ctx.destination);
      if (this.ctx.state === 'suspended') await this.ctx.resume();
    } catch (err) {
      await this.stop(); // release the microphone instead of leaving it captured
      throw err;
    }
  }

  async stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx) await this.ctx.close().catch(() => {});
    this.stream = null;
    this.ctx = null;
  }
}

/** Records the microphone into memory; stop() returns a 16 kHz WAV Blob. */
export class MicRecorder {
  constructor({ onLevel } = {}) {
    this.chunks = [];
    this.capture = new MicCapture({ onChunk: (c) => this.chunks.push(c), onLevel });
  }

  async start() {
    this.chunks = [];
    await this.capture.start();
  }

  get seconds() {
    return this.chunks.length * 0.1;
  }

  async stop() {
    await this.capture.stop();
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const pcm = new Int16Array(total);
    let o = 0;
    for (const c of this.chunks) {
      pcm.set(c, o);
      o += c.length;
    }
    return wavFromInt16(pcm, SAMPLE_RATE);
  }
}

/** Decodes any audio file the browser understands into a 16 kHz mono WAV Blob. */
export async function fileToWav(file) {
  const data = await file.arrayBuffer();
  const tmp = new AudioContext();
  let decoded;
  try {
    decoded = await tmp.decodeAudioData(data);
  } catch {
    throw new Error(`"${file.name}" is not an audio format this browser can read.`);
  } finally {
    tmp.close();
  }
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE)), SAMPLE_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  const f = rendered.getChannelData(0);
  const pcm = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]));
    pcm[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return wavFromInt16(pcm, SAMPLE_RATE);
}

export function wavFromInt16(pcm, rate) {
  const header = new DataView(new ArrayBuffer(44));
  const writeStr = (o, s) => [...s].forEach((ch, i) => header.setUint8(o + i, ch.charCodeAt(0)));
  writeStr(0, 'RIFF');
  header.setUint32(4, 36 + pcm.byteLength, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, rate, true);
  header.setUint32(28, rate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  writeStr(36, 'data');
  header.setUint32(40, pcm.byteLength, true);
  return new Blob([header, pcm], { type: 'audio/wav' });
}

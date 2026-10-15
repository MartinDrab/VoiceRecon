// Browser audio helpers: microphone capture as 16 kHz PCM, file decoding, WAV encoding.

import { t } from './i18n.js';

export const SAMPLE_RATE = 16000;

const MIC_KEY = 'voicerecon.microphone';
const PROCESSING = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };

/** The microphone chosen by the user as { id, label }, or null for the system default. */
export function preferredMicrophone() {
  try {
    const v = JSON.parse(localStorage.getItem(MIC_KEY) || 'null');
    return v && typeof v.id === 'string' && v.id ? v : null;
  } catch {
    return null;
  }
}

/** Remembers a microphone (a MediaDeviceInfo) for all pages of this browser; null = system default. */
export function setPreferredMicrophone(device) {
  try {
    if (device) localStorage.setItem(MIC_KEY, JSON.stringify({ id: device.deviceId, label: device.label }));
    else localStorage.removeItem(MIC_KEY);
  } catch { /* storage unavailable: the choice lasts until the page is closed */ }
}

/**
 * Audio inputs of this computer. Browsers hide their names until microphone access has been
 * allowed once. The "default" and "communications" entries some browsers add are left out:
 * they are aliases of real devices, and "System default" is always offered separately.
 */
export async function listMicrophones() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === 'audioinput' && d.deviceId && !['default', 'communications'].includes(d.deviceId));
}

/**
 * Captures the microphone and delivers 100 ms chunks of 16 kHz mono Int16 PCM.
 * onChunk(Int16Array), onLevel(rms 0..1). Uses the preferred microphone when it is connected,
 * otherwise the system default (then fellBack is true). label is the name of the device in use.
 */
export class MicCapture {
  /** @param {{ onChunk?: (pcm: Int16Array) => void, onLevel?: (rms: number) => void }} [handlers] */
  constructor({ onChunk, onLevel } = {}) {
    this.onChunk = onChunk;
    this.onLevel = onLevel;
    this.ctx = null;
    this.stream = null;
    this.label = '';
    this.fellBack = false;
  }

  static supported() {
    return Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.AudioWorkletNode);
  }

  async start() {
    if (!MicCapture.supported()) {
      throw new Error(window.isSecureContext
        ? t('This browser cannot record audio.')
        : t('The microphone is only available over HTTPS or on localhost.'));
    }
    const preferred = preferredMicrophone();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: preferred ? { ...PROCESSING, deviceId: { exact: preferred.id } } : PROCESSING,
      });
    } catch (err) {
      if (!preferred || !['OverconstrainedError', 'NotFoundError', 'NotReadableError'].includes(err.name)) throw err;
      // The chosen microphone is unplugged or busy: use the default one rather than nothing.
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: PROCESSING });
      this.fellBack = true;
    }
    const track = this.stream.getAudioTracks()[0];
    this.label = (track && track.label) || '';
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
  /** @param {{ onLevel?: (rms: number) => void }} [handlers] */
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

/**
 * Decodes any audio (or video) file the browser can play into 16 kHz mono 16-bit samples. The
 * browser resamples while decoding, which keeps long files manageable: an hour of stereo takes
 * about 460 MB while decoding instead of 1.4 GB at 48 kHz.
 * @param {File} file
 * @returns {Promise<Int16Array>}
 */
export async function decodeFile(file) {
  let decoded;
  try {
    decoded = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error(t('"{name}" is not an audio format this browser can read.', { name: file.name }));
  }
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c));
  const pcm = new Int16Array(decoded.length);
  for (let i = 0; i < pcm.length; i++) {
    let sum = 0;
    for (const ch of channels) sum += ch[i];
    const s = Math.max(-1, Math.min(1, sum / channels.length));
    pcm[i] = Math.round(s < 0 ? s * 32768 : s * 32767);
  }
  return pcm;
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

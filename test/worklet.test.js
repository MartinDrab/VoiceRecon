'use strict';

// The browser's AudioWorklet (microphone -> 16 kHz PCM) run in Node with a minimal stand-in for
// the AudioWorkletGlobalScope. It is not type-checked (TypeScript has no worklet library), so it
// is tested here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'static', 'js', 'pcm-worklet.js'), 'utf8');

function worklet(rate) {
  /** @type {any} */
  let Processor = null;
  const chunks = [];
  vm.runInNewContext(SOURCE, {
    sampleRate: rate,
    Math,
    Float32Array,
    Int16Array,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { postMessage: (m) => chunks.push(m) };
      }
    },
    registerProcessor: (_name, cls) => {
      Processor = cls;
    },
  });
  return { processor: new Processor(), chunks };
}

/** Feeds a 2 s tone in 128-sample render quanta; returns the output gain and sample count. */
function run(rate, freq) {
  const { processor, chunks } = worklet(rate);
  const n = rate * 2;
  const x = Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * freq * i) / rate));
  for (let i = 0; i < n; i += 128) assert.strictEqual(processor.process([[x.subarray(i, i + 128)]]), true);
  const out = chunks.flatMap((c) => [...c.pcm].map((v) => v / 32768));
  const steady = out.slice(1600); // skip the filter's warm-up
  const rms = Math.sqrt(steady.reduce((s, v) => s + v * v, 0) / steady.length);
  return { gain: rms / (0.5 / Math.SQRT2), samples: out.length, levels: chunks.map((c) => c.level) };
}

test('48 kHz and 44.1 kHz microphones become 16 kHz without aliasing', () => {
  for (const rate of [48000, 44100]) {
    const speech = run(rate, 1000);
    assert.strictEqual(speech.samples, 30400, `${rate}: 19 full 100 ms chunks of 1600 samples`);
    assert.ok(Math.abs(speech.gain - 1) < 0.01, `${rate}: 1 kHz passes (${speech.gain})`);
    assert.ok(run(rate, 12000).gain < 0.01, `${rate}: 12 kHz is removed instead of folding to 4 kHz`);
    assert.ok(speech.levels.every((l) => l > 0.3 && l < 0.4), 'chunks report their level (RMS)');
  }
});

test('16 kHz input passes through unchanged and stereo is mixed to mono', () => {
  const { processor, chunks } = worklet(16000);
  const left = Float32Array.from({ length: 1600 }, (_, i) => (i % 2 ? 0.25 : -0.25));
  const right = Float32Array.from({ length: 1600 }, () => 0.25);
  for (let i = 0; i < 1600; i += 128) processor.process([[left.subarray(i, i + 128), right.subarray(i, i + 128)]]);
  assert.strictEqual(chunks.length, 1);
  assert.strictEqual(chunks[0].pcm[0], 0); // (-0.25 + 0.25) / 2
  assert.strictEqual(chunks[0].pcm[1], Math.round(0.25 * 32767)); // (0.25 + 0.25) / 2
  assert.strictEqual(processor.process([]), true, 'no input is fine');
});

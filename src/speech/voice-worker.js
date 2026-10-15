'use strict';

// Voice prints of recordings, computed in a worker thread (see SpeechEngine.analyzeRecording()).
// Decoding, resampling, finding the speech and the speaker embedding of a 10-minute recording take
// several seconds of CPU; on the main thread that stalled the whole server, live transcription too.

const { parentPort, workerData } = require('worker_threads');
const { SpeechEngine, analyze } = require('./engine');

const engine = new SpeechEngine(workerData.config);
engine.loadSpeakerModel();
parentPort.postMessage({ type: 'ready' });

parentPort.on('message', ({ id, input }) => {
  try {
    const result = analyze(engine, input);
    const transfer = [result.embedding, result.wav].filter(Boolean).map((a) => a.buffer);
    parentPort.postMessage({ id, result }, transfer);
  } catch (err) {
    const { message, status, template, params } = err;
    parentPort.postMessage({ id, error: { message, status, template, params } });
  }
});

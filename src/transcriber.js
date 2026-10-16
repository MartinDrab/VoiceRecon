'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { concat, encodeWav } = require('./audio');
const { SAMPLE_RATE, VAD_WINDOW, cosine, l2normalize, yieldToEventLoop } = require('./speech/engine');

const sec = (s) => Math.round(s * SAMPLE_RATE);

const HISTORY = sec(40); // raw audio kept so utterances can be cut with padding
const PAD_BEFORE = sec(0.4); // the VAD tends to detect speech onsets a little late
const PAD_AFTER = sec(0.3); // only after a real pause: the VAD waits for >= 0.35 s of silence
const TAIL_SILENCE = sec(0.3); // without it the recognizer sometimes drops the last words
const PARTIAL_EVERY = sec(0.8);
const MIN_PARTIAL = sec(1.2); // shorter snippets mostly produce guesses in the wrong language
// Alone, a short utterance is often taken for another language ("Ukrajincům" came out as
// "Uh Ukraine Soom"), so it is recognized after the speech that preceded it (see recognize()).
const SHORT_UTTERANCE = sec(2.5);
const CONTEXT = sec(4); // speech kept as context: the end of the previous utterances
const CONTEXT_GAP = sec(0.5); // silence between the context and the utterance, so no word spans both
const NEW_SPEAKER_MIN = sec(1.5);
const UNKNOWN_AUDIO_LIMIT = sec(60);
const MAX_RECENT = 2000; // final lines whose voice print is kept so the user can correct them

// Speaker-change detection inside one utterance (people answering without a pause).
const CHANGE_MIN = sec(3.0);
const CHANGE_WIN = sec(1.5);
const CHANGE_HOP = sec(0.5);
const CHANGE_MIN_SIDE = 2; // windows on each side of a split
// A–B–A without a pause needs two cuts at once: any one cut leaves A in both halves, which then still
// sound alike. The stretch cut out needs this many windows (1.5 s between the cuts): with 2, a second
// of one person's own speech was cut out of a 20 s stretch.
const CHANGE_MIN_MIDDLE = 3;
// Halves of one utterance that are less similar than this are split between speakers. Measured on
// real voices answering without a pause: 0.3 left most changes unsplit, 0.5 found them (95% of speech
// time credited correctly instead of 86%) without splitting anyone's own speech.
const CHANGE_MAX_SIMILARITY = 0.5;
// Enrolled voices taking turns: a window counts for a voice when it matches it clearly (above the
// threshold and this far ahead of the next voice), and a voice must hold for this many windows.
const VOICE_MARGIN = 0.1;
const VOICE_RUN = 1;

// Long stretches of one speaker are split into lines at sentence ends, each at least this long.
const LINE_MIN_SECONDS = 3;

const DEBUG = process.env.VOICERECON_DEBUG === '1';
const debug = (...args) => DEBUG && console.log('[transcriber]', ...args);
const DEBUG_DIR = path.join(os.tmpdir(), 'voicerecon-debug');

/**
 * Voice Transcriber: one live transcription session (one microphone).
 *
 * Audio is fed in as 16 kHz mono float samples. A voice activity detector cuts it into
 * utterances; each finished utterance is transcribed, split where the speaker changes, and every
 * part is attributed to a known voice (or to a session-local "unknown speaker"). While someone is
 * still talking, interim results are produced whenever the recognizer has spare capacity.
 *
 * Emits "message" with objects of these shapes:
 *   { type: 'partial', text, speaker }            interim text of the utterance in progress
 *   { type: 'final', id, start, end, text, lang, speaker }
 *   { type: 'relabel', from, to }                  an unknown speaker was saved as / assigned to a voice
 * where speaker = { kind: 'voice', id, score } | { kind: 'unknown', id, label } | { kind: 'none' }.
 * Times are seconds of audio since the session started.
 */
class TranscriptionSession extends EventEmitter {
  /**
   * Options (the live transcript uses the defaults):
   *   interim              produce interim results (default true)
   *   learn                let clear matches refine the voices (default true; see considerLearning)
   *   background           recognize at low priority, behind live sessions (uploaded files)
   *   vad                  overrides for SpeechEngine.createVad(), e.g. { minSilence: 0.3 }
   *   changeMaxSimilarity  split an utterance when its halves are less similar than this
   *   splitMiddle          also cut out a middle stretch that sounds unlike the rest (A–B–A; default true)
   */
  constructor(engine, voices, {
    interim = true, learn = true, background = false, vad = {}, changeMaxSimilarity = CHANGE_MAX_SIMILARITY,
    splitMiddle = true,
  } = {}) {
    super();
    this.engine = engine;
    this.voices = voices;
    this.interim = interim;
    this.learn = learn;
    this.background = background;
    this.changeMaxSimilarity = changeMaxSimilarity;
    this.splitMiddle = splitMiddle;
    this.vad = engine.createVad(vad);
    this.leftover = new Float32Array(0);
    this.history = [];
    this.historyStart = 0;
    this.historyLen = 0;
    this.fed = 0; // samples fed so far (absolute position)
    this.base = 0; // VAD positions restart after finish(); this maps them to absolute ones
    this.lastSegEnd = 0; // absolute end of the audio given to the recognizer for the last utterance
    this.speechStart = null; // absolute start of the utterance in progress (for partials)
    this.lastPartialAt = 0;
    this.gen = 0; // incremented for every utterance that starts
    this.partialGen = 0; // utterance whose interim text the client currently shows (0 = none)
    this.partialBusy = false;
    this.seq = 0;
    this.chain = Promise.resolve();
    this.unknown = []; // { id, label, centroid, count, audio: Float32Array[], audioLen }
    this.unknownSeq = 0;
    this.lastSpeaker = null;
    this.context = new Float32Array(0); // the last CONTEXT samples of speech, for short utterances
    this.recent = new Map(); // final id -> { embedding, seconds }, for corrections
    this.closed = false;
  }

  /** Seconds of audio received so far (the clock that final results' start/end refer to). */
  get audioSeconds() {
    return this.fed / SAMPLE_RATE;
  }

  /** Feeds 16 kHz mono float samples. */
  push(samples) {
    if (this.closed) return;
    const data = this.leftover.length ? concat([this.leftover, samples]) : samples;
    let i = 0;
    for (; i + VAD_WINDOW <= data.length; i += VAD_WINDOW) this.step(data.slice(i, i + VAD_WINDOW));
    this.leftover = data.slice(i);
    this.maybePartial();
  }

  step(win) {
    this.history.push(win);
    this.historyLen += win.length;
    while (this.historyLen - this.history[0].length >= HISTORY) {
      this.historyStart += this.history[0].length;
      this.historyLen -= this.history.shift().length;
    }
    this.vad.acceptWaveform(win);
    this.fed += win.length;

    if (this.speechStart === null && this.vad.isDetected()) {
      this.speechStart = Math.max(this.fed - win.length - PAD_BEFORE, this.lastSegEnd);
      this.lastPartialAt = 0;
      this.gen++;
    }
    while (!this.vad.isEmpty()) {
      const seg = this.vad.front(false);
      this.vad.pop();
      this.segmentDone(seg);
    }
  }

  /** Copies audio between two absolute positions out of the history buffer. */
  extract(from, to) {
    from = Math.max(from, this.historyStart);
    to = Math.min(to, this.fed);
    const out = new Float32Array(Math.max(0, to - from));
    let pos = this.historyStart;
    for (const chunk of this.history) {
      const end = pos + chunk.length;
      if (end > from && pos < to) {
        const a = Math.max(from, pos);
        const b = Math.min(to, end);
        out.set(chunk.subarray(a - pos, b - pos), a - from);
      }
      pos = end;
      if (pos >= to) break;
    }
    return out;
  }

  segmentDone(seg) {
    const coreStart = this.base + seg.start;
    const core = Float32Array.from(seg.samples);
    const from = Math.max(coreStart - PAD_BEFORE, this.lastSegEnd);
    // When the VAD force-splits continuous speech, the next utterance follows immediately, so
    // padding after the cut would hand the same words to both utterances.
    const coreEnd = coreStart + core.length;
    const to = Math.min(this.vad.isDetected() ? coreEnd : coreEnd + PAD_AFTER, this.fed);
    const audio = withTail(this.extract(from, to));
    this.lastSegEnd = Math.max(to, coreEnd);
    this.speechStart = null;
    this.engine.cancel(this, { interimOnly: true }); // interim results of this utterance are moot
    const context = core.length < SHORT_UTTERANCE ? this.context : null;
    const recent = concat([this.context, core]);
    this.context = recent.slice(Math.max(0, recent.length - CONTEXT));
    this.enqueueFinal(audio, from, core, coreStart, this.gen, context);
  }

  maybePartial() {
    if (!this.interim || this.speechStart === null || this.partialBusy || !this.engine.idle) return;
    const length = this.fed - this.speechStart;
    if (length < MIN_PARTIAL || length - this.lastPartialAt < PARTIAL_EVERY) return;
    this.lastPartialAt = length;
    const gen = this.gen;
    const audio = this.extract(this.speechStart, this.fed);
    this.partialBusy = true;
    this.recognize(withTail(audio), audio.length < SHORT_UTTERANCE ? this.context : null, { interim: true, owner: this })
      .then(async (r) => {
        if (this.closed || this.speechStart === null || this.gen !== gen || !r.text) return;
        const embedding = audio.length >= NEW_SPEAKER_MIN ? await this.engine.embedLine(audio) : null;
        if (this.closed || this.speechStart === null || this.gen !== gen) return; // ended meanwhile
        const speaker = this.peekSpeaker(embedding);
        this.partialGen = gen;
        this.emit('message', { type: 'partial', text: r.text, speaker });
      })
      .catch((err) => this.fail(err))
      .finally(() => {
        this.partialBusy = false;
      });
  }

  /**
   * @param audio     padded utterance audio, used for speech recognition
   * @param from      absolute position of audio[0]
   * @param core      the utterance as cut by the VAD, used for speaker recognition
   * @param coreStart absolute position of core[0]
   * @param gen       the utterance number (to retire its interim text once the final is out)
   * @param context   speech said before a short utterance (see recognize()), or null
   */
  enqueueFinal(audio, from, core, coreStart, gen, context = null) {
    // Queued now so finals keep their order.
    const asr = this.recognize(audio, context, { owner: this, background: this.background });
    asr.catch(() => {}); // a rejection is handled when the chain awaits it, not before
    this.chain = this.chain
      .then(async () => {
        const r = await asr;
        debug(`segment ${(coreStart / SAMPLE_RATE).toFixed(2)}+${(core.length / SAMPLE_RATE).toFixed(2)}s: "${r.text}"`);
        if (DEBUG) {
          fs.mkdirSync(DEBUG_DIR, { recursive: true });
          fs.writeFileSync(path.join(DEBUG_DIR, `segment-${coreStart}.wav`), encodeWav(audio, SAMPLE_RATE));
        }
        if (this.closed) return;
        if (r.text) {
          const turns = await this.speakerTurns(core);
          if (this.closed) return;
          const audioStart = from / SAMPLE_RATE; // word times count from here
          const words = wordsOf(r);
          // Each speaker's words; without word times only the first part can get the text.
          const parts = words
            ? cutWords(words, turns.slice(1).map((t) => (coreStart + t.start) / SAMPLE_RATE - audioStart))
            : [null];
          if (turns.length > 1) debug(`  split at ${turns.slice(1).map((t) => (t.start / SAMPLE_RATE).toFixed(2)).join(', ')} s`);
          for (const [i, t] of turns.entries()) {
            const own = words ? parts[i] || [] : null; // null: no word times
            if (own ? !wordsText(own) : i > 0) continue;
            const part = core.subarray(t.start, t.end);
            const embedding = await this.engine.embedLine(part);
            if (this.closed) return;
            const speaker = this.assignSpeaker(part, embedding);
            const partStart = (coreStart + t.start) / SAMPLE_RATE;
            const partEnd = (coreStart + t.end) / SAMPLE_RATE;
            // One line per few sentences. A cut lies midway between the words on either side; one
            // that would leave less than a second of this part on either side is not made.
            const lines = own ? [] : [null];
            const edges = [partStart];
            const sentences = own ? sentenceLines(own) : [];
            let pending = [];
            sentences.forEach((line, j) => {
              pending = pending.concat(line);
              const next = sentences[j + 1];
              const cut = next && audioStart + (line[line.length - 1].end + next[0].start) / 2;
              if (next && (cut - edges[edges.length - 1] < 1 || partEnd - cut < 1)) return;
              lines.push(pending);
              pending = [];
              if (next) edges.push(cut);
            });
            edges.push(partEnd);
            lines.forEach((line, j) => {
              const id = ++this.seq;
              this.remember(id, embedding, part.length / SAMPLE_RATE); // a correction learns the whole part
              this.emit('message', {
                type: 'final',
                id,
                start: round(edges[j]),
                end: round(edges[j + 1]),
                text: line ? wordsText(line) : r.text,
                lang: r.lang,
                speaker,
              });
            });
          }
        }
        // Retire the interim text only now, so the utterance never disappears from the screen.
        // If a newer utterance already shows interim text, leave that alone.
        if (this.partialGen === gen) this.clearPartial();
      })
      .catch((err) => this.fail(err));
  }

  /**
   * Speech-to-text of an utterance. With `context` (speech said before a short utterance), the
   * recognizer hears the context, a short silence and then the utterance, and only the utterance's
   * own words are kept; times in the result are relative to the utterance, as without context.
   * @param {Float32Array} audio
   * @param {Float32Array | null} context
   * @param {{ interim?: boolean, background?: boolean, owner?: any }} options for SpeechEngine.transcribe()
   */
  recognize(audio, context, options) {
    if (!context || !context.length) return this.engine.transcribe(audio, options);
    const lead = context.length + CONTEXT_GAP;
    const input = new Float32Array(lead + audio.length);
    input.set(context);
    input.set(audio, lead);
    return this.engine.transcribe(input, options).then((r) => {
      const own = dropLead(r, lead / SAMPLE_RATE, CONTEXT_GAP / 2 / SAMPLE_RATE);
      // Without word times the context cannot be cut off: recognize the utterance alone.
      return own || this.engine.transcribe(audio, options);
    });
  }

  clearPartial() {
    this.partialGen = 0;
    this.emit('message', { type: 'partial', text: '', speaker: { kind: 'none' } });
  }

  /** Reports an error to the listener, or logs it once the session is closed (never throws). */
  fail(err) {
    if (!this.closed && this.listenerCount('error')) this.emit('error', err);
    else console.error('Transcription error:', err);
  }

  /**
   * Splits an utterance where the voice changes (binary segmentation over sliding-window speaker
   * embeddings, with two cuts at once where one speaker talks before and after another). Returns
   * [{ start, end }] in samples relative to the utterance. Each embedding takes ~25 ms of CPU, so
   * the event loop is given a turn between them to keep audio flowing.
   */
  async speakerTurns(core) {
    const whole = [{ start: 0, end: core.length }];
    if (core.length < CHANGE_MIN) return whole;
    const embs = [];
    for (let s = 0; s + CHANGE_WIN <= core.length; s += CHANGE_HOP) {
      await yieldToEventLoop();
      if (this.closed) return whole;
      const e = this.engine.embed(core.subarray(s, s + CHANGE_WIN));
      if (!e) return whole;
      embs.push(e);
    }
    // Voice print of the windows [a, b), or of [a, b) and [c, d) together, from running sums.
    const sums = [new Float64Array(embs[0].length)];
    for (const e of embs) sums.push(sums[sums.length - 1].map((x, j) => x + e[j]));
    const mean = (a, b, c = 0, d = 0) => l2normalize(sums[b].map((x, j) => x - sums[a][j]
      + sums[d][j] - sums[c][j]));
    const cuts = [];
    // Within a part (windows lo..hi), cut where its halves sound least alike, if unlike enough. If no
    // single cut is, cut out the middle stretch that sounds least like the rest around it (A–B–A).
    const split = (lo, hi, depth) => {
      if (depth > 3 || hi - lo < 2 * CHANGE_MIN_SIDE) return;
      let best = [];
      let bestSim = this.changeMaxSimilarity;
      for (let k = lo + CHANGE_MIN_SIDE; k <= hi - CHANGE_MIN_SIDE; k++) {
        const sim = cosine(mean(lo, k), mean(k, hi));
        if (sim < bestSim) {
          bestSim = sim;
          best = [k];
        }
      }
      if (!best.length && this.splitMiddle) {
        for (let i = lo + CHANGE_MIN_SIDE; i + CHANGE_MIN_MIDDLE + CHANGE_MIN_SIDE <= hi; i++) {
          for (let j = i + CHANGE_MIN_MIDDLE; j + CHANGE_MIN_SIDE <= hi; j++) {
            const sim = cosine(mean(i, j), mean(lo, i, j, hi));
            if (sim < bestSim) {
              bestSim = sim;
              best = [i, j];
            }
          }
        }
      }
      if (!best.length) return;
      const edges = [lo, ...best, hi];
      for (let p = 0; p + 1 < edges.length; p++) {
        if (p > 0) cuts.push(edges[p]);
        split(edges[p], edges[p + 1], depth + 1);
      }
    };
    // Enrolled voices taking turns are found first: people who sound alike may still be told apart
    // by their recordings. Within each part, the halves' similarity finds everyone else.
    const parts = [0, ...this.voiceChanges(embs), embs.length];
    for (let i = 0; i + 1 < parts.length; i++) {
      if (i > 0) cuts.push(parts[i]);
      split(parts[i], parts[i + 1], 0);
    }
    cuts.sort((a, b) => a - b);
    if (!cuts.length) return whole;
    // Boundary between windows k-1 and k: midway between their centres.
    const bounds = cuts.map((k) => k * CHANGE_HOP + (CHANGE_WIN - CHANGE_HOP) / 2);
    const edges = [0, ...bounds, core.length];
    return edges.slice(1).map((end, i) => ({ start: edges[i], end }));
  }

  /**
   * Windows (indexes into `embs`) where one enrolled voice takes over from another: each window is
   * matched against the voices, and a change counts when both voices hold for VOICE_RUN windows
   * that match them clearly. A cut lies midway between the last window of one voice and the first
   * of the next.
   */
  voiceChanges(embs) {
    const runs = []; // { voiceId, first, last } window indexes
    embs.forEach((e, k) => {
      const { voiceId, scores } = this.voices.identify(e);
      if (voiceId === null || (scores[1] && scores[0].score - scores[1].score < VOICE_MARGIN)) return;
      const run = runs[runs.length - 1];
      if (run && run.voiceId === voiceId) run.last = k;
      else runs.push({ voiceId, first: k, last: k });
    });
    const solid = [];
    for (const run of runs) {
      if (run.last - run.first + 1 < VOICE_RUN) continue;
      const prev = solid[solid.length - 1];
      if (prev && prev.voiceId === run.voiceId) prev.last = run.last;
      else solid.push({ ...run });
    }
    return solid.slice(1).map((run, i) => Math.round((solid[i].last + run.first + 1) / 2));
  }

  /** Matches without changing any state (used for interim results). */
  peekSpeaker(embedding) {
    if (!embedding) return { kind: 'none' };
    const m = this.voices.identify(embedding);
    if (m.voiceId !== null) return { kind: 'voice', id: m.voiceId, score: round(m.score) };
    const u = this.bestUnknown(embedding);
    return u ? unknownRef(u) : { kind: 'none' };
  }

  bestUnknown(embedding) {
    let best = null;
    let bestScore = this.voices.threshold;
    for (const u of this.unknown) {
      const s = cosine(embedding, u.centroid);
      if (s >= bestScore) {
        best = u;
        bestScore = s;
      }
    }
    return best;
  }

  remember(id, embedding, seconds) {
    this.recent.set(id, { embedding, seconds });
    if (this.recent.size > MAX_RECENT) this.recent.delete(this.recent.keys().next().value);
  }

  /**
   * Decides who spoke a piece of audio, creating a new unknown speaker when needed. Clear matches
   * may be learned by the voice (see VoiceManager.considerLearning).
   */
  assignSpeaker(samples, embedding = this.engine.embed(samples)) {
    let speaker;
    if (embedding) {
      const m = this.voices.identify(embedding);
      if (m.voiceId !== null) {
        speaker = { kind: 'voice', id: m.voiceId, score: round(m.score) };
        if (this.learn) this.voices.considerLearning(m.voiceId, embedding, samples.length / SAMPLE_RATE);
      } else {
        let u = this.bestUnknown(embedding);
        if (u) {
          u.centroid = l2normalize(u.centroid.map((x, i) => x * u.count + embedding[i]));
          u.count++;
        } else if (samples.length >= NEW_SPEAKER_MIN) {
          const n = ++this.unknownSeq;
          u = { id: `u${n}`, label: `Speaker ${n}`, centroid: embedding, count: 1, audio: [], audioLen: 0 };
          this.unknown.push(u);
        }
        if (u) {
          if (u.audioLen < UNKNOWN_AUDIO_LIMIT) {
            u.audio.push(Float32Array.from(samples));
            u.audioLen += samples.length;
          }
          speaker = unknownRef(u);
        }
      }
    }
    // Too short to tell: most likely the person who spoke last.
    if (!speaker) speaker = this.lastSpeaker || { kind: 'unknown', id: null, label: '?' };
    this.lastSpeaker = speaker;
    return speaker;
  }

  /** Saves an unknown speaker of this session as a new voice, using the audio heard so far. */
  async saveUnknown(unknownId, { name, color }) {
    const u = this.unknown.find((x) => x.id === unknownId);
    if (!u || u.saving) throw new Error('That speaker is no longer available in this session.');
    const voiceId = this.voices.create({ name, color });
    u.saving = true; // the voice print takes a moment; a second click must not save it twice
    try {
      await this.voices.addSample(voiceId, { samples: concat(u.audio), sampleRate: SAMPLE_RATE, label: 'From live transcript' });
    } catch (err) {
      u.saving = false;
      this.voices.remove(voiceId);
      throw err;
    }
    this.unknown = this.unknown.filter((x) => x !== u);
    const to = { kind: 'voice', id: voiceId, score: 1 };
    if (this.lastSpeaker && this.lastSpeaker.id === unknownId) this.lastSpeaker = to;
    this.emit('message', { type: 'relabel', from: unknownRef(u), to });
    return voiceId;
  }

  /**
   * The user says that these final lines were spoken by an existing voice: the voice learns how
   * they sounded. Returns the number of lines learned.
   */
  correct(ids, voiceId) {
    const items = ids.map((id) => this.recent.get(id)).filter(Boolean);
    return this.voices.learnCorrections(voiceId, items);
  }

  /** The user says that an unknown speaker of this session is in fact an existing voice. */
  assignUnknown(unknownId, voiceId) {
    const u = this.unknown.find((x) => x.id === unknownId);
    if (!u) throw new Error('That speaker is no longer available in this session.');
    // Saving as a new voice relabels the lines when it is done; assigning now would give the same
    // person two voices.
    if (u.saving) throw new Error('That speaker is being saved as a new voice.');
    this.voices.learnCorrections(voiceId, [{ embedding: u.centroid, seconds: u.audioLen / SAMPLE_RATE }]);
    this.unknown = this.unknown.filter((x) => x !== u);
    const to = { kind: 'voice', id: voiceId, score: 1 };
    if (this.lastSpeaker && this.lastSpeaker.id === unknownId) this.lastSpeaker = to;
    this.emit('message', { type: 'relabel', from: unknownRef(u), to });
  }

  /** Resolves once every utterance cut so far has its final result (paces uploaded files). */
  settled() {
    return this.chain;
  }

  /** Flushes buffered speech (e.g. when the microphone stops) and waits for all final results. */
  async finish() {
    if (this.closed) return;
    if (this.leftover.length) {
      const pad = new Float32Array(VAD_WINDOW);
      pad.set(this.leftover);
      this.leftover = new Float32Array(0);
      this.step(pad);
    }
    this.vad.flush();
    while (!this.vad.isEmpty()) {
      const seg = this.vad.front(false);
      this.vad.pop();
      this.segmentDone(seg);
    }
    this.vad.reset();
    this.base = this.fed;
    this.speechStart = null;
    await this.chain;
    if (this.partialGen && !this.closed) this.clearPartial();
  }

  close() {
    this.closed = true;
    this.engine.cancel(this);
    this.removeAllListeners();
  }
}

/**
 * The part of a recognition result that starts `lead` seconds into the input: words starting
 * before lead - margin belong to the context. Token times are shifted to start at lead. Returns
 * null when the result has no token times to cut by.
 */
function dropLead(result, lead, margin) {
  const { tokens, timestamps, durations } = result;
  if (!tokens.length) return { ...result, text: '' };
  if (tokens.length !== timestamps.length) return null;
  let first = timestamps.findIndex((t) => t >= lead - margin);
  if (first < 0) first = tokens.length;
  // A punctuation mark recognized late still ends the context's last sentence.
  while (first < tokens.length && !tokens[first].startsWith(' ') && !/[\p{L}\p{N}]/u.test(tokens[first])) first++;
  const text = tokens.slice(first).join('').trim();
  return {
    ...result,
    text: text && text[0].toUpperCase() + text.slice(1),
    tokens: tokens.slice(first),
    timestamps: timestamps.slice(first).map((t) => Math.max(0, t - lead)),
    durations: (durations || []).slice(first),
  };
}

function withTail(samples) {
  const out = new Float32Array(samples.length + TAIL_SILENCE);
  out.set(samples);
  return out;
}

function unknownRef(u) {
  return { kind: 'unknown', id: u.id, label: u.label };
}

function round(x) {
  return Math.round(x * 1000) / 1000;
}

/**
 * Splits recognized text into consecutive parts near the given times (seconds, relative to the
 * recognized audio). Cuts are made between words only, preferring sentence ends and pauses close
 * to the estimated time. Tokens starting with a space begin a new word.
 */
function splitWords(result, bounds) {
  const words = wordsOf(result);
  return words ? cutWords(words, bounds).map(wordsText) : [result.text];
}

/** The recognized words with their times in seconds, [{ text, start, end }]; null without token times. */
function wordsOf(result) {
  const { tokens, timestamps, durations } = result;
  if (!tokens.length || tokens.length !== timestamps.length) return null;
  const words = [];
  tokens.forEach((tok, i) => {
    const end = timestamps[i] + (durations[i] || 0);
    if (!words.length || tok.startsWith(' ')) words.push({ text: tok, start: timestamps[i], end });
    else {
      const w = words[words.length - 1];
      w.text += tok;
      w.end = end;
    }
  });
  return words;
}

/** Cuts words into consecutive parts near the given times (see splitWords); returns the parts. */
function cutWords(words, bounds) {
  const cuts = []; // index of the first word of each following part
  let min = 1;
  for (const b of bounds) {
    let best = -1;
    let bestScore = -Infinity;
    for (let j = min; j < words.length; j++) {
      const dist = Math.abs(words[j].start - b);
      if (dist > 0.6) continue;
      const gap = Math.max(0, words[j].start - words[j - 1].end);
      const sentenceEnd = /[.?!…]$/.test(words[j - 1].text) ? 0.3 : 0;
      const score = gap + sentenceEnd - 0.5 * dist;
      if (score > bestScore) {
        bestScore = score;
        best = j;
      }
    }
    if (best < 0) {
      // No word near the time: cut before the first word after it. With none after it (the
      // recognizer missed the next speaker's words), every word stays with the earlier part.
      const after = words.findIndex((w, j) => j >= min && w.start >= b);
      best = after < 0 ? words.length : after;
    }
    cuts.push(best);
    min = Math.min(best + 1, words.length);
  }
  const edges = [0, ...cuts, words.length];
  return edges.slice(1).map((end, i) => words.slice(edges[i], end));
}

function wordsText(words) {
  const t = words.map((w) => w.text).join('').trim();
  return t && t[0].toUpperCase() + t.slice(1);
}

/**
 * Splits one speaker's words into lines at sentence ends, so that a long stretch of speech does not
 * become one long line. A cut needs at least LINE_MIN_SECONDS on both sides, a sentence end before
 * it (not "32." as in "32. epizoda") and a capital letter or digit after it.
 */
function sentenceLines(words) {
  const lines = [];
  let first = 0;
  const last = words.length - 1;
  for (let j = 0; j < last; j++) {
    const end = words[j].text.trim();
    if (!/[.?!…]$/.test(end) || /^\d+\.$/.test(end) || !/^\s*[\p{Lu}\d]/u.test(words[j + 1].text)) continue;
    if (words[j].end - words[first].start < LINE_MIN_SECONDS) continue;
    if (words[last].end - words[j + 1].start < LINE_MIN_SECONDS) break;
    lines.push(words.slice(first, j + 1));
    first = j + 1;
  }
  lines.push(words.slice(first));
  return lines;
}

module.exports = { TranscriptionSession, splitWords, dropLead, sentenceLines, wordsOf, CHANGE_MAX_SIMILARITY };

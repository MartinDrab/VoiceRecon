'use strict';

const crypto = require('crypto');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { HttpError } = require('./errors');
const { decodeWav, encodeWav } = require('./audio');
const {
  SAMPLE_RATE, cosine, meanEmbedding, embeddingToBlob: toBlob, embeddingFromBlob: fromBlob,
} = require('./speech/engine');
const { getSetting, setSetting } = require('./db');

const COLOR_RE = /^#[0-9a-f]{6}$/i;
const MIN_SPEECH_SECONDS = 1.0;
const MAX_SAMPLE_SECONDS = 10 * 60;

// Learning from live speech. A live line is learned only when the enrollment recordings alone
// already identify it clearly, so a wrong match cannot reinforce itself.
const LEARN_MIN_SECONDS = 2.0;
const LEARN_ABOVE_THRESHOLD = 0.1; // enrollment score must exceed the threshold by this much
const LEARN_MIN_LEAD = 0.15; // ... and beat the second-best voice by this much
const CORRECTION_MIN_SECONDS = 1.0;
const MAX_LEARNED = { live: 30, correction: 30 }; // per voice; the oldest are dropped first
const MIN_LIVE_FOR_PRINT = 3; // live lines needed before they count (corrections count at once)

function validateName(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 60) {
    throw new HttpError(400, 'Name must be 1–60 characters long.');
  }
  return name.trim();
}

function validateColor(color) {
  if (typeof color !== 'string' || !COLOR_RE.test(color)) throw new HttpError(400, 'Color must look like #RRGGBB.');
  return color.toLowerCase();
}

/**
 * Voice Manager: the database of known voices. Each voice has a name, a color and one or more
 * recordings. A voice is matched by its best "print": the average of all its recordings, each
 * recording on its own (people sound different in different rooms or on different microphones),
 * and the average of lines learned from live speech and from corrections. Emits "changed"
 * whenever voices are modified.
 */
class VoiceManager extends EventEmitter {
  constructor(db, engine, { dataDir, defaultThreshold }) {
    super();
    this.db = db;
    this.engine = engine;
    this.recordingsDir = path.join(dataDir, 'recordings');
    this.defaultThreshold = defaultThreshold;
    this.prints = new Map(); // voiceId -> { enrolled: Float32Array[], learned: Float32Array | null }
  }

  /** Call once the speech engine is loaded. Re-embeds samples made with a different speaker model. */
  init() {
    const model = this.engine.speakerModelName;
    const stale = this.db.prepare('SELECT * FROM voice_samples WHERE model <> ?').all(model);
    for (const s of stale) {
      try {
        const { samples } = decodeWav(fs.readFileSync(path.join(this.recordingsDir, s.file)));
        const embedding = this.engine.embedLong(this.engine.speechOnly(samples));
        if (embedding) {
          this.db.prepare('UPDATE voice_samples SET embedding = ?, model = ? WHERE id = ?').run(toBlob(embedding), model, s.id);
        }
      } catch (err) {
        console.warn(`Could not re-embed voice sample ${s.id}: ${err.message}`);
      }
    }
    if (stale.length) console.log(`Re-computed ${stale.length} voice embedding(s) for model ${model}.`);
    // Learned prints have no audio to recompute them from; they are relearned with the new model.
    this.db.prepare('DELETE FROM voice_learned WHERE model <> ?').run(model);
    for (const { id } of this.db.prepare('SELECT id FROM voices').all()) this.refreshPrints(id);
  }

  get threshold() {
    return getSetting(this.db, 'speakerThreshold', this.defaultThreshold);
  }

  setThreshold(value) {
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0.05 || v > 0.95) throw new HttpError(400, 'Threshold must be between 0.05 and 0.95.');
    setSetting(this.db, 'speakerThreshold', Math.round(v * 100) / 100);
    this.emit('changed');
  }

  /** Whether confidently matched live lines are added to voice prints (corrections always are). */
  get learnFromSpeech() {
    return getSetting(this.db, 'learnFromSpeech', false);
  }

  setLearnFromSpeech(enabled) {
    if (typeof enabled !== 'boolean') throw new HttpError(400, 'Expected true or false.');
    setSetting(this.db, 'learnFromSpeech', enabled);
    this.emit('changed');
  }

  list() {
    const voices = this.db.prepare('SELECT * FROM voices ORDER BY name COLLATE NOCASE').all();
    const samples = this.db.prepare(
      'SELECT id, voice_id, label, duration, speech_duration, created_at FROM voice_samples ORDER BY id',
    ).all();
    const learned = this.db.prepare('SELECT voice_id, source, COUNT(*) AS n FROM voice_learned GROUP BY voice_id, source').all();
    const learnedCount = (voiceId, source) => (learned.find((l) => l.voice_id === voiceId && l.source === source) || { n: 0 }).n;
    return voices.map((v) => {
      const own = samples.filter((s) => s.voice_id === v.id).map((s) => ({
        id: s.id,
        label: s.label,
        duration: s.duration,
        speechDuration: s.speech_duration,
        createdAt: s.created_at,
      }));
      return {
        id: v.id,
        name: v.name,
        color: v.color,
        createdAt: v.created_at,
        samples: own,
        speechSeconds: own.reduce((n, s) => n + s.speechDuration, 0),
        learned: { live: learnedCount(v.id, 'live'), correction: learnedCount(v.id, 'correction') },
      };
    });
  }

  /** Short form for transcript clients. */
  summary() {
    return this.db.prepare('SELECT id, name, color FROM voices ORDER BY name COLLATE NOCASE').all()
      .map((v) => ({ id: v.id, name: v.name, color: v.color }));
  }

  get(id) {
    const v = this.db.prepare('SELECT * FROM voices WHERE id = ?').get(id);
    if (!v) throw new HttpError(404, 'Voice not found.');
    return v;
  }

  create({ name, color }) {
    const { lastInsertRowid } = this.db.prepare('INSERT INTO voices (name, color) VALUES (?, ?)')
      .run(validateName(name), validateColor(color));
    this.emit('changed');
    return Number(lastInsertRowid);
  }

  update(id, { name, color }) {
    this.get(id);
    if (name !== undefined) this.db.prepare('UPDATE voices SET name = ? WHERE id = ?').run(validateName(name), id);
    if (color !== undefined) this.db.prepare('UPDATE voices SET color = ? WHERE id = ?').run(validateColor(color), id);
    this.emit('changed');
  }

  remove(id) {
    this.get(id);
    this.db.prepare('DELETE FROM voices WHERE id = ?').run(id);
    fs.rmSync(path.join(this.recordingsDir, String(id)), { recursive: true, force: true });
    this.prints.delete(id);
    this.emit('changed');
  }

  /**
   * Adds a recording of the voice. Only the speech parts (found by VAD) are used for the
   * embedding; the full recording is stored so it can be played back and re-embedded later.
   */
  addSample(voiceId, { samples, sampleRate, label = '' }) {
    this.get(voiceId);
    if (!this.engine.ready) throw new HttpError(503, 'Speech models are still loading. Try again in a moment.');
    const audio = this.engine.resample(samples, sampleRate);
    const duration = audio.length / SAMPLE_RATE;
    if (duration > MAX_SAMPLE_SECONDS) throw new HttpError(400, 'Recordings may be at most 10 minutes long.');
    const speech = this.engine.speechOnly(audio);
    const speechDuration = speech.length / SAMPLE_RATE;
    if (speechDuration < MIN_SPEECH_SECONDS) {
      throw new HttpError(400, `Not enough speech in the recording (found ${speechDuration.toFixed(1)} s, need at least ${MIN_SPEECH_SECONDS} s).`);
    }
    const embedding = this.engine.embedLong(speech);
    if (!embedding) throw new HttpError(400, 'Could not compute a voice print from this recording.');

    const file = `${voiceId}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.wav`;
    fs.mkdirSync(path.join(this.recordingsDir, String(voiceId)), { recursive: true });
    fs.writeFileSync(path.join(this.recordingsDir, file), encodeWav(audio, SAMPLE_RATE));
    const { lastInsertRowid } = this.db.prepare(
      'INSERT INTO voice_samples (voice_id, file, label, duration, speech_duration, embedding, model) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(voiceId, file, String(label).slice(0, 120), duration, speechDuration, toBlob(embedding), this.engine.speakerModelName);
    this.refreshPrints(voiceId);
    this.emit('changed');
    return { id: Number(lastInsertRowid), duration, speechDuration };
  }

  removeSample(voiceId, sampleId) {
    const s = this.db.prepare('SELECT * FROM voice_samples WHERE id = ? AND voice_id = ?').get(sampleId, voiceId);
    if (!s) throw new HttpError(404, 'Recording not found.');
    this.db.prepare('DELETE FROM voice_samples WHERE id = ?').run(sampleId);
    fs.rmSync(path.join(this.recordingsDir, s.file), { force: true });
    this.refreshPrints(voiceId);
    this.emit('changed');
  }

  samplePath(voiceId, sampleId) {
    const s = this.db.prepare('SELECT file FROM voice_samples WHERE id = ? AND voice_id = ?').get(sampleId, voiceId);
    if (!s) throw new HttpError(404, 'Recording not found.');
    return path.join(this.recordingsDir, s.file);
  }

  /** Rebuilds the prints of one voice from its recordings and learned lines. */
  refreshPrints(voiceId) {
    const model = this.engine.speakerModelName;
    const samples = this.db.prepare('SELECT embedding, speech_duration FROM voice_samples WHERE voice_id = ? AND model = ?')
      .all(voiceId, model)
      .map((r) => ({ embedding: fromBlob(r.embedding), weight: Math.min(r.speech_duration, 60) }));
    if (!samples.length) {
      // Learned lines alone never make a voice recognizable: there is nothing to anchor them.
      this.prints.delete(voiceId);
      return;
    }
    const enrolled = [meanEmbedding(samples)];
    if (samples.length > 1) enrolled.push(...samples.map((x) => x.embedding));
    const learnedRows = this.db.prepare('SELECT source, embedding, seconds FROM voice_learned WHERE voice_id = ? AND model = ?')
      .all(voiceId, model);
    const live = learnedRows.filter((r) => r.source === 'live').length;
    const corrections = learnedRows.length - live;
    const learned = corrections > 0 || live >= MIN_LIVE_FOR_PRINT
      ? meanEmbedding(learnedRows.map((r) => ({ embedding: fromBlob(r.embedding), weight: Math.min(r.seconds, 15) })))
      : null;
    this.prints.set(voiceId, { enrolled, learned });
  }

  /**
   * Matches a speaker embedding against all enrolled voices; a voice scores its best print.
   * With enrolledOnly, learned prints are ignored (used to decide what may be learned).
   * @returns {{ voiceId: number|null, score: number, scores: {voiceId: number, score: number}[] }}
   */
  identify(embedding, { enrolledOnly = false } = {}) {
    const scores = [];
    for (const [voiceId, p] of this.prints) {
      let score = -1;
      for (const e of p.enrolled) score = Math.max(score, cosine(embedding, e));
      if (p.learned && !enrolledOnly) score = Math.max(score, cosine(embedding, p.learned));
      scores.push({ voiceId, score });
    }
    scores.sort((a, b) => b.score - a.score);
    const best = scores[0];
    const ok = best && best.score >= this.threshold;
    return { voiceId: ok ? best.voiceId : null, score: best ? best.score : 0, scores };
  }

  /**
   * Called for every live line matched to a voice. When learning is on, a line that the
   * enrollment recordings alone attribute to this voice clearly enough is remembered, so the
   * voice print adapts to the room and microphone. Returns true when the line was learned.
   */
  considerLearning(voiceId, embedding, seconds) {
    if (!this.learnFromSpeech || !embedding || seconds < LEARN_MIN_SECONDS) return false;
    const { scores } = this.identify(embedding, { enrolledOnly: true });
    const [best, second] = scores;
    if (!best || best.voiceId !== voiceId) return false;
    if (best.score < this.threshold + LEARN_ABOVE_THRESHOLD) return false;
    if (second && best.score - second.score < LEARN_MIN_LEAD) return false;
    this.addLearned(voiceId, 'live', embedding, seconds);
    return true;
  }

  /**
   * A user said that some lines were spoken by this voice; remember how they sounded.
   * @param items [{ embedding, seconds }]
   * @returns the number of lines learned (very short ones are skipped)
   */
  learnCorrections(voiceId, items) {
    this.get(voiceId);
    let n = 0;
    for (const { embedding, seconds } of items) {
      if (!embedding || seconds < CORRECTION_MIN_SECONDS) continue;
      this.addLearned(voiceId, 'correction', embedding, seconds);
      n++;
    }
    if (n) this.emit('changed');
    return n;
  }

  addLearned(voiceId, source, embedding, seconds) {
    this.db.prepare('INSERT INTO voice_learned (voice_id, source, seconds, embedding, model) VALUES (?, ?, ?, ?, ?)')
      .run(voiceId, source, seconds, toBlob(embedding), this.engine.speakerModelName);
    this.db.prepare(`DELETE FROM voice_learned WHERE voice_id = ? AND source = ? AND id NOT IN (
      SELECT id FROM voice_learned WHERE voice_id = ? AND source = ? ORDER BY id DESC LIMIT ?)`)
      .run(voiceId, source, voiceId, source, MAX_LEARNED[source]);
    this.refreshPrints(voiceId);
  }

  /** Forgets everything learned for a voice (or for all voices), keeping its recordings. */
  forgetLearned(voiceId) {
    if (voiceId === undefined) {
      this.db.prepare('DELETE FROM voice_learned').run();
      for (const id of [...this.prints.keys()]) this.refreshPrints(id);
    } else {
      this.get(voiceId);
      this.db.prepare('DELETE FROM voice_learned WHERE voice_id = ?').run(voiceId);
      this.refreshPrints(voiceId);
    }
    this.emit('changed');
  }
}

module.exports = { VoiceManager };

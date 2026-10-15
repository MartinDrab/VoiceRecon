'use strict';

const { HttpError } = require('./errors');
const { meanEmbedding, embeddingToBlob, embeddingFromBlob } = require('./speech/engine');

const MAX_TEXT = 5000;
const MAX_LABEL = 60;
const MAX_TITLE = 120;
const MARK_START = '\u0002'; // search-hit markers in snippets; the browser turns them into <mark>
const MARK_END = '\u0003';

const two = (n) => String(n).padStart(2, '0');

/** "1:02:03" or "02:03" for a number of seconds. */
function clockOffset(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  return h ? `${h}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${two(Math.floor(s / 60))}:${two(s % 60)}`;
}

/** "00:01:02,345" (SubRip time). */
function srtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return `${two(Math.floor(ms / 3600000))}:${two(Math.floor(ms / 60000) % 60)}:${two(Math.floor(ms / 1000) % 60)},${String(ms % 1000).padStart(3, '0')}`;
}

/** Local date and time "2026-10-15 14:05". */
function localDateTime(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

function localTime(ms) {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** Lower case without diacritics ("Příliš" -> "prilis"), as the search index sees text. */
function fold(text) {
  return String(text).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** The words of a search as FTS5 prefix terms ('"word"*'); punctuation cannot inject syntax. */
function ftsTerms(q) {
  return String(q || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 12).map((w) => `"${w}"*`);
}

/**
 * Saved transcripts. Live sessions append lines as they are recognized; afterwards users can
 * rename a transcript, fix the text of a line, move lines to another speaker, delete lines,
 * search all transcripts and export them.
 */
class TranscriptStore {
  constructor(db, voices) {
    this.db = db;
    this.voices = voices;
    this.recording = new Map(); // transcript id -> number of live sessions writing to it
  }

  /** Live sessions report which transcript they write to, so pages can show "still recording". */
  setRecording(id, on) {
    if (!id) return;
    const n = (this.recording.get(id) || 0) + (on ? 1 : -1);
    if (n > 0) this.recording.set(id, n);
    else this.recording.delete(id);
  }

  create(userId) {
    const now = Date.now();
    const { lastInsertRowid } = this.db.prepare('INSERT INTO transcripts (user_id, started_at, updated_at) VALUES (?, ?, ?)')
      .run(userId, now, now);
    return this.get(Number(lastInsertRowid));
  }

  get(id) {
    const t = this.db.prepare('SELECT * FROM transcripts WHERE id = ?').get(id);
    if (!t) throw new HttpError(404, 'Transcript not found.');
    return t;
  }

  /** Continues a transcript in a new live session (after a reconnect or page reload); null if not allowed. */
  resume(id, user) {
    const t = this.db.prepare('SELECT * FROM transcripts WHERE id = ?').get(id);
    if (!t || t.user_id !== user.id) return null;
    this.db.prepare('UPDATE transcripts SET sessions = sessions + 1 WHERE id = ?').run(id);
    return this.get(id);
  }

  /**
   * @param line { start, end, spokenAt, speaker: { voiceId, key, label }, text, seconds, embedding, model }
   * @returns the new line id
   */
  appendLine(transcriptId, line) {
    const { lastInsertRowid } = this.db.prepare(`INSERT INTO transcript_lines
      (transcript_id, start_sec, end_sec, spoken_at, voice_id, speaker_key, speaker_label, text, seconds, embedding, model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      transcriptId, line.start, line.end, line.spokenAt, line.speaker.voiceId ?? null, line.speaker.key,
      String(line.speaker.label).slice(0, MAX_LABEL), String(line.text).slice(0, MAX_TEXT), line.seconds || 0,
      line.embedding ? embeddingToBlob(line.embedding) : null, line.embedding ? line.model : null,
    );
    this.db.prepare('UPDATE transcripts SET updated_at = ?, duration = MAX(duration, ?) WHERE id = ?')
      .run(Date.now(), line.end, transcriptId);
    return Number(lastInsertRowid);
  }

  /** Speaker fields for a voice ({ voiceId }) or a typed name ({ label }). */
  resolveSpeaker(speaker) {
    if (speaker && Number.isInteger(speaker.voiceId)) {
      const v = this.voices.get(speaker.voiceId);
      return { voiceId: v.id, key: `v:${v.id}`, label: v.name };
    }
    const label = speaker && typeof speaker.label === 'string' ? speaker.label.trim() : '';
    if (!label || label.length > MAX_LABEL) throw new HttpError(400, `Choose a voice or type a name (at most ${MAX_LABEL} characters).`);
    return { voiceId: null, key: `n:${label.toLowerCase()}`, label };
  }

  /**
   * Moves some lines ({ lineIds }) or all lines of one speaker ({ key }) to another speaker.
   * @returns the affected rows as they were before the change
   */
  setSpeaker(transcriptId, { lineIds, key }, speaker) {
    const s = this.resolveSpeaker(speaker);
    let where;
    let params;
    if (Array.isArray(lineIds)) {
      if (!lineIds.length || lineIds.length > 5000) throw new HttpError(400, 'Invalid lines.');
      where = `transcript_id = ? AND id IN (${lineIds.map(() => '?').join(',')})`;
      params = [transcriptId, ...lineIds];
    } else {
      if (typeof key !== 'string') throw new HttpError(400, 'Invalid speaker.');
      where = 'transcript_id = ? AND speaker_key = ?';
      params = [transcriptId, key];
    }
    const rows = this.db.prepare(`SELECT * FROM transcript_lines WHERE ${where}`).all(...params);
    if (!rows.length) throw new HttpError(404, 'Line not found.');
    this.db.prepare(`UPDATE transcript_lines SET voice_id = ?, speaker_key = ?, speaker_label = ? WHERE ${where}`)
      .run(s.voiceId, s.key, s.label, ...params);
    this.touch(transcriptId);
    return rows;
  }

  /**
   * After a user moved lines to a voice: teach the voice how they sounded (one correction made
   * from the average of the lines, so a long transcript does not flood the voice's memory).
   */
  learnFrom(rows, voiceId, model) {
    const usable = rows.filter((r) => r.embedding && r.model === model && r.seconds >= 1);
    if (!usable.length) return 0;
    const embedding = meanEmbedding(usable.map((r) => ({ embedding: embeddingFromBlob(r.embedding), weight: Math.min(r.seconds, 15) })));
    const seconds = usable.reduce((n, r) => n + r.seconds, 0);
    return this.voices.learnCorrections(voiceId, [{ embedding, seconds }]);
  }

  updateText(transcriptId, lineId, text) {
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) {
      throw new HttpError(400, `Text must be 1–${MAX_TEXT} characters long. Delete the line instead of emptying it.`);
    }
    const r = this.db.prepare('UPDATE transcript_lines SET text = ?, edited = 1 WHERE transcript_id = ? AND id = ?')
      .run(text.trim(), transcriptId, lineId);
    if (!r.changes) throw new HttpError(404, 'Line not found.');
    this.touch(transcriptId);
  }

  deleteLine(transcriptId, lineId) {
    const r = this.db.prepare('DELETE FROM transcript_lines WHERE transcript_id = ? AND id = ?').run(transcriptId, lineId);
    if (!r.changes) throw new HttpError(404, 'Line not found.');
    this.touch(transcriptId);
  }

  rename(transcriptId, title) {
    if (typeof title !== 'string' || title.trim().length > MAX_TITLE) throw new HttpError(400, `Titles may be at most ${MAX_TITLE} characters long.`);
    this.get(transcriptId);
    this.db.prepare('UPDATE transcripts SET title = ? WHERE id = ?').run(title.trim(), transcriptId);
  }

  remove(transcriptId) {
    this.get(transcriptId);
    this.db.prepare('DELETE FROM transcripts WHERE id = ?').run(transcriptId);
  }

  touch(transcriptId) {
    this.db.prepare('UPDATE transcripts SET updated_at = ? WHERE id = ?').run(Date.now(), transcriptId);
  }

  /** Lines for display: voices show their current name and color, other speakers their label. */
  lines(transcriptId) {
    this.get(transcriptId);
    return this.db.prepare(`SELECT l.*, v.name AS voice_name, v.color AS voice_color
      FROM transcript_lines l LEFT JOIN voices v ON v.id = l.voice_id
      WHERE l.transcript_id = ? ORDER BY l.start_sec, l.id`).all(transcriptId).map(publicLine);
  }

  /** One transcript's header data (as in the list). */
  summary(transcriptId) {
    return this.summaries([this.get(transcriptId)])[0];
  }

  summaries(rows) {
    if (!rows.length) return [];
    const ids = rows.map((t) => t.id);
    const marks = ids.map(() => '?').join(',');
    const counts = new Map(this.db.prepare(`SELECT transcript_id AS id, COUNT(*) AS n FROM transcript_lines
      WHERE transcript_id IN (${marks}) GROUP BY transcript_id`).all(...ids).map((r) => [r.id, r.n]));
    const speakers = this.db.prepare(`SELECT l.transcript_id AS id, l.speaker_key AS key, COUNT(*) AS n,
        COALESCE(v.name, l.speaker_label) AS name, v.color AS color, v.id AS voiceId
      FROM transcript_lines l LEFT JOIN voices v ON v.id = l.voice_id
      WHERE l.transcript_id IN (${marks}) GROUP BY l.transcript_id, l.speaker_key ORDER BY n DESC`).all(...ids);
    const first = this.db.prepare(`SELECT transcript_id AS id, text FROM transcript_lines WHERE id IN (
      SELECT MIN(id) FROM transcript_lines WHERE transcript_id IN (${marks}) GROUP BY transcript_id)`).all(...ids);
    const users = new Map(this.db.prepare('SELECT id, username FROM users').all().map((u) => [u.id, u.username]));
    return rows.map((t) => ({
      id: t.id,
      title: t.title,
      startedAt: t.started_at,
      updatedAt: t.updated_at,
      duration: t.duration,
      lines: counts.get(t.id) || 0,
      speakers: speakers.filter((s) => s.id === t.id).map((s) => ({ key: s.key, name: s.name, color: s.color, voiceId: s.voiceId, lines: s.n })),
      preview: (first.find((f) => f.id === t.id) || { text: '' }).text.slice(0, 200),
      userId: t.user_id,
      user: users.get(t.user_id) || null,
      recording: this.recording.has(t.id),
    }));
  }

  /**
   * Newest first. With a query, only transcripts that contain all its words somewhere (ignoring
   * case and diacritics, words matched as prefixes), or whose title contains it; each with a few
   * snippets of lines that contain any of the words.
   */
  list({ q = '', limit = 30, offset = 0 } = {}) {
    limit = Math.max(1, Math.min(100, Number(limit) || 30));
    offset = Math.max(0, Number(offset) || 0);
    const terms = ftsTerms(q);
    if (!terms.length) {
      const total = this.db.prepare('SELECT COUNT(*) AS n FROM transcripts').get().n;
      const rows = this.db.prepare('SELECT * FROM transcripts ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?').all(limit, offset);
      return { total, transcripts: this.summaries(rows) };
    }
    // The index matches single lines, so every word is looked up on its own and the transcripts
    // containing all of them are intersected.
    const byTerm = this.db.prepare(`SELECT DISTINCT l.transcript_id AS id
      FROM transcript_lines_fts JOIN transcript_lines l ON l.id = transcript_lines_fts.rowid
      WHERE transcript_lines_fts MATCH ?`);
    let found = null;
    for (const term of terms) {
      const ids = new Set(byTerm.all(term).map((r) => r.id));
      found = found ? new Set([...found].filter((id) => ids.has(id))) : ids;
      if (!found.size) break;
    }
    const wanted = fold(q).trim();
    const titled = this.db.prepare("SELECT id, title FROM transcripts WHERE title <> ''").all()
      .filter((t) => fold(t.title).includes(wanted)).map((t) => t.id);
    const ids = [...new Set([...found, ...titled])];
    const hits = found.size
      ? this.db.prepare(`SELECT l.transcript_id AS id, l.id AS lineId,
            snippet(transcript_lines_fts, 0, '${MARK_START}', '${MARK_END}', '…', 14) AS snippet
          FROM transcript_lines_fts JOIN transcript_lines l ON l.id = transcript_lines_fts.rowid
          WHERE transcript_lines_fts MATCH ? AND l.transcript_id IN (${[...found].map(() => '?').join(',')})
          ORDER BY l.transcript_id DESC, l.start_sec LIMIT 2000`).all(terms.join(' OR '), ...found)
      : [];
    const rows = ids.length
      ? this.db.prepare(`SELECT * FROM transcripts WHERE id IN (${ids.map(() => '?').join(',')})
          ORDER BY started_at DESC, id DESC`).all(...ids)
      : [];
    const page = rows.slice(offset, offset + limit);
    return {
      total: rows.length,
      transcripts: this.summaries(page).map((t) => {
        const own = hits.filter((h) => h.id === t.id);
        return { ...t, hits: own.length, snippets: own.slice(0, 3).map((h) => ({ lineId: h.lineId, text: h.snippet })) };
      }),
    };
  }

  title(t) {
    return t.title || `Transcript of ${localDateTime(t.started_at)}`;
  }

  /** @returns {{ filename, type, body }} */
  export(transcriptId, format) {
    const t = this.get(transcriptId);
    const lines = this.lines(transcriptId);
    const base = `transcript-${t.id}-${localDateTime(t.started_at).slice(0, 10)}`;
    if (format === 'txt') {
      const head = `${this.title(t)}\n${localDateTime(t.started_at)}, ${clockOffset(t.duration)}\n\n`;
      const body = lines.map((l) => `[${localTime(l.spokenAt)}] ${l.speaker.name}: ${l.text}`).join('\n');
      return { filename: `${base}.txt`, type: 'text/plain; charset=utf-8', body: `${head}${body}\n` };
    }
    if (format === 'srt') {
      const body = lines.map((l, i) => {
        const end = Math.max(l.end, l.start + 0.5);
        return `${i + 1}\n${srtTime(l.start)} --> ${srtTime(end)}\n${l.speaker.name}: ${l.text}\n`;
      }).join('\n');
      return { filename: `${base}.srt`, type: 'application/x-subrip; charset=utf-8', body };
    }
    if (format === 'json') {
      const data = {
        id: t.id,
        title: this.title(t),
        startedAt: new Date(t.started_at).toISOString(),
        duration: t.duration,
        lines: lines.map((l) => ({
          start: l.start,
          end: l.end,
          spokenAt: new Date(l.spokenAt).toISOString(),
          speaker: l.speaker.name,
          voiceId: l.speaker.voiceId,
          text: l.text,
          edited: l.edited,
        })),
      };
      return { filename: `${base}.json`, type: 'application/json; charset=utf-8', body: `${JSON.stringify(data, null, 2)}\n` };
    }
    throw new HttpError(400, 'Format must be txt, srt or json.');
  }
}

function publicLine(r) {
  const voice = r.voice_id !== null && r.voice_name !== null;
  return {
    id: r.id,
    start: r.start_sec,
    end: r.end_sec,
    spokenAt: r.spoken_at,
    text: r.text,
    edited: Boolean(r.edited),
    speaker: {
      key: r.speaker_key,
      voiceId: voice ? r.voice_id : null,
      name: voice ? r.voice_name : r.speaker_label,
      color: voice ? r.voice_color : null,
    },
  };
}

module.exports = { TranscriptStore, ftsTerms, srtTime, clockOffset, MARK_START, MARK_END };

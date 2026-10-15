# AGENTS.md

Guidance for AI coding agents working on VoiceRecon. User-facing documentation (setup, features,
configuration) is in [README.md](README.md); this file covers how the code fits together and the
rules that keep it working.

## What this is

A single Node.js server with a plain HTML/JS front end (no build step) that transcribes a live
conversation from the browser microphone and colors the text by speaker. Everything runs offline on
the CPU through [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (`sherpa-onnx-node`, prebuilt
native addon):

- **Silero VAD** cuts the stream into utterances.
- **Parakeet TDT 0.6B v3** (int8) does speech-to-text. It covers Czech, English and 23 other languages, and detects the language automatically; `result.lang` is always empty.
- **CAM++** (3D-Speaker) computes speaker embeddings (voice prints).

The UI and all text are in English; the transcribed speech is mainly Czech.

## Commands

```bash
npm install                          # dependencies (express, ws, sherpa-onnx-node)
npm run models                       # speech models -> models/ (~520 MB, gitignored)
npm run models -- --test             # also the two Czech TTS voices used for test audio
node scripts/make-test-audio.js      # synthetic conversation -> test/fixtures/ (gitignored)
npm test                             # unit + end-to-end tests (node:test)
npm run lint                         # ESLint (eslint.config.js)
npm run typecheck                    # TypeScript checkJs: tsconfig.json (server) + public/tsconfig.json (pages)
npm run check                        # lint + typecheck + test, as CI runs it
npm run evaluate -- test/fixtures    # accuracy report: WER and speaker accuracy (see README)
npm run evaluate -- <dir> --learn 0,1 --change-similarity 0.3,0.5,0.6   # compare settings
npm start                            # http://127.0.0.1:3000
npm run create-user -- <name> [--admin | --user]   # add a user / reset a password
```

- Node 22.13 or newer is required for `node:sqlite`; development used Node 24 on Windows 11.
- `test/e2e.test.js` starts the real server with a temporary `DATA_DIR`, enrolls two voices, streams `test/fixtures/conversation.wav` over the WebSocket and checks speakers, timing and word recall. It **skips** when models or fixtures are missing, so make sure it ran (look for its ✔ line), not just that the suite passed.
- `npm run evaluate -- <folder>` runs the real `TranscriptionSession` offline on a recording and scores it against a hand-written `reference.txt` (no timestamps needed; words are aligned). `--threshold`, `--min-silence` and `--change-similarity` take comma-separated lists for parameter sweeps. `test/fixtures` is a ready-made (synthetic) dataset; real ones are made with the transcript page's *Keep audio for download* + *Download recording*.
- `VOICERECON_DEBUG=1` logs every utterance's recognized text and saves its exact ASR input as WAV files in `%TEMP%/voicerecon-debug`. Use it to diagnose recognition problems before changing parameters.
- Never point a dev or test server at the user's real `data/` folder. Set `DATA_DIR` to a short temporary path.

## Layout

| Path | Role |
|---|---|
| `src/server.js` | Express app: security headers, pages, REST API, startup (models load in the background) |
| `src/ws.js` | WebSocket `/ws/transcribe`: one `TranscriptionSession` per connection, voice-list broadcast |
| `src/transcriber.js` | **Voice Transcriber**: VAD segmentation, interim/final results, speaker-change splitting, unknown-speaker clustering |
| `src/voices.js` | **Voice Manager**: voices, recordings, voice prints (average, per recording, learned), `identify()`, learning from live speech and corrections |
| `src/speech/engine.js` | Loads the models; ASR job queue; `embed`, `embedLong`, `speechOnly`, `resample` |
| `src/auth.js` | Users, scrypt hashes, sessions, login throttling, Express guards |
| `src/db.js` | SQLite (`node:sqlite`), migrations, settings |
| `src/audio.js` | WAV decode/encode, PCM conversion, windowed-sinc `resample()` |
| `src/transcripts.js` | Saved transcripts: lines with speaker keys and voice prints, full-text search (SQLite FTS5), edits, speaker changes, TXT/SRT/JSON export |
| `src/evaluation.js` | Reference parsing, banded word alignment, WER, speaker accuracy by name and after mapping unknown speakers |
| `public/*.html`, `public/static/js/*.js` | Pages: login, transcript, history (list), history-view (one transcript), voices, users (ES modules) |
| `public/static/js/pcm-worklet.js` | AudioWorklet: microphone -> 16 kHz mono Int16, windowed-sinc resampler |
| `scripts/evaluate.js` | Accuracy evaluation CLI (temporary database, ASR results cached across parameter runs) |
| `scripts/` | Also: model downloader, test-audio generator, create-user CLI |

## Data flow

1. The browser captures the mic. `pcm-worklet.js` resamples it to 16 kHz and sends 100 ms Int16 frames as binary WebSocket messages. JSON text messages control the session (`start`, `stop`, `saveUnknown`).
2. `TranscriptionSession.push()` feeds 512-sample windows to the VAD and keeps 40 s of raw history.
3. While someone speaks, an interim transcription runs every 0.8 s, but only when the engine is idle.
4. When the VAD closes an utterance, `segmentDone()` cuts it from the history with padding and queues the final transcription.
5. The serialized `this.chain` then splits the utterance where the voice changes (`speakerTurns`), assigns each part to a voice or unknown speaker (`assignSpeaker`), and emits `final` messages followed by the interim-clear message.
6. `VoiceManager` emits `changed` on any edit; `ws.js` then broadcasts the voice list, so open transcripts recolor and rename immediately.

## Invariants: don't break these

**Audio and speech**
- The whole server pipeline is 16 kHz mono float32 (`SAMPLE_RATE`). Resample at the edges (`engine.resample`, which uses the windowed-sinc `audio.resample`, and the worklet), never in the middle. Plain linear resampling aliases and measurably hurts recognition.
- `TranscriptionSession` takes options (`interim`, `vad`, `changeMaxSimilarity`) for the evaluation script; the server uses the defaults. A new tunable belongs in these options with the current value as default, so it can be swept with `npm run evaluate`.
- All ASR goes through `SpeechEngine.transcribe()`. Never call the recognizer directly: the queue serializes CPU-heavy decoding, runs finals before interims, and tags jobs with an `owner` so `cancel()` can drop work for closed sessions and finished utterances.
- Final ASR input must end with `TAIL_SILENCE` (0.3 s of zeros). Without it Parakeet sometimes drops the last words or a whole trailing sentence. This was verified on real failures.
- `PAD_BEFORE` exists because the VAD reports speech onsets late; short utterances otherwise lose their first words. `PAD_AFTER` is added only when the VAD is not detecting speech, i.e. after a real pause. `lastSegEnd` records the end of audio already given to the recognizer, so consecutive utterances never share audio.
- The VAD's `maxSpeechDuration` is soft: it cuts at the next dip, so utterances can be longer than 15 s. `HISTORY` (40 s) must stay well above that.
- Interim text is cleared only after the utterance's final is emitted (`partialGen`), so text never disappears from the screen. Keep that order.
- Embeddings are L2-normalized, so `cosine()` is a plain dot product. Normalize any new vector before comparing it.
- Speaker-embedding work is synchronous native code (~10–30 ms per call). Loops over many embeddings must `await yieldToEventLoop()` between calls; otherwise audio ingestion stalls for every user.
- A voice scores its **best** print: the recordings' average, each recording (from two on), and the average of learned lines (`voice_learned`). Learning from live speech is gated by `identify(..., { enrolledOnly: true })`: never let learned prints take part in deciding what gets learned, or one wrong match feeds itself. A voice without recordings has no prints at all, whatever it learned.
- Corrections (`correct` / `assignUnknown` WebSocket messages) use the embeddings the session keeps per final line id (`session.recent`); only lines of the current session can be corrected.
- Every `voice_samples` row stores the speaker `model` that produced its embedding. `VoiceManager.init()` re-embeds rows from the stored WAVs when `SPEAKER_MODEL` changes, so keep the original recordings.

**Saved transcripts**
- Each WebSocket connection writes to one transcript (`live` in `ws.js`). It is created with the first final line, continued when `start` names a transcript of the same user (page reload, reconnect), and replaced on `newTranscript`. Saving errors are logged and never interrupt the live transcript.
- `speaker_key` groups a speaker's lines: `v:<voice id>`, `u:<session no>:<unknown id>` (unknown ids restart in every live session, hence the session number), `n:<typed name>`, or `?`. Display names come from the voice when it still exists, otherwise from the stored `speaker_label`.
- Lines keep their voice print (`embedding`, `model`), so moving lines to a voice in History teaches it (`TranscriptStore.learnFrom`: one averaged correction per change).
- The FTS5 index is maintained by triggers on `transcript_lines` (insert, delete, text update); keep text changes going through SQL so the triggers fire. The index matches single lines, so `list()` intersects per-word results to find words spread over a transcript.
- `TranscriptStore.recording` (in memory) says which transcripts have a live session attached; History pages poll only those.

**Never crash the process**
- Code in the WebSocket `upgrade` and `message` listeners runs outside Express. An exception there is uncaught and stops the server. Keep the existing try/catch wrappers and validate every client message (it may be `null` or any JSON).
- Transcriber errors go through `session.fail()`. Never call `this.emit('error')` directly: after `close()` there are no listeners and emit would throw. Promises created ahead of the chain need a handler attached immediately (see `asr.catch(() => {})`).

**Server and security**
- Express 5: async handlers may throw. Throw `HttpError(status, message)` for anything the user should see; other errors become a generic 500. The `json` middleware array guarantees `req.body` is an object.
- The session cookie `vr_session` is HttpOnly and SameSite=Strict, and only the SHA-256 of the token is stored. Changing a password signs out the user's other sessions. The last administrator cannot be demoted or deleted.
- The first administrator can be created only from loopback (`/api/setup`), and the check-and-insert in `createUser(..., { onlyIfNoUsers })` must stay free of `await`.
- Login throttling counts an attempt **before** the slow password check, and unknown usernames are verified against a dummy hash so timing is equal. Preserve both when touching `login()`.
- `parseCookies` must never throw: cookies from other apps on the same host reach this server too.
- The CSP is `script-src 'self'`: no inline scripts and no inline event handlers in HTML. Inline styles are allowed.
- The WebSocket accepts only same-origin browsers (`sameOrigin`) and re-checks the session every 30 s.

**Database**
- `MIGRATIONS` in `src/db.js` is append-only; `PRAGMA user_version` tracks what has run. Never edit a migration that may already exist in someone's database; add a new one.
- Ids use `AUTOINCREMENT` on purpose, so a deleted voice's id is never reused by a new voice (open transcripts still refer to it).

## Code conventions

- Server: CommonJS with `'use strict'`. Browser: ES modules without bundling. Dependencies: only `express`, `ws` and `sherpa-onnx-node`; don't add one for something a few lines can do.
- 2-space indentation, single quotes, semicolons, trailing commas in multi-line literals. Keep lines under ~120 characters where practical.
- One JSDoc block per class or public function, explaining *why* rather than restating the code. Constants carry their unit (`sec(0.4)` = samples) and a short reason.
- Build front-end DOM with `h()` from `common.js` and set user data via text or attributes. Never use `innerHTML` with data (only `icon()` uses it, for fixed SVG).
- Use `api()` from `common.js` for requests; it redirects to the login page on 401.
- Type checking runs on plain JavaScript (`checkJs`, not strict). Add JSDoc types where the checker needs them (optional fields of option objects, `@type {any}` casts for DOM lookups); declarations the code cannot make itself live in `src/types.d.ts` (e.g. `req.user`) and `public/static/js/globals.d.ts` (e.g. `window.voiceReconTheme`). `pcm-worklet.js` is not type-checked (no TypeScript library for worklets) and is covered by `test/worklet.test.js` instead.
- The microphone is chosen in one place: `preferredMicrophone()` in `public/static/js/audio.js`, used by every `MicCapture`; a missing device falls back to the default (`fellBack`).
- User-facing messages are full sentences ending with a period.
- Colors only through the CSS custom properties at the top of `app.css`. The light values are on `:root`; the dark values exist twice, once for the system setting (`@media (prefers-color-scheme: dark) :root:not([data-theme="light"])`) and once for the manual choice (`:root[data-theme="dark"]`). Keep both dark blocks identical and give every new color token a light and a dark value; `test/ui.test.js` checks this. Text in a voice's color goes through `oklch(from var(--c) clamp(var(--voice-l-min), l, var(--voice-l-max)) c h)` so any chosen color stays readable.
- Every page loads `/static/js/theme.js` as a plain (blocking) script before `app.css`; it applies the saved theme before the first paint. Check new UI in both themes (`resize_window` with `colorScheme`, or the theme button).

## Platform gotchas (Windows dev machine)

- SQLite (and Python) cannot open paths longer than 260 characters. Keep `DATA_DIR` and temporary script paths short.
- In Git Bash, `tar` is GNU tar, which reads `C:\...` as a remote host. Pass relative archive paths (see `download-models.js`).
- The machine has no GPU and no microphone. ASR runs at about 5% of real time on 4 vCPUs, and the server uses ~1 GB of RAM.

## Testing the browser UI without a microphone

1. Start a dev server with a temporary `DATA_DIR`.
2. Create the admin through `POST /api/setup` from localhost.
3. Upload a WAV as a voice sample so the page can fetch it, then delete that voice.
4. Before pressing Start, replace `getUserMedia` in the page:

```js
navigator.mediaDevices.getUserMedia = async () => {
  const ctx = new AudioContext();
  await ctx.resume();
  const buf = await ctx.decodeAudioData(wavArrayBuffer.slice(0));
  const dest = ctx.createMediaStreamDestination();
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(dest);
  src.start();
  return dest.stream;
};
```

The transcript keeps its lines in `sessionStorage`; clear it between runs.

The synthetic TTS voices are easier than real speakers: same-voice scores are 0.8–0.95 and
different voices score about 0. Don't tune `SPEAKER_THRESHOLD` (default 0.4) or the change-detection
constants on them alone; tune them with `npm run evaluate` on real recordings.

## Before you finish a change

- Run `npm run check` (lint, type checks, tests) and confirm the end-to-end test actually ran. With `VOICERECON_REQUIRE_MODELS=1` the speech tests fail instead of skipping when models are missing (the nightly CI uses this).
- For transcriber or speech changes, run `npm run evaluate -- test/fixtures` before and after (and on any real dataset available) and compare WER and speaker accuracy. On the fixtures, speaker accuracy must stay 100%; WER was 14.9% when the tool was introduced.
- Update README.md when behavior, configuration or commands change.

# AGENTS.md

Guidance for AI coding agents working on VoiceRecon. User-facing documentation (setup, features,
configuration) is in [README.md](README.md); this file covers how the code fits together and the
rules that keep it working.

## What this is

A single Node.js server with a plain HTML/JS front end (no build step) that transcribes a live
conversation from the browser microphone and colors the text by speaker. Everything runs offline on
the CPU, or on an NVIDIA GPU with `PROVIDER=cuda` (see Invariants), through [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (`sherpa-onnx-node`, prebuilt
native addon):

- **Silero VAD** cuts the stream into utterances.
- **Parakeet TDT 0.6B v3** (fp32 encoder; int8 decoder and joiner on the CPU, fp32 ones on the GPU) does speech-to-text. It covers Czech, English and 23 other languages, and detects the language automatically; `result.lang` is always empty.
- **WeSpeaker ResNet34-LM** computes speaker embeddings (voice prints), with one metadata entry added so that sherpa-onnx normalizes its features (see Invariants).

The UI is in English and Czech (chosen per browser); the transcribed speech is mainly Czech.

## Commands

```bash
npm install                          # dependencies (express, ws, sherpa-onnx-node, opusscript)
npm run models                       # speech models -> models/ (~3 GB download, gitignored)
npm run models -- --test             # also the two Czech TTS voices used for test audio
                                     # (with PROVIDER=cuda also the fp32 decoder and joiner and the CUDA libraries)
node scripts/make-test-audio.js      # synthetic conversation -> test/fixtures/ (gitignored)
npm test                             # unit + end-to-end tests (node:test), one file at a time: the end-to-end
                                     # and evaluation tests both need the CPU, and interim results need it idle
npm run lint                         # ESLint (eslint.config.js)
npm run typecheck                    # TypeScript checkJs: tsconfig.json (server) + public/tsconfig.json (pages)
npm run test:browser                 # browser tests (Playwright, test/browser/); once: npx playwright install chromium --only-shell
npm run check                        # lint + typecheck + test + test:browser, as CI runs it
npm run evaluate -- test/fixtures    # accuracy report: WER and speaker accuracy (see README)
npm run evaluate -- <dir> --learn 0,1 --change-similarity 0.3,0.5,0.6 --split-middle 0,1   # compare settings
npm run deb [-- --arch arm64]        # Debian package -> dist/ (scripts/build-deb.js; works on Windows too)
node scripts/bench-asr.js <FLEURS folder> --variant parakeet-fp32enc-beam4 [--opus]   # speech models' WER (see the file)
node scripts/bench-speaker.js prepare|embed|report ...   # speaker models on VoxPopuli (see the file)
npm start                            # http://127.0.0.1:3000
start.cmd / ./start.sh [--no-browser]   # for users: installs what is missing, starts, opens the browser (scripts/launch.js)
npm run create-user -- <name> [--admin | --user]   # add a user / reset a password
```

- Node 22.13 or newer is required for `node:sqlite`; development used Node 24 on Windows 11.
- `test/e2e.test.js` starts the real server with a temporary `DATA_DIR`, enrolls two voices, streams `test/fixtures/conversation.wav` over the WebSocket and checks speakers, timing and word recall. It **skips** when models or fixtures are missing, so make sure it ran (look for its ✔ line), not just that the suite passed.
- `npm run test:browser` (`playwright.config.js`, `test/browser/`): `global-setup.js` makes a temporary `DATA_DIR` with an `admin` (random password) and the voice Anna (`seed.js`), starts the real server on a free port, signs in, and passes the address, the cookie file and the folder to the tests in `VOICERECON_TEST_*` variables; it stops the server and deletes the folder afterwards. One worker and one server for all files. Each test seeds what it changes: `seedTranscript()` writes a transcript with lines and Opus audio of a tone straight into the running server's database (no models needed), and voices a test creates are deleted after it, so tests are independent and can be repeated (`--repeat-each`) or retried. Tests that need the models call `needsSpeech()` (`fixtures.js`) and skip without them, unless `VOICERECON_REQUIRE_MODELS=1`. Chromium's fake microphone plays `test/fixtures/conversation.wav` once (`--use-file-for-fake-audio-capture`), so live listening is tested end to end in the page. The browser runs with `locale: 'en-US'`, so assertions use the English texts.
- `npm run backup -- [file]` / `npm run restore -- <file>` (`src/backup.js`): the data folder as one tar (`backup.json`, a `VACUUM INTO` copy of the database without `sessions`, `recordings/`, `audio/`); the admin download is `GET /api/backup`. A restore extracts to a new folder, checks its database opens, then swaps it in and keeps the old one as `<DATA_DIR>.before-restore-<time>`; it refuses while the server answers and refuses any other file names (no `..`). From the Users page, `POST /api/backup/restore` streams the file to `DATA_DIR/restore-upload-*.part`, checks it (`checkBackup()`, nothing extracted) and keeps it as `DATA_DIR/restore-pending.tar`; `server.js` calls `applyPendingRestore()` before `openDatabase()`, which moves it next to the data folder first (Windows cannot rename a folder holding an open file), restores it, deletes it whatever happens (tried once) and writes `restore-result.json` for the page. *Restart now* (`POST /api/restart`, only when `supervised()`) answers, then shuts down with `RESTART_CODE`; the page waits until the server stops answering `/api/setup` and answers again, then reloads. `test/launch.test.js` runs the real launcher to check both restarts (it skips without the models: the launcher would download them).
- `npm run export-test -- <transcript id> <folder>` turns a transcript corrected in History (with kept audio) into such a folder: `conversation.wav`, `reference.txt`, `voices/`.
- `npm run evaluate -- <folder>` runs the real `TranscriptionSession` offline on a recording and scores it against a hand-written `reference.txt` (no timestamps needed; words are aligned). `--threshold`, `--min-silence` and `--change-similarity` take comma-separated lists for parameter sweeps. `test/fixtures` is a ready-made (synthetic) dataset; real ones are made with the transcript page's *Keep audio for download* + *Download recording*.
- `VOICERECON_DEBUG=1` logs every utterance's recognized text and saves its exact ASR input as WAV files in `%TEMP%/voicerecon-debug`. Use it to diagnose recognition problems before changing parameters.
- Never point a dev or test server at the user's real `data/` folder. Set `DATA_DIR` to a short temporary path.
- `src/config.js` also reads a `.env` file in the project folder (environment variables win). A developer's `.env` therefore reaches tests and scripts too; tests that start a server set what they depend on explicitly (see the `env` in `test/e2e.test.js`). The model file list lives in `config.modelFiles`, shared by the speech engine and the launcher.

## Layout

| Path | Role |
|---|---|
| `src/server.js` | Express app: security headers, pages, REST API, startup (models load in the background) |
| `src/ws.js` | WebSocket `/ws/transcribe`: one `TranscriptionSession` per connection, voice-list broadcast |
| `src/uploads.js` | Uploaded recordings: streamed to `DATA_DIR/uploads`, transcribed one at a time in the background into a new transcript; also transcribes a saved transcript again from its kept audio (`again()`: one session per audio piece, lines replaced when its turn comes, wall-clock times taken from the old lines, pieces held against the size limit meanwhile) |
| `src/regroup.js` | Speakers of a whole recording decided per speaker (merge alike speakers, move clearly misplaced lines, name unknown speakers whose average matches a voice); run on the saved lines (`TranscriptStore.regroup()`) when an uploaded file is done, when a live connection stops writing to a transcript, and from History (*Re-check speakers*); `npm run evaluate -- --regroup` measures it |
| `src/transcriber.js` | **Voice Transcriber**: VAD segmentation, interim/final results, speaker-change splitting, unknown-speaker clustering |
| `src/voices.js` | **Voice Manager**: voices, recordings, voice prints (average, per recording, learned), `identify()`, learning from live speech and corrections |
| `src/speech/engine.js` | Loads the models; ASR job queue (beam search with names and terms, `setHotwords`; `decode()` retries a too-short result in halves); `embed`, `embedLine`, `embedLong`, `speechOnly`, `resample` |
| `src/speech/gpu-libs.js` | `PROVIDER=cuda`: sherpa-onnx's CUDA build of ONNX Runtime per platform (file names, SHA-256), where its libraries must go and why (copied next to the addon on Windows, `LD_LIBRARY_PATH` on Linux), the NVIDIA libraries to look for before asking for CUDA, and whether CUDA really loaded |
| `src/speech/voice-worker.js` | Worker thread for voice prints of whole recordings (`engine.analyzeRecording()`): decode, resample, find speech, embed, encode |
| `src/auth.js` | Users, scrypt hashes, sessions, login throttling, Express guards |
| `src/db.js` | SQLite (`node:sqlite`), migrations, settings |
| `src/audio.js` | WAV decode/encode, PCM conversion, windowed-sinc `resample()` |
| `src/transcripts.js` | Saved transcripts: lines with speaker keys and voice prints, full-text search (SQLite FTS5) with filters by voice and start time, edits, speaker changes, TXT/SRT/VTT/DOCX/JSON export |
| `src/docx.js` | A transcript as a Word document: a few Office Open XML parts in a zip written with `zlib` (no dependency) |
| `src/audio-store.js` | Audio kept with transcripts (`DATA_DIR/audio`, table `transcript_audio`): pieces that each start at a transcript time, live audio encoded to Opus as it arrives (`ws.js`) or an uploaded WAV kept after transcription (`uploads.js`) and converted to Opus in the background (`convert()`, also legacy WAV/PCM pieces at startup); clips and whole-transcript WAV for History, decoded on the fly, and the whole audio as one Ogg Opus file (`opus()`: the pieces' packets copied, silence packets between); `pcm()` for transcribing again; size limit |
| `src/opus.js` | Ogg Opus writer and reader (16 kHz mono, 32 kbps, AUDIO mode, 20 ms packets, one-second pages) on `opusscript` (libopus as WebAssembly) |
| `src/evaluation.js` | Reference parsing, banded word alignment, WER, speaker accuracy by name and after mapping unknown speakers |
| `public/*.html`, `public/static/js/*.js` | Pages: login, transcript, history (list), history-view (one transcript), voices, users (ES modules) |
| `public/static/js/pcm-worklet.js` | AudioWorklet: microphone -> 16 kHz mono Int16, windowed-sinc resampler |
| `scripts/evaluate.js` | Accuracy evaluation CLI (temporary database, ASR results cached across parameter runs) |
| `scripts/launch.js` | One-step start behind `start.cmd` / `start.sh`: checks Node, installs missing dependencies and models, starts the server, opens the browser; only opens the browser when VoiceRecon already runs; starts the server again when it exits with `RESTART_CODE` |
| `scripts/build-deb.js`, `packaging/deb/` | The Debian package: the ar and tar archives are written in JS (no dpkg-deb; the tar header writer is `src/backup.js`'s `tarHeader()`), the production dependencies come from `npm ci --omit=dev --os=linux --cpu=…` (sherpa-onnx's Linux build); the systemd unit runs `launch.js` as the user `voicerecon` with `/etc/voicerecon/voicerecon.env`, `/usr/bin/voicerecon` runs the CLI tools as that user. `packaging/deb/test-install.sh` installs it on Ubuntu and purges it (the CI job `deb`, and `release.yml` before publishing). A pre-release `x.y.z-rc.1` gets the Debian version `x.y.z~rc.1` (sorts before `x.y.z`); the file name keeps the hyphen, because GitHub renames `~` in release files |
| `.github/workflows/release.yml` | On a tag `v<version>` (made by `npm version`, which must match `package.json`): packages for amd64 and arm64, the amd64 one install-tested, then a GitHub release with both, `SHA256SUMS` and generated notes (`-` in the version: a pre-release) |
| `src/restart.js` | Restarting from the Users page: `RESTART_CODE` (75) and `supervised()` (`VOICERECON_SUPERVISED=1`, set by the launcher: only then is a restart offered, `POST /api/restart`) |
| `scripts/` | Also: model downloader, test-audio generator, create-user CLI |

## Data flow

1. The browser captures the mic. `pcm-worklet.js` resamples it to 16 kHz and sends 100 ms Int16 frames as binary WebSocket messages. JSON text messages control the session (`start`, `stop`, `saveUnknown`).
2. `TranscriptionSession.push()` feeds 512-sample windows to the VAD and keeps 40 s of raw history.
3. While someone speaks, an interim transcription runs every 0.8 s, but only when the engine is idle.
4. When the VAD closes an utterance, `segmentDone()` cuts it from the history with padding and queues the final transcription.
5. The serialized `this.chain` then splits the utterance where the voice changes (`speakerTurns`), assigns each part to a voice or unknown speaker (`assignSpeaker`), and emits `final` messages followed by the interim-clear message.
6. `VoiceManager` emits `changed` on any edit; `ws.js` then broadcasts the voice list, so open transcripts recolor and rename immediately.

Uploaded files take the same path from step 2 on. *Transcribe a file* (`transcribe-file.js`, on the History page and in the Transcript page's menu) reads the file in the browser (`media.js`; the dialog in `file-length.js`, shared with voice recordings on the Voices page, shows its length and reads only the part the user chooses: a start time and a length) and uploads it as 16 kHz mono 16-bit WAV (`POST /api/transcripts/upload`, streamed to disk; `?offset=` is where the part starts, and `UploadQueue.save()` adds it to every line's times, so they are those of the whole recording). `UploadQueue` creates the transcript at once and feeds the file to a `TranscriptionSession` with `{ interim: false, learn: false, background: true }`, a few seconds at a time, waiting for `session.settled()` in between. Progress is in `TranscriptStore.processing` (in memory, like `recording`).

## Invariants: don't break these

**Audio and speech**
- The whole server pipeline is 16 kHz mono float32 (`SAMPLE_RATE`). Resample at the edges (`engine.resample`, which uses the windowed-sinc `audio.resample`, and the worklet), never in the middle. Plain linear resampling aliases and measurably hurts recognition.
- Speaker changes inside an utterance (`speakerTurns`): `voiceChanges()` first cuts where one enrolled voice clearly takes over from another (each 1.5 s window matched with `identify()`, one clear window is enough), then `split()` cuts each part where its halves sound least alike. When no single cut is unlike enough, `split()` cuts out the middle stretch (at least `CHANGE_MIN_MIDDLE` windows) that sounds least like the rest of the part around it, if that is below the same similarity: A–B–A (B answers and A goes on, without a pause) needs both cuts at once, because any one cut leaves A in both halves, which then still sound alike, and `voiceChanges()` sees no change while only one of A and B is enrolled. Voice prints of window ranges come from running sums, so the middle search (all pairs of cuts) costs ~5 ms on the main thread for a 20 s utterance and ~13 ms for 30 s. `cutWords()` maps the cut times to word boundaries; when no word follows a cut (the recognizer missed the next speaker's words), all words stay with the earlier part. Each part is then split into lines at sentence ends (`sentenceLines()`: at least 3 s per line, not after an ordinal like "32."); its lines share the part's speaker and voice print.
- `TranscriptionSession` takes options (`interim`, `learn`, `background`, `vad`, `changeMaxSimilarity`, `splitMiddle`); live sessions use the defaults, uploaded files and the evaluation script set some. A new tunable belongs in these options with the current value as default, so it can be swept with `npm run evaluate`.
- Parakeet runs with the fp32 encoder (`encoder.onnx`, which loads `encoder.weights` from its own folder) and the int8 decoder and joiner of the int8 package. On FLEURS Czech (723 utterances, beam search) the int8 encoder had 21.6 % WER against 11.0 % at the same speed (English, 647 utterances: 9.8 % against 6.0 %); fp32 decoder and joiner gain only 0.3 points more but double the decoding time, because beam search runs them many times. The price is ~1.5 GB more RAM and ~0.7 s more loading time. Both encoder files are in `config.modelFiles`, so a missing `encoder.weights` stops loading with the missing-files message (and makes the launcher download it); without that check the native code ends the whole process without a word. `tokens.txt` is the same in both packages, so the vocabulary and hotwords are unaffected.
- `PROVIDER=cuda` (`config.provider`) gives the recognizer and the speaker-embedding extractor `provider: 'cuda'`, and the recognizer the fp32 decoder and joiner (`decoder.onnx`, `joiner.onnx`, downloaded next to the int8 ones): ONNX Runtime has no CUDA kernel for the int8 models' `DynamicQuantizeLinear`, so with them part of every decoding step ran on the CPU (19 s of speech on an RTX 5060: 0.63 s, against 0.41 s with fp32 and 1.6 s on 4 CPU threads; greedy search 0.13 s, so on the GPU the beam search's per-frame decoder and joiner calls are the cost, not the encoder). The VAD always stays on the CPU (`provider: 'cpu'`: 32 ms steps of a tiny model). `SpeechEngine.chooseProvider()` asks for CUDA only when `gpu.missingPrerequisites()` finds the NVIDIA libraries (cuDNN, cuBLAS, …): a missing one does not throw, sherpa-onnx ends the whole process when the recognizer is created or at the first decode. After loading, `gpu.cudaLoaded()` (the process's shared objects from `process.report`) says whether CUDA really was used; the addon cannot say, and sherpa-onnx only logs its fallback. `engine.provider` is the provider in use (`/api/status`); the voice-print worker gets it in `workerData`. On CUDA, `load()` decodes a second of silence so that cuDNN's start-up (about 0.3 s) does not land in someone's first sentence.
- The CUDA libraries are sherpa-onnx's own release package of the same version as `sherpa-onnx-node` (`gpu-libs.js` pins the file names and SHA-256 values: bump them together with `package.json`). Only the ONNX Runtime libraries differ: sherpa-onnx picks the provider at run time from `Ort::GetAvailableProviders()`, not at compile time. Where they go is platform-specific for a reason. On Windows they are copied next to `sherpa-onnx.node`, because Node loads addons with `LOAD_WITH_ALTERED_SEARCH_PATH` and imports resolve from that folder before `PATH` (so `npm install` undoes it; `launch.js` and `download-models.js` copy again). On Linux they stay in `MODELS_DIR/gpu-libs` and `launch.js` puts that folder in the server's `LD_LIBRARY_PATH`, which the addon's `RUNPATH` (`$ORIGIN`) yields to, while the npm package's `libsherpa-onnx-c-api.so` has an `RPATH` that would not; and `/usr/lib/voicerecon` is read-only to the Debian service. So on Linux `node src/server.js` alone cannot use the GPU; `start.sh`, `launch.js` and the service can. The Linux path was derived from the ELF headers and not yet run on a GPU.
- Names and terms ("hotwords") need beam search (`modified_beam_search`, 4 paths: 20–40 % slower than greedy) and a BPE vocabulary file to turn words into the model's tokens. Parakeet ships only `tokens.txt`, so `loadVocabulary()` writes `voicerecon-bpe.vocab` next to it (score = -id). One phrase the model cannot spell makes the recognizer drop the whole list, so `setHotwords()` filters with `spellable()`. Boosts per token: voice names 1, the Voices page's terms 2 (`NAME_BOOST`, `TERM_BOOST` in `voices.js`): on real recordings 2 fixed a name 1 missed, but on test/fixtures 2 turned "Byli" into "Jili" for the voice name "jirka". The server keeps the list current on every `voices` change (`syncHotwords`); `npm run evaluate` uses the voices' names and `--words`.
- sherpa-onnx 1.13.8's beam search for TDT models sometimes returns nothing or a lone "Yeah." for clear speech (k2-fsa/sherpa-onnx#3267; in English test conversations built from VoxPopuli 19–22 % of the words, in Czech ones built from real recordings 0.5 %). `decode()` re-decodes a final result with fewer than 0.5 tokens per second over at least 2 s in two halves (interim results are never retried: they are replaced within a second and would hold the queue up), cut at the quietest 20 ms of the middle third (twice at most), and keeps whichever result has more tokens; the halves' word times are shifted, so `cutWords()` still works. `setConfig()` cannot switch the decoder to greedy (it is built once), and a second fp32 recognizer would cost 2.1 GB of RAM.
- All ASR goes through `SpeechEngine.transcribe()`. Never call the recognizer directly: the queue serializes CPU-heavy decoding, runs finals before interims before background jobs (uploaded files), and tags jobs with an `owner` so `cancel()` can drop work for closed sessions and finished utterances. `engine.idle` ignores background jobs, so live interim results keep coming while a file is transcribed.
- An uploaded file must never get ahead of live work: `UploadQueue` feeds it in 1 s pieces with an event-loop turn between them and waits for the session to settle after every 5 s. Keep it that way, and keep one file at a time.
- Final ASR input must end with `TAIL_SILENCE` (0.3 s of zeros). Without it Parakeet sometimes drops the last words or a whole trailing sentence. This was verified on real failures.
- Utterances shorter than `SHORT_UTTERANCE` (2.5 s) go through `recognize()` with context: the last 4 s of earlier speech, 0.5 s of silence, then the utterance; `dropLead()` keeps only the tokens timed after the context. Alone, Parakeet often picks the wrong language for them (verified on a real recording; on test/fixtures the WER fell from 14.9 % to 10.4 %). Results keep times relative to the utterance, so `splitWords()` works on them unchanged.
- `PAD_BEFORE` exists because the VAD reports speech onsets late; short utterances otherwise lose their first words. `PAD_AFTER` is added only when the VAD is not detecting speech, i.e. after a real pause. `lastSegEnd` records the end of audio already given to the recognizer, so consecutive utterances never share audio.
- The VAD's `maxSpeechDuration` is soft: it cuts at the next dip, so utterances can be longer than 15 s. `HISTORY` (40 s) must stay well above that.
- Interim text is cleared only after the utterance's final is emitted (`partialGen`), so text never disappears from the screen. Keep that order.
- `transcript_lines.speaker_manual` marks speakers a user chose (`setSpeaker()`: History, live corrections, saving or assigning an unknown speaker). `regroup()` and `moveLines()` never change those lines; keep any new way of setting a speaker by hand going through `setSpeaker()`.
- Kept audio must stay aligned with line times: a live piece starts at `session.audioSeconds + live.offset` of its first frame and holds exactly the frames pushed to the session, so transcript time t is sample `16000 * (t - start)` of the piece (the end-to-end test compares the loudness of a played clip with the streamed audio every 20 ms). Opus pieces keep this: the pre-skip in each file's OpusHead removes the encoder's delay (312 in AUDIO mode; files written in VOIP mode before 2026-10-17 say 309, and readers go by the header), `end()` encodes one more silent frame so the last samples come out, and the final page's granule position gives the exact length. A file still being written can be read up to its last full page minus the encoder's delay; `wav()` pads whatever a piece lacks with silence so the promised length always holds. A piece's file is swapped to its Opus copy only while nothing holds it (`hold()`: transcribing again, and every WAV or Opus download while it streams, since parts are opened only when their turn comes); otherwise the conversion waits for `release()`. Any change to `live.offset` (`newTranscript`, `attach`) must end the current piece first (`endPiece()`). An uploaded file's piece starts at its `offset`.
- Embeddings are L2-normalized, so `cosine()` is a plain dot product. Normalize any new vector before comparing it.
- Speaker-embedding work is synchronous native code: ResNet34-LM takes ~16 ms per second of audio at the speaker model's 2 threads (24 ms for a 1.5 s window, twice CAM++). Loops over many embeddings must `await yieldToEventLoop()` between calls; otherwise audio ingestion stalls for every user. For the same reason a final part's voice print is the mean of the 1.5 s windows `speakerTurns()` already embedded (those wholly inside the part; 0.98 cosine to embedding the part again, same margin to other voices), an interim result's is that of the utterance's last 6 s only (`PARTIAL_VOICE`; a print of the whole utterance so far grew with every interim result), and anything else goes through `engine.embedLine()`, which embeds anything longer than 6 s in equal pieces with an event-loop turn between them and averages them (on a 14 s clip 0.997 cosine to the whole-clip print). Never call `embed()` on audio of unbounded length on the main thread: a 15 s line would block it for ~0.24 s.
- The speaker model is `wespeaker_resnet34_LM_cmn.onnx`: the sherpa-onnx release's `wespeaker_en_voxceleb_resnet34_LM.onnx` with `feature_normalize_type=global-mean` appended to its ONNX metadata (`addMetadata()` in `download-models.js`, which checks the SHA-256 before and after). WeSpeaker models are trained on mean-normalized features (CMN), but the release files lack that entry, and sherpa-onnx 1.13.8 subtracts the mean only when the metadata names it. Without it the voice print follows the loudness (the same speech at −20 dB scored 0.71 against itself) and Czech EER was 17 % instead of 1.34 % (CAM++: 1.72 %). Any other WeSpeaker file needs the same fix; check a new speaker model by embedding the same speech at two volumes (cosine should be ~1.0). The patched file has its own name so that installs re-embed their recordings.
- Unknown speakers are joined at `JOIN_SIMILARITY` (0.5), not at the match threshold (0.6): an unknown speaker's print comes from a few short lines, and a stricter value splits one person into several speakers (on the four enrolled voices, grouping was clean from 0.4 to 0.6 and split people from 0.65). `npm run evaluate -- … --join-similarity` sweeps it.
- `CHANGE_MAX_SIMILARITY` (0.5), `VOICE_MARGIN` and the `LEARN_*` constants were set with CAM++ and kept for ResNet34-LM: its scores are on the same scale (same-speaker 5th percentile at 3 s 0.61 vs 0.60), and halves of one utterance split at 0.5 with 0.8 % false splits and 0.6 % missed changes (CAM++: 0.6 % / 1.2 %). On a conversation made from the four real enrolled voices (turns 0.15–0.8 s apart, each person in turn not enrolled), a change similarity of 0.7 split an A–B–A stretch with an unenrolled A that 0.5 credits wholly to B (55 % → 4 % of A's words named), but it also split people's own speech (enrolled words named right 95–98 % instead of 98–100 %); 0.6 changed nothing. One cut at a time cannot split A–B–A, so `split()`'s middle search (`splitMiddle`) fixes it at 0.5 instead: on that conversation the unenrolled people's words given a name fell from 11.5 / 55.1 % to 0 / 2.0 % (one word, as with pauses between all turns), enrolled words named right stayed 97.7–100 %, and with pauses between all turns (no merged utterances) and on `test/fixtures` nothing changed. On 714 one-speaker stretches of 4–20 s cut from the four recordings it added no split; a 2-window middle added two (1 s cut out of 20 s), hence `CHANGE_MIN_MIDDLE` = 3. On 96 mixes each of A–B–A and B–A–B with no pause (pieces of 2–7 s, A unenrolled), both changes were found 93 and 89 times instead of 12 and 18, and A's speech got a name 2 % and 12 % of the time instead of 26 % and 77 %.
- Files are read in the browser by `media.js`. MP4/M4A/MOV with AAC and WAV are read piece by piece: `containers.js` finds the frames (MP4 sample tables, `co64` for files over 4 GB) or the samples, WebCodecs `AudioDecoder` decodes the AAC frames, and `resample.js` converts to 16 kHz as they come (bit for bit what `resample()` in `src/audio.js` gives). Their length is known from the header, only the chosen part is decoded, and any length fits in memory. Other formats go through `decodeFile()` (`decodeAudioData`), which decodes the whole file at its own rate first: a 2.1-hour M4A needed 2.7 GB that way and failed with a misleading "not an audio format" message. `containers.js` and `resample.js` have no imports, so `test/media.test.js` runs them in Node.
- Whole recordings (voice samples, *Test recognition*, saving an unknown speaker) go through `engine.analyzeRecording()`, which runs `analyze()` in `voice-worker.js` with its own speaker model: on the main thread a 10-minute recording stopped the server for 5.8 s; in the worker the slowest request meanwhile took 20 ms. Never call `speechOnly()`/`embedLong()` on a whole recording on the main thread (only `VoiceManager.init()` does, at startup, when the speaker model changed). If the worker fails, the work falls back to the main thread. `VoiceManager.addSample()` and `TranscriptionSession.saveUnknown()` are therefore async.
- A voice scores its **best** print: the recordings' average, each recording (from two on), and the average of learned lines (`voice_learned`). Learning from live speech is gated by `identify(..., { enrolledOnly: true })`: never let learned prints take part in deciding what gets learned, or one wrong match feeds itself. A voice without recordings has no prints at all, whatever it learned.
- Corrections (`correct` / `assignUnknown` WebSocket messages) use the embeddings the session keeps per final line id (`session.recent`); only lines of the current session can be corrected.
- Every `voice_samples` row stores the speaker `model` that produced its embedding. `VoiceManager.init()` re-embeds rows from the stored WAVs when `SPEAKER_MODEL` changes, so keep the original recordings.
- A threshold saved on the Voices page (`settings.speakerThreshold`) is stored with the model it was set for (`speakerThresholdModel`) and counts only for that model (`savedThreshold()`); with another model the default applies, because scores of different models are on different scales. A threshold saved before the model was recorded counts for the model of the recordings' prints; `init()` pins it before re-embedding them.

**Saved transcripts**
- Each WebSocket connection writes to one transcript (`live` in `ws.js`). It is created with the first final line, continued when `start` names a transcript of the same user (page reload, reconnect), and replaced on `newTranscript`. Saving errors are logged and never interrupt the live transcript.
- `speaker_key` groups a speaker's lines: `v:<voice id>`, `u:<session no>:<unknown id>` (unknown ids restart in every live session, hence the session number), `n:<typed name>`, or `?`. Display names come from the voice when it still exists, otherwise from the stored `speaker_label`.
- Lines keep their voice print (`embedding`, `model`), so moving lines to a voice in History teaches it (`TranscriptStore.learnFrom`: one averaged correction per change).
- The FTS5 index is maintained by triggers on `transcript_lines` (insert, delete, text update); keep text changes going through SQL so the triggers fire. The index matches single lines, so `list()` intersects per-word results to find words spread over a transcript.
- `TranscriptStore.recording` (in memory) says which transcripts have a live session or an uploaded file attached; History pages poll only those. Uploaded files never teach voices (`learn: false`), and their temporary WAVs are deleted when done and on startup.

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

- Server: CommonJS with `'use strict'`. Browser: ES modules without bundling. Dependencies: only `express`, `ws`, `sherpa-onnx-node` and `opusscript` (an Opus codec is not a few lines); don't add one for something a few lines can do.
- 2-space indentation, single quotes, semicolons, trailing commas in multi-line literals. Keep lines under ~120 characters where practical.
- One JSDoc block per class or public function, explaining *why* rather than restating the code. Constants carry their unit (`sec(0.4)` = samples) and a short reason.
- Build front-end DOM with `h()` from `common.js` and set user data via text or attributes. Never use `innerHTML` with data (only `icon()` uses it, for fixed SVG).
- Use `api()` from `common.js` for requests; it redirects to the login page on 401.
- Type checking runs on plain JavaScript (`checkJs`, not strict). Add JSDoc types where the checker needs them (optional fields of option objects, `@type {any}` casts for DOM lookups); declarations the code cannot make itself live in `src/types.d.ts` (e.g. `req.user`) and `public/static/js/globals.d.ts` (e.g. `window.voiceReconTheme`). `pcm-worklet.js` is not type-checked (no TypeScript library for worklets) and is covered by `test/worklet.test.js` instead.
- The microphone is chosen in one place: `preferredMicrophone()` in `public/static/js/audio.js`, used by every `MicCapture`; a missing device falls back to the default (`fellBack`).
- User-facing messages are full sentences ending with a period.
- Colors only through the CSS custom properties at the top of `app.css`. The light values are on `:root`; the dark values exist twice, once for the system setting (`@media (prefers-color-scheme: dark) :root:not([data-theme="light"])`) and once for the manual choice (`:root[data-theme="dark"]`). Keep both dark blocks identical and give every new color token a light and a dark value; `test/ui.test.js` checks this. Text in a voice's color goes through `oklch(from var(--c) clamp(var(--voice-l-min), l, var(--voice-l-max)) c h)` so any chosen color stays readable.
- Every page loads `/static/js/boot.js` as a plain (blocking) script before `app.css`; it applies the saved theme and sets `<html lang>` before the first paint. Check new UI in both themes (`resize_window` with `colorScheme`, or the theme button) and in both languages.
- **Every user-facing text is translated; English is the key.** Pages: mark static HTML with `data-i18n` (the text is the key; a template like `data-i18n="Press {0} or {1}."` keeps child elements as `{0}`, `{1}`) or `data-i18n-attr="placeholder,title"`; in scripts use `t('Text with {name}', { name })` and `plural(n, '{n} line', '{n} lines')` from `common.js`, always with string literals. Add the Czech text to `public/static/js/lang/cs.js` (counts need `one`, `few` and `other` forms). Server: throw `new HttpError(status, 'Text with {name}.', { name })`, never a message built with `${}`, and add the Czech text to `src/lang/cs.js`; the error handler and the WebSocket translate it for each client (`vr_lang` cookie, else `Accept-Language`). Stored data stays in English (e.g. `Speaker 2`, `From live transcript`) and is translated when shown. `test/i18n.test.js` fails on a missing or unused Czech text. Dates and numbers go through `locale` / `formatNumber()` (Czech uses `15. 10. 2026` and `0,40`).

## Platform gotchas (Windows dev machine)

- SQLite (and Python) cannot open paths longer than 260 characters. Keep `DATA_DIR` and temporary script paths short.
- In Git Bash, `tar` is GNU tar, which reads `C:\...` as a remote host. Pass relative archive paths (see `download-models.js`).
- The machine has no GPU and no microphone. ASR runs at about 5% of real time on 4 vCPUs, and the server uses ~2.3 GB of RAM after loading the models (3.3 GB peak over a long run). The GPU numbers in README.md and above come from a laptop with an RTX 5060 (Windows 11, CUDA 13.4, cuDNN 9.26).
- cuDNN's Windows installer does not put its `bin` folder (e.g. `C:\Program Files\NVIDIA\CUDNN\v9.26\bin\13.4\x64`) on `PATH`. Without it, `PROVIDER=cuda` now falls back to the CPU with a warning; before `chooseProvider()` the recognizer loaded fine and the first decode ended the process ("LoadLibrary failed for cudnn64_9.dll").

## Testing the browser UI without a microphone

`npm run test:browser` covers the pages automatically (see Commands); add a test in `test/browser/` for new behavior there. To look at a page by hand, e.g. in an agent's browser pane, where Chromium's fake-microphone flags are not available:

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
different voices score about 0. Don't tune `SPEAKER_THRESHOLD` or the change-detection constants on
them alone; tune them with `npm run evaluate` on real recordings. `CHANGE_MAX_SIMILARITY` 0.5 was
chosen on three real 60 s recordings: at 0.3 most speaker changes without a pause stayed in one line.
The threshold 0.6 was chosen for ResNet34-LM on Czech parliament speeches (VoxPopuli, 52 speakers,
10 enrolled voices): people who were not enrolled got a name for 0.6 / 1.1 / 1.8 % of their
1.5 / 3 / 6 s segments, enrolled people were named correctly for 78 / 96 / 99 %, and enrolled people
almost never got someone else's name (≤ 0.1 %). CAM++ at the old 0.5 gave 12 / 21 / 33 % false
names, which matches what real recordings showed (people who were not enrolled scoring up to 0.50).
0.55 is the balanced optimum if unknown short lines matter more than occasional false names.

## Before you finish a change

- Run `npm run check` (lint, type checks, tests, browser tests) and confirm the end-to-end test and the speech browser tests actually ran (not `-` skipped). With `VOICERECON_REQUIRE_MODELS=1` the speech tests fail instead of skipping when models are missing (the nightly CI uses this).
- For transcriber or speech changes, run `npm run evaluate -- test/fixtures` before and after (and on any real dataset available) and compare WER and speaker accuracy. On the fixtures, speaker accuracy must stay 100%; WER was 14.9% when the tool was introduced.
- Update README.md when behavior, configuration or commands change.

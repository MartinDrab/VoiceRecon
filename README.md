# Voice Recognizer and Speech to Text

The goal of this project is to listen to a realtime conversation (in realtime), recognize individual voices and write down what they are saying, marking who says what and distinguishing texts corresponding to individual voices by colors.

## Components

- **Voice Manager**. Examines input voice data stream and matches them to its database of voices. Apart from its data, a color and name is defined for each voice. New voices can be added, existing ones removed or modified (their color or name changed, new voice data specified). The component obtains voice data from given voice recordings.
- **Voice Transcriber**. Responsible for converting input voice data to text. Czech language needs to be supported, English is optional.Transcribing needs to be done in realtime since the voice data can come from microphone.
- **Web Interface**. Gives the user an ability to communicate with other components (manage voice recordings, voice names and colors). Also, it listens to microphone, sends the recording to other components and writes down the transcript (including identification of individual voices). One page should take care of voice management, one should be responsible for the transcript in realtime and should basically display nothing else if possible. Another page should take care of user management. User authentication is needed to access the application.

Can be implemented in any set of languages suitable for individual tasks (C, Delphi, Go, Node.js etc.) and are installed on this computer.

---

## Implementation

VoiceRecon is a single Node.js server with a plain HTML/JS front end. All speech processing runs
**locally on the CPU**: no cloud services, no API keys, and no audio leaves the computer.

| Component | Where | Technology |
|---|---|---|
| Voice Transcriber | [src/transcriber.js](src/transcriber.js), [src/speech/engine.js](src/speech/engine.js) | [Silero VAD](https://github.com/snakers4/silero-vad) cuts the stream into utterances; [NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) (int8) transcribes them. It covers 25 European languages including **Czech and English** and detects the language by itself. |
| Voice Manager | [src/voices.js](src/voices.js) | [CAM++](https://github.com/modelscope/3D-Speaker) speaker embeddings (voice prints). Each voice's recordings are averaged into a voice print that live speech is compared against (cosine similarity). |
| Web Interface | [public/](public/), [src/server.js](src/server.js), [src/ws.js](src/ws.js) | Express + WebSocket. The browser captures the microphone, converts it to 16 kHz PCM in an AudioWorklet and streams it to the server. |
| Users & login | [src/auth.js](src/auth.js) | SQLite (`node:sqlite`), scrypt password hashes, HTTP-only session cookies. |

All models run through [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), which provides prebuilt Node.js bindings, so nothing has to be compiled.

On the development machine (4 virtual CPUs, no GPU), the speech recognizer runs at about 5 % of
real time (a 4-second sentence takes about 0.2 s), and the server needs about 1 GB of RAM.

### What you get

- **Transcript page** (`/transcript`): only the conversation. Each speaker's text is in their color with their name above it. Text appears in grey italics while someone is still talking and is replaced by the final text once they pause. The toolbar fades away while listening (move the mouse to bring it back). Keyboard: <kbd>Space</kbd> starts/stops, <kbd>+</kbd>/<kbd>−</kbd> change the text size. Everything said is saved on the server as it is recognized (see *History*). The menu can download the transcript as a text file, start a *New transcript* (the previous one stays in History), open the current transcript in History, choose the *Microphone*, or switch to full screen. The chosen microphone is remembered by the browser and also used for recordings on the Voices page; it can be switched while listening. If it is unplugged, the default microphone is used and a message says so (the browser shows microphone names only after microphone access has been allowed once). With *Keep audio for download* turned on, it can also download the recorded audio (see [Measuring accuracy](#measuring-accuracy-on-your-own-recordings)).
- **Unknown speakers**: people without a saved voice are grouped as *Speaker 1*, *Speaker 2*, … (grey, dashed marker). Click such a name to say which existing voice it is, or to save that person as a new voice using the audio heard so far; the earlier lines are relabeled immediately.
- **Corrections**: if a line is credited to the wrong person, click the name and pick who really said it. That voice remembers how the line sounded and is recognized better from then on. Lines can be corrected while the session is still connected (not after a page reload).
- **Speaker changes without a pause**: when someone answers without a gap, the utterance is split where the voice changes, and the text is cut between words.
- **Voices page** (`/voices`): create voices, rename them, change colors, add recordings (record in the browser or upload any audio file the browser can play: WAV, MP3, M4A, OGG, …), play back or delete recordings. After choosing files to upload, a dialog shows how long each one is and lets you use the whole file or only its first part, e.g. the first `1:30` of a long recording (at most 10 minutes per recording). *Test recognition* shows how closely a clip matches each voice. Administrators can tune the *match threshold*, turn on *Learn from live speech* and list *Names and terms*: words the recognizer should prefer where they fit what was said, such as names, places and product names. The voices' names are preferred automatically, more lightly; a name that is still misheard can be added to the list too (on a real recording "Flagan" became "FlyGun" that way). Each voice card shows what it has learned from corrections and live speech, with *Forget* to undo it (the recordings stay).
- **Transcribing recordings**: *Transcribe a file* (on the History page, and in the Transcript page's menu) takes any audio or video file the browser can play (MP3, M4A/AAC, WAV, OGG/Opus, FLAC, WebM, MP4, …) up to 4 hours long, or only its first part (for example the first `20:00`, chosen after picking the file). The browser converts it to 16 kHz mono WAV and uploads it; the server transcribes it in the background with the same speaker recognition as live listening, and the new transcript opens and fills in as it goes (on the 4-CPU development machine in about 8 % of the recording's length: an hour takes about 5 minutes). You can close the page meanwhile, or stop it and keep what is done. From the Transcript page, listening goes on and a link opens the new transcript in another tab. The title is the file name, and the times count from when the recording started (the file's modification time minus its length). Live listening keeps priority, and recordings do not change how voices are recognized. Without a browser, `POST /api/transcripts/upload?name=…` accepts a 16 kHz mono 16-bit WAV file (signed-in session cookie needed).
- **History** (`/history`): every saved transcript, newest first, with its speakers and first line. The search box finds transcripts containing all the words you type, anywhere in the transcript; case and Czech diacritics are ignored ("dovolene" finds "dovolené") and words match as prefixes. Matching lines are shown with the words highlighted; a click opens the transcript at that line.
- **Saved transcript** (`/history/<id>`):
  - Rename it.
  - Fix a line's text: pencil, then <kbd>Enter</kbd> to save.
  - Delete a line.
  - Change who spoke: click a name or a line's person icon, then choose a voice or type any name, for that line, that turn, or every line of that speaker. Moving lines to a voice also teaches the voice how they sounded, as corrections on the transcript page do.
  - Export as **TXT** (`[time] Name: text`, usable as an evaluation reference), **SRT** subtitles or **JSON**.
  - A transcript that is still being recorded updates itself.
  - Everyone signed in can read and edit transcripts; deleting one is for its author and administrators.
- **Light and dark themes**: by default VoiceRecon follows the operating system. The sun/moon/monitor button in the top bar (and *Theme* in the transcript page's menu, or the button in the corner of the sign-in page) switches between *System*, *Light* and *Dark*; the choice is remembered in the browser. Speaker colors are adjusted for each theme so that text in any voice color stays readable.
- **Users page** (`/users`): administrators add users, set passwords, change roles and delete users. Every user can change their own password there.
- **Czech and English**: the pages, messages and exports follow the browser's language (Czech or Slovak gives Czech, anything else English). The **CS**/**EN** button in the top bar (*Čeština*/*English* in the transcript page's menu, or the button in the corner of the sign-in page) switches it; the choice is remembered by the browser. Saved data does not change: unknown speakers show as *Mluvčí 2* in Czech and *Speaker 2* in English.

## Requirements

- Node.js 22.13 or newer (developed with 24.22)
- Windows 10/11 x64, Linux or macOS
- About 1 GB of free RAM and 700 MB of disk space for the models
- A browser with microphone access (Chrome, Edge or Firefox)

## Setup

The quickest way: install [Node.js](https://nodejs.org/) 22.13 or newer, then start VoiceRecon with
**`start.cmd`** on Windows (double-click it) or **`./start.sh`** on Linux and macOS. The first time,
this installs the dependencies and downloads the speech models (about 520 MB); then it starts the
server and opens VoiceRecon in the browser. Stop it with <kbd>Ctrl</kbd>+<kbd>C</kbd> (on Windows
answer *Y* to "Terminate batch job") or by closing the window. Started again while it is running, it
just opens the browser. `--no-browser` starts it without opening one.

The same steps by hand:

```bash
npm install
```

```bash
npm run models
```

This downloads the speech models (about 520 MB) into `models/`.

```bash
npm start
```

Open <http://localhost:3000> **on the computer that runs the server**. On the first visit you
create the administrator account (this is allowed only from that computer). If you ever lose the
administrator password:

```bash
npm run create-user -- admin --admin
```

Then:

1. Go to **Voices** and create a voice for each person. Add 20–60 seconds of natural speech for each (several shorter recordings are fine).
2. Go to **Transcript** and press **Start**.

### Using it from other devices (phone, another PC)

Browsers only allow microphone access on `https://` pages or on `localhost`. To use VoiceRecon over
the network, give it a certificate and listen on all interfaces. A self-signed certificate can be
made with the `openssl` that ships with Git for Windows:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout data/key.pem -out data/cert.pem -subj "/CN=voicerecon"
```

Then start the server with `HOST=0.0.0.0`, `TLS_CERT=data/cert.pem` and `TLS_KEY=data/key.pem`
(for example in a `.env` file, see below) and accept the certificate warning in the browser once.

### Configuration

All settings are optional environment variables. They can also be kept in a `.env` file in the
project folder, one `VARIABLE=value` per line (variables set in the environment win):

```ini
PORT=3001
HOST=0.0.0.0
TLS_CERT=data/cert.pem
TLS_KEY=data/key.pem
```


| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP(S) port |
| `HOST` | `127.0.0.1` | Interface to listen on (`0.0.0.0` = all) |
| `TLS_CERT`, `TLS_KEY` | — | PEM certificate and key; enables HTTPS |
| `DATA_DIR` | `./data` | Database and voice recordings |
| `MODELS_DIR` | `./models` | Speech models |
| `THREADS` | CPU cores, max 4 | Threads for speech recognition |
| `SPEAKER_MODEL` | `3dspeaker_campplus_zh_en_advanced.onnx` | Speaker-embedding model file in `MODELS_DIR` |
| `SPEAKER_THRESHOLD` | `0.5` | Initial match threshold (later changed on the Voices page) |
| `SESSION_TTL_HOURS` | `168` | How long a login lasts |
| `VOICERECON_DEBUG` | — | `1` logs every utterance and saves its audio to `%TEMP%/voicerecon-debug` |

Relative paths (`DATA_DIR`, `MODELS_DIR`, `TLS_CERT`, `TLS_KEY`) count from the project folder,
wherever the server is started from. Keep the full path of `DATA_DIR` reasonably short on Windows: SQLite cannot open a database whose
path is longer than 260 characters.

## How the transcription works

1. The browser streams 16 kHz mono audio over a WebSocket (`/ws/transcribe`) in 100 ms frames.
2. Silero VAD finds speech. An utterance ends after 0.35 s of silence; after 15 s of continuous speech it is cut at the next short dip.
3. While someone talks, the unfinished utterance is re-transcribed about every 0.8 s whenever the CPU is free. These interim results are shown greyed out.
4. A finished utterance is transcribed with a little padding around it. One shorter than 2.5 s is transcribed after the last 4 s of speech that came before it, and only its own words are kept: alone, the recognizer often took a short Czech phrase for English ("Ukrajincům" came out as "Uh Ukraine Soom"). Sliding 1.5 s voice prints check whether the speaker changes inside it: first where one saved voice clearly takes over from another, then where two parts simply sound different (for people without a saved voice). Each part is matched against the saved voices. If no voice reaches the threshold, the part goes to the closest unknown speaker of this session, or starts a new one. A long stretch of one speaker is split into lines at sentence ends (each line at least 3 s long).
5. Final lines replace the interim text in the browser. Changes made on the Voices page (names, colors) show up in open transcripts immediately.

An uploaded recording goes through the same steps, without interim results and at a lower priority than live listening.

### How voices are matched

A voice is compared with several voice prints and gets the score of the best one:

- the average of all its recordings;
- each recording on its own, once there are two or more. Record a person in each room or on each microphone you use; the matching recording then wins even if it differs from the others;
- the average of what it has learned: lines you corrected to this voice, and, if *Learn from live speech* is on, lines that were recognized very clearly. Live lines count once there are three of them; a correction counts immediately. At most 30 of each are kept per voice, the oldest are dropped first.

*Learn from live speech* is off by default. A live line is learned only when it is at least 2 s
long and the voice's **recordings alone** match it at least 0.1 above the threshold and at least
0.15 better than any other voice. Learned lines are never used for that decision, so a mistake
cannot reinforce itself. Corrections are always learned, so a wrong correction can mislead the
voice. Use *Forget* on the Voices page to undo it. Learning helps most when the room or microphone
differs from where the recordings were made. Check it on your own recordings with
`npm run evaluate -- my-meeting --learn 0,1` (see below).

Voice prints are recomputed automatically from the stored recordings if the speaker model is
changed (`SPEAKER_MODEL`); learned lines are dropped then, because they have no audio to recompute from.

## Measuring accuracy on your own recordings

The default settings were tuned on synthetic voices, which are much easier to tell apart than
real people. To find out how well VoiceRecon works for your meetings, and to tune it, measure it on
a recording of a real conversation.

1. **Record a conversation.** In the transcript page menu, turn on *Keep audio for download*, then
   talk as usual (3–4 people for 5–15 minutes is plenty). Afterwards use *Download recording* and
   *Download transcript*. The audio stays only in that browser tab until you clear the transcript
   or close the tab. Any other WAV recording works as well.
2. **Write down what was really said.** Correct the downloaded transcript (the words, and the name
   before each turn) and save it as `reference.txt`:

   ```
   Martin: Dobrý den, můžeme začít?
   Jana: Ano. Nejdřív bych prošla včerejší výsledky.
   ```

   Write one turn per line as `Name: text`, using the same names as on the Voices page. The
   `[time]` prefixes from the download may stay, a line without a name continues the previous
   turn, and lines starting with `#` are ignored.
3. **Put both into a folder.** Optionally, add enrollment recordings of the speakers:

   ```
   my-meeting/
     recording.wav
     reference.txt
     voices/          Martin.wav, Jana/first.wav, Jana/second.wav, …
   ```

   Without `voices/`, pass `--app-voices` to use the voices enrolled in VoiceRecon. People without
   a voice are expected to show up as unknown speakers. Recognition is always run on a separate
   copy, so the app's data are never changed.
4. **Run the evaluation:**

   ```bash
   npm run evaluate -- my-meeting --app-voices
   ```

The report shows:

- **avg score**: the average match score of lines credited to a saved voice. The further above the
  threshold, the safer the matches.
- **WER** (word error rate): the share of reference words that were recognized wrongly, missed, or
  added. *WER (no accents)* ignores diacritics and shows how much of the error is only accents.
- **speaker ok (name)**: the share of words credited to the right person by name, which is what the
  transcript page shows.
- **speaker ok (mapped)**: the same after pairing unknown speakers ("Speaker 1") with real people.
  It shows whether different voices were at least kept apart.
- Numbers per speaker, and a table of who was credited with whose words.

To compare settings, give several values. Every combination is a separate run; recognition
results are reused when only speaker settings change, so threshold sweeps are fast:

```bash
npm run evaluate -- my-meeting --app-voices --threshold 0.4,0.5,0.6 --min-silence 0.25,0.35
```

| Option | Meaning |
|---|---|
| `--threshold` | match threshold for saved voices (set the winner on the Voices page) |
| `--min-silence` | seconds of silence that end an utterance (`minSilence` in `src/speech/engine.js`) |
| `--change-similarity` | how different two parts of one utterance must sound to be split between speakers (`CHANGE_MAX_SIMILARITY` in `src/transcriber.js`). In an echoey room people sound more alike; try 0.3,0.5,0.6 |
| `--learn` | `0,1` compares learning from live speech off and on (each run starts without learned lines) |
| `--words <file>` | names and terms the recognizer should prefer, one per line (as *Names and terms* on the Voices page; the voices' names are always included). `--no-words` turns even those off, for comparison |
| `--details <file>` | word-by-word differences of the best run, plus VoiceRecon's transcript |
| `--json <file>` | all numbers of all runs |
| `--audio`, `--reference` | other file names than `recording.wav` / `reference.txt` |

Numbers are written as words or digits inconsistently by the recognizer ("dva" vs. "2"), and that
counts as an error. Write numbers in the reference the way you prefer to see them.

## Development

```bash
npm run check
```

This runs ESLint (`npm run lint`), type checking of the JavaScript with TypeScript in `checkJs`
mode (`npm run typecheck`; nothing is compiled) and all tests (`npm test`). The tests include unit
tests and an end-to-end test. The end-to-end test starts the server, enrolls two
voices, streams a recorded Czech conversation over the WebSocket and checks who said what. It needs
synthetic test audio, made with two Czech text-to-speech voices:

```bash
npm run models -- --test
```

```bash
node scripts/make-test-audio.js
```

GitHub Actions runs the same checks on every push and pull request (`.github/workflows/ci.yml`:
Ubuntu with Node 22 and 24, Windows with Node 24). The speech tests need the models, so there they
skip themselves; a nightly workflow (`speech-tests.yml`, also startable by hand) downloads the
models, runs every test with `VOICERECON_REQUIRE_MODELS=1` (missing models then fail instead of
skipping) and attaches an accuracy report to the run.

Project layout:

```
src/          server: config, database, auth, audio I/O, speech engine, voice manager, transcriber,
              WebSocket, evaluation scoring
public/       pages (login, transcript, history, voices, users) and their scripts/styles
scripts/      launcher (behind start.cmd / start.sh), model download, test-audio generator,
              create-user CLI, accuracy evaluation
test/         unit and end-to-end tests; test/fixtures (generated) is also an evaluation dataset
```

## Known limitations

- Very short utterances (under about one second, e.g. "ano", "jo") are too short to recognize the voice reliably. They are attributed to the previous speaker. When people answer each other without a pause, a turn shorter than about 1.5 s stays in the neighbouring line.
- A word list helps only words that sound close to what is listed: "Andrew Sharp" said the Czech way still came out as "Andru Šárp".
- People talking over each other at the same time are not separated; the louder voice usually wins.
- Accuracy depends on the microphone. A single microphone in the middle of the table works, but a distant laptop microphone in an echoing room makes both transcription and voice matching worse.
- Lines can be corrected on the transcript page only while the live session is connected; afterwards use History, which works for any saved line. Corrections teach voices only for lines recorded with the current speaker model.
- A transcript continues after a page reload or a lost connection, but a second browser tab starts its own transcript.
- Uploaded files are converted in the browser. M4A, MP4, MOV (with AAC audio) and WAV files are read piece by piece, so their length does not matter (a 2-hour M4A takes about 30 s to read). Other formats (MP3, OGG, WebM, FLAC) are decoded whole by the browser, which runs out of memory on long recordings (roughly over an hour); convert those to M4A or WAV first. If the server restarts while a file is being transcribed, the lines done so far stay, and the rest has to be uploaded again.

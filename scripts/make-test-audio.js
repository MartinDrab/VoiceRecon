'use strict';

/**
 * Generates synthetic Czech test audio with two different TTS voices (needs the optional test
 * models: `npm run models -- --test`). Writes into test/fixtures/:
 *   voices/<voice>.wav     enrollment recording for each voice
 *   conversation.wav       a dialogue alternating between the voices
 *   conversation.json      the expected turns { voice, text, start, end }
 *   reference.txt          the same turns as "voice: text" lines
 * so the folder is also a dataset for `npm run evaluate -- test/fixtures`.
 */

const fs = require('fs');
const path = require('path');
const sherpa = require('sherpa-onnx-node');
const config = require('../src/config');
const { encodeWav, concat } = require('../src/audio');

const OUT = path.join(config.root, 'test', 'fixtures');
const RATE = 16000;

const VOICES = {
  jirka: { dir: 'vits-piper-cs_CZ-jirka-medium', model: 'cs_CZ-jirka-medium.onnx', espeak: true },
  coqui: { dir: 'vits-coqui-cs-cv', model: 'model.onnx', espeak: false },
};

const ENROLL = {
  jirka: [
    'Jmenuji se Jirka a tohle je ukázka mého hlasu.',
    'Rád chodím na procházky do lesa a večer si čtu knihy.',
    'Dnes ráno jsem vstával brzy, protože jsem měl důležitou schůzku.',
  ],
  coqui: [
    'Dobrý den, toto je nahrávka pro rozpoznání mého hlasu.',
    'Ve volném čase ráda vařím a poslouchám hudbu.',
    'Minulý týden jsme byli s rodinou na chatě u řeky.',
  ],
};

// [voice, text, pause after in seconds]
const DIALOGUE = [
  ['jirka', 'Ahoj, jak se máš? Dlouho jsme se neviděli.', 0.7],
  ['coqui', 'Ahoj, mám se dobře, děkuji. Právě jsem se vrátila z dovolené.', 0.6],
  ['jirka', 'To je skvělé. Kam jste jeli?', 0.1], // answered without a pause
  ['coqui', 'Byli jsme v Itálii u moře. Počasí bylo krásné a jídlo vynikající.', 0.6],
  ['jirka', 'To ti závidím. Já jsem celé léto pracoval na novém projektu.', 0.5],
  ['coqui', 'A o jaký projekt jde?', 0.7],
  ['jirka', 'Vyvíjíme aplikaci, která v reálném čase přepisuje řeč na text a pozná, kdo mluví.', 0.9],
];

function loadTts(v) {
  const dir = path.join(config.modelsDir, v.dir);
  if (!fs.existsSync(dir)) throw new Error(`Missing ${dir}. Run "npm run models -- --test" first.`);
  return new sherpa.OfflineTts({
    model: {
      vits: {
        model: path.join(dir, v.model),
        tokens: path.join(dir, 'tokens.txt'),
        dataDir: v.espeak ? path.join(dir, 'espeak-ng-data') : '',
      },
      numThreads: 2,
    },
  });
}

function speak(tts, text) {
  const a = tts.generate({ text, sid: 0, speed: 1.0 });
  return a.sampleRate === RATE ? Float32Array.from(a.samples) : new sherpa.LinearResampler(a.sampleRate, RATE).flush(a.samples);
}

const silence = (s) => new Float32Array(Math.round(s * RATE));

function main() {
  fs.mkdirSync(path.join(OUT, 'voices'), { recursive: true });
  const tts = Object.fromEntries(Object.entries(VOICES).map(([k, v]) => [k, loadTts(v)]));

  for (const [voice, sentences] of Object.entries(ENROLL)) {
    const parts = sentences.flatMap((t) => [speak(tts[voice], t), silence(0.5)]);
    fs.writeFileSync(path.join(OUT, 'voices', `${voice}.wav`), encodeWav(concat(parts), RATE));
  }

  const parts = [silence(1.0)];
  const turns = [];
  let t = 1.0;
  for (const [voice, text, pause] of DIALOGUE) {
    const audio = speak(tts[voice], text);
    turns.push({ voice, text, start: t, end: t + audio.length / RATE });
    t += audio.length / RATE + pause;
    parts.push(audio, silence(pause));
  }
  parts.push(silence(1.0));
  fs.writeFileSync(path.join(OUT, 'conversation.wav'), encodeWav(concat(parts), RATE));
  fs.writeFileSync(path.join(OUT, 'conversation.json'), JSON.stringify(turns, null, 2));
  const reference = turns.map((t) => `${t.voice}: ${t.text}`).join('\n');
  fs.writeFileSync(path.join(OUT, 'reference.txt'), `${reference}\n`);
  console.log(`Wrote test audio to ${OUT}`);
}

main();

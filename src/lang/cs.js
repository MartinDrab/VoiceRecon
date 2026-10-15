'use strict';

// Czech texts of the server's messages, keyed by the English text (see src/i18n.js).
// test/i18n.test.js checks that every message the server can send is here.

module.exports = {
  // sign-in and users
  'Please log in.': 'Přihlaste se prosím.',
  'Administrator rights are required.': 'K tomu jsou potřeba práva správce.',
  'Wrong username or password.': 'Nesprávné uživatelské jméno nebo heslo.',
  'Too many failed login attempts. Try again in a few minutes.': 'Příliš mnoho neúspěšných pokusů o přihlášení. Zkuste to znovu za několik minut.',
  'Username must be 3–32 characters: letters, digits, dot, dash or underscore.':
    'Uživatelské jméno musí mít 3–32 znaků: písmena, číslice, tečku, pomlčku nebo podtržítko.',
  'Password must be at least {min} characters long.': 'Heslo musí mít alespoň {min} znaků.',
  'Role must be "admin" or "user".': 'Role musí být „admin“ nebo „user“.',
  'The application is already set up.': 'Aplikace už je nastavená.',
  'The first administrator can only be created from the computer running VoiceRecon.':
    'Prvního správce lze vytvořit jen na počítači, na kterém VoiceRecon běží.',
  'User "{username}" already exists.': 'Uživatel „{username}“ už existuje.',
  'User not found.': 'Uživatel nebyl nalezen.',
  'The last administrator cannot be demoted.': 'Poslednímu správci nelze odebrat práva správce.',
  'The last administrator cannot be deleted.': 'Posledního správce nelze smazat.',
  'The current password is not correct.': 'Současné heslo není správné.',
  'You cannot delete your own account.': 'Vlastní účet nemůžete smazat.',

  // voices and recordings
  'Speech models are still loading. Try again in a moment.': 'Modely řeči se ještě načítají. Zkuste to za chvíli.',
  'Voice not found.': 'Hlas nebyl nalezen.',
  'Recording not found.': 'Nahrávka nebyla nalezena.',
  'Name must be 1–60 characters long.': 'Jméno musí mít 1–60 znaků.',
  'Color must look like #RRGGBB.': 'Barva musí mít tvar #RRGGBB.',
  'Threshold must be between 0.05 and 0.95.': 'Práh musí být mezi 0,05 a 0,95.',
  'Expected true or false.': 'Očekává se true nebo false.',
  'Recordings may be at most 10 minutes long.': 'Nahrávka může být dlouhá nejvýše 10 minut.',
  'Not enough speech in the recording.': 'V nahrávce je příliš málo řeči.',
  'Not enough speech in the recording (found {found} s, need at least {need} s).':
    'V nahrávce je příliš málo řeči (nalezeno {found} s, potřeba je alespoň {need} s).',
  'Could not compute a voice print from this recording.': 'Z této nahrávky se nepodařilo vytvořit hlasový otisk.',
  'Send the recording as a WAV file (Content-Type: audio/wav).': 'Pošlete nahrávku jako soubor WAV (Content-Type: audio/wav).',
  'Not a WAV file.': 'Nejde o soubor WAV.',
  'WAV file is missing its fmt or data chunk.': 'Souboru WAV chybí část fmt nebo data.',
  'Invalid WAV header.': 'Neplatná hlavička souboru WAV.',
  'Unsupported WAV encoding (format {format}, {bits} bits).': 'Nepodporované kódování WAV (formát {format}, {bits} bitů).',
  'Missing model files (run "npm run models"):\n{files}': 'Chybí soubory modelů (spusťte „npm run models“):\n{files}',

  // live transcription
  'Invalid message.': 'Neplatná zpráva.',
  'No transcription is running.': 'Žádný přepis neběží.',
  'Choose a voice.': 'Vyberte hlas.',
  'That speaker is no longer available in this session.': 'Tento mluvčí už v této relaci není k dispozici.',

  // saved transcripts
  'Transcript not found.': 'Přepis nebyl nalezen.',
  'Line not found.': 'Řádek nebyl nalezen.',
  'Invalid lines.': 'Neplatné řádky.',
  'Invalid speaker.': 'Neplatný mluvčí.',
  'Choose a voice or type a name.': 'Vyberte hlas nebo napište jméno.',
  'Choose a voice or type a name (at most {max} characters).': 'Vyberte hlas nebo napište jméno (nejvýše {max} znaků).',
  'Text must be 1–{max} characters long. Delete the line instead of emptying it.':
    'Text musí mít 1–{max} znaků. Místo vymazání textu raději smažte celý řádek.',
  'Titles may be at most {max} characters long.': 'Název může mít nejvýše {max} znaků.',
  'Only the author or an administrator can delete this transcript.': 'Tento přepis může smazat jen jeho autor nebo správce.',
  'Only the author or an administrator can stop this transcription.': 'Tento přepis může zastavit jen jeho autor nebo správce.',

  // uploaded recordings
  'Recordings may be at most {hours} hours long.': 'Nahrávka může být dlouhá nejvýše {hours} hodiny.',
  'Send the recording as a 16 kHz mono 16-bit WAV file.': 'Pošlete nahrávku jako soubor WAV (16 kHz, mono, 16 bitů).',
  'The recording is empty.': 'Nahrávka je prázdná.',
  'The upload was interrupted.': 'Odesílání bylo přerušeno.',
  'Format must be txt, srt or json.': 'Formát musí být txt, srt nebo json.',
  'Transcript of {date}': 'Přepis z {date}',
  'Speaker {n}': 'Mluvčí {n}',

  // general
  'Invalid id.': 'Neplatný identifikátor.',
  'Not found.': 'Nenalezeno.',
  'Internal server error.': 'Vnitřní chyba serveru.',
  'request entity too large': 'Soubor je příliš velký.',
};

'use strict';

const { execSync } = require('child_process');

/**
 * Work out what language the user speaks, so a stranger can unzip this and
 * run it without editing anything.
 *
 * Order: Windows UI language -> system locale -> Node's own idea -> English.
 */

/** Piper voices we know how to fetch, keyed by language code. */
const VOICE_CATALOG = {
  en: { file: 'en_US-lessac-medium',  path: 'en/en_US/lessac/medium' },
  es: { file: 'es_ES-davefx-medium',  path: 'es/es_ES/davefx/medium' },
  pt: { file: 'pt_BR-faber-medium',   path: 'pt/pt_BR/faber/medium' },
  ru: { file: 'ru_RU-dmitri-medium',  path: 'ru/ru_RU/dmitri/medium' },
  de: { file: 'de_DE-thorsten-medium', path: 'de/de_DE/thorsten/medium' },
  fr: { file: 'fr_FR-siwis-medium',   path: 'fr/fr_FR/siwis/medium' },
  it: { file: 'it_IT-riccardo-x_low', path: 'it/it_IT/riccardo/x_low' },
  pl: { file: 'pl_PL-darkman-medium', path: 'pl/pl_PL/darkman/medium' },
  tr: { file: 'tr_TR-dfki-medium',    path: 'tr/tr_TR/dfki/medium' },
  nl: { file: 'nl_NL-mls-medium',     path: 'nl/nl_NL/mls/medium' },
  uk: { file: 'uk_UA-ukrainian_tts-medium', path: 'uk/uk_UA/ukrainian_tts/medium' },
  zh: { file: 'zh_CN-huayan-medium',  path: 'zh/zh_CN/huayan/medium' },
};

function normalise(tag) {
  if (!tag) return null;
  const code = String(tag).trim().toLowerCase().split(/[-_.]/)[0];
  return /^[a-z]{2}$/.test(code) ? code : null;
}

/** Ask Windows what language the user actually uses. */
function detectSystemLanguage() {
  const attempts = [
    // What the user set as their display language - the best signal.
    () => execSync(
      'powershell -NoProfile -Command "(Get-Culture).TwoLetterISOLanguageName"',
      { encoding: 'utf8', windowsHide: true, timeout: 5000 }
    ),
    () => execSync(
      'powershell -NoProfile -Command "(Get-WinSystemLocale).TwoLetterISOLanguageName"',
      { encoding: 'utf8', windowsHide: true, timeout: 5000 }
    ),
  ];

  for (const attempt of attempts) {
    try {
      const code = normalise(attempt());
      if (code) return code;
    } catch (_) { /* try the next one */ }
  }

  // Node's own locale, if Intl is available.
  try {
    const code = normalise(Intl.DateTimeFormat().resolvedOptions().locale);
    if (code) return code;
  } catch (_) {}

  try {
    const code = normalise(process.env.LANG || process.env.LANGUAGE);
    if (code) return code;
  } catch (_) {}

  return 'en';
}

module.exports = { detectSystemLanguage, VOICE_CATALOG, normalise };

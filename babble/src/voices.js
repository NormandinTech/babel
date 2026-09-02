'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

/**
 * Piper voice catalog and on-demand downloader.
 *
 * Whisper understands ~99 languages on the way in. What Babble can SPEAK is
 * limited only by which voice files are on disk, so rather than ship gigabytes,
 * fetch one when it's wanted.
 *
 * The catalog is pulled from the upstream voices.json rather than hardcoded.
 * That file is the source of truth for exact paths and it grows as Piper adds
 * languages - hardcoding would go stale and produce 404s. A built-in list
 * covers the offline case.
 */

const BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';
const INDEX_URL = `${BASE}/voices.json`;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Used when voices.json can't be fetched. Verified paths. */
const FALLBACK = {
  ar: { name: 'Arabic',        file: 'ar_JO-kareem-medium',          path: 'ar/ar_JO/kareem/medium' },
  ca: { name: 'Catalan',       file: 'ca_ES-upc_ona-medium',         path: 'ca/ca_ES/upc_ona/medium' },
  cs: { name: 'Czech',         file: 'cs_CZ-jirka-medium',           path: 'cs/cs_CZ/jirka/medium' },
  cy: { name: 'Welsh',         file: 'cy_GB-gwryw_gogleddol-medium', path: 'cy/cy_GB/gwryw_gogleddol/medium' },
  da: { name: 'Danish',        file: 'da_DK-talesyntese-medium',     path: 'da/da_DK/talesyntese/medium' },
  de: { name: 'German',        file: 'de_DE-thorsten-medium',        path: 'de/de_DE/thorsten/medium' },
  el: { name: 'Greek',         file: 'el_GR-rapunzelina-low',        path: 'el/el_GR/rapunzelina/low' },
  en: { name: 'English',       file: 'en_US-lessac-medium',          path: 'en/en_US/lessac/medium' },
  es: { name: 'Spanish',       file: 'es_ES-davefx-medium',          path: 'es/es_ES/davefx/medium' },
  fa: { name: 'Persian',       file: 'fa_IR-amir-medium',            path: 'fa/fa_IR/amir/medium' },
  fi: { name: 'Finnish',       file: 'fi_FI-harri-medium',           path: 'fi/fi_FI/harri/medium' },
  fr: { name: 'French',        file: 'fr_FR-siwis-medium',           path: 'fr/fr_FR/siwis/medium' },
  hu: { name: 'Hungarian',     file: 'hu_HU-anna-medium',            path: 'hu/hu_HU/anna/medium' },
  is: { name: 'Icelandic',     file: 'is_IS-salka-medium',           path: 'is/is_IS/salka/medium' },
  it: { name: 'Italian',       file: 'it_IT-riccardo-x_low',         path: 'it/it_IT/riccardo/x_low' },
  ka: { name: 'Georgian',      file: 'ka_GE-natia-medium',           path: 'ka/ka_GE/natia/medium' },
  kk: { name: 'Kazakh',        file: 'kk_KZ-issai-high',             path: 'kk/kk_KZ/issai/high' },
  lb: { name: 'Luxembourgish', file: 'lb_LU-marylux-medium',         path: 'lb/lb_LU/marylux/medium' },
  ne: { name: 'Nepali',        file: 'ne_NP-google-medium',          path: 'ne/ne_NP/google/medium' },
  nl: { name: 'Dutch',         file: 'nl_NL-mls-medium',             path: 'nl/nl_NL/mls/medium' },
  no: { name: 'Norwegian',     file: 'no_NO-talesyntese-medium',     path: 'no/no_NO/talesyntese/medium' },
  pl: { name: 'Polish',        file: 'pl_PL-darkman-medium',         path: 'pl/pl_PL/darkman/medium' },
  pt: { name: 'Portuguese',    file: 'pt_BR-faber-medium',           path: 'pt/pt_BR/faber/medium' },
  ro: { name: 'Romanian',      file: 'ro_RO-mihai-medium',           path: 'ro/ro_RO/mihai/medium' },
  ru: { name: 'Russian',       file: 'ru_RU-dmitri-medium',          path: 'ru/ru_RU/dmitri/medium' },
  sk: { name: 'Slovak',        file: 'sk_SK-lili-medium',            path: 'sk/sk_SK/lili/medium' },
  sl: { name: 'Slovenian',     file: 'sl_SI-artur-medium',           path: 'sl/sl_SI/artur/medium' },
  sr: { name: 'Serbian',       file: 'sr_RS-serbski_institut-medium', path: 'sr/sr_RS/serbski_institut/medium' },
  sv: { name: 'Swedish',       file: 'sv_SE-nst-medium',             path: 'sv/sv_SE/nst/medium' },
  sw: { name: 'Swahili',       file: 'sw_CD-lanfrica-medium',        path: 'sw/sw_CD/lanfrica/medium' },
  tr: { name: 'Turkish',       file: 'tr_TR-dfki-medium',            path: 'tr/tr_TR/dfki/medium' },
  uk: { name: 'Ukrainian',     file: 'uk_UA-ukrainian_tts-medium',   path: 'uk/uk_UA/ukrainian_tts/medium' },
  vi: { name: 'Vietnamese',    file: 'vi_VN-vais1000-medium',        path: 'vi/vi_VN/vais1000/medium' },
  zh: { name: 'Chinese',       file: 'zh_CN-huayan-medium',          path: 'zh/zh_CN/huayan/medium' },
};

// Prefer a mid-sized voice: good enough to understand, small enough to download.
const QUALITY_RANK = { medium: 0, high: 1, low: 2, x_low: 3 };

let CATALOG = { ...FALLBACK };
let catalogSource = 'built-in';

function modelsDir(root) { return path.join(root, 'models'); }
function cachePath(root) { return path.join(modelsDir(root), 'voices-index.json'); }

function get(url, { json = false } = {}) {
  return new Promise((resolve, reject) => {
    const go = (u, n = 0) => {
      if (n > 5) return reject(new Error('too many redirects'));
      https.get(u, { headers: { 'User-Agent': 'babble' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          // HuggingFace redirects to a relative path (/api/resolve-cache/...),
          // which https.get won't accept. Resolve it against the current URL.
          return go(new URL(res.headers.location, u).href, n + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => { body += c; });
        res.on('end', () => {
          try { resolve(json ? JSON.parse(body) : body); }
          catch (e) { reject(new Error('bad index: ' + e.message)); }
        });
      }).on('error', reject);
    };
    go(url);
  });
}

/**
 * Turn upstream voices.json into one entry per language, keeping the
 * best-sized voice for each.
 */
function buildCatalog(index) {
  const out = {};
  for (const entry of Object.values(index)) {
    const lang = entry.language && entry.language.family;
    if (!lang) continue;

    const onnx = Object.keys(entry.files || {}).find(f => f.endsWith('.onnx'));
    if (!onnx) continue;

    const q = QUALITY_RANK[entry.quality] ?? 9;
    const existing = out[lang];
    if (existing && existing._rank <= q) continue;

    out[lang] = {
      name: (entry.language.name_english || lang) +
            (entry.language.name_native && entry.language.name_native !== entry.language.name_english
              ? ` (${entry.language.name_native})` : ''),
      file: path.posix.basename(onnx, '.onnx'),
      path: path.posix.dirname(onnx),
      _rank: q,
    };
  }
  return out;
}

/** Refresh the catalog from upstream. Falls back silently when offline. */
async function refreshCatalog(root, { force = false } = {}) {
  const cache = cachePath(root);

  if (!force && fs.existsSync(cache)) {
    try {
      const stat = fs.statSync(cache);
      const cached = JSON.parse(fs.readFileSync(cache, 'utf8'));
      CATALOG = cached;
      catalogSource = 'cached';
      if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) return CATALOG;
    } catch (_) { /* rebuild below */ }
  }

  try {
    const index = await get(INDEX_URL, { json: true });
    const built = buildCatalog(index);
    if (Object.keys(built).length > 5) {
      CATALOG = built;
      catalogSource = 'upstream';
      fs.mkdirSync(modelsDir(root), { recursive: true });
      fs.writeFileSync(cache, JSON.stringify(built));
    }
  } catch (_) {
    if (catalogSource === 'built-in') CATALOG = { ...FALLBACK };
  }
  return CATALOG;
}

function voicePath(root, lang) {
  const v = CATALOG[lang];
  return v ? path.join(modelsDir(root), `${v.file}.onnx`) : null;
}

function isInstalled(root, lang) {
  const p = voicePath(root, lang);
  return Boolean(p) && fs.existsSync(p) && fs.existsSync(p + '.json');
}

function listVoices(root) {
  return Object.entries(CATALOG)
    .map(([code, v]) => ({ code, name: v.name, installed: isInstalled(root, code) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function fetchTo(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const go = (u, n = 0) => {
      if (n > 5) return reject(new Error('too many redirects'));
      https.get(u, { headers: { 'User-Agent': 'babble' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return go(new URL(res.headers.location, u).href, n + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
        const total = parseInt(res.headers['content-length'], 10) || 0;
        let done = 0;
        const tmp = dest + '.part';
        const out = fs.createWriteStream(tmp);
        res.on('data', c => { done += c.length; if (onProgress && total) onProgress(done / total); });
        res.pipe(out);
        out.on('finish', () => out.close(() => { fs.renameSync(tmp, dest); resolve(); }));
        out.on('error', e => { try { fs.unlinkSync(tmp); } catch (_) {} reject(e); });
      }).on('error', reject);
    };
    go(url);
  });
}

/** Both files are required - Piper can't pronounce anything without the .json. */
async function installVoice(root, lang, onProgress) {
  if (!CATALOG[lang]) await refreshCatalog(root);
  const v = CATALOG[lang];
  if (!v) throw new Error(`No Piper voice available for '${lang}'.`);
  if (isInstalled(root, lang)) return voicePath(root, lang);

  fs.mkdirSync(modelsDir(root), { recursive: true });
  const onnx = path.join(modelsDir(root), `${v.file}.onnx`);

  await fetchTo(`${BASE}/${v.path}/${v.file}.onnx`, onnx, onProgress);
  await fetchTo(`${BASE}/${v.path}/${v.file}.onnx.json`, onnx + '.json');
  return onnx;
}

module.exports = {
  get CATALOG() { return CATALOG; },
  get catalogSource() { return catalogSource; },
  refreshCatalog, listVoices, isInstalled, voicePath, installVoice, modelsDir, buildCatalog,
};

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { encodeWav } = require('./audio');

let counter = 0;

/**
 * whisper.cpp wrapper.
 *
 * Two entry points:
 *   detectLanguage()  - fast, exits after language ID. Used to skip work when
 *                       the speaker is already speaking your language.
 *   transcribe()      - full decode, optionally translating to English.
 *
 * Game audio is the hard case: fed wind, rain and gunfire, whisper does not
 * fail quietly - it invents a confident stock phrase and repeats it. Defences,
 * in order of effectiveness:
 *   1. -nth   whisper's own non-speech detector
 *   2. -et    entropy threshold; high-entropy decodes are the model spiralling
 *   3. -nf    no fallback, so one bad decode can't seed the next
 *   4. a phrase list, for the well-known ones
 */
class Stt {
  constructor(cfg, tmpDir) {
    this.exe = cfg.exe;
    this.model = cfg.model;
    this.threads = cfg.threads || 8;
    this.extraArgs = cfg.extraArgs || [];
    this.noSpeechThold = cfg.noSpeechThold ?? 0.6;
    this.entropyThold = cfg.entropyThold ?? 2.6;
    this.tmpDir = tmpDir || path.join(os.tmpdir(), 'babble');
    this.keepTemp = false;
    this.gpuChecked = false;
    fs.mkdirSync(this.tmpDir, { recursive: true });
  }

  _writeWav(samples) {
    const id = `utt-${Date.now()}-${counter++}`;
    const wavPath = path.join(this.tmpDir, `${id}.wav`);
    fs.writeFileSync(wavPath, encodeWav(samples, 16000));
    return { id, wavPath };
  }

  _cleanup(files) {
    if (this.keepTemp) return;
    for (const f of files) { try { fs.unlinkSync(f); } catch (_) {} }
  }

  /**
   * Detect the spoken language without a full decode. Much cheaper than
   * transcribing, which matters when most speech around you is already in
   * your own language and should be skipped entirely.
   * Returns a language code, or null if detection failed.
   */
  async detectLanguage(samples) {
    const { wavPath } = this._writeWav(samples);
    const args = [
      '-m', this.model,
      '-f', wavPath,
      '-dl',                    // detect language and exit
      '-t', String(this.threads),
      ...this.extraArgs,
    ];

    try {
      const { stdout, stderr } = await this._spawn(args);
      const blob = stdout + stderr;
      const m = blob.match(/auto-detected language:\s*([a-z]{2,3})/i);
      return m ? m[1].toLowerCase() : null;
    } catch (_) {
      return null;                       // fall back to full transcription
    } finally {
      this._cleanup([wavPath]);
    }
  }

  async transcribe(samples, { toEnglish = false, language = 'auto' } = {}) {
    const { id, wavPath } = this._writeWav(samples);
    const outBase = path.join(this.tmpDir, id);

    const args = [
      '-m', this.model,
      '-f', wavPath,
      '-l', language,
      '-t', String(this.threads),
      '-nt',
      '-oj', '-of', outBase,
      '--no-prints',
      '-nth', String(this.noSpeechThold),
      '-et', String(this.entropyThold),
      '-nf',
      ...this.extraArgs,
    ];
    if (toEnglish) args.push('-tr');

    let result;
    try {
      const { stdout, stderr } = await this._spawn(args);

      // Report once whether CUDA actually engaged. A silent CPU fallback is
      // the difference between 500 ms and 7 s per utterance.
      if (!this.gpuChecked) {
        this.gpuChecked = true;
        const blob = stdout + stderr;
        if (/CUDA|cuBLAS|GPU/i.test(blob)) this.gpuStatus = 'gpu';
        else this.gpuStatus = 'cpu';
      }

      try {
        const json = JSON.parse(fs.readFileSync(`${outBase}.json`, 'utf8'));
        const segments = json.transcription || [];
        const text = segments.map(s => (s.text || '').trim()).join(' ').trim();
        const lang =
          (json.result && json.result.language) ||
          (json.params && json.params.language) || 'unknown';
        result = { text, language: lang };
      } catch (_) {
        result = { text: stdout.trim(), language: 'unknown' };
      }
    } finally {
      this._cleanup([wavPath, `${outBase}.json`]);
    }
    return result;
  }

  _spawn(args) {
    return new Promise((resolve, reject) => {
      const p = spawn(this.exe, args, { windowsHide: true });
      let stdout = '', stderr = '';
      p.stdout.on('data', d => { stdout += d.toString(); });
      p.stderr.on('data', d => { stderr += d.toString(); });
      p.on('error', reject);
      p.on('close', code =>
        code === 0
          ? resolve({ stdout, stderr })
          : reject(new Error(`whisper exited ${code}: ${stderr.slice(-300)}`))
      );
    });
  }
}

/** Known hallucinations. Whisper produces these on music and ambient noise. */
const HALLUCINATIONS = [
  'thanks for watching', 'thank you for watching', 'please subscribe',
  'subscribe to my channel', 'like and subscribe', 'see you next time',
  'mother of the year', 'thanks for listening', 'i will see you in the next video',
  'bye bye', 'the end', 'to be continued', 'copyright', 'all rights reserved',
  'transcription by', 'subtitles by', 'amara.org',
  '[music]', '[applause]', '[blank_audio]', '[silence]', '[sound]',
  'you', '.', 'bye.', 'thank you.', 'okay.', 'oh.', 'so.', 'yeah.', 'esc', 'â™ª',
];

function looksLikeHallucination(text) {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return true;

  const stripped = t.replace(/[^\w\s]/g, '').trim();
  if (stripped.length < 3) return true;

  if (HALLUCINATIONS.includes(t) || HALLUCINATIONS.includes(stripped)) return true;
  if (HALLUCINATIONS.some(h => h.length > 8 && t.includes(h))) return true;

  // Same token 3+ times in a row - a decode loop.
  if (/\b(\w+)(\s+\1\b){2,}/.test(stripped)) return true;

  // Whole phrase repeated back to back.
  const words = stripped.split(' ');
  if (words.length >= 6) {
    const half = Math.floor(words.length / 2);
    if (words.slice(0, half).join(' ') === words.slice(half, half * 2).join(' ')) return true;
  }

  // Bracketed sound tags.
  if (/^[\[\(].*[\]\)]$/.test(t)) return true;

  return false;
}

module.exports = { Stt, looksLikeHallucination };

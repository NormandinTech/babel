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
 * Two modes:
 *   transcribe()  — source language in, source language text out (+ detected lang)
 *   translate()   — source language in, ENGLISH text out, one pass, no MT stage
 *
 * The second one is free performance when your target is English: whisper
 * does the translation internally, so you skip a whole stage of the pipeline.
 */
class Stt {
  constructor(cfg, tmpDir) {
    this.exe = cfg.exe;
    this.model = cfg.model;
    this.threads = cfg.threads || 8;
    this.extraArgs = cfg.extraArgs || [];
    this.tmpDir = tmpDir || path.join(os.tmpdir(), 'babel');
    this.keepTemp = false;
    fs.mkdirSync(this.tmpDir, { recursive: true });
  }

  async transcribe(samples, { toEnglish = false, language = 'auto' } = {}) {
    const id = `utt-${Date.now()}-${counter++}`;
    const wavPath = path.join(this.tmpDir, `${id}.wav`);
    const outBase = path.join(this.tmpDir, id);

    fs.writeFileSync(wavPath, encodeWav(samples, 16000));

    const args = [
      '-m', this.model,
      '-f', wavPath,
      '-l', language,
      '-t', String(this.threads),
      '-nt',                 // no timestamps in output
      '-oj', '-of', outBase, // JSON output, gives us the detected language
      '--no-prints',
      ...this.extraArgs,
    ];
    if (toEnglish) args.push('-tr');

    const text = await this._run(args, outBase);

    if (!this.keepTemp) {
      for (const f of [wavPath, `${outBase}.json`]) {
        try { fs.unlinkSync(f); } catch (_) {}
      }
    }
    return text;
  }

  _run(args, outBase) {
    return new Promise((resolve, reject) => {
      const p = spawn(this.exe, args, { windowsHide: true });
      let stderr = '';
      let stdout = '';
      p.stdout.on('data', d => { stdout += d.toString(); });
      p.stderr.on('data', d => { stderr += d.toString(); });

      p.on('error', reject);
      p.on('close', (code) => {
        if (code !== 0) return reject(new Error(`whisper exited ${code}: ${stderr.slice(-400)}`));

        // Prefer the JSON — it carries the detected language.
        try {
          const json = JSON.parse(fs.readFileSync(`${outBase}.json`, 'utf8'));
          const segments = json.transcription || [];
          const text = segments.map(s => (s.text || '').trim()).join(' ').trim();
          const language =
            (json.result && json.result.language) ||
            (json.params && json.params.language) ||
            'unknown';
          return resolve({ text, language });
        } catch (_) {
          return resolve({ text: stdout.trim(), language: 'unknown' });
        }
      });
    });
  }
}

/**
 * Whisper's most common failure on game audio is hallucinating stock phrases
 * during near-silence or noise. VAD catches most of it; this catches the rest.
 */
const HALLUCINATIONS = [
  'thanks for watching', 'thank you for watching', 'please subscribe',
  'subscribe to my channel', 'like and subscribe', 'see you next time',
  '[music]', '[applause]', '[blank_audio]', 'you', '.', 'bye.',
  'thank you.', 'okay.', 'oh.', '♪',
];

function looksLikeHallucination(text) {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return true;
  if (t.length < 2) return true;
  if (HALLUCINATIONS.includes(t)) return true;
  if (HALLUCINATIONS.some(h => h.length > 8 && t.includes(h))) return true;
  // Same token repeated 4+ times in a row is a classic decode loop.
  if (/\b(\w+)(\s+\1\b){3,}/.test(t)) return true;
  return false;
}

module.exports = { Stt, looksLikeHallucination };

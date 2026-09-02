'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

let counter = 0;

/**
 * Piper TTS. Standalone exe, no Python - which is the point: someone you met
 * in a lobby should be able to unzip and run.
 */
class Tts {
  constructor(cfg, tmpDir) {
    this.exe = cfg.exe;
    this.voices = cfg.voices || {};
    this.tmpDir = tmpDir || path.join(os.tmpdir(), 'babble');
    fs.mkdirSync(this.tmpDir, { recursive: true });
  }

  /** A voice counts only if the file is actually on disk. */
  hasVoice(lang) {
    const v = this.voices[lang];
    return Boolean(v) && fs.existsSync(v);
  }

  /** Languages we can actually speak right now. */
  availableLanguages() {
    return Object.keys(this.voices).filter(l => this.hasVoice(l));
  }

  async speak(text, lang) {
    const voice = this.voices[lang];
    if (!voice) throw new Error(`No Piper voice configured for '${lang}'.`);
    if (!fs.existsSync(voice)) throw new Error(`Voice model missing: ${voice}`);

    const outPath = path.join(this.tmpDir, `tts-${Date.now()}-${counter++}.wav`);

    await new Promise((resolve, reject) => {
      const p = spawn(this.exe, ['-m', voice, '-f', outPath, '-q'], { windowsHide: true });
      let stderr = '';
      p.stderr.on('data', d => { stderr += d.toString(); });
      p.on('error', reject);
      p.on('close', code =>
        code === 0 ? resolve() : reject(new Error(`piper exited ${code}: ${stderr.slice(-300)}`))
      );
      p.stdin.write(text);
      p.stdin.end();
    });

    return outPath;
  }
}

/**
 * Playback to a named device.
 *
 * ffplay uses SDL, which picks its output from SDL_AUDIODEVICE. Crude, but it
 * needs no native modules and no audio driver of our own.
 */
class Player {
  constructor(ffplayExe) {
    this.ffplayExe = ffplayExe;
    this.queues = new Map();     // device -> promise chain, so clips never overlap
  }

  play(wavPath, device = '', { deleteAfter = true } = {}) {
    const key = device || '__default__';
    const prev = this.queues.get(key) || Promise.resolve();

    const next = prev
      .catch(() => {})
      .then(() => this._playNow(wavPath, device))
      .finally(() => {
        if (deleteAfter) { try { fs.unlinkSync(wavPath); } catch (_) {} }
      });

    this.queues.set(key, next);
    return next;
  }

  _playNow(wavPath, device) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      if (device) {
        env.SDL_AUDIODRIVER = 'directsound';
        env.SDL_AUDIODEVICE = device;
      }
      const p = spawn(
        this.ffplayExe,
        ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-i', wavPath],
        { env, windowsHide: true }
      );
      p.on('error', reject);
      p.on('close', () => resolve());
    });
  }
}

module.exports = { Tts, Player };

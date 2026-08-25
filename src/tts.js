'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

let counter = 0;

/**
 * Piper TTS. Standalone .exe, no Python — which is the whole reason it's the
 * default here. Someone you met in a lobby should be able to unzip and run.
 *
 * Swapping in Kokoro-82M later means replacing this class with a Python
 * sidecar; the interface (text -> wav path) stays identical.
 */
class Tts {
  constructor(cfg, tmpDir) {
    this.exe = cfg.exe;
    this.voices = cfg.voices || {};
    this.tmpDir = tmpDir || path.join(os.tmpdir(), 'babel');
    fs.mkdirSync(this.tmpDir, { recursive: true });
  }

  hasVoice(lang) {
    return Boolean(this.voices[lang]);
  }

  async speak(text, lang) {
    const voice = this.voices[lang];
    if (!voice) throw new Error(`No Piper voice configured for '${lang}'. Add one to config.json > tts.voices.`);
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
 * Playback to a NAMED device.
 *
 * This is the piece that makes the outgoing direction work at all: the
 * translated speech has to land on the virtual cable that the game reads
 * as its microphone, not on your headphones.
 *
 * ffplay uses SDL, and SDL picks its output device from SDL_AUDIODEVICE.
 * Crude, but it needs no native modules and no driver of your own.
 */
class Player {
  constructor(ffplayExe) {
    this.ffplayExe = ffplayExe;
    this.queues = new Map(); // device -> Promise chain, so clips never overlap
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

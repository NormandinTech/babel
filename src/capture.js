'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { Decimator, downmixToMono, bufferToFloat32 } = require('./audio');

/**
 * Two capture sources, both normalised to 16 kHz mono float32:
 *
 *  - ProcessCapture: WASAPI per-process loopback. Grabs the game's audio
 *    without touching the game process (no injection, no memory reads —
 *    this is an OS API, which is what keeps it clear of anti-cheat).
 *
 *  - MicCapture: ffmpeg dshow. Your voice, for the outgoing direction.
 */

class ProcessCapture extends EventEmitter {
  constructor({ processName, sourceRate = 48000, sourceChannels = 2 }) {
    super();
    this.processName = processName;
    this.sourceRate = sourceRate;
    this.sourceChannels = sourceChannels;
    this.decimator = new Decimator(Math.round(sourceRate / 16000));
    this.pid = null;
    this._loopback = null;
  }

  static async listProcesses() {
    const lb = require('application-loopback');
    return await lb.getActiveWindowProcessIds();
  }

  async start() {
    const lb = require('application-loopback');
    const windows = await lb.getActiveWindowProcessIds();

    const needle = this.processName.toLowerCase();
    const match = windows.find(w =>
      (w.title || '').toLowerCase().includes(needle.replace(/\.exe$/, '')) ||
      String(w.processId) === this.processName
    );

    if (!match) {
      throw new Error(
        `Could not find a window for "${this.processName}". ` +
        `Is the game running? Run 'npm run processes' to see what's visible.`
      );
    }

    this.pid = match.processId;
    this.emit('info', `Capturing PID ${this.pid} — ${match.title}`);

    this._loopback = lb.startAudioCapture(String(this.pid), {
      onData: (chunk) => this._onPcm(Buffer.from(chunk)),
    });
  }

  _onPcm(buf) {
    const interleaved = bufferToFloat32(buf);
    const mono = downmixToMono(interleaved, this.sourceChannels);
    const down = this.decimator.process(mono);
    if (down.length) this.emit('audio', down);
  }

  stop() {
    if (this.pid) {
      try { require('application-loopback').stopAudioCapture(String(this.pid)); } catch (_) {}
    }
  }
}

class MicCapture extends EventEmitter {
  constructor({ device, ffmpegExe }) {
    super();
    this.device = device;
    this.ffmpegExe = ffmpegExe;
    this.proc = null;
    this.leftover = Buffer.alloc(0);
  }

  /** Ask ffmpeg what dshow audio devices exist. Names go straight into config.json. */
  static listDevices(ffmpegExe) {
    return new Promise((resolve) => {
      const p = spawn(ffmpegExe, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
      let err = '';
      p.stderr.on('data', d => { err += d.toString(); });
      p.on('close', () => {
        const names = [];
        for (const line of err.split(/\r?\n/)) {
          const m = line.match(/"([^"]+)"\s*\(audio\)/);
          if (m) names.push(m[1]);
        }
        resolve(names);
      });
    });
  }

  start() {
    // Ask ffmpeg to do the resampling for us — it's already a dependency.
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'dshow',
      '-audio_buffer_size', '50',
      '-i', `audio=${this.device}`,
      '-ac', '1', '-ar', '16000',
      '-f', 'f32le', '-',
    ];
    this.proc = spawn(this.ffmpegExe, args);

    this.proc.stdout.on('data', (chunk) => {
      const buf = Buffer.concat([this.leftover, chunk]);
      const usable = buf.length - (buf.length % 4);
      this.leftover = buf.subarray(usable);
      if (usable > 0) this.emit('audio', bufferToFloat32(buf.subarray(0, usable)));
    });

    this.proc.stderr.on('data', d => this.emit('error', new Error(d.toString().trim())));
    this.proc.on('close', code => this.emit('info', `mic capture exited (${code})`));
  }

  stop() {
    if (this.proc) this.proc.kill();
  }
}

module.exports = { ProcessCapture, MicCapture };

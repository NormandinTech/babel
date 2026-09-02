'use strict';

const { spawn, execSync } = require('child_process');
const { EventEmitter } = require('events');
const {
  Decimator, downmixToMono, bufferToFloat32, bufferInt16ToFloat32,
} = require('./audio');

/**
 * Audio capture, normalised to 16 kHz mono float32.
 *
 * ProcessCapture reads game audio through a Windows OS API (WASAPI loopback) -
 * no injection, no memory reads, nothing anti-cheat looks for.
 *
 * loopback-capture emits raw PCM: 16-bit signed, stereo, 48 kHz.
 */

const SOURCE_RATE = 48000;
const SOURCE_CHANNELS = 2;

/** Games we know about, tried in order when auto-detecting. */
const KNOWN_GAMES = [
  'DayZ_x64.exe', 'DayZ.exe',
  'cod.exe', 'ModernWarfare.exe', 'BlackOps', 'Warzone',
  'Discord.exe', 'TeamSpeak', 'Mumble',
];

function listProcesses() {
  const out = execSync('tasklist /fo csv /nh', { encoding: 'utf8', windowsHide: true });
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = line.match(/"([^"]*)"/g);
    if (!cells || cells.length < 2) continue;
    const name = cells[0].slice(1, -1);
    const pid = parseInt(cells[1].slice(1, -1), 10);
    const memKb = cells[4] ? parseInt(cells[4].slice(1, -1).replace(/[^\d]/g, ''), 10) : 0;
    if (Number.isFinite(pid)) rows.push({ name, pid, memKb });
  }
  return rows;
}

/** Resolve an exe name, partial name, or raw PID to a running process. */
function resolvePid(target) {
  if (!target) return null;
  const asNum = parseInt(target, 10);
  if (Number.isFinite(asNum) && String(asNum) === String(target).trim()) {
    return { pid: asNum, name: `PID ${asNum}`, memKb: 0 };
  }

  const needle = String(target).toLowerCase().replace(/\.exe$/, '');
  const matches = listProcesses().filter(p =>
    p.name.toLowerCase().replace(/\.exe$/, '').includes(needle)
  );
  if (!matches.length) return null;
  matches.sort((a, b) => b.memKb - a.memKb);
  return matches[0];
}

/** Look for any game or voice app we recognise. */
function autoDetect() {
  for (const candidate of KNOWN_GAMES) {
    const hit = resolvePid(candidate);
    if (hit) return hit;
  }
  return null;
}

class ProcessCapture extends EventEmitter {
  constructor({ processName, source = 'process' }) {
    super();
    this.processName = processName;
    this.source = source;
    this.decimator = new Decimator(SOURCE_RATE / 16000);
    this.capture = null;
    this.pid = null;
    this.bytesSeen = 0;
    this.mode = null;
  }

  static listProcesses() {
    return listProcesses();
  }

  async start() {
    const loopback = require('loopback-capture');
    this.capture = new loopback.LoopbackCapture();
    const onChunk = (chunk) => this._onPcm(Buffer.from(chunk));

    if (this.source === 'system') {
      this.capture.startSystemAudio(onChunk);
      this.mode = 'system';
      this.emit('info', 'listening to all system audio');
      this._watchdog();
      return;
    }

    // Try the configured name, then anything we recognise, then fall back to
    // system audio. Never just fail - a stranger in a lobby has no way to fix it.
    let match = resolvePid(this.processName);
    if (!match) {
      match = autoDetect();
      if (match) {
        this.emit('info', `"${this.processName}" not running - found ${match.name} instead`);
      }
    }

    if (!match) {
      this.capture.startSystemAudio(onChunk);
      this.mode = 'system';
      this.emit('info', 'no known game found - listening to all system audio instead');
      this._watchdog();
      return;
    }

    this.pid = match.pid;
    try {
      this.capture.start(this.pid, true, onChunk);
      this.mode = 'process';
      this.emit('info', `listening to ${match.name} (PID ${this.pid})`);
    } catch (err) {
      this.capture.startSystemAudio(onChunk);
      this.mode = 'system';
      this.emit('info', `could not capture ${match.name} (${err.message}) - using system audio`);
    }
    this._watchdog();
  }

  _watchdog() {
    const t = setTimeout(() => {
      if (this.bytesSeen === 0) {
        this.emit('info', 'no audio yet. Is sound actually playing on the default device?');
        // Per-process capture can come up empty even when it "started".
        if (this.mode === 'process' && this.capture) {
          this.emit('info', 'switching to system audio as a fallback');
          try { this.capture.stop(); } catch (_) {}
          try {
            this.capture.startSystemAudio((c) => this._onPcm(Buffer.from(c)));
            this.mode = 'system';
          } catch (_) {}
        }
      } else {
        this.emit('info', `audio OK (${Math.round(this.bytesSeen / 1024)} KB so far)`);
      }
    }, 6000);
    if (t.unref) t.unref();
  }

  _onPcm(buf) {
    this.bytesSeen += buf.length;
    const interleaved = bufferInt16ToFloat32(buf);
    const mono = downmixToMono(interleaved, SOURCE_CHANNELS);
    const down = this.decimator.process(mono);
    if (down.length) this.emit('audio', down);
  }

  stop() {
    if (this.capture) {
      try { this.capture.stop(); } catch (_) {}
      this.capture = null;
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

  static listDevices(ffmpegExe) {
    return new Promise((resolve) => {
      const p = spawn(ffmpegExe, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
      let err = '';
      p.on('error', () => resolve([]));
      p.stderr.on('data', d => { err += d.toString(); });
      p.on('close', () => {
        const names = [];
        for (const line of err.split(/\r?\n/)) {
          const m = line.match(/"([^"]+)"\s*\((audio|audio,\s*video)\)/);
          if (m) names.push(m[1]);
        }
        resolve(names);
      });
    });
  }

  /** Pick a mic automatically when config doesn't name one. */
  static async autoDevice(ffmpegExe) {
    const devices = await MicCapture.listDevices(ffmpegExe);
    if (!devices.length) return null;
    const preferred = devices.find(d => /headset|microphone|mic\b/i.test(d));
    return preferred || devices[0];
  }

  start() {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'dshow',
      '-audio_buffer_size', '50',
      '-rtbufsize', '64M',
      '-i', `audio=${this.device}`,
      '-ac', '1', '-ar', '16000',
      '-f', 'f32le', '-',
    ];
    this.proc = spawn(this.ffmpegExe, args, { windowsHide: true });

    this.proc.stdout.on('data', (chunk) => {
      const buf = Buffer.concat([this.leftover, chunk]);
      const usable = buf.length - (buf.length % 4);
      this.leftover = buf.subarray(usable);
      if (usable > 0) this.emit('audio', bufferToFloat32(buf.subarray(0, usable)));
    });

    this.proc.stderr.on('data', d => this.emit('error', new Error(d.toString().trim())));
    this.proc.on('error', err => this.emit('error', err));
    this.proc.on('close', code => this.emit('info', `mic capture ended (${code})`));
    this.emit('info', `listening to mic: ${this.device}`);
  }

  stop() {
    if (this.proc) this.proc.kill();
  }
}

module.exports = { ProcessCapture, MicCapture, listProcesses };

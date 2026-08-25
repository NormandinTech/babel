'use strict';

const fs = require('fs');
const path = require('path');

const { ProcessCapture, MicCapture } = require('./capture');
const { Stt } = require('./stt');
const { Translator } = require('./translate');
const { Tts, Player } = require('./tts');
const { Direction } = require('./pipeline');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, 'tmp');

const LEVELS = { debug: 0, info: 1, warn: 2 };

function makeLogger(level) {
  const min = LEVELS[level] ?? 1;
  const stamp = () => new Date().toTimeString().slice(0, 8);
  return {
    debug: m => { if (min <= 0) console.log(`${stamp()} ${m}`); },
    info:  m => { if (min <= 1) console.log(`${stamp()} ${m}`); },
    warn:  m => { if (min <= 2) console.log(`${stamp()} ! ${m}`); },
    line:  m => console.log(`${stamp()} ${m}`),
  };
}

function resolveIn(cfgPath) {
  if (!cfgPath) return cfgPath;
  return path.isAbsolute(cfgPath) ? cfgPath : path.join(ROOT, cfgPath);
}

function loadConfig() {
  const p = path.join(ROOT, 'config.json');
  if (!fs.existsSync(p)) {
    console.error('config.json not found. Copy config.example.json to config.json first.');
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));

  cfg.whisper.exe = resolveIn(cfg.whisper.exe);
  cfg.whisper.model = resolveIn(cfg.whisper.model);
  cfg.tts.exe = resolveIn(cfg.tts.exe);
  for (const k of Object.keys(cfg.tts.voices)) cfg.tts.voices[k] = resolveIn(cfg.tts.voices[k]);
  cfg.ffmpeg.ffmpegExe = resolveIn(cfg.ffmpeg.ffmpegExe);
  cfg.ffmpeg.ffplayExe = resolveIn(cfg.ffmpeg.ffplayExe);

  return cfg;
}

/** Fail loudly at startup instead of 40 seconds into a match. */
function preflight(cfg, log) {
  const problems = [];
  const need = [
    [cfg.whisper.exe, 'whisper-cli.exe'],
    [cfg.whisper.model, 'whisper model (.bin)'],
    [cfg.tts.exe, 'piper.exe'],
    [cfg.ffmpeg.ffmpegExe, 'ffmpeg.exe'],
    [cfg.ffmpeg.ffplayExe, 'ffplay.exe'],
    [path.join(ROOT, 'models', 'silero_vad.onnx'), 'silero_vad.onnx'],
  ];
  for (const [p, label] of need) {
    if (!fs.existsSync(p)) problems.push(`missing ${label}  ->  ${p}`);
  }

  const targets = new Set();
  if (cfg.incoming.enabled) targets.add(cfg.incoming.targetLanguage);
  if (cfg.outgoing.enabled) targets.add(cfg.outgoing.targetLanguage);
  for (const t of targets) {
    const v = cfg.tts.voices[t];
    if (!v) problems.push(`no Piper voice configured for target language '${t}'`);
    else if (!fs.existsSync(v)) problems.push(`Piper voice missing for '${t}'  ->  ${v}`);
  }

  if (cfg.outgoing.enabled && !cfg.outgoing.micDevice) {
    problems.push(`outgoing.micDevice is empty — run 'npm run devices' and paste the exact name`);
  }

  if (problems.length) {
    console.error('\nPreflight failed:\n');
    for (const p of problems) console.error('  - ' + p);
    console.error('\nSee README.md for where each file goes.\n');
    process.exit(1);
  }
  log.info('preflight ok');
}

async function main() {
  const args = process.argv.slice(2);
  const cfg = loadConfig();
  const log = makeLogger(cfg.debug.logLevel);

  if (args.includes('--list-processes')) {
    const list = await ProcessCapture.listProcesses();
    console.log('\nVisible windows (use the title or PID in config.json > incoming.processName):\n');
    for (const w of list) console.log(`  ${String(w.processId).padStart(7)}  ${w.title}`);
    console.log('');
    return;
  }

  if (args.includes('--list-devices')) {
    const devices = await MicCapture.listDevices(cfg.ffmpeg.ffmpegExe);
    console.log('\nAudio input devices (for config.json > outgoing.micDevice):\n');
    for (const d of devices) console.log(`  "${d}"`);
    console.log('\nFor playback devices, open Windows Sound settings — use the exact device name.\n');
    return;
  }

  preflight(cfg, log);

  fs.mkdirSync(TMP, { recursive: true });

  const stt = new Stt(cfg.whisper, TMP);
  stt.keepTemp = cfg.debug.keepTempWavs;
  const translator = new Translator(cfg.translate);
  const tts = new Tts(cfg.tts, TMP);
  const player = new Player(cfg.ffmpeg.ffplayExe);

  const directions = [];

  if (cfg.incoming.enabled) {
    directions.push(new Direction({
      name: 'in ',
      capture: new ProcessCapture({ processName: cfg.incoming.processName }),
      vadCfg: cfg.vad,
      stt, translator, tts, player, log,
      targetLanguage: cfg.incoming.targetLanguage,
      playbackDevice: cfg.incoming.playbackDevice,
    }));
  }

  if (cfg.outgoing.enabled) {
    directions.push(new Direction({
      name: 'out',
      capture: new MicCapture({ device: cfg.outgoing.micDevice, ffmpegExe: cfg.ffmpeg.ffmpegExe }),
      vadCfg: cfg.vad,
      stt, translator, tts, player, log,
      targetLanguage: cfg.outgoing.targetLanguage,
      playbackDevice: cfg.outgoing.playbackDevice,
    }));
  }

  if (!directions.length) {
    console.error('Both directions are disabled in config.json. Nothing to do.');
    process.exit(1);
  }

  for (const d of directions) {
    try {
      await d.start();
    } catch (err) {
      log.warn(`could not start ${d.name.trim()}: ${err.message}`);
    }
  }

  console.log('\nRunning. Ctrl+C to stop.\n');

  const shutdown = () => {
    console.log('\nstopping...');
    for (const d of directions) d.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('\nfatal:', err.message);
  process.exit(1);
});

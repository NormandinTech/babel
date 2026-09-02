'use strict';

const fs = require('fs');
const path = require('path');

const { ProcessCapture, MicCapture } = require('./capture');
const { Stt } = require('./stt');
const { Translator } = require('./translate');
const { Tts, Player } = require('./tts');
const { Direction } = require('./pipeline');
const { detectSystemLanguage, VOICE_CATALOG } = require('./locale');

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
  // Only the languages actually in use need a voice on disk. The catalog lists
  // many; missing ones are simply unavailable, not errors.
  for (const t of targets) {
    if (!t) continue;
    const v = cfg.tts.voices[t];
    if (!v) problems.push(`no Piper voice configured for target language '${t}'`);
    else if (!fs.existsSync(v)) problems.push(`Piper voice missing for '${t}'  ->  ${v}`);
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
    const list = ProcessCapture.listProcesses()
      .filter(p => p.memKb > 20000)
      .sort((a, b) => b.memKb - a.memKb);
    console.log('\nRunning processes by memory (put the name or PID in config.json > incoming.processName):\n');
    for (const p of list.slice(0, 40)) {
      console.log(`  ${String(p.pid).padStart(7)}  ${String(Math.round(p.memKb / 1024)).padStart(6)} MB  ${p.name}`);
    }
    console.log('');
    return;
  }

  if (args.includes('--list-devices')) {
    const devices = await MicCapture.listDevices(cfg.ffmpeg.ffmpegExe);
    console.log('\nAudio input devices (for config.json > outgoing.micDevice):\n');
    if (!devices.length) {
      console.log('  (none found)\n');
      console.log('  Windows may be blocking microphone access, or no recording device is enabled.');
      console.log('  Check: Settings > Privacy & security > Microphone > "Let desktop apps access your microphone"');
      console.log('  And:   Win+R -> mmsys.cpl -> Recording tab -> right-click -> Show Disabled Devices\n');
    } else {
      for (const d of devices) console.log(`  "${d}"`);
      console.log('');
    }
    return;
  }

  // Blank targetLanguage means "use whatever language this computer is set to".
  // Lets someone unzip and run without editing anything.
  if (!cfg.incoming.targetLanguage) {
    const detected = detectSystemLanguage();
    if (cfg.tts.voices[detected]) {
      cfg.incoming.targetLanguage = detected;
      log.info(`system language detected: ${detected}`);
    } else {
      cfg.incoming.targetLanguage = 'en';
      const known = VOICE_CATALOG[detected];
      log.warn(
        known
          ? `system language is '${detected}' but no voice is installed - using English. ` +
            `Download ${known.file}.onnx (+ .onnx.json) into models\\ and add it to tts.voices.`
          : `system language '${detected}' has no Piper voice available - using English.`
      );
    }
  }
  if (cfg.outgoing.enabled && !cfg.outgoing.targetLanguage) {
    cfg.outgoing.targetLanguage = 'en';
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
      capture: new ProcessCapture({
        processName: cfg.incoming.processName,
        source: cfg.incoming.source,
      }),
      vadCfg: cfg.vad,
      stt, translator, tts, player, log,
      targetLanguage: cfg.incoming.targetLanguage,
      playbackDevice: cfg.incoming.playbackDevice,
      speakSameLanguage: cfg.incoming.speakSameLanguage === true,
      repeatWindowMs: (cfg.filters && cfg.filters.repeatWindowMs) || 45000,
      maxAgeMs: (cfg.filters && cfg.filters.maxAgeMs) || 8000,
    }));
  }

  if (cfg.outgoing.enabled) {
    let mic = cfg.outgoing.micDevice;
    if (!mic) {
      mic = await MicCapture.autoDevice(cfg.ffmpeg.ffmpegExe);
      if (mic) log.info(`auto-selected mic: ${mic}`);
      else log.warn('no microphone found - outgoing direction disabled');
    }
    if (mic) directions.push(new Direction({
      name: 'out',
      capture: new MicCapture({ device: mic, ffmpegExe: cfg.ffmpeg.ffmpegExe }),
      vadCfg: cfg.vad,
      stt, translator, tts, player, log,
      targetLanguage: cfg.outgoing.targetLanguage,
      playbackDevice: cfg.outgoing.playbackDevice,
      speakSameLanguage: true,
      repeatWindowMs: (cfg.filters && cfg.filters.repeatWindowMs) || 45000,
      maxAgeMs: (cfg.filters && cfg.filters.maxAgeMs) || 8000,
    }));
  }

  if (!directions.length) {
    console.error('Both directions are disabled in config.json. Nothing to do.');
    process.exit(1);
  }

  let started = 0;
  for (const d of directions) {
    try {
      await d.start();
      started++;
    } catch (err) {
      log.warn(`could not start ${d.name.trim()}: ${err.message}`);
    }
  }

  if (started === 0) {
    console.error('\nNothing is listening - every enabled direction failed to start.');
    console.error('Fix the errors above, or set incoming.source to "system" to capture all desktop audio.\n');
    process.exit(1);
  }

  console.log(`\nRunning (${started}/${directions.length} direction(s) active). Ctrl+C to stop.\n`);

  // Whisper falls back to CPU silently. Say so once, loudly - it is a 10x difference.
  const gpuWatch = setInterval(() => {
    if (stt.gpuChecked) {
      clearInterval(gpuWatch);
      if (stt.gpuStatus === 'cpu') {
        log.warn('whisper is running on CPU, not GPU - expect ~10x slower transcription.');
        log.warn('check that the CUDA DLLs are in bin\\ and whisper.extraArgs is empty.');
      } else {
        log.info('whisper is using the GPU');
      }
    }
  }, 1000);
  if (gpuWatch.unref) gpuWatch.unref();

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

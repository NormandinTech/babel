'use strict';

const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const { ProcessCapture, MicCapture } = require('./capture');
const { Stt } = require('./stt');
const { Translator } = require('./translate');
const { Tts, Player } = require('./tts');
const { Direction } = require('./pipeline');
const { detectSystemLanguage, VOICE_CATALOG } = require('./locale');
const { startServer, LANG_NAMES } = require('./server');
const { Hotkey } = require('./hotkey');
const voices = require('./voices');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, 'tmp');

const LEVELS = { debug: 0, info: 1, warn: 2 };

function makeLogger(level, logFile) {
  // Written from inside the app rather than by piping the console, so nothing
  // sits between the terminal and Ctrl+C.
  let stream = null;
  try {
    stream = fs.createWriteStream(logFile, { flags: 'w' });
  } catch (_) { /* logging is optional */ }
  const tee = (line) => { try { if (stream) stream.write(line + '\n'); } catch (_) {} };

  const min = LEVELS[level] ?? 1;
  const stamp = () => new Date().toTimeString().slice(0, 8);
  const out = (m) => { const l = `${stamp()} ${m}`; console.log(l); tee(l); };
  return {
    debug: m => { if (min <= 0) out(m); },
    info:  m => { if (min <= 1) out(m); },
    warn:  m => { if (min <= 2) out('! ' + m); },
    line:  m => out(m),
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
  const log = makeLogger(cfg.debug.logLevel, path.join(ROOT, 'babel-log.txt'));

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

  const addIdx = args.indexOf('--add-voice');
  if (addIdx !== -1) {
    const lang = args[addIdx + 1];
    await voices.refreshCatalog(ROOT, { force: true });
    if (!lang || !voices.CATALOG[lang]) {
      console.log(`\n${Object.keys(voices.CATALOG).length} languages available (${voices.catalogSource} list):\n`);
      for (const v of voices.listVoices(ROOT)) {
        console.log(`  ${v.code.padEnd(4)} ${v.name.padEnd(14)} ${v.installed ? 'installed' : ''}`);
      }
      console.log('\nUsage: node src/index.js --add-voice de\n');
      return;
    }
    process.stdout.write(`downloading ${voices.CATALOG[lang].name} voice... `);
    let last = -1;
    try {
      await voices.installVoice(ROOT, lang, (f) => {
        const pct = Math.floor(f * 100);
        if (pct >= last + 10) { last = pct; process.stdout.write(pct + '% '); }
      });
      console.log('\ndone. Pick it in settings, or set incoming.targetLanguage to "' + lang + '".\n');
    } catch (err) {
      console.log('\nthat download did not finish: ' + err.message);
      console.log('Check your connection and try again.\n');
      process.exitCode = 1;
    }
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
      cfg._missingVoice = detected;
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

  // Pull the current voice list from upstream (cached a week, falls back to a
  // built-in list offline), then pick up anything already in models/ so that
  // downloading a voice is the whole job - no config editing.
  try { await voices.refreshCatalog(ROOT); } catch (_) { /* built-in list is fine */ }
  for (const v of voices.listVoices(ROOT)) {
    if (v.installed) cfg.tts.voices[v.code] = voices.voicePath(ROOT, v.code);
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

  // ---- control panel + hotkey ----
  const state = {
    enabled: true,
    targetLanguage: cfg.incoming.targetLanguage,
    audioFlowing: false,
    gpu: null,
    missingVoice: cfg._missingVoice || null,
  };

  for (const d of directions) {
    d.capture.on('info', m => { if (/audio OK/.test(m)) state.audioFlowing = true; });
  }

  const control = {
    getState: () => ({
      ...state,
      hotkey: cfg.hotkey && cfg.hotkey.toggleKey,
      gpu: stt.gpuStatus || null,
      languages: tts.availableLanguages()
        .map(c => ({ code: c, name: LANG_NAMES[c] || c })),
    }),
    toggle: () => {
      state.enabled = !state.enabled;
      for (const d of directions) d.paused = !state.enabled;
      log.info(state.enabled ? 'translation on' : 'translation paused');
      if (panel) panel.pushState();
    },
    listVoices: () => voices.listVoices(ROOT),
    refreshVoices: () => voices.refreshCatalog(ROOT, { force: true }).then(() => voices.listVoices(ROOT)),
    installVoice: async (lang) => {
      const file = await voices.installVoice(ROOT, lang);
      cfg.tts.voices[lang] = file;   // available immediately, no restart
      tts.voices[lang] = file;
      log.info(`installed ${voices.CATALOG[lang].name} voice`);
      return file;
    },
    setTarget: (lang) => {
      if (!tts.hasVoice(lang)) return;
      state.targetLanguage = lang;
      for (const d of directions) if (d.name.trim() === 'in') d.setTarget(lang);
      log.info(`now translating into ${LANG_NAMES[lang] || lang}`);
      if (panel) panel.pushState();
    },
  };

  let panel = null;
  if (cfg.panel !== false) {
    panel = startServer({ port: (cfg.panel && cfg.panel.port) || 7331, control, log });
    for (const d of directions) d.onCaption = c => panel.pushCaption(c.from, c.text);
  }

  const keyName = (cfg.hotkey && cfg.hotkey.toggleKey) || 'scroll lock';
  const panelPort = (cfg.panel && cfg.panel.port) || 7331;
  const pretty = keyName.replace(/\b\w/g, c => c.toUpperCase());

  const modName = (cfg.hotkey && cfg.hotkey.menuModifier) || 'shift';
  const hotkey = new Hotkey({
    key: keyName,
    modifier: modName,
    onPress: () => control.toggle(),
    // Ctrl + the same key opens the settings page in the default browser.
    // Nothing is drawn over the game and nothing sits on screen; the panel
    // exists only while you have it open.
    onMenu: () => {
      log.info('opening settings');
      spawn('cmd', ['/c', 'start', '', `http://localhost:${panelPort}`],
            { windowsHide: true, detached: true }).unref();
    },
    log,
  });
  if (cfg.hotkey !== false) hotkey.start();

  console.log(`\nRunning (${started}/${directions.length} direction(s) active).`);
  console.log(`  ${pretty}          turn translation on or off`);
  console.log(`  ${modName[0].toUpperCase() + modName.slice(1)} + ${pretty}  open settings`);
  console.log(`  Ctrl + C            stop\n`);

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

  let stopping = false;
  const shutdown = () => {
    if (stopping) process.exit(0);   // second Ctrl+C - go now
    stopping = true;
    console.log('\nstopping...');
    for (const d of directions) { try { d.stop(); } catch (_) {} }
    try { hotkey.stop(); } catch (_) {}
    try { if (panel) panel.close(); } catch (_) {}
    // Open SSE connections and child processes can hold the loop open;
    // don't wait on them.
    setTimeout(() => process.exit(0), 150).unref();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGBREAK', shutdown);

  // Node's SIGINT is emulated on Windows and gets unreliable once child
  // processes share the console. A readline interface catches it properly.
  if (process.platform === 'win32' && process.stdin.isTTY) {
    const rl = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.on('SIGINT', shutdown);
    rl.on('close', () => {});
  }
}

main().catch(err => {
  console.error('\nfatal:', err.message);
  process.exit(1);
});

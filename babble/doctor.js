// doctor.js - reports the full state of the install. Run: node doctor.js
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const R = __dirname;
const ok = s => console.log('  [ok]      ' + s);
const bad = s => console.log('  [PROBLEM] ' + s);

console.log('\n=== BABBLE DOCTOR ===\n');
console.log('folder:', R, '\n');

console.log('--- code version ---');
const checks = [
  ['src/capture.js', 'no known game found', 'capture.js has auto-fallback'],
  ['src/capture.js', 'startSystemAudio', 'capture.js knows loopback-capture v2 API'],
  ['src/vad.js', 'CONTEXT + WINDOW', 'vad.js has the 576-sample context FIX'],
  ['src/index.js', 'autoDevice', 'index.js auto-selects a mic'],
  ['run.bat', 'node src', 'run.bat launches correctly'],
  ['src/voices.js', 'new URL(res.headers.location', 'voices.js follows relative redirects'],
  ['src/hotkey.js', 'detached: true', 'hotkey.js does not block Ctrl+C'],
];
for (const [f, needle, label] of checks) {
  const p = path.join(R, f);
  if (!fs.existsSync(p)) { bad(`${f} MISSING`); continue; }
  fs.readFileSync(p, 'utf8').includes(needle) ? ok(label) : bad(label + '  <-- OLD FILE, not updated');
}

console.log('\n--- binaries and models ---');
for (const [f, label] of [
  ['bin/whisper-cli.exe', 'whisper-cli.exe'],
  ['bin/piper/piper.exe', 'piper.exe'],
  ['bin/ffmpeg.exe', 'ffmpeg.exe'],
  ['bin/ffplay.exe', 'ffplay.exe'],
  ['models/silero_vad.onnx', 'silero_vad.onnx'],
  ['models/ggml-small.bin', 'whisper model'],
  ['models/en_US-lessac-medium.onnx', 'english voice'],
]) {
  const p = path.join(R, f);
  if (fs.existsSync(p)) ok(`${label}  (${(fs.statSync(p).size / 1048576).toFixed(1)} MB)`);
  else bad(`${label} MISSING at ${f}`);
}

console.log('\n--- config ---');
try {
  const c = JSON.parse(fs.readFileSync(path.join(R, 'config.json'), 'utf8'));
  console.log('  incoming :', c.incoming.enabled ? 'ON' : 'OFF',
              '| source:', c.incoming.source, '| process:', c.incoming.processName,
              '| target:', c.incoming.targetLanguage);
  console.log('  outgoing :', c.outgoing.enabled ? 'ON' : 'OFF',
              '| target:', c.outgoing.targetLanguage);
  console.log('  translate backend:', c.translate.backend);
  console.log('  piper exe path   :', c.tts.exe);
  console.log('  log level        :', c.debug.logLevel);

  if (c.translate.backend === 'llama') bad('backend is "llama" - needs a server on :8080. Use "whisper" for English.');
  if (c.incoming.targetLanguage !== 'en' && c.translate.backend === 'whisper') {
    bad(`incoming target "${c.incoming.targetLanguage}" needs llama backend`);
  }
  const piper = path.isAbsolute(c.tts.exe) ? c.tts.exe : path.join(R, c.tts.exe);
  if (!fs.existsSync(piper)) bad(`tts.exe points at ${c.tts.exe} which does not exist`);
} catch (e) {
  bad('config.json unreadable: ' + e.message);
}

console.log('\n--- node modules ---');
for (const m of ['loopback-capture', 'onnxruntime-node']) {
  try { require.resolve(m); ok(m + ' installed'); }
  catch { bad(m + ' NOT installed - run: npm install'); }
}

console.log('\n--- is DayZ running? ---');
try {
  const out = execSync('tasklist /fo csv /nh', { encoding: 'utf8', windowsHide: true });
  const games = out.split(/\r?\n/)
    .map(l => (l.match(/"([^"]*)"/g) || []))
    .filter(c => c.length > 4)
    .map(c => ({ name: c[0].slice(1, -1), pid: c[1].slice(1, -1),
                 mem: parseInt(c[4].slice(1, -1).replace(/\D/g, ''), 10) || 0 }))
    .filter(p => /dayz|cod|warzone|discord|teamspeak|mumble/i.test(p.name));
  if (games.length) games.forEach(g => ok(`${g.name} (PID ${g.pid}, ${Math.round(g.mem / 1024)} MB)`));
  else bad('no game or voice app found running right now');
} catch (e) { bad('tasklist failed: ' + e.message); }

console.log('\n--- last run log ---');
const log = path.join(R, 'babble-log.txt');
if (fs.existsSync(log)) {
  const lines = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/);
  console.log('  (last 15 lines)');
  lines.slice(-15).forEach(l => console.log('   ' + l));
} else {
  bad('babble-log.txt does not exist - run.bat has not produced a log yet');
}
console.log('');

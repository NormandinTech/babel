'use strict';

const http = require('http');

/**
 * Local control panel on http://localhost:7331
 *
 * Deliberately a plain Node http server with the page inlined: no build step,
 * no dependencies, no Electron. Works offline, adds nothing to the download.
 *
 * Doubles as the captions display - open it on a second monitor or a phone and
 * you get a live transcript without drawing anything over the game.
 */

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Babel</title>
<style>
  :root {
    --shell:      #141109;
    --panel:      #1E1A11;
    --raised:     #2A2517;
    --edge:       #3A3320;
    --signal:     #E8A33D;
    --signal-dim: #8A6323;
    --bone:       #D6CEB8;
    --muted:      #857C64;
    --live:       #9BB068;
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    background: var(--shell);
    color: var(--bone);
    font: 400 15px/1.5 ui-sans-serif, "Segoe UI", system-ui, sans-serif;
    min-height: 100vh;
    display: flex;
    justify-content: center;
    padding: 28px 20px 40px;
  }
  main { width: 100%; max-width: 620px; }

  .plate {
    background: var(--panel);
    border: 1px solid var(--edge);
    border-radius: 3px;
  }

  /* --- receiver head --- */
  .head {
    padding: 26px 26px 22px;
    display: flex;
    align-items: center;
    gap: 22px;
  }
  .power {
    flex: none;
    width: 108px; height: 108px;
    border-radius: 50%;
    background: var(--raised);
    border: 2px solid var(--edge);
    color: var(--muted);
    cursor: pointer;
    display: grid;
    place-content: center;
    gap: 5px;
    font: inherit;
    transition: border-color .18s, color .18s, background .18s;
  }
  .power:hover { border-color: var(--signal-dim); }
  .power:focus-visible { outline: 2px solid var(--signal); outline-offset: 3px; }
  .power .dot {
    width: 13px; height: 13px; border-radius: 50%;
    background: var(--muted);
    justify-self: center;
    transition: background .18s, box-shadow .18s;
  }
  .power .word { font-size: 13px; letter-spacing: .04em; font-weight: 600; }
  body.on .power {
    color: var(--signal);
    border-color: var(--signal);
    background: #2E2513;
  }
  body.on .power .dot {
    background: var(--signal);
    box-shadow: 0 0 12px var(--signal);
  }
  body.on.flowing .power .dot { animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { .power .dot { animation: none !important; } }

  .head-text h1 {
    margin: 0 0 3px;
    font-size: 27px;
    font-weight: 650;
    letter-spacing: -.02em;
  }
  .head-text p { margin: 0; color: var(--muted); font-size: 14px; }
  .head-text .hint { margin-top: 9px; font-size: 13px; color: var(--signal-dim); }
  kbd {
    background: var(--raised); border: 1px solid var(--edge);
    border-radius: 3px; padding: 1px 6px;
    font: 600 12px ui-monospace, "Cascadia Mono", Consolas, monospace;
    color: var(--bone);
  }

  /* --- settings --- */
  .row {
    border-top: 1px solid var(--edge);
    padding: 17px 26px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
  }
  .row label { font-weight: 500; }
  .row .why { display: block; color: var(--muted); font-size: 13px; font-weight: 400; margin-top: 2px; }
  select {
    background: var(--raised);
    color: var(--bone);
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 8px 11px;
    font: inherit;
    min-width: 168px;
  }
  select:focus-visible { outline: 2px solid var(--signal); outline-offset: 1px; }
  .btn {
    background: var(--raised); color: var(--bone);
    border: 1px solid var(--edge); border-radius: 3px;
    padding: 8px 15px; font: inherit; cursor: pointer;
    transition: border-color .15s, color .15s;
  }
  .btn:hover:not(:disabled) { border-color: var(--signal); color: var(--signal); }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn:focus-visible { outline: 2px solid var(--signal); outline-offset: 1px; }

  /* --- transcript --- */
  .feed { margin-top: 22px; }
  .feed-top {
    display: flex; align-items: baseline; justify-content: space-between;
    margin-bottom: 9px; padding: 0 2px;
  }
  .feed-top h2 { margin: 0; font-size: 15px; font-weight: 600; }
  .feed-top span { color: var(--muted); font-size: 13px; }
  .log {
    background: var(--panel);
    border: 1px solid var(--edge);
    border-radius: 3px;
    height: 320px;
    overflow-y: auto;
    padding: 8px 0;
    font: 400 13.5px/1.6 ui-monospace, "Cascadia Mono", Consolas, monospace;
  }
  .line { padding: 7px 18px; border-bottom: 1px solid #241F14; }
  .line:last-child { border-bottom: 0; }
  .line .meta { color: var(--muted); font-size: 12px; }
  .line .said { color: var(--bone); display: block; margin-top: 2px; }
  .line .src { color: var(--signal-dim); }
  .empty { padding: 26px 18px; color: var(--muted); }

  .foot { margin-top: 16px; color: var(--muted); font-size: 13px; padding: 0 2px; }
  .warn { color: var(--signal); }
</style>
</head>
<body>
<main>
  <div class="plate">
    <div class="head">
      <button class="power" id="power" aria-pressed="false">
        <span class="dot" aria-hidden="true"></span>
        <span class="word" id="powerWord">Off</span>
      </button>
      <div class="head-text">
        <h1>Babel</h1>
        <p id="status">Starting up</p>
        <p class="hint"><kbd id="keyname">Scroll Lock</kbd> toggles this without opening anything</p>
      </div>
    </div>

    <div class="row">
      <label for="target">
        Speak to me in
        <span class="why">Anything you hear in another language gets translated to this.</span>
      </label>
      <select id="target"></select>
    </div>

    <div class="row" id="getRow">
      <label for="getLang">
        Add a language
        <span class="why" id="getWhy">One-time download, about 60 MB.</span>
      </label>
      <span style="display:flex;gap:9px">
        <select id="getLang"></select>
        <button class="btn" id="getBtn">Download</button>
      </span>
    </div>
  </div>

  <section class="feed">
    <div class="feed-top">
      <h2>What people said</h2>
      <span id="count"></span>
    </div>
    <div class="log" id="log" aria-live="polite">
      <p class="empty">Nothing yet. Translations appear here as people speak.</p>
    </div>
  </section>

  <p class="foot" id="foot"></p>
  <p class="foot">Close this tab when you're done. Babel keeps running.</p>
</main>

<script>
const $ = s => document.querySelector(s);
let heard = 0;

async function post(path, body) {
  await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

function paint(s) {
  document.body.classList.toggle('on', s.enabled);
  document.body.classList.toggle('flowing', !!s.audioFlowing);
  $('#power').setAttribute('aria-pressed', String(s.enabled));
  $('#powerWord').textContent = s.enabled ? 'On' : 'Off';

  $('#status').textContent = !s.enabled
    ? 'Paused. Nothing is being translated.'
    : s.audioFlowing ? 'Listening' : 'Waiting for sound';

  if (s.hotkey) $('#keyname').textContent = s.hotkey;

  const sel = $('#target');
  if (sel.options.length !== (s.languages || []).length) {
    sel.innerHTML = '';
    for (const l of s.languages || []) {
      const o = document.createElement('option');
      o.value = l.code; o.textContent = l.name;
      sel.appendChild(o);
    }
  }
  if (s.targetLanguage) sel.value = s.targetLanguage;

  const notes = [];
  if (s.gpu === 'cpu') notes.push('<span class="warn">Running on the processor, not the graphics card. Translations will lag.</span>');
  if (s.missingVoice) notes.push('No voice installed for ' + s.missingVoice + ', so English is being used.');
  $('#foot').innerHTML = notes.join('<br>');
}

$('#power').addEventListener('click', () => post('/api/toggle'));
$('#target').addEventListener('change', e => post('/api/target', { language: e.target.value }));

async function loadCatalog() {
  const list = await (await fetch('/api/voices')).json();
  const sel = $('#getLang');
  sel.innerHTML = '';
  const missing = list.filter(v => !v.installed);
  if (!missing.length) {
    $('#getRow').style.display = 'none';
    return;
  }
  for (const v of missing) {
    const o = document.createElement('option');
    o.value = v.code; o.textContent = v.name;
    sel.appendChild(o);
  }
  $('#getWhy').textContent = missing.length + ' more languages available. One-time download, about 60 MB.';
}

$('#getBtn').addEventListener('click', async () => {
  const code = $('#getLang').value;
  const name = $('#getLang').selectedOptions[0].textContent;
  const btn = $('#getBtn');
  btn.disabled = true;
  btn.textContent = 'Downloading';
  $('#getWhy').textContent = 'Getting the ' + name + ' voice. This can take a minute.';
  try {
    const r = await (await fetch('/api/voices/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: code }),
    })).json();
    if (r.ok) {
      $('#getWhy').textContent = name + ' is ready. Pick it above to use it.';
      await loadCatalog();
      paint(await (await fetch('/api/state')).json());
    } else {
      $('#getWhy').textContent = r.error || 'That download did not finish.';
    }
  } catch (err) {
    $('#getWhy').textContent = 'Could not reach the voice server. Check your connection.';
  }
  btn.disabled = false;
  btn.textContent = 'Download';
});

loadCatalog();

function addLine(d) {
  const log = $('#log');
  const blank = log.querySelector('.empty');
  if (blank) blank.remove();

  const el = document.createElement('div');
  el.className = 'line';
  const time = new Date().toTimeString().slice(0, 5);
  el.innerHTML =
    '<span class="meta">' + time + ' &middot; <span class="src">' + d.from + '</span></span>' +
    '<span class="said"></span>';
  el.querySelector('.said').textContent = d.text;

  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  while (log.children.length > 200) log.removeChild(log.firstChild);

  heard++;
  $('#count').textContent = heard + (heard === 1 ? ' translation' : ' translations');
}

const es = new EventSource('/api/stream');
es.addEventListener('state', e => paint(JSON.parse(e.data)));
es.addEventListener('caption', e => addLine(JSON.parse(e.data)));

fetch('/api/state').then(r => r.json()).then(paint);
</script>
</body>
</html>`;

const LANG_NAMES = {
  en: 'English', es: 'Spanish', pt: 'Portuguese', ru: 'Russian',
  de: 'German', fr: 'French', it: 'Italian', pl: 'Polish',
  tr: 'Turkish', nl: 'Dutch', uk: 'Ukrainian', zh: 'Chinese',
  ar: 'Arabic', ja: 'Japanese', ko: 'Korean', sv: 'Swedish',
};

function startServer({ port = 7331, control, log }) {
  const clients = new Set();

  const send = (event, payload) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) {
      try { res.write(frame); } catch (_) { clients.delete(res); }
    }
  };

  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(PAGE);
    }

    if (url === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(control.getState()));
    }

    if (url === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(`event: state\ndata: ${JSON.stringify(control.getState())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (url === '/api/voices' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(control.listVoices()));
    }

    if (url === '/api/voices/refresh' && req.method === 'POST') {
      Promise.resolve(control.refreshVoices ? control.refreshVoices() : control.listVoices())
        .then(list => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(list));
        })
        .catch(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(control.listVoices()));
        });
      return;
    }

    if (url === '/api/voices/install' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', async () => {
        let out;
        try {
          const { language } = JSON.parse(body || '{}');
          await control.installVoice(language);
          out = { ok: true };
        } catch (err) {
          out = { ok: false, error: err.message };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
        send('state', control.getState());
      });
      return;
    }

    if (req.method === 'POST' && (url === '/api/toggle' || url === '/api/target')) {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        try {
          const data = body ? JSON.parse(body) : {};
          if (url === '/api/toggle') control.toggle();
          else if (data.language) control.setTarget(data.language);
        } catch (_) { /* ignore malformed input */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(control.getState()));
        send('state', control.getState());
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      log.warn(`control panel port ${port} is taken - panel disabled, translation still works`);
    } else {
      log.warn(`control panel: ${err.message}`);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    log.info(`control panel: http://localhost:${port}`);
  });

  return {
    pushCaption: (from, text) => send('caption', { from, text }),
    pushState: () => send('state', control.getState()),
    close: () => { server.close(); clients.clear(); },
  };
}

module.exports = { startServer, LANG_NAMES };

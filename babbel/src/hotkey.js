'use strict';

const { spawn } = require('child_process');

/**
 * Global hotkey via polling, not a keyboard hook.
 *
 * This distinction matters. Installing a low-level keyboard hook
 * (SetWindowsHookEx) intercepts the input stream and is the kind of thing
 * anti-cheat looks at. GetAsyncKeyState only *reads* key state - it never
 * touches input on its way to the game. Same thing legitimate overlay tools do.
 *
 * Runs as a small PowerShell loop that prints a line when the key goes down;
 * no native module to compile, nothing to install.
 *
 * Default is Scroll Lock: it survived onto modern keyboards with essentially
 * no purpose, so no game binds it.
 */

const KEYS = {
  'scroll lock': 0x91, 'scrolllock': 0x91,
  'pause': 0x13, 'break': 0x13,
  'insert': 0x2D, 'home': 0x24, 'end': 0x23,
  'page up': 0x21, 'page down': 0x22,
  'f13': 0x7C, 'f14': 0x7D, 'f15': 0x7E, 'f16': 0x7F,
  'num lock': 0x90, 'caps lock': 0x14,
  'right ctrl': 0xA3, 'right shift': 0xA1, 'right alt': 0xA5,
  'numpad 0': 0x60, 'numpad 1': 0x61, 'numpad 2': 0x62, 'numpad 3': 0x63,
  'numpad 4': 0x64, 'numpad 5': 0x65, 'numpad 6': 0x66, 'numpad 7': 0x67,
  'numpad 8': 0x68, 'numpad 9': 0x69, 'numpad *': 0x6A, 'numpad -': 0x6D,
};

function resolveKey(name) {
  const k = String(name || '').trim().toLowerCase();
  return KEYS[k] ?? null;
}

const MODIFIERS = {
  shift: 0x10,
  ctrl: 0x11,
  control: 0x11,
  alt: 0x12,
};

/**
 * Shift is the default modifier, not Ctrl, and the reason is a hardware quirk:
 * the keyboard controller translates Ctrl+Scroll Lock into Break (VK_CANCEL)
 * before Windows ever sees a Scroll Lock press. Same for Ctrl+Pause. So a poll
 * watching Scroll Lock never fires. Shift passes through untouched.
 */
class Hotkey {
  /**
   * @param {string} key        plain press - toggles translation
   * @param {string} modifier   held with key to open settings
   * @param {Function} onPress  fired on plain press
   * @param {Function} onMenu   fired on modifier + key
   */
  constructor({ key = 'scroll lock', modifier = 'shift', onPress, onMenu, log }) {
    this.keyName = key;
    this.code = resolveKey(key);
    this.modName = String(modifier || 'shift').toLowerCase();
    this.modCode = MODIFIERS[this.modName] ?? MODIFIERS.shift;
    this.onPress = onPress;
    this.onMenu = onMenu;
    this.log = log;
    this.proc = null;
  }

  start() {
    if (this.code === null) {
      this.log.warn(
        `hotkey "${this.keyName}" is not one we can watch - toggle from the control panel instead. ` +
        `Try: ${Object.keys(KEYS).slice(0, 6).join(', ')}`
      );
      return false;
    }

    // GetAsyncKeyState reads state; it does not hook or intercept input.
    const script = `
$sig = '[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k);'
$api = Add-Type -MemberDefinition $sig -Name K -Namespace W -PassThru
$was = $false
while ($true) {
  $now = ($api::GetAsyncKeyState(${this.code}) -band 0x8000) -ne 0
  $mod = ($api::GetAsyncKeyState(${this.modCode}) -band 0x8000) -ne 0
  if ($now -and -not $was) {
    if ($mod) { Write-Output 'MENU' } else { Write-Output 'PRESS' }
    [Console]::Out.Flush()
  }
  $was = $now
  Start-Sleep -Milliseconds 40
}`.trim();

    try {
      // detached: true matters. A PowerShell child sharing this console
      // intercepts Ctrl+C before Node's SIGINT handler runs, which makes the
      // app unkillable from the terminal. Detaching gives it its own group.
      this.proc = spawn(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true, detached: true, stdio: ['ignore', 'pipe', 'ignore'] }
      );
      this.proc.unref();

      this.proc.stdout.on('data', (d) => {
        const out = d.toString();
        try {
          if (out.includes('MENU') && this.onMenu) this.onMenu();
          else if (out.includes('PRESS')) this.onPress();
        } catch (err) {
          this.log.warn(`hotkey: ${err.message}`);
        }
      });

      this.proc.on('error', err => {
        this.log.warn(`hotkey unavailable (${err.message}) - use the control panel`);
      });

      return true;
    } catch (err) {
      this.log.warn(`hotkey unavailable (${err.message}) - use the control panel`);
      return false;
    }
  }

  stop() {
    if (!this.proc) return;
    const pid = this.proc.pid;
    try { this.proc.kill(); } catch (_) {}
    // kill() doesn't take the tree down on Windows, and a detached PowerShell
    // survives it - taskkill /T is what actually ends the loop.
    try {
      require('child_process').execSync(`taskkill /pid ${pid} /T /F`, {
        stdio: 'ignore', windowsHide: true, timeout: 3000,
      });
    } catch (_) { /* already gone */ }
    this.proc = null;
  }
}

module.exports = { Hotkey, KEYS };

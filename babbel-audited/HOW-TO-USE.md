# Babbel

Hear other players in your language. Free, runs on your own PC, no account.

Someone speaks Russian in the server, you hear English a second later. Nothing
appears on your screen while you play.

---

## Before you start

You need a **PC running Windows 10 or 11**, and **headphones**. Not speakers -
on speakers the translated voice feeds back into your microphone and loops.

An NVIDIA graphics card makes it about ten times faster. It works without one,
just slower.

---

## Setting it up

### 1. Install Node.js

Go to **nodejs.org** and download the version marked LTS. Run the installer and
click through it. Nothing to configure.

### 2. Get Babbel

Download the zip from **github.com/NormandinTech/babbel**, then right-click it,
choose **Properties**, tick **Unblock** at the bottom, and click OK.

Do that *before* extracting. Windows blocks files that came from the internet,
and unblocking the zip first saves you doing it to every file inside.

Now extract it somewhere simple like `C:\babbel`. Avoid your Downloads folder -
it makes everything harder to find later.

### 3. Change two Windows settings

Both of these cause silent failures that are miserable to diagnose. Two minutes
now saves you an evening.

**Stop games from locking your sound card**

Press **Windows key + R**, type `mmsys.cpl`, press Enter. On the **Playback**
tab, double-click your headphones, go to the **Advanced** tab, and untick
*"Allow applications to take exclusive control of this device."* Click OK.

Without this, games grab the audio device and Babbel hears silence.

**Turn your microphone up**

Same window, **Recording** tab. Double-click your microphone, go to **Levels**,
and drag it to 100. If there's a *Microphone Boost* slider, +10 dB helps.

Talk while you watch the green bar next to your mic. It should move well into
the middle. If it barely twitches, Babbel can't hear you either.

*(Only needed if you want other people to hear you translated. Skip it if you
just want to understand them.)*

### 4. Start it

Double-click **run.bat**.

The first time, it installs what it needs - that takes a minute. After that it
starts in a couple of seconds.

Windows may show a blue *"Windows protected your PC"* box. Click **More info**,
then **Run anyway**. That appears for any program without a paid certificate.

---

## Using it

Once it's running, play normally. There's nothing on screen.

| Key | What it does |
|---|---|
| **Scroll Lock** | turn translation on or off |
| **Shift + Scroll Lock** | open settings |
| **Ctrl + C** | stop Babbel (in its window) |

Settings open in your browser, not over the game. Change what you need, close
the tab, keep playing. Babbel keeps running.

---

## Choosing your language

Babbel understands about 99 languages automatically. You never tell it what
other people are speaking - it works that out per sentence.

You only choose **your own** language, and it picks that up from your Windows
settings on first run.

To change it, press **Shift + Scroll Lock** and use the dropdown. If your
language isn't listed, use *Add a language* below it - 51 are available, each a
one-time download of about 60 MB.

---

## When something's wrong

Run this in the Babbel folder to check everything at once:

```
node doctor.js
```

| What you see | What to do |
|---|---|
| Nothing happens when people talk | Check `audio OK` appeared at startup. If it says *no audio yet*, redo the exclusive-mode setting above. |
| It reads out nonsense during firefights | Open `config.json`, find `"threshold"`, change 0.7 to 0.85. |
| Same phrase over and over | A known glitch of the speech model. Raise the threshold as above. |
| Translations arrive very late | Check startup said *using the GPU*. If it says CPU, open `config.json` and make sure `"extraArgs"` is `[]`. |
| It gets names and slang wrong | Download `ggml-medium.bin` into `models\` and point `whisper.model` at it. Slower, much more accurate. |
| Ctrl+C won't stop it | Close the window, or press Ctrl+C twice. |

Every session writes `babbel-log.txt` in the folder. If you ask for help, that
file has everything anyone needs.

---

## Being heard in another language

The steps above cover *understanding* people. If you also want your own speech
translated for them, there's one extra piece.

Windows has no built-in virtual microphone, so install **VB-CABLE** (free, from
vb-audio.com). Then:

1. In `config.json`, set `outgoing` to `"enabled": true`
2. In your game's audio settings, set the microphone to **CABLE Output**

Your teammates now hear the translation instead of your actual voice. That's
intended - it's how they understand you.

One limit: translating *into* English is free. Translating into any other
language needs `llama-server` running, which is a separate setup.

---

## Questions people ask

**Can this get me banned?** It reads audio through a normal Windows feature and
never touches the game. It doesn't hook the game, read its memory, or draw over
it - those are the things anti-cheat looks for. That said, no one can promise
you anything about another company's anti-cheat.

**Does it send my voice anywhere?** No. Everything runs on your PC. The only
time it uses the internet is downloading a new voice.

**Will it work on Xbox or PlayStation?** No - consoles don't let apps read other
apps' audio. But if *you* are on PC, you'll understand console players in your
lobby fine. They don't need anything.

**Is it really free?** Yes. MIT licensed, source on GitHub, no account, no
limits, nothing to buy.

---

## If you want to say thanks

Tell someone in a lobby about it. That's the whole point.

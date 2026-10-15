# Orbit

A web file explorer for your own computers. Browse, view, edit, upload, download,
and delete files on any machine running the Orbit agent — all from a web page,
from anywhere.

Three pieces:

- **Web client** (`docs/`) — static HTML/CSS/JS, hosted free on **GitHub Pages**.
- **Relay** (`server/`) — a tiny WebSocket broker, hosted on **Coolify** (your
  own always-on server) at `https://orbit.zdstudios.network`.
- **Agent** (`agent/`) — a small program you run on each computer you want to reach.

```
  Browser (GitHub Pages)  <--wss-->  Relay (Coolify)  <--wss-->  Agent (your PC)
```

The browser never connects to your computer directly. Both the browser and the
agent dial **out** to the relay, so there are no ports to open and it works
behind any home router. A single shared password gates every connection.

---

## 1. Deploy the relay (Coolify)

The relay is containerized (`server/Dockerfile`) and runs on Coolify — always on,
no cold starts. Full steps are in **[COOLIFY.md](COOLIFY.md)**; in short: point a
Coolify app at this repo (Build pack **Dockerfile**, base directory **`/server`**,
port **3000**), set `AUTH_TOKEN`, give it a domain, and deploy. Any Docker host
works too.

> It can also run on any Docker host or anywhere that takes a Node app — the relay has no host-specific code.

## 2. Enable GitHub Pages

Repo **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
branch `main`, folder **`/docs`**. Your client will be live at
`https://<you>.github.io/<repo>/`.

## 3. Run the agent on a computer

Grab a Windows build from the [latest release](https://github.com/ZDStudios/online-file-explorer/releases/latest). There are two:

- **`orbit-agent-auto.exe`** — relay URL and password are baked in. Just
  double-click it; it connects immediately and shares the whole machine. (This is
  the ready-to-go build for this deployment.)
- **`orbit-agent.exe`** — the consumer build. On first run it asks for the relay
  URL, password, device name, and an optional folder, then saves them to
  `config.json` next to itself. Use this to point the agent at your own relay.

Or run from source:

```bash
cd agent
npm install
node agent.js --setup
```

On first run it asks for the relay URL, the token, a device name, and an optional
folder to restrict access to (leave blank for the whole machine). Answers are
saved to `config.json` next to the program. Run it again any time to reconnect;
it stays running and reconnects automatically.

Repeat on as many computers as you like — each shows up as its own device, by
name, in the web client.

## 4. Use it

Open your GitHub Pages URL, enter the relay URL and token, and pick a device.
You can:

- Browse folders and drives
- **View** images and PDFs inline
- **Edit** text/code files and save back to the device
- **Upload** (button or drag-and-drop) and **download** files
- **Rename**, **delete**, and create folders

---

## Background running & auto-start (Windows)

When you run the packaged `.exe` (e.g. from your Downloads), it **installs itself
into your Startup folder** and runs from there:
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\orbit-agent-auto.exe`.
It copies itself into Startup, launches that copy **hidden in the background**
(no console window), and **deletes the one you downloaded**. From then on Windows
starts it automatically at every login, and it keeps itself there across updates.

- **Battery:** the agent runs at below-normal priority and sits idle (just a kept-
  alive WebSocket) when nothing is happening, so its battery impact is negligible.
- **Sleep / closing the lid:** Windows suspends every program while the machine
  sleeps, so files can't be served during true sleep — but the agent isn't
  killed. The moment the laptop wakes, it resumes and reconnects on its own.
  (Orbit deliberately does **not** force the machine to stay awake, because that
  would drain the battery. If you want 24/7 access with the lid closed, set
  Windows → Power → "When I close the lid" to *Do nothing* while plugged in.)

Run once without installing auto-start:

```bat
orbit-agent-auto.exe --no-startup
```

To stop the running agent, end `orbit-agent-auto.exe` in Task Manager.

**Remove it remotely:** in the web client, select the device and click
**Remove from device**. After a confirmation and re-entering the password, the
agent uninstalls itself on that computer — it removes its Startup entry, deletes
its saved config, and deletes its own `.exe`, then exits.

## Automatic updates

The background agent checks `agent/version.json` in this repo every 30 minutes
(and ~20s after it starts). When that file's `version` is higher than the running
build, the agent downloads the matching `.exe` from the release, swaps itself in,
relaunches hidden, and cleans up — no user action, all in the background. The new
exe re-registers its own Startup entry on launch, so auto-start keeps working.

**Older exes keep working** — this is purely client-side and the relay never gates
on version, so any previously built agent still connects to the same relay.

To roll out an update: bump `AGENT_VERSION` in `agent/agent.js` and the `version`
in `agent/version.json` together, rebuild (`npm run build`), and upload the new
exes to the release. Agents pick it up within 30 minutes.

## Security notes

- The agent grants **full read/write** to whatever root you choose. Only run it
  on machines you own, and keep the token secret.
- Everything is end-to-end over TLS (`wss://`) via the relay's HTTPS host.
- To limit exposure, set a restricted folder during `--setup` (or `ORBIT_ROOT`).

## Building the agent .exe yourself

```bash
cd agent
npm install
npm run build   # -> dist/orbit-agent.exe and dist/orbit-agent-auto.exe
```

`build.js` produces both targets. The baked-in relay/password for the auto build
live at the top of `build.js` — edit them there to bake in your own.

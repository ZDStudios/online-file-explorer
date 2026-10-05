# Orbit

A web file explorer for your own computers. Browse, view, edit, upload, download,
and delete files on any machine running the Orbit agent — all from a web page,
from anywhere.

Three pieces:

- **Web client** (`docs/`) — static HTML/CSS/JS, hosted free on **GitHub Pages**.
- **Relay** (`server/`) — a tiny WebSocket broker, hosted free on **Render**.
- **Agent** (`agent/`) — a small program you run on each computer you want to reach.

```
  Browser (GitHub Pages)  <--ws-->  Relay (Render)  <--ws-->  Agent (your PC)
```

The browser never connects to your computer directly. Both the browser and the
agent dial **out** to the relay, so there are no ports to open and it works
behind any home router. A single shared token gates every connection.

---

## 1. Deploy the relay to Render (free)

1. Fork/clone this repo to your GitHub (already done if you're reading this there).
2. In the [Render dashboard](https://dashboard.render.com) → **New → Blueprint**,
   point it at this repo. Render reads `render.yaml` and creates the
   `orbit-relay` web service on the free plan.
3. Render generates an `AUTH_TOKEN` automatically. Open the service →
   **Environment** and copy its value — you'll need it for the web client and the
   agent.
4. Note the service URL, e.g. `https://orbit-relay.onrender.com`.

> Free Render services sleep after inactivity and cold-start in ~30–60s on the
> next connection. The agent auto-reconnects, so it comes back on its own.

## 2. Enable GitHub Pages

Repo **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
branch `main`, folder **`/docs`**. Your client will be live at
`https://<you>.github.io/<repo>/`.

## 3. Run the agent on a computer

Grab `agent/dist/orbit-agent.exe` (Windows) or run from source:

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

## Security notes

- The agent grants **full read/write** to whatever root you choose. Only run it
  on machines you own, and keep the token secret.
- Everything is end-to-end over TLS (`wss://`) once Render is in front.
- To limit exposure, set a restricted folder during `--setup` (or `ORBIT_ROOT`).

## Building the agent .exe yourself

```bash
cd agent
npm install
npm run build   # -> dist/orbit-agent.exe
```

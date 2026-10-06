'use strict';

/* Orbit web client. Talks to the relay over WebSocket, addresses requests to a
 * chosen device (agent), and renders a file explorer. No build step, no deps. */

const $ = (id) => document.getElementById(id);
const LS = { relay: 'orbit.relay', token: 'orbit.token', theme: 'orbit.theme' };

// Relay is preconfigured so visitors only type the password. The password is
// NEVER baked in — it must be entered and is verified by the server.
const DEFAULT_RELAY = 'https://orbit-relay-c72o.onrender.com';

let ws = null;
let reqSeq = 0;
const pending = new Map();         // reqId -> {resolve, reject, timer}
let devices = [];
let activeDevice = null;
let cwd = '';
let curEntries = [];
let navHistory = [];   // folders visited, for the Back button

// connection lifecycle
let creds = { relay: '', token: '' };
let reconnectTimer = null;
let attempt = 0;
let everOnline = false;
let authFailed = false;
let inApp = false;

// ---- theme -----------------------------------------------------------------
function applyTheme(mode) {
  // mode: 'light' | 'dark' | 'system'
  if (mode === 'system' || !mode) { document.documentElement.removeAttribute('data-theme'); localStorage.removeItem(LS.theme); }
  else { document.documentElement.setAttribute('data-theme', mode); localStorage.setItem(LS.theme, mode); }
  const seg = document.getElementById('set-theme');
  if (seg) seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.theme === (mode || 'system')));
}
(function initTheme() { applyTheme(localStorage.getItem(LS.theme) || 'system'); })();

// ---- toast -----------------------------------------------------------------
function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 3200);
  setTimeout(() => el.remove(), 3600);
}

// ---- connection ------------------------------------------------------------
function relayToWs(url) {
  url = url.trim().replace(/\/+$/, '');
  if (url.startsWith('http://')) return 'ws://' + url.slice(7);
  if (url.startsWith('https://')) return 'wss://' + url.slice(8);
  if (url.startsWith('ws://') || url.startsWith('wss://')) return url;
  return 'wss://' + url;
}

// ---- status beacon ----
function beacon(state, label) {
  const b = $('beacon');
  b.setAttribute('data-state', state);
  $('beacon-label').textContent = label || state;
  // mirror into header chip
  $('conn-dot').className = 'dot ' + (state === 'online' ? 'on' : state === 'offline' ? 'off' : '');
  $('conn-txt').textContent = label || state;
}

function showWait(title, sub) {
  $('gate-form').style.display = 'none';
  $('gate-wait').style.display = 'block';
  $('gate').style.display = 'flex';
  if (title) $('wait-title').textContent = title;
  if (sub != null) $('wait-sub').textContent = sub;
}
function showForm(err) {
  $('gate-wait').style.display = 'none';
  $('gate-form').style.display = 'block';
  $('gate').style.display = 'flex';
  $('g-err').textContent = err || '';
}

// Begin (or resume) the connection loop. Keeps retrying through a cold boot;
// the saved password is verified by the server as soon as it answers.
function startConnecting() {
  authFailed = false;
  clearTimeout(reconnectTimer);
  dial();
}

function scheduleRetry() {
  if (authFailed) return;
  attempt++;
  const delay = Math.min(2000 + attempt * 1000, 8000);
  // red while we sit idle between attempts, with a live countdown
  if (!inApp) beacon('offline', 'server offline');
  else beacon('offline', 'reconnecting');
  let left = Math.ceil(delay / 1000);
  const tick = () => {
    if (!inApp) {
      $('wait-meta').textContent = everOnline
        ? `Lost the server. Retrying in ${left}s…`
        : `Attempt ${attempt} · still waking up · retrying in ${left}s`;
    }
    left--;
  };
  tick();
  clearInterval(scheduleRetry._iv);
  scheduleRetry._iv = setInterval(tick, 1000);
  reconnectTimer = setTimeout(() => { clearInterval(scheduleRetry._iv); dial(); }, delay);
}

function dial() {
  let base;
  try { base = relayToWs(creds.relay); } catch { showForm('That relay URL looks invalid.'); return; }
  const u = new URL(base);
  u.searchParams.set('role', 'web');
  u.searchParams.set('token', creds.token);

  beacon('connecting', inApp ? 'reconnecting' : 'starting');
  if (!inApp) showWait(everOnline ? 'Reconnecting…' : 'Waking the server…',
    everOnline ? 'The connection dropped. Getting it back.' : 'Free servers sleep when idle. This can take up to a minute — hang tight.');

  try { ws = new WebSocket(u.toString()); }
  catch { scheduleRetry(); return; }

  let settled = false; // got a definitive answer (auth ok/fail) on this socket?

  ws.onopen = () => {
    beacon('connecting', 'authenticating');
    if (!inApp) { $('wait-title').textContent = 'Checking your password…'; $('wait-meta').textContent = ''; }
  };

  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'error') {
      if (msg.error === 'auth_failed') { settled = true; onAuthFail(); }
      return;
    }
    if (msg.type === 'hello') { settled = true; onOnline(); return; }
    if (msg.type === 'devices') { devices = msg.devices || []; renderDevices(); return; }
    if (msg.type === 'resp' && msg.reqId != null && pending.has(msg.reqId)) {
      const p = pending.get(msg.reqId); pending.delete(msg.reqId); clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error || 'request failed'));
    }
  };

  ws.onclose = () => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('connection closed')); }
    pending.clear();
    if (authFailed) return;
    scheduleRetry();
  };
  ws.onerror = () => { /* onclose handles retry */ };
}

function onOnline() {
  attempt = 0; everOnline = true; clearInterval(scheduleRetry._iv);
  beacon('online', 'online');
  if (!inApp) {
    inApp = true;
    $('gate').style.display = 'none';
    $('app').style.display = 'grid';
    if (!activeDevice && devices.length === 1) selectDevice(devices[0].id);
  }
}

function onAuthFail() {
  authFailed = true;
  clearTimeout(reconnectTimer); clearInterval(scheduleRetry._iv);
  localStorage.removeItem(LS.token);
  if (ws) { try { ws.close(); } catch {} }
  inApp = false;
  $('app').style.display = 'none';
  beacon('offline', 'wrong password');
  showForm('That password was rejected by the server.');
}

function rpc(op, extra, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error('not connected'));
    if (!activeDevice) return reject(new Error('no device selected'));
    const reqId = ++reqSeq;
    const msg = Object.assign({ op, reqId, device: activeDevice }, extra || {});
    const timer = setTimeout(() => { pending.delete(reqId); reject(new Error('timed out')); }, timeoutMs || 30000);
    pending.set(reqId, { resolve, reject, timer });
    ws.send(JSON.stringify(msg));
  });
}

// ---- devices ---------------------------------------------------------------
function platLabel(p) {
  return ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' })[p] || p || 'device';
}
function renderDevices() {
  const box = $('devices');
  if (!devices.length) {
    box.innerHTML = '<div class="empty">No devices online. Run the Orbit agent on a computer to see it here.</div>';
    if (activeDevice && !devices.find(d => d.id === activeDevice)) { activeDevice = null; showPlaceholder('That device went offline.'); }
    return;
  }
  box.innerHTML = '';
  devices.forEach((d, idx) => {
    const el = document.createElement('div');
    el.className = 'device' + (d.id === activeDevice ? ' active' : '');
    el.style.animationDelay = Math.min(idx * 40, 300) + 'ms';
    el.innerHTML = `<div class="name"><span class="dot on"></span>${esc(d.name)}</div>
      <div class="meta">${platLabel(d.platform)} · up ${since(d.connectedAt)}</div>`;
    el.onclick = () => selectDevice(d.id);
    box.appendChild(el);
  });
  if (activeDevice && !devices.find(d => d.id === activeDevice)) { activeDevice = null; showPlaceholder('That device went offline.'); }
}
function since(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + 's'; if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h'; return Math.floor(s / 86400) + 'd';
}

async function selectDevice(id) {
  activeDevice = id; renderDevices();
  cwd = ''; navHistory = []; updateBack();
  await browse('');
}

function updateBack() {
  const b = $('btn-back'); if (b) b.disabled = navHistory.length === 0;
}

// Navigate to a folder, remembering where we came from (for Back).
function navTo(p) {
  if (p !== cwd) { navHistory.push(cwd); updateBack(); }
  browse(p);
}

function goBack() {
  if (!navHistory.length) return;
  const prev = navHistory.pop();
  updateBack();
  browse(prev);
}

// ---- browsing --------------------------------------------------------------
function showPlaceholder(main, sub) {
  $('listing').innerHTML = `<div class="placeholder"><div class="big">${esc(main)}</div>${sub ? '<div>' + esc(sub) + '</div>' : ''}</div>`;
}

async function browse(p) {
  if (!activeDevice) return;
  showPlaceholder('Loading…');
  try {
    const r = await rpc('list', { path: p });
    cwd = r.path || '';
    curEntries = r.entries || [];
    renderListing(r);
  } catch (e) {
    showPlaceholder('Could not open folder', e.message);
  }
}

function renderCrumbs(r) {
  const c = $('crumbs'); c.innerHTML = '';
  const root = document.createElement('span'); root.textContent = '⌂';
  root.onclick = () => navTo(''); c.appendChild(root);
  if (!cwd) return;
  const win = cwd.includes('\\') && !cwd.startsWith('/');
  const sepChar = win ? '\\' : '/';
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  let acc = win ? '' : '';
  parts.forEach((part, i) => {
    const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '›'; c.appendChild(sep);
    if (win) acc = i === 0 ? part + '\\' : acc + (acc.endsWith('\\') ? '' : '\\') + part;
    else acc = acc + '/' + part;
    const span = document.createElement('span'); span.textContent = part;
    const target = acc;
    span.onclick = () => navTo(target); c.appendChild(span);
  });
}

function renderListing(r) {
  renderCrumbs(r);
  const entries = r.entries || [];
  if (!entries.length) { showPlaceholder('Empty folder'); return; }
  const rows = entries.map((e, i) => {
    const icon = e.type === 'dir' ? '📁' : iconFor(e.name);
    const size = e.type === 'dir' ? '—' : fmtSize(e.size);
    const when = e.mtime ? fmtDate(e.mtime) : '';
    return `<tr class="row" data-i="${i}" style="animation-delay:${Math.min(i * 18, 400)}ms">
      <td><div class="fname"><span class="ico">${icon}</span><span>${esc(e.name)}</span></div></td>
      <td class="size">${size}</td>
      <td class="mtime">${when}</td>
      <td><div class="rowacts">
        ${e.type === 'file' ? `<button data-act="dl">Download</button>` : ''}
        <button data-act="rn">Rename</button>
        <button data-act="del">Delete</button>
      </div></td></tr>`;
  }).join('');
  $('listing').innerHTML = `<table><thead><tr><th>Name</th><th>Size</th><th>Modified</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  $('listing').querySelectorAll('tr.row').forEach(tr => {
    const e = entries[+tr.dataset.i];
    tr.querySelector('.fname').onclick = () => e.type === 'dir' ? navTo(e.path) : openFile(e);
    tr.querySelectorAll('[data-act]').forEach(b => {
      b.onclick = (ev) => { ev.stopPropagation(); const a = b.dataset.act;
        if (a === 'dl') downloadFile(e); else if (a === 'rn') renameEntry(e); else if (a === 'del') deleteEntry(e); };
    });
  });
}

// ---- file ops --------------------------------------------------------------
async function deleteEntry(e) {
  if (!confirm(`Delete "${e.name}"? This cannot be undone.`)) return;
  try { await rpc('delete', { path: e.path }); toast('Deleted ' + e.name, 'ok'); browse(cwd); }
  catch (err) { toast('Delete failed: ' + err.message, 'bad'); }
}
async function renameEntry(e) {
  const name = prompt('Rename to:', e.name); if (!name || name === e.name) return;
  const sep = e.path.includes('\\') ? '\\' : '/';
  const dir = e.path.slice(0, e.path.lastIndexOf(sep));
  const to = (dir || '') + sep + name;
  try { await rpc('rename', { from_path: e.path, to_path: to }); toast('Renamed', 'ok'); browse(cwd); }
  catch (err) { toast('Rename failed: ' + err.message, 'bad'); }
}
async function mkdir() {
  const name = prompt('New folder name:'); if (!name) return;
  const sep = cwd.includes('\\') ? '\\' : '/';
  const p = cwd ? cwd + (cwd.endsWith(sep) ? '' : sep) + name : name;
  try { await rpc('mkdir', { path: p }); toast('Folder created', 'ok'); browse(cwd); }
  catch (err) { toast('Could not create folder: ' + err.message, 'bad'); }
}

function b64ToBytes(b64) {
  const bin = atob(b64); const len = bin.length; const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i); return bytes;
}
function bytesToB64(bytes) {
  let bin = ''; const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}

async function downloadFile(e) {
  toast('Fetching ' + e.name + '…');
  try {
    const r = await rpc('read', { path: e.path }, 120000);
    const blob = new Blob([b64ToBytes(r.data)]);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = r.name || e.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  } catch (err) { toast('Download failed: ' + err.message, 'bad'); }
}

async function uploadFiles(fileList) {
  const sep = cwd.includes('\\') ? '\\' : '/';
  for (const f of fileList) {
    try {
      toast('Uploading ' + f.name + '…');
      const buf = new Uint8Array(await f.arrayBuffer());
      const p = cwd ? cwd + (cwd.endsWith(sep) ? '' : sep) + f.name : f.name;
      await rpc('write', { path: p, data: bytesToB64(buf) }, 120000);
      toast('Uploaded ' + f.name, 'ok');
    } catch (err) { toast('Upload failed (' + f.name + '): ' + err.message, 'bad'); }
  }
  browse(cwd);
}

// ---- viewer / editor -------------------------------------------------------
const IMG = ['png','jpg','jpeg','gif','webp','bmp','svg','ico','avif'];
const TEXT = ['txt','md','markdown','json','js','mjs','cjs','ts','jsx','tsx','css','scss','html','htm','xml','yml','yaml','csv','log','ini','cfg','conf','sh','bash','py','rb','go','rs','c','h','cpp','hpp','java','kt','php','sql','toml','env','gitignore','bat','ps1','lua','vue','svelte'];
function ext(n) { const i = n.lastIndexOf('.'); return i < 0 ? '' : n.slice(i + 1).toLowerCase(); }
function iconFor(n) {
  const x = ext(n);
  if (IMG.includes(x)) return '🖼️';
  if (['zip','rar','7z','tar','gz'].includes(x)) return '🗜️';
  if (['mp3','wav','flac','ogg','m4a'].includes(x)) return '🎵';
  if (['mp4','mkv','mov','avi','webm'].includes(x)) return '🎬';
  if (x === 'pdf') return '📕';
  if (TEXT.includes(x)) return '📄';
  return '📄';
}
const mimeByExt = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', bmp:'image/bmp', svg:'image/svg+xml', ico:'image/x-icon', avif:'image/avif', pdf:'application/pdf' };

let viewing = null;
async function openFile(e) {
  const x = ext(e.name);
  viewing = e;
  $('v-title').textContent = e.name;
  $('v-size').textContent = fmtSize(e.size);
  $('v-body').innerHTML = '<div class="center">Loading…</div>';
  $('v-foot').style.display = 'flex';
  $('v-note').textContent = '';
  $('v-save').style.display = 'none';
  $('overlay').classList.add('show');
  if (e.size > 64 * 1024 * 1024) {
    $('v-body').innerHTML = '<div class="center">File is too large to preview. Use Download.</div>';
    return;
  }
  try {
    const r = await rpc('read', { path: e.path }, 120000);
    const bytes = b64ToBytes(r.data);
    if (IMG.includes(x)) {
      const blob = new Blob([bytes], { type: mimeByExt[x] || 'image/*' });
      const url = URL.createObjectURL(blob);
      $('v-body').innerHTML = `<img src="${url}" alt="${esc(e.name)}">`;
    } else if (x === 'pdf') {
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      $('v-body').innerHTML = `<iframe src="${url}" style="width:100%;height:70vh;border:0"></iframe>`;
    } else if (TEXT.includes(x) || isProbablyText(bytes)) {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      const ta = document.createElement('textarea'); ta.value = text; ta.spellcheck = false;
      $('v-body').innerHTML = ''; $('v-body').appendChild(ta);
      $('v-save').style.display = 'inline-block';
      $('v-note').textContent = 'Editing · changes save back to the device';
    } else {
      $('v-body').innerHTML = '<div class="center">No preview for this file type. Use Download.</div>';
    }
  } catch (err) {
    $('v-body').innerHTML = `<div class="center">Could not open: ${esc(err.message)}</div>`;
  }
}
function isProbablyText(bytes) {
  const n = Math.min(bytes.length, 4000); let ctrl = 0;
  for (let i = 0; i < n; i++) { const b = bytes[i]; if (b === 0) return false; if (b < 9 || (b > 13 && b < 32)) ctrl++; }
  return ctrl / Math.max(1, n) < 0.1;
}
async function saveViewer() {
  if (!viewing) return;
  const ta = $('v-body').querySelector('textarea'); if (!ta) return;
  try {
    const bytes = new TextEncoder().encode(ta.value);
    await rpc('write', { path: viewing.path, data: bytesToB64(bytes) }, 120000);
    toast('Saved ' + viewing.name, 'ok'); closeViewer(); browse(cwd);
  } catch (err) { toast('Save failed: ' + err.message, 'bad'); }
}
function closeViewer() {
  const f = $('v-body').querySelector('img, iframe');
  if (f && f.src.startsWith('blob:')) URL.revokeObjectURL(f.src);
  $('overlay').classList.remove('show'); $('v-body').innerHTML = ''; viewing = null;
}

// ---- formatting ------------------------------------------------------------
function fmtSize(n) {
  if (n == null) return '';
  const u = ['B','KB','MB','GB','TB']; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(1)) + ' ' + u[i];
}
function fmtDate(ms) {
  const d = new Date(ms); if (isNaN(d)) return '';
  return d.toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: 'numeric' }) + ' ' +
         d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

// ---- creating new files (txt / docx / pdf), generated in-browser ----------
function escXml(s) { return String(s).replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c])); }

function genTxt(content) { return new TextEncoder().encode(content || ''); }

// minimal single-font PDF with the text laid out line by line
function genPdf(content) {
  const lines = (content || '').split(/\r?\n/);
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  let text = 'BT /F1 12 Tf 72 720 Td 15 TL\n';
  if (!lines.length || (lines.length === 1 && lines[0] === '')) text += '() Tj\n';
  else lines.forEach((ln, i) => { text += (i ? 'T* ' : '') + '(' + esc(ln) + ') Tj\n'; });
  text += 'ET';
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    '<</Length ' + text.length + '>>\nstream\n' + text + '\nendstream',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
  const xref = pdf.length;
  pdf += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
  offsets.forEach(off => { pdf += String(off).padStart(10, '0') + ' 00000 n \n'; });
  pdf += 'trailer\n<</Size ' + (objs.length + 1) + '/Root 1 0 R>>\nstartxref\n' + xref + '\n%%EOF';
  return new TextEncoder().encode(pdf);
}

// minimal .docx (a zip of OOXML parts)
function crc32(bytes) {
  let c = ~0;
  for (let i = 0; i < bytes.length; i++) { c ^= bytes[i]; for (let k = 0; k < 8; k++) c = (c & 1) ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; }
  return (~c) >>> 0;
}
function zipStore(files) {
  const enc = new TextEncoder();
  const locals = []; const central = []; let offset = 0;
  const u16 = (n) => [n & 255, (n >>> 8) & 255];
  const u32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = f.data; const crc = crc32(data); const size = data.length;
    const lh = [].concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(size), u32(size), u16(name.length), u16(0));
    const local = new Uint8Array(lh.length + name.length + size);
    local.set(lh, 0); local.set(name, lh.length); local.set(data, lh.length + name.length);
    locals.push(local);
    const ch = [].concat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(size), u32(size), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset));
    const cent = new Uint8Array(ch.length + name.length);
    cent.set(ch, 0); cent.set(name, ch.length);
    central.push(cent);
    offset += local.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cdSize), u32(offset), u16(0)));
  const total = offset + cdSize + eocd.length;
  const out = new Uint8Array(total); let p = 0;
  for (const l of locals) { out.set(l, p); p += l.length; }
  for (const c of central) { out.set(c, p); p += c.length; }
  out.set(eocd, p);
  return out;
}
function genDocx(content) {
  const paras = (content || '').split(/\r?\n/).map(ln =>
    `<w:p><w:r><w:t xml:space="preserve">${escXml(ln)}</w:t></w:r></w:p>`).join('');
  const enc = new TextEncoder();
  const files = [
    { name: '[Content_Types].xml', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') },
    { name: '_rels/.rels', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
    { name: 'word/document.xml', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + (paras || '<w:p/>') + '<w:sectPr/></w:body></w:document>') },
  ];
  return zipStore(files);
}

function openNewFile() {
  if (!activeDevice) { toast('Pick a device first.', 'bad'); return; }
  $('nf-name').value = ''; $('nf-content').value = ''; $('nf-note').textContent = '';
  const txt = document.querySelector('input[name="nf-type"][value="txt"]'); if (txt) txt.checked = true;
  $('nf-overlay').classList.add('show');
  setTimeout(() => $('nf-name').focus(), 50);
}
function closeNewFile() { $('nf-overlay').classList.remove('show'); }

async function createNewFile() {
  const type = (document.querySelector('input[name="nf-type"]:checked') || {}).value || 'txt';
  let name = $('nf-name').value.trim() || 'untitled';
  const content = $('nf-content').value;
  const dotExt = '.' + type;
  if (ext(name) !== type) name += dotExt;
  const sep = cwd.includes('\\') ? '\\' : '/';
  const p = cwd ? cwd + (cwd.endsWith(sep) ? '' : sep) + name : name;
  let bytes;
  try {
    bytes = type === 'pdf' ? genPdf(content) : type === 'docx' ? genDocx(content) : genTxt(content);
  } catch (e) { toast('Could not build file: ' + e.message, 'bad'); return; }
  try {
    $('nf-note').textContent = 'Creating…';
    await rpc('write', { path: p, data: bytesToB64(bytes) }, 120000);
    toast('Created ' + name, 'ok');
    closeNewFile();
    browse(cwd);
  } catch (e) { $('nf-note').textContent = ''; toast('Create failed: ' + e.message, 'bad'); }
}

// ---- wiring ----------------------------------------------------------------
function startApp(relay, token) {
  localStorage.setItem(LS.relay, relay); localStorage.setItem(LS.token, token);
  creds = { relay, token };
  attempt = 0; everOnline = false; inApp = false;
  startConnecting();
}

$('g-go').onclick = () => {
  const relay = $('g-relay').value.trim(); const token = $('g-token').value.trim();
  if (!relay || !token) { $('g-err').textContent = 'Both fields are required.'; return; }
  $('g-err').textContent = ''; startApp(relay, token);
};
$('g-token').addEventListener('keydown', e => { if (e.key === 'Enter') $('g-go').click(); });
$('g-relay').addEventListener('keydown', e => { if (e.key === 'Enter') $('g-token').focus(); });
$('wait-cancel').onclick = () => {
  authFailed = true; clearTimeout(reconnectTimer); clearInterval(scheduleRetry._iv);
  if (ws) { try { ws.close(); } catch {} }
  localStorage.removeItem(LS.token);
  beacon('offline', 'offline');
  showForm('');
  $('g-token').value = ''; $('g-token').focus();
};

$('btn-logout').onclick = () => { localStorage.removeItem(LS.token); if (ws) ws.close(); location.reload(); };

// settings
function openSettings() {
  applyTheme(localStorage.getItem(LS.theme) || 'system');
  $('set-relay').value = creds.relay || localStorage.getItem(LS.relay) || DEFAULT_RELAY;
  $('set-relay-note').textContent = '';
  $('set-overlay').classList.add('show');
}
function closeSettings() { $('set-overlay').classList.remove('show'); }
// remove (remote uninstall) a device
function deviceName(id) { const d = devices.find(x => x.id === id); return d ? d.name : 'this device'; }
function openRemove() {
  if (!activeDevice) { toast('Pick a device first.', 'bad'); return; }
  $('rm-name').textContent = deviceName(activeDevice);
  $('rm-pass').value = ''; $('rm-note').textContent = '';
  $('rm-overlay').classList.add('show');
  setTimeout(() => $('rm-pass').focus(), 50);
}
function closeRemove() { $('rm-overlay').classList.remove('show'); }
async function confirmRemove() {
  const password = $('rm-pass').value;
  if (!password) { $('rm-note').textContent = 'Enter the password to confirm.'; return; }
  const id = activeDevice; const name = deviceName(id);
  $('rm-note').textContent = 'Removing…';
  try {
    await rpc('uninstall', { password }, 15000);
    closeRemove();
    toast('Removed Orbit from ' + name, 'ok');
    activeDevice = null;
    showPlaceholder('Device removed', 'The agent has uninstalled itself from ' + name + '.');
  } catch (e) {
    $('rm-note').textContent = /password/i.test(e.message) ? 'Incorrect password.' : ('Failed: ' + e.message);
  }
}
$('btn-remove').onclick = openRemove;
$('rm-close').onclick = closeRemove;
$('rm-confirm').onclick = confirmRemove;
$('rm-overlay').onclick = (e) => { if (e.target === $('rm-overlay')) closeRemove(); };
$('rm-pass').addEventListener('keydown', e => { if (e.key === 'Enter') confirmRemove(); });

$('btn-settings').onclick = openSettings;
$('set-close').onclick = closeSettings;
$('set-overlay').onclick = (e) => { if (e.target === $('set-overlay')) closeSettings(); };
$('set-theme').querySelectorAll('button').forEach(b => { b.onclick = () => applyTheme(b.dataset.theme); });
$('set-relay-reset').onclick = () => { $('set-relay').value = DEFAULT_RELAY; $('set-relay-note').textContent = 'Reset to default — Save to apply.'; };
$('set-relay-save').onclick = () => {
  const relay = $('set-relay').value.trim();
  if (!relay) { $('set-relay-note').textContent = 'Enter a URL or reset to default.'; return; }
  localStorage.setItem(LS.relay, relay);
  creds.relay = relay;
  closeSettings();
  // reconnect against the new server with the saved password
  everOnline = false; attempt = 0;
  if (ws) { try { ws.close(); } catch {} }
  startConnecting();
};
$('btn-back').onclick = goBack;
$('btn-up').onclick = () => { if (cwd) navTo(parentOf(cwd)); };

// jump straight to a typed path (e.g. C:\Users\Zayn\My Drive)
function showPathInput() {
  if (!activeDevice) { toast('Pick a device first.', 'bad'); return; }
  $('crumbs').style.display = 'none';
  const i = $('path-input'); i.style.display = 'block'; $('path-go').style.display = 'inline-block';
  i.value = cwd; i.focus(); i.select();
}
function hidePathInput() {
  $('path-input').style.display = 'none'; $('path-go').style.display = 'none';
  $('crumbs').style.display = '';
}
function submitPath() {
  const v = $('path-input').value.trim();
  hidePathInput();
  if (v) navTo(v);
}
$('btn-goto').onclick = showPathInput;
$('path-go').onclick = submitPath;
$('path-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitPath();
  else if (e.key === 'Escape') hidePathInput();
});
$('path-input').addEventListener('blur', () => setTimeout(hidePathInput, 120)); // allow Go click
$('btn-refresh').onclick = () => activeDevice && browse(cwd);
$('btn-mkdir').onclick = () => activeDevice && mkdir();
$('btn-newfile').onclick = () => activeDevice && openNewFile();
$('nf-cancel').onclick = closeNewFile;
$('nf-create').onclick = createNewFile;
$('nf-overlay').onclick = (e) => { if (e.target === $('nf-overlay')) closeNewFile(); };
$('nf-name').addEventListener('keydown', e => { if (e.key === 'Enter') createNewFile(); });
$('btn-upload').onclick = () => activeDevice && $('file-input').click();
$('file-input').onchange = (e) => { if (e.target.files.length) uploadFiles(e.target.files); e.target.value = ''; };
$('v-close').onclick = closeViewer;
$('v-save').onclick = saveViewer;
$('v-download').onclick = () => viewing && downloadFile(viewing);
$('overlay').onclick = (e) => { if (e.target === $('overlay')) closeViewer(); };
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if ($('overlay').classList.contains('show')) closeViewer();
  if ($('nf-overlay').classList.contains('show')) closeNewFile();
  if ($('set-overlay').classList.contains('show')) closeSettings();
  if ($('rm-overlay').classList.contains('show')) closeRemove();
});

// drag & drop upload
const listing = $('listing');
['dragover','dragenter'].forEach(ev => listing.addEventListener(ev, e => { e.preventDefault(); }));
listing.addEventListener('drop', e => {
  e.preventDefault();
  if (activeDevice && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
});

function parentOf(p) {
  const sep = p.includes('\\') && !p.startsWith('/') ? '\\' : '/';
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 1) return '';
  parts.pop();
  if (sep === '\\') return parts.length === 1 ? parts[0] + '\\' : parts.join('\\');
  return '/' + parts.join('/');
}

// prefill + auto-connect if we have saved creds
(function boot() {
  beacon('offline', 'offline');
  const relay = localStorage.getItem(LS.relay) || DEFAULT_RELAY;
  const token = localStorage.getItem(LS.token) || '';   // never prefilled with a default
  $('g-relay').value = relay;
  if (token) {
    // Returning visitor on this browser — reconnect with the saved password.
    startApp(relay, token);
  } else {
    // New visitor must enter the password; the server verifies it.
    showForm('');
    setTimeout(() => $('g-token').focus(), 100);
  }
})();

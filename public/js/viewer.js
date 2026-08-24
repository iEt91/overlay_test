// viewer.js — Overlay Viewer (canvas + DOM images + audio estable para OBS)

// ----------------------------- WS & DOM refs -----------------------------
const viewerToken = window.__TANGO_VIEWER_TOKEN__ || new URLSearchParams(location.search).get('viewer_token');
const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://')
  + location.host
  + `?viewer_token=${encodeURIComponent(viewerToken || '')}`;
const socket = new WebSocket(WS_URL);

const container = document.getElementById('viewerContainer');
const canvas = document.getElementById('viewerCanvas');
const ctx = canvas && canvas.getContext ? canvas.getContext('2d', { alpha: true }) : null;
const imageLayer = document.getElementById('viewerImageLayer');

// Panel para desbloquear audio si el navegador/OBS lo exige
const audioUnlock = document.getElementById('audioUnlock');
const btnEnableAudio = document.getElementById('btnEnableAudio');

// ----------------------------- Estado mundial -----------------------------
const imageCache = new Map();
const domImageMap = new Map();

let WORLD = {
  strokes: [],
  images: [],
  texts: [],
  timers: [],
  audio: { current: null, playlist: [] },
  viewport: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 },
  volume: 1.0
};

// ----------------------------- Audio (estable) -----------------------------
// Subsistema robusto para CEF/OBS: 1 solo AudioContext, 1 solo HTMLAudioElement,
// espera canplaythrough, offset inicial 1 sola vez, y fades cortos.
const AudioState = {
  ctx: null,
  gain: null,
  el: null,              // HTMLAudioElement compartido
  srcNode: null,         // MediaElementAudioSourceNode
  currentUrl: null,
  playing: false,
  masterVolume: 1.0,
  fadeMs: 120,
  lastStartAtServer: null,
};

function ensureAudioGraph() {
  if (AudioState.ctx) return;
  AudioState.ctx = new (window.AudioContext || window.webkitAudioContext)();
  AudioState.gain = AudioState.ctx.createGain();
  AudioState.gain.gain.value = AudioState.masterVolume;
  AudioState.gain.connect(AudioState.ctx.destination);

  const el = new Audio();
  el.preload = "auto";
  el.crossOrigin = "anonymous";
  el.loop = false;
  el.autoplay = false;
  el.controls = false;

  const src = AudioState.ctx.createMediaElementSource(el);
  src.connect(AudioState.gain);

  el.addEventListener("ended", () => { AudioState.playing = false; });
  el.addEventListener("error", (e) => {
    console.warn("[viewer] Audio error", e);
    AudioState.playing = false;
  });

  AudioState.el = el;
  AudioState.srcNode = src;
}

function setMasterVolume(vol) {
  AudioState.masterVolume = Math.max(0, Math.min(1, vol ?? 1));
  if (AudioState.gain && AudioState.ctx) {
    const now = AudioState.ctx.currentTime;
    AudioState.gain.gain.cancelScheduledValues(now);
    AudioState.gain.gain.setValueAtTime(AudioState.gain.gain.value, now);
    AudioState.gain.gain.linearRampToValueAtTime(AudioState.masterVolume, now + 0.05);
  }
}

async function fadeTo(target, ms) {
  if (!AudioState.gain || !AudioState.ctx) return;
  const now = AudioState.ctx.currentTime;
  AudioState.gain.gain.cancelScheduledValues(now);
  AudioState.gain.gain.setValueAtTime(AudioState.gain.gain.value, now);
  AudioState.gain.gain.linearRampToValueAtTime(target, now + ms / 1000);
  return new Promise(r => setTimeout(r, ms));
}

async function playAudioOnce({ url, startedAtServer }) {
  ensureAudioGraph();

  if (AudioState.ctx.state === "suspended") {
    try { await AudioState.ctx.resume(); } catch {}
  }

  // Si ya suena algo, paramos antes de cambiar fuente
  if (AudioState.playing) {
    await stopAudio(true);
  }

  // Cargamos nueva fuente
  AudioState.el.src = url;
  AudioState.el.currentTime = 0;
  AudioState.el.load();
  AudioState.currentUrl = url;
  AudioState.lastStartAtServer = startedAtServer || null;

  // Esperamos canplaythrough (o timeout suave) para evitar “petardeos”
  await new Promise((resolve) => {
    const onReady = () => {
      AudioState.el.removeEventListener("canplaythrough", onReady);
      clearTimeout(to);
      resolve();
    };
    const to = setTimeout(() => resolve(), 1200);
    AudioState.el.addEventListener("canplaythrough", onReady, { once: true });
  });

  // Offset inicial UNA sola vez
  if (AudioState.lastStartAtServer) {
    const nowServer = Date.now();
    const elapsed = Math.max(0, (nowServer - AudioState.lastStartAtServer) / 1000);
    const dur = Number.isFinite(AudioState.el.duration) ? AudioState.el.duration : null;
    const seekTo = dur ? Math.min(elapsed, Math.max(0, dur - 0.25)) : elapsed;
    try { AudioState.el.currentTime = seekTo; } catch {}
  }

  try {
    await fadeTo(0.0, 0);
    await AudioState.el.play();
    AudioState.playing = true;
    await fadeTo(AudioState.masterVolume, AudioState.fadeMs);
  } catch (e) {
    console.warn("[viewer] play() blocked:", e);
    showAudioUnlock(); // Permitirá reintentar tras click
  }
}

async function stopAudio(immediate = false) {
  if (!AudioState.el) return;
  try {
    if (!immediate) await fadeTo(0.0, AudioState.fadeMs);
    AudioState.el.pause();
    AudioState.el.currentTime = 0;
  } catch {}
  AudioState.playing = false;
  AudioState.currentUrl = null;
  AudioState.lastStartAtServer = null;
}

// API que usa el WS:
function handleAudioTrigger(payload) { // { url, startedAtServer? }
  playAudioOnce(payload);
}
function handleAudioStop() {
  stopAudio(false);
}
function handleVolumeUpdate({ volume }) {
  setMasterVolume(typeof volume === 'number' ? volume : AudioState.masterVolume);
}

// UI para desbloquear audio (OBS/Chrome autoplay)
function showAudioUnlock() {
  if (!audioUnlock) return;
  audioUnlock.style.display = 'block';
  if (btnEnableAudio) {
    btnEnableAudio.onclick = async () => {
      try { ensureAudioGraph(); await AudioState.ctx.resume(); } catch {}
      try {
        if (AudioState.el && AudioState.el.src) await AudioState.el.play();
        audioUnlock.style.display = 'none';
      } catch (e) { console.warn("manual play failed", e); }
    };
  }
}

// ----------------------------- WebSocket -----------------------------
socket.addEventListener('open', () => {
  socket.send(JSON.stringify({ type: 'hello', role: 'viewer' }));
  console.log('viewer ws open');
});

socket.addEventListener('message', (ev) => {
  try { const msg = JSON.parse(ev.data); handleMessage(msg); } catch (e) { console.warn('ws parse err', e); }
});

function handleMessage(msg) {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case 'snapshot':
      if (msg.state) {
        WORLD = Object.assign({}, WORLD, msg.state);
        if (typeof WORLD.volume !== 'number') WORLD.volume = 1.0;
        setMasterVolume(WORLD.volume);
        adjustCanvasToViewport();
        render(); // inmediato
      }
      break;

    case 'viewport:update':
      WORLD.viewport = Object.assign({}, WORLD.viewport, msg.payload);
      adjustCanvasToViewport();
      break;

    // Strokes
    case 'stroke:start':
      WORLD.strokes.push(msg.payload);
      break;
    case 'stroke:point': {
      const { id, point } = msg.payload || {};
      const s = WORLD.strokes.find(x => x.id === id);
      if (s) s.points.push(point);
      break;
    }
    case 'stroke:end':
      // noop visual: ya dibujamos por puntos
      break;

    // Images
    case 'image:add':
      WORLD.images.push(msg.payload);
      preloadImage(msg.payload && msg.payload.url);
      break;
    case 'image:update': {
      const p = msg.payload;
      const idx = WORLD.images.findIndex(x => x.id === p.id);
      if (idx >= 0) WORLD.images[idx] = Object.assign({}, WORLD.images[idx], p);
      break;
    }
    case 'image:remove':
      if (msg.payload && msg.payload.id)
        WORLD.images = WORLD.images.filter(x => x.id !== msg.payload.id);
      break;

    // Audio
    case 'audio:trigger':
      WORLD.audio.current = msg.payload;
      handleAudioTrigger(msg.payload);
      break;
    case 'audio:stop':
      WORLD.audio.current = null;
      handleAudioStop();
      break;
    case 'audio:pause':
      if (AudioState.el) AudioState.el.pause();
      AudioState.playing = false;
      if (WORLD.audio.current) WORLD.audio.current.paused = true;
      break;
    case 'audio:resume':
      if (AudioState.el && AudioState.currentUrl) {
        AudioState.el.play().then(() => { AudioState.playing = true; }).catch(showAudioUnlock);
      } else if (msg.payload) {
        handleAudioTrigger(msg.payload);
      }
      if (msg.payload) WORLD.audio.current = Object.assign({}, WORLD.audio.current, msg.payload, { paused: false });
      break;
    case 'volume:update':
      WORLD.volume = (msg.payload && typeof msg.payload.volume === 'number') ? msg.payload.volume : WORLD.volume;
      handleVolumeUpdate({ volume: WORLD.volume });
      break;

    default:
      break;
  }
}

// ----------------------------- Render -----------------------------
function preloadImage(url) {
  if (!url) return;
  if (imageCache.has(url)) return;
  const im = new Image();
  im.crossOrigin = 'anonymous';
  im.src = url;
  imageCache.set(url, im);
}

function adjustCanvasToViewport() {
  if (!canvas || !ctx || !container) return;
  const vp = WORLD.viewport || { width: 1920, height: 1080 };
  container.style.width = vp.width + 'px';
  container.style.height = vp.height + 'px';
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.floor(vp.width * ratio);
  canvas.height = Math.floor(vp.height * ratio);
  canvas.style.width = vp.width + 'px';
  canvas.style.height = vp.height + 'px';
  if (imageLayer) {
    imageLayer.style.width = vp.width + 'px';
    imageLayer.style.height = vp.height + 'px';
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

(function loop() { render(); requestAnimationFrame(loop); })();

function render() {
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  const vp = WORLD.viewport || { x: 0, y: 0, width: 1920, height: 1080 };
  ctx.translate(-vp.x, -vp.y);

  for (const img of WORLD.images || []) if (img.viewerVisible !== false && img.visible !== false) drawImageObject(img);
  for (const text of WORLD.texts || []) if (text.viewerVisible !== false) drawText(text);
  for (const timer of WORLD.timers || []) if (timer.viewerVisible !== false) drawTimer(timer);
  for (const s of WORLD.strokes || []) drawStroke(s);

  ctx.restore();
  updateDomImages();
}

function drawText(item) {
  ctx.save();
  ctx.fillStyle = item.color || '#ffffff';
  ctx.font = `${item.size || 48}px "${item.font || 'Arial'}"`;
  ctx.textBaseline = 'top';
  String(item.text || '').split('\n').forEach((line, index) => ctx.fillText(line, item.x || 0, (item.y || 0) + index * (item.size || 48) * 1.2));
  ctx.restore();
}
function drawTimer(item) {
  const elapsed = Math.max(0, Math.floor((Date.now() - item.startedAtServer) / 1000));
  const seconds = item.mode === 'down' ? Math.max(0, (item.duration || 0) - elapsed) : elapsed;
  const text = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  drawText({ ...item, text });
}

function drawStroke(stroke) {
  if (!stroke || !stroke.points || stroke.points.length === 0) return;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = stroke.color || '#ff0000';
  ctx.lineWidth = stroke.width || 4;
  ctx.beginPath();
  const p0 = stroke.points[0];
  ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i < stroke.points.length; i++) {
    const p = stroke.points[i];
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
}

function drawImageObject(img) {
  // fallback de dibujo en canvas (aunque los GIFs van por DOM)
  let image = imageCache.get(img.url);
  if (!image) {
    image = new Image();
    image.crossOrigin = 'anonymous';
    image.src = img.url;
    imageCache.set(img.url, image);
  }
  try {
    const width = img.width || 300, height = img.height || 200;
    const centerX = (img.x || 0) + width / 2, centerY = (img.y || 0) + height / 2;
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate((Number(img.rotation) || 0) * Math.PI / 180);
    ctx.scale(img.flipX ? -1 : 1, 1);
    ctx.drawImage(image, -width / 2, -height / 2, width, height);
    ctx.restore();
  } catch (e) { /* noop */ }
}

// DOM overlay para imágenes (GIFs animan nativo)
function updateDomImages() {
  if (!imageLayer) return;
  const used = new Set();
  for (const img of WORLD.images || []) {
    if (img.viewerVisible === false || img.visible === false) continue;
    let el = domImageMap.get(img.id);
    if (!el) {
      el = document.createElement('img');
      el.style.position = 'absolute';
      el.style.pointerEvents = 'none';
      el.crossOrigin = 'anonymous';
      el.src = img.url;
      imageLayer.appendChild(el);
      domImageMap.set(img.id, el);
    }
    el.style.left = (img.x || 0) + 'px';
    el.style.top = (img.y || 0) + 'px';
    el.style.width = (img.width || 300) + 'px';
    el.style.height = (img.height || 200) + 'px';
    el.style.transformOrigin = 'center center';
    el.style.transform = `rotate(${Number(img.rotation) || 0}deg) scaleX(${img.flipX ? -1 : 1})`;
    el.style.visibility = 'visible';
    used.add(img.id);
  }
  // Limpia nodos obsoletos
  for (const [id, el] of domImageMap.entries()) {
    if (!used.has(id)) { try { el.remove(); } catch (e) {} domImageMap.delete(id); }
  }
}

// Ajuste inicial
adjustCanvasToViewport();
setMasterVolume(WORLD.volume);

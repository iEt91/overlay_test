// server.js
// Servidor con WebSocket básico para broadcast entre editors y viewers.
// Estado en memoria para MVP (ahora con biblioteca de assets).

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

// Carpeta de uploads dentro de public
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Multer config (guardamos en public/uploads)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const clean = file.originalname.replace(/\s+/g, '-').slice(0, 120);
    cb(null, `${unique}-${clean}`);
  }
});
const upload = multer({ storage });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Servir carpeta public
app.use(express.static(path.join(__dirname, 'public')));

// Estado en memoria
let STATE = {
  strokes: [],    // strokes completos (para snapshot)
  images: [],     // imágenes actualmente en canvas: { id, url, x, y, width, height }
  texts: [],
  timers: [],
  audio: { current: null, playlist: [], slots: {} },
  assets: { images: [], audio: [], fonts: [] }, // biblioteca de assets del proyecto
  viewport: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 }, // safe zone por defecto 1920x1080
  volume: 1,
  updatedAt: Date.now()
};

// GET /state -> devuelve estado actual + timestamp del servidor
app.get('/state', (req, res) => {
  res.json({
    serverTime: Date.now(),
    state: STATE
  });
});

// POST /state -> reemplaza estado completo (compatibilidad)
app.post('/state', (req, res) => {
  const incoming = req.body;
  if (!incoming) return res.status(400).json({ error: 'No body' });

  STATE = {
    strokes: Array.isArray(incoming.strokes) ? incoming.strokes : STATE.strokes,
    images: Array.isArray(incoming.images) ? incoming.images : STATE.images,
    texts: Array.isArray(incoming.texts) ? incoming.texts : STATE.texts,
    timers: Array.isArray(incoming.timers) ? incoming.timers : STATE.timers,
    audio: incoming.audio || STATE.audio,
    assets: incoming.assets || STATE.assets,
    viewport: incoming.viewport || STATE.viewport,
    volume: typeof incoming.volume === 'number' ? incoming.volume : STATE.volume,
    updatedAt: Date.now()
  };

  // Notify all WS clients about new snapshot
  broadcastWS({ type: 'snapshot', state: STATE });

  res.json({ ok: true, serverTime: STATE.updatedAt });
});

// POST /upload -> sube imágenes/audio, devuelve URL pública
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const publicUrl = `/uploads/${req.file.filename}`;
  res.json({ url: publicUrl });
});

// Endpoint simple para reset (útil en pruebas)
app.post('/reset', (req, res) => {
  STATE = {
    strokes: [],
    images: [],
    texts: [],
    timers: [],
    audio: { current: null, playlist: [], slots: {} },
    assets: { images: [], audio: [], fonts: [] },
    viewport: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 },
    volume: 1,
    updatedAt: Date.now()
  };
  broadcastWS({ type: 'snapshot', state: STATE });
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function broadcastWS(obj, except = null) {
  const raw = JSON.stringify(obj);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client !== except) {
      client.send(raw);
    }
  });
}

// WS protocol: hello; editors send incremental events; server updates STATE for snapshot-worthy events and rebroadcasts.
wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.role = 'unknown';

  ws.on('pong', () => ws.isAlive = true);

  ws.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg); } catch (e) { return; }

    if (data.type === 'hello') {
      ws.role = data.role || 'viewer';
      // send current snapshot immediately
      ws.send(JSON.stringify({ type: 'snapshot', state: STATE }));
      return;
    }

    switch (data.type) {
      // stroke events
      case 'stroke:start':
        if (data.payload) {
          STATE.strokes.push(data.payload);
          STATE.updatedAt = Date.now();
        }
        broadcastWS(data, null);
        break;
      case 'stroke:point':
        if (data.payload && data.payload.id && data.payload.point) {
          const s = STATE.strokes.find(x => x.id === data.payload.id);
          if (s) s.points.push(data.payload.point);
          STATE.updatedAt = Date.now();
        }
        broadcastWS(data, null);
        break;
      case 'stroke:end':
        STATE.updatedAt = Date.now();
        broadcastWS(data, null);
        break;

      // image/canvas events
      case 'image:add':
        if (data.payload) {
          STATE.images.push(data.payload);
          STATE.updatedAt = Date.now();
        }
        broadcastWS(data, null);
        break;
      case 'image:update':
        if (data.payload && data.payload.id) {
          const idx = STATE.images.findIndex(x => x.id === data.payload.id);
          if (idx >= 0) {
            STATE.images[idx] = Object.assign({}, STATE.images[idx], data.payload);
            STATE.updatedAt = Date.now();
          }
        }
        broadcastWS(data, null);
        break;
      case 'image:remove':
        if (data.payload && data.payload.id) {
          STATE.images = STATE.images.filter(x => x.id !== data.payload.id);
          STATE.updatedAt = Date.now();
        }
        broadcastWS(data, null);
        break;

      // assets (biblioteca)
      case 'asset:image:add':
        if (data.payload) {
          STATE.assets.images.push(data.payload);
          STATE.updatedAt = Date.now();
        }
        broadcastWS({ type: 'assets:update', payload: STATE.assets }, null);
        break;
      case 'asset:image:delete':
        if (data.payload && data.payload.id) {
          STATE.assets.images = STATE.assets.images.filter(x => x.id !== data.payload.id);
          // also remove from canvas if present
          STATE.images = STATE.images.filter(x => x.url !== data.payload.url);
          STATE.updatedAt = Date.now();
        }
        // El Viewer no usa la biblioteca: necesita el estado completo para retirar
        // inmediatamente las imágenes que este asset tenía colocadas en el canvas.
        broadcastWS({ type: 'snapshot', state: STATE }, null);
        break;
      case 'asset:audio:add':
        if (data.payload) {
          STATE.assets.audio.push(data.payload);
          STATE.updatedAt = Date.now();
        }
        broadcastWS({ type: 'assets:update', payload: STATE.assets }, null);
        break;
      case 'asset:audio:delete':
        if (data.payload && data.payload.id) {
          STATE.assets.audio = STATE.assets.audio.filter(x => x.id !== data.payload.id);
          STATE.audio.playlist = STATE.audio.playlist.filter(x => x.id !== data.payload.id);
          STATE.updatedAt = Date.now();
        }
        broadcastWS({ type: 'assets:update', payload: STATE.assets }, null);
        break;

      // viewport
      case 'viewport:update':
        if (data.payload) {
          STATE.viewport = Object.assign({}, STATE.viewport, data.payload);
          STATE.updatedAt = Date.now();
        }
        broadcastWS(data, null);
        break;

      // audio
      case 'audio:trigger':
        if (data.payload) {
          STATE.audio.current = data.payload;
          STATE.updatedAt = Date.now();
        }
        broadcastWS(data, null);
        break;
      case 'audio:stop':
        STATE.audio.current = null;
        STATE.updatedAt = Date.now();
        broadcastWS({ type: 'audio:stop' }, null);
        break;

      case 'asset:font:add':
        if (data.payload) {
          STATE.assets.fonts = STATE.assets.fonts || [];
          STATE.assets.fonts.push(data.payload);
          STATE.updatedAt = Date.now();
        }
        broadcastWS({ type: 'assets:update', payload: STATE.assets }, null);
        break;

      case 'text:add':
        if (data.payload) { STATE.texts.push(data.payload); STATE.updatedAt = Date.now(); }
        broadcastWS({ type: 'snapshot', state: STATE }, null);
        break;
      case 'text:update':
        if (data.payload && data.payload.id) {
          const index = STATE.texts.findIndex(item => item.id === data.payload.id);
          if (index >= 0) STATE.texts[index] = Object.assign({}, STATE.texts[index], data.payload);
          STATE.updatedAt = Date.now();
        }
        broadcastWS({ type: 'snapshot', state: STATE }, null);
        break;
      case 'text:remove':
        if (data.payload && data.payload.id) { STATE.texts = STATE.texts.filter(item => item.id !== data.payload.id); STATE.updatedAt = Date.now(); }
        broadcastWS({ type: 'snapshot', state: STATE }, null);
        break;
      case 'timer:add':
        if (data.payload) {
          // La hora del servidor mantiene el cronómetro igual para moderadores y Viewer.
          STATE.timers.push(Object.assign({}, data.payload, { startedAtServer: Date.now() }));
          STATE.updatedAt = Date.now();
        }
        broadcastWS({ type: 'snapshot', state: STATE }, null);
        break;
      case 'timer:update':
        if (data.payload && data.payload.id) {
          const index = STATE.timers.findIndex(item => item.id === data.payload.id);
          if (index >= 0) STATE.timers[index] = Object.assign({}, STATE.timers[index], data.payload);
          STATE.updatedAt = Date.now();
        }
        broadcastWS({ type: 'snapshot', state: STATE }, null);
        break;
      case 'timer:remove':
        if (data.payload && data.payload.id) { STATE.timers = STATE.timers.filter(item => item.id !== data.payload.id); STATE.updatedAt = Date.now(); }
        broadcastWS({ type: 'snapshot', state: STATE }, null);
        break;
      case 'audio:pause':
        if (STATE.audio.current) STATE.audio.current.paused = true;
        broadcastWS({ type: 'audio:pause' }, null);
        break;
      case 'audio:resume':
        if (STATE.audio.current) STATE.audio.current = Object.assign({}, STATE.audio.current, data.payload, { paused: false });
        broadcastWS({ type: 'audio:resume', payload: STATE.audio.current }, null);
        break;
      case 'volume:update':
        if (data.payload && typeof data.payload.volume === 'number') {
          STATE.volume = Math.max(0, Math.min(1, data.payload.volume));
          STATE.updatedAt = Date.now();
        }
        broadcastWS({ type: 'volume:update', payload: { volume: STATE.volume } }, null);
        break;

      // snapshot (full)
      case 'snapshot':
        if (data.payload && typeof data.payload === 'object') {
          STATE = Object.assign({}, STATE, data.payload, { updatedAt: Date.now() });
        }
        broadcastWS({ type: 'snapshot', state: STATE }, null);
        break;

      default:
        broadcastWS(data, null);
    }
  });

  ws.on('close', () => { /* noop */ });
});

// heartbeat to clean dead clients
const interval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping(() => {});
  });
}, 30000);

server.listen(PORT, () => {
  console.log(`Telestrator MVP server listening on http://localhost:${PORT}`);
  console.log('Viewer: http://localhost:' + PORT + '/viewer.html');
  console.log('Editor: http://localhost:' + PORT + '/editor.html');
});

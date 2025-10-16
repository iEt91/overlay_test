// viewer.js - image overlay + audio unlock fallback + volume update handling
const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
const socket = new WebSocket(WS_URL);

const container = document.getElementById('viewerContainer');
const canvas = document.getElementById('viewerCanvas');
const ctx = canvas && canvas.getContext ? canvas.getContext('2d', { alpha: true }) : null;
const imageLayer = document.getElementById('viewerImageLayer');
const audioUnlock = document.getElementById('audioUnlock');
const btnEnableAudio = document.getElementById('btnEnableAudio');

const imageCache = new Map();
const domImageMap = new Map();

let WORLD = {
  strokes: [],
  images: [],
  audio: { current: null, playlist: [] },
  viewport: { x:0,y:0,width:1920,height:1080,scale:1 },
  volume: 1.0
};

let currentAudio = null;
let masterVolume = 1.0;

socket.addEventListener('open', () => {
  socket.send(JSON.stringify({ type: 'hello', role: 'viewer' }));
  console.log('viewer ws open');
});

socket.addEventListener('message', (ev) => {
  try { const msg = JSON.parse(ev.data); handleMessage(msg); } catch(e) { console.warn('ws parse err', e); }
});

function handleMessage(msg) {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case 'snapshot':
      if (msg.state) {
        WORLD = Object.assign({}, WORLD, msg.state);
        if (!WORLD.volume) WORLD.volume = 1.0;
        masterVolume = WORLD.volume;
        adjustCanvasToViewport();
        render(); // immediate
      }
      break;
    case 'viewport:update':
      WORLD.viewport = Object.assign({}, WORLD.viewport, msg.payload);
      adjustCanvasToViewport(); break;
    case 'stroke:start':
      WORLD.strokes.push(msg.payload); break;
    case 'stroke:point': {
      const { id, point } = msg.payload || {}; const s = WORLD.strokes.find(x=>x.id===id); if (s) s.points.push(point);
      break;
    }
    case 'image:add':
      WORLD.images.push(msg.payload); preloadImage(msg.payload.url); break;
    case 'image:update': {
      const p = msg.payload; const idx = WORLD.images.findIndex(x => x.id === p.id);
      if (idx>=0) WORLD.images[idx] = Object.assign({}, WORLD.images[idx], p);
      break;
    }
    case 'audio:trigger':
      WORLD.audio.current = msg.payload; handleAudio(WORLD.audio); break;
    case 'audio:stop':
      WORLD.audio.current = null; if (currentAudio) { try { currentAudio.pause(); currentAudio = null; } catch(e){} } break;
    case 'volume:update':
      masterVolume = (msg.payload && typeof msg.payload.volume === 'number') ? msg.payload.volume : masterVolume;
      if (currentAudio) try { currentAudio.volume = masterVolume; } catch(e) {}
      break;
    default: break;
  }
}

function preloadImage(url) {
  if (!url) return;
  if (imageCache.has(url)) return;
  const im = new Image(); im.crossOrigin='anonymous'; im.src = url; imageCache.set(url, im);
}

function adjustCanvasToViewport() {
  if (!canvas || !ctx || !container) return;
  const vp = WORLD.viewport || { width:1920, height:1080 };
  container.style.width = vp.width + 'px'; container.style.height = vp.height + 'px';
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.floor(vp.width * ratio); canvas.height = Math.floor(vp.height * ratio);
  canvas.style.width = vp.width + 'px'; canvas.style.height = vp.height + 'px';
  imageLayer.style.width = vp.width + 'px'; imageLayer.style.height = vp.height + 'px';
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

(function loop(){ render(); requestAnimationFrame(loop); })();

function render() {
  if (!ctx) return;
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.save();
  const vp = WORLD.viewport || { x:0,y:0,width:1920,height:1080 };
  ctx.translate(-vp.x, -vp.y);

  for (const img of WORLD.images || []) drawImageObject(img);
  for (const s of WORLD.strokes || []) drawStroke(s);

  ctx.restore();
  updateDomImages();
}

function drawStroke(stroke) {
  if (!stroke || !stroke.points || stroke.points.length===0) return;
  ctx.lineJoin='round'; ctx.lineCap='round'; ctx.strokeStyle = stroke.color || '#ff0000';
  ctx.lineWidth = stroke.width || 4; ctx.beginPath();
  const p0 = stroke.points[0]; ctx.moveTo(p0.x,p0.y);
  for (let i=1;i<stroke.points.length;i++){ const p = stroke.points[i]; ctx.lineTo(p.x,p.y); }
  ctx.stroke();
}

function drawImageObject(img) {
  // keep minimal: images are rendered by DOM overlay (updateDomImages), but draw fallback for compatibility
  let image = imageCache.get(img.url);
  if (!image) { image = new Image(); image.crossOrigin='anonymous'; image.src = img.url; imageCache.set(img.url,image); }
  try {
    if (img.width && img.height) ctx.drawImage(image, img.x, img.y, img.width, img.height);
    else ctx.drawImage(image, img.x, img.y);
  } catch(e){}
}

// DOM overlay for images (GIFs animate natively)
function updateDomImages() {
  const used = new Set();
  for (const img of WORLD.images) {
    let el = domImageMap.get(img.id);
    if (!el) {
      el = document.createElement('img');
      el.style.position='absolute'; el.style.pointerEvents='none';
      el.crossOrigin='anonymous'; el.src = img.url;
      imageLayer.appendChild(el); domImageMap.set(img.id, el);
    }
    el.style.left = (img.x || 0) + 'px'; el.style.top = (img.y || 0) + 'px';
    el.style.width = (img.width || 300) + 'px'; el.style.height = (img.height || 200) + 'px';
    el.style.visibility = 'visible';
    used.add(img.id);
  }
  for (const [id, el] of domImageMap.entries()) {
    if (!used.has(id)) { try { el.remove(); } catch(e){} domImageMap.delete(id); }
  }
}

/* Audio */
let lastAudioUrl = null;
function handleAudio(audioState) {
  if (!audioState || !audioState.current) { if (currentAudio) { try { currentAudio.pause(); currentAudio=null; } catch(e){} } lastAudioUrl=null; return; }
  const cur = audioState.current;
  if (cur.url === lastAudioUrl) return;
  lastAudioUrl = cur.url;
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  currentAudio = new Audio(cur.url); currentAudio.crossOrigin='anonymous'; currentAudio.volume = masterVolume;
  const startedAtServer = cur.startedAtServer || Date.now();
  currentAudio.addEventListener('canplay', () => {
    const elapsed = Math.max(0, Date.now() - startedAtServer) / 1000;
    try { if (elapsed > 0 && elapsed < currentAudio.duration) currentAudio.currentTime = elapsed; } catch(e){}
    currentAudio.play().catch(err => {
      console.warn('viewer audio autoplay blocked:', err);
      // show enable button to manually allow playback
      showAudioUnlock();
    });
  });
}

function showAudioUnlock() {
  if (!audioUnlock) return;
  audioUnlock.style.display = 'block';
  btnEnableAudio && btnEnableAudio.addEventListener('click', () => {
    if (!currentAudio) return;
    currentAudio.play().then(() => {
      audioUnlock.style.display = 'none';
    }).catch(e => {
      console.warn('manual play failed', e);
    });
  }, { once: true });
}

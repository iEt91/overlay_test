// editor.js - GIF overlay + undo/clean robustos (mejora: persistencia / broadcast)
document.addEventListener('DOMContentLoaded', () => {
  try {
    const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
    const socket = new WebSocket(WS_URL);

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'hello', role: 'editor' }));
      console.log('WS editor connected');
    });

    socket.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'snapshot' && msg.state) {
          if (msg.state.assets) {
            STATE.assets = { images: [], audio: [], fonts: [], ...msg.state.assets };
            updateImagesLibraryUI();
            updateAudioLibraryUI();
            updateFontOptions(); loadCustomFonts(STATE.assets.fonts);
          }
          if (msg.state.images) STATE.images = msg.state.images.map(img => ({ ...img, viewerVisible: img.viewerVisible !== false && img.visible !== false }));
          if (msg.state.strokes) STATE.strokes = msg.state.strokes;
          if (msg.state.texts) STATE.texts = msg.state.texts;
          if (msg.state.timers) STATE.timers = msg.state.timers;
          if (msg.state.audio) STATE.audio = { current: null, playlist: [], slots: {}, ...msg.state.audio };
          if (typeof msg.state.volume === 'number') STATE.volume = msg.state.volume;
          updateCanvasImagesUI();
          updateSoundboardUI();
          updateTextList(); updateTimerList();
        } else if (msg.type === 'assets:update') {
          STATE.assets = { images: [], audio: [], fonts: [], ...(msg.payload || STATE.assets) };
          updateImagesLibraryUI();
          updateAudioLibraryUI();
          updateFontOptions(); loadCustomFonts(STATE.assets.fonts);
        } else if (msg.type === 'audio:stop') {
          stopAllLocalAudio();
        } else if (msg.type === 'volume:update') {
          STATE.volume = msg.payload && msg.payload.volume != null ? msg.payload.volume : STATE.volume;
          setLocalVolume(STATE.volume);
          if (masterVolumeEl) masterVolumeEl.value = Math.round(STATE.volume * 100);
          updateSoundboardUI();
        } else if (msg.type === 'image:update' && msg.payload) {
          const index = STATE.images.findIndex(img => img.id === msg.payload.id);
          if (index >= 0) STATE.images[index] = { ...STATE.images[index], ...msg.payload };
          updateCanvasImagesUI(); redraw();
        } else if (msg.type === 'image:remove' && msg.payload) {
          STATE.images = STATE.images.filter(img => img.id !== msg.payload.id);
          updateCanvasImagesUI(); redraw();
        }
      } catch (e) { console.warn('ws parse', e); }
    });

    // DOM
    const canvas = document.getElementById('editorCanvas');
    const viewportWrap = document.getElementById('editorViewport');
    const imageLayer = document.getElementById('imageLayer');

    const brushColorEl = document.getElementById('brushColor');
    const brushSizeEl = document.getElementById('brushSize');
    const btnClearLocal = document.getElementById('btn-clear-local');
    const btnPush = document.getElementById('btn-push-state');
    const btnFetchState = document.getElementById('btn-fetch-state');
    const btnResetServer = document.getElementById('btn-reset-server');
    const imgFile = document.getElementById('imgFile');
    const btnUploadImg = document.getElementById('btn-upload-img');
    const imagesList = document.getElementById('imagesList');
    const canvasImagesList = document.getElementById('canvasImagesList');
    const audioFile = document.getElementById('audioFile');
    const btnUploadAudio = document.getElementById('btn-upload-audio');
    const audioList = document.getElementById('audioList');
    const soundboard = document.getElementById('soundboard');
    const btnSoundPause = document.getElementById('btn-sound-pause');
    const btnSoundStop = document.getElementById('btn-sound-stop');

    const masterVolumeEl = document.getElementById('masterVolume');
    const btnUndo = document.getElementById('btn-undo');
    const btnClean = document.getElementById('btn-clean');
    const streamPreview = document.getElementById('streamPreview');
    const streamPlatform = document.getElementById('streamPlatform');
    const streamSource = document.getElementById('streamSource');
    const btnShowStream = document.getElementById('btn-show-stream');
    const btnHideStream = document.getElementById('btn-hide-stream');
    const paraText = document.getElementById('paraText');
    const paraColor = document.getElementById('paraColor');
    const paraFont = document.getElementById('paraFont');
    const fontFile = document.getElementById('fontFile'); const btnUploadFont = document.getElementById('btn-upload-font');
    const btnSavePara = document.getElementById('btn-save-para'); const paraList = document.getElementById('paraList');
    const timerMode = document.getElementById('timerMode'); const timerSeconds = document.getElementById('timerSeconds');
    const timerColor = document.getElementById('timerColor'); const timerFontSize = document.getElementById('timerFontSize'); const timerFont = document.getElementById('timerFont');
    const timerX = document.getElementById('timerX'); const timerY = document.getElementById('timerY'); const btnAddTimer = document.getElementById('btn-add-timer'); const timerList = document.getElementById('timerList');

    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabPanels = document.querySelectorAll('.tab-panel');

    const ctx = canvas.getContext('2d', { alpha: true });

    // STATE
    let STATE = {
      strokes: [],
      images: [],
      texts: [],
      timers: [],
      audio: { current: null, playlist: [], slots: {} },
      assets: { images: [], audio: [], fonts: [] },
      viewport: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 },
      volume: 1.0
    };

    // tools
    let tool = 'brush';
    function setTool(nextTool) {
      tool = nextTool;
      canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
    }
    setTool('brush');

    // transform/pan/zoom
    let transform = { scale: 1, tx: 0, ty: 0 };
    function syncStreamPreviewToCanvas() {
      // El stream ocupa el mundo 1920×1080: así sigue exactamente la zona segura.
      streamPreview.style.left = `${-transform.tx * transform.scale}px`;
      streamPreview.style.top = `${-transform.ty * transform.scale}px`;
      streamPreview.style.width = `${1920 * transform.scale}px`;
      streamPreview.style.height = `${1080 * transform.scale}px`;
    }
    let isPanning = false, panStart = {x:0,y:0}, panStartTransform = {tx:0,ty:0};

    // caches
    const imageCache = new Map();            // url -> Image
    const domImageMap = new Map();           // imageId -> <img> DOM element (for animated gifs and also static images)

    // audio players local
    const audioPlayers = new Map();

    function fitCanvas() {
      const rect = viewportWrap.getBoundingClientRect();
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';
      imageLayer.style.width = rect.width + 'px';
      imageLayer.style.height = rect.height + 'px';
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(rect.width * ratio);
      canvas.height = Math.floor(rect.height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      redraw();
    }
    window.addEventListener('resize', fitCanvas);
    setTimeout(fitCanvas, 80);

    function worldToScreen(p) { return { x: (p.x - transform.tx) * transform.scale, y: (p.y - transform.ty) * transform.scale }; }
    function screenToWorld(p) { return { x: p.x / transform.scale + transform.tx, y: p.y / transform.scale + transform.ty }; }
    function generateId() { return Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36); }
    function isGifUrl(url) { return /\.gif(\?.*)?$/i.test(url); }
    const loadedFonts = new Set();
    function loadCustomFonts(fonts = []) {
      fonts.forEach(font => {
        if (!font || !font.name || !font.url || loadedFonts.has(font.id)) return;
        loadedFonts.add(font.id);
        new FontFace(font.name, `url(${font.url})`).load().then(face => { document.fonts.add(face); redraw(); }).catch(() => {});
      });
    }
    function updateFontOptions() {
      const current = paraFont.value;
      const options = ['Arial', 'Verdana', 'Georgia', 'Impact', 'monospace', ...(STATE.assets.fonts || []).map(font => font.name)];
      paraFont.innerHTML = ''; timerFont.innerHTML = '';
      [...new Set(options)].forEach(name => { const option = new Option(name, name); paraFont.add(option); timerFont.add(new Option(name, name)); });
      paraFont.value = options.includes(current) ? current : 'Arial'; timerFont.value = paraFont.value;
    }
    function streamEmbedUrl(platform, source) {
      const value = source.trim().replace(/\/$/, '');
      if (!value) return null;
      if (platform === 'twitch') {
        const channel = value.replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '').split(/[/?#]/)[0];
        return channel ? `https://player.twitch.tv/?channel=${encodeURIComponent(channel)}&parent=${encodeURIComponent(location.hostname)}&muted=true&autoplay=true` : null;
      }
      if (platform === 'kick') {
        const channel = value.replace(/^https?:\/\/(www\.)?kick\.com\//i, '').split(/[/?#]/)[0];
        return channel ? `https://player.kick.com/${encodeURIComponent(channel)}?autoplay=true&muted=true&allowfullscreen=false` : null;
      }
      let videoId = value;
      try {
        const url = new URL(value);
        videoId = url.searchParams.get('v') || url.pathname.split('/').filter(Boolean).pop();
      } catch (_) {}
      return videoId ? `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?autoplay=1&mute=1&controls=0&playsinline=1` : null;
    }
    function showStreamPreview() {
      const src = streamEmbedUrl(streamPlatform.value, streamSource.value);
      if (!src) { alert('Escribí el canal o enlace del stream'); return; }
      streamPreview.innerHTML = '';
      if (streamPlatform.value === 'twitch') {
        const channel = streamSource.value.trim().replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '').split(/[/?#]/)[0];
        const playerHost = document.createElement('div'); playerHost.id = 'twitch-background-player'; streamPreview.appendChild(playerHost);
        streamPreview.style.display = 'flex'; setStreamInteraction(true);
        const createPlayer = () => {
          const player = new window.Twitch.Player(playerHost.id, {
            width: '100%', height: '100%', channel, parent: [location.hostname], autoplay: true, muted: true
          });
          player.addEventListener(window.Twitch.Player.READY, () => { player.setMuted(true); player.play(); });
        };
        if (window.Twitch && window.Twitch.Player) createPlayer();
        else {
          const script = document.createElement('script'); script.src = 'https://player.twitch.tv/js/embed/v1.js'; script.onload = createPlayer; document.head.appendChild(script);
        }
        return;
      }
      const iframe = document.createElement('iframe'); iframe.src = src; iframe.allow = 'autoplay; fullscreen'; iframe.title = 'Vista previa del stream';
      streamPreview.appendChild(iframe); streamPreview.style.display = 'flex'; setStreamInteraction(true);
    }
    function setStreamInteraction(enabled) {
      // Solo Configuración deja el reproductor por encima para poder usar sus controles.
      streamPreview.classList.toggle('interactive', Boolean(enabled && streamPreview.children.length));
    }
    function publishSnapshot() {
      try { socket.send(JSON.stringify({ type: 'snapshot', payload: STATE })); } catch (e) {}
      return fetch('/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(STATE) })
        .catch(err => console.warn('No se pudo guardar el estado', err));
    }

    // tabs
    tabButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        tabButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const target = btn.getAttribute('data-tab');
        tabPanels.forEach(p => p.style.display = (p.getAttribute('data-tab') === target) ? '' : 'none');
        setStreamInteraction(target === 'control');
        // El pincel solo está disponible mientras se consulta su pestaña.
        setTool(target === 'tools' ? 'brush' : 'select');
      });
    });

    // pointer/drawing
    let drawing=false, currentStroke=null;
    let selectedImageId=null, selectedTextId=null, selectedTimerId=null, draggingImage=false, draggingText=false, draggingTimer=false, dragStart=null, resizing=false, resizingText=false, resizingTimer=false, resizeStart=null;

    canvas.addEventListener('pointerdown', (e) => {
      try {
        if (e.button === 1) { isPanning = true; panStart = { x: e.clientX, y: e.clientY }; panStartTransform = { tx: transform.tx, ty: transform.ty }; canvas.style.cursor = 'grabbing'; return; }
        const rect = canvas.getBoundingClientRect();
        const screenPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        const worldPos = screenToWorld(screenPos);

        if (tool === 'select') {
          for (let i = STATE.timers.length - 1; i >= 0; i--) {
            const timer = STATE.timers[i]; const box = getTextBounds(getTimerDisplay(timer));
            const toggleX = box.x + box.width + 6, toggleY = box.y - 30;
            if (screenPos.x >= toggleX && screenPos.x <= toggleX + 26 && screenPos.y >= toggleY && screenPos.y <= toggleY + 26) {
              timer.viewerVisible = !timer.viewerVisible;
              try { socket.send(JSON.stringify({ type: 'timer:update', payload: timer })); } catch(e) {}
              updateTimerList(); redraw(); return;
            }
            const handleSize = 30, hx = box.x + box.width - handleSize, hy = box.y + box.height - handleSize;
            if (screenPos.x >= hx && screenPos.x <= box.x + box.width + 8 && screenPos.y >= hy && screenPos.y <= box.y + box.height + 8) {
              selectedTimerId = timer.id; selectedTextId = null; selectedImageId = null; resizingTimer = true; resizeStart = { mouse: screenPos, size: timer.size || 56 }; return;
            }
            if (screenPos.x >= box.x && screenPos.x <= box.x + box.width && screenPos.y >= box.y && screenPos.y <= box.y + box.height) {
              selectedTimerId = timer.id; selectedTextId = null; selectedImageId = null; draggingTimer = true;
              dragStart = { offsetWorld: { x: worldPos.x - timer.x, y: worldPos.y - timer.y } }; return;
            }
          }
          for (let i = STATE.texts.length - 1; i >= 0; i--) {
            const text = STATE.texts[i];
            const box = getTextBounds(text);
            const toggleX = box.x + box.width + 6, toggleY = box.y - 30;
            if (screenPos.x >= toggleX && screenPos.x <= toggleX + 26 && screenPos.y >= toggleY && screenPos.y <= toggleY + 26) {
              text.viewerVisible = !text.viewerVisible;
              try { socket.send(JSON.stringify({ type: 'text:update', payload: text })); } catch(e) {}
              updateTextList(); redraw(); return;
            }
            const handleSize = 30, hx = box.x + box.width - handleSize, hy = box.y + box.height - handleSize;
            if (screenPos.x >= hx && screenPos.x <= box.x + box.width + 8 && screenPos.y >= hy && screenPos.y <= box.y + box.height + 8) {
              selectedTextId = text.id; selectedTimerId = null; selectedImageId = null; resizingText = true; resizeStart = { mouse: screenPos, size: text.size || 48 }; return;
            }
            if (screenPos.x >= box.x && screenPos.x <= box.x + box.width && screenPos.y >= box.y && screenPos.y <= box.y + box.height) {
              selectedTextId = text.id; selectedTimerId = null; selectedImageId = null; draggingText = true;
              dragStart = { offsetWorld: { x: worldPos.x - text.x, y: worldPos.y - text.y } }; return;
            }
          }
          for (let i = STATE.images.length - 1; i >= 0; i--) {
            const img = STATE.images[i];
            const imgS = worldToScreen({ x: img.x, y: img.y });
            const sW = (img.width || 300) * transform.scale;
            const sH = (img.height || 200) * transform.scale;
            const toggleX = imgS.x + sW + 6, toggleY = imgS.y - 30;
            if (screenPos.x >= toggleX && screenPos.x <= toggleX + 26 && screenPos.y >= toggleY && screenPos.y <= toggleY + 26) {
              img.viewerVisible = !img.viewerVisible;
              try { socket.send(JSON.stringify({ type: 'image:update', payload: img })); } catch(e) {}
              updateCanvasImagesUI(); redraw(); return;
            }
            const handleSize = 30, hx = imgS.x + sW - handleSize, hy = imgS.y + sH - handleSize;
            if (screenPos.x >= hx && screenPos.x <= imgS.x + sW + 8 && screenPos.y >= hy && screenPos.y <= imgS.y + sH + 8) {
              selectedImageId = img.id; selectedTextId = null; selectedTimerId = null; resizing = true; resizeStart = { mouse: screenPos, imgStart: { width: img.width || 300, height: img.height || 200 } }; return;
            }
            if (screenPos.x >= imgS.x && screenPos.x <= imgS.x + sW && screenPos.y >= imgS.y && screenPos.y <= imgS.y + sH) {
              selectedImageId = img.id; selectedTextId = null; selectedTimerId = null; draggingImage = true;
              const offsetWorld = { x: worldPos.x - img.x, y: worldPos.y - img.y };
              dragStart = { mouse: screenPos, imgStart: { x: img.x, y: img.y }, offsetWorld }; return;
            }
          }
          selectedImageId = null; selectedTextId = null; selectedTimerId = null; redraw(); return;
        }

        if (tool === 'brush' && e.button === 0) {
          drawing = true;
          currentStroke = { id: generateId(), color: brushColorEl.value, width: parseInt(brushSizeEl.value,10), points: [worldPos] };
          STATE.strokes.push(currentStroke);
          try { socket.send(JSON.stringify({ type:'stroke:start', payload: currentStroke })); } catch(e) {}
          redraw();
        }
      } catch (err) { console.error('pointerdown err', err); }
    });

    canvas.addEventListener('pointermove', (e) => {
      try {
        const rect = canvas.getBoundingClientRect();
        const screenPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        const worldPos = screenToWorld(screenPos);

        if (isPanning) {
          const dx = (panStart.x - e.clientX) / transform.scale;
          const dy = (panStart.y - e.clientY) / transform.scale;
          transform.tx = panStartTransform.tx + dx;
          transform.ty = panStartTransform.ty + dy;
          STATE.viewport.scale = transform.scale;
          try { socket.send(JSON.stringify({ type:'viewport:update', payload: STATE.viewport })); } catch(e){}
          redraw();
          return;
        }

        if (resizing && selectedImageId) {
          const img = STATE.images.find(x=>x.id===selectedImageId); if(!img) return;
          const dx = (screenPos.x - resizeStart.mouse.x)/transform.scale;
          const dy = (screenPos.y - resizeStart.mouse.y)/transform.scale;
          img.width = Math.max(10, resizeStart.imgStart.width + dx);
          img.height = Math.max(10, resizeStart.imgStart.height + dy);
          try { socket.send(JSON.stringify({ type:'image:update', payload: img })); } catch(e){}
          redraw(); return;
        }

        if (resizingText && selectedTextId) {
          const text = STATE.texts.find(item => item.id === selectedTextId); if (!text) return;
          const delta = (screenPos.x - resizeStart.mouse.x) / transform.scale;
          text.size = Math.max(8, Math.round(resizeStart.size + delta));
          try { socket.send(JSON.stringify({ type:'text:update', payload: text })); } catch(e) {}
          redraw(); return;
        }

        if (resizingTimer && selectedTimerId) {
          const timer = STATE.timers.find(item => item.id === selectedTimerId); if (!timer) return;
          timer.size = Math.max(8, Math.round(resizeStart.size + (screenPos.x - resizeStart.mouse.x) / transform.scale));
          try { socket.send(JSON.stringify({ type:'timer:update', payload: timer })); } catch(e) {}
          redraw(); return;
        }

        if (draggingText && selectedTextId) {
          const text = STATE.texts.find(item => item.id === selectedTextId); if (!text) return;
          text.x = worldPos.x - dragStart.offsetWorld.x; text.y = worldPos.y - dragStart.offsetWorld.y;
          try { socket.send(JSON.stringify({ type:'text:update', payload: text })); } catch(e) {}
          redraw(); return;
        }

        if (draggingTimer && selectedTimerId) {
          const timer = STATE.timers.find(item => item.id === selectedTimerId); if (!timer) return;
          timer.x = worldPos.x - dragStart.offsetWorld.x; timer.y = worldPos.y - dragStart.offsetWorld.y;
          try { socket.send(JSON.stringify({ type:'timer:update', payload: timer })); } catch(e) {}
          redraw(); return;
        }

        if (draggingImage && selectedImageId) {
          const img = STATE.images.find(x=>x.id===selectedImageId); if(!img) return;
          img.x = worldPos.x - dragStart.offsetWorld.x;
          img.y = worldPos.y - dragStart.offsetWorld.y;
          try { socket.send(JSON.stringify({ type:'image:update', payload: img })); } catch(e){}
          redraw(); return;
        }

        if (drawing && currentStroke) {
          currentStroke.points.push(worldPos);
          try { socket.send(JSON.stringify({ type:'stroke:point', payload:{ id: currentStroke.id, point: worldPos } })); } catch(e){}
          drawIncremental(currentStroke);
        }
      } catch (err) { console.error('pointermove err', err); }
    });

    canvas.addEventListener('pointerup', (e) => {
      try {
        if (isPanning && e.button===1) { isPanning=false; canvas.style.cursor='default'; return; }
        if (resizing) { resizing=false; resizeStart=null; return; }
        if (resizingText) { resizingText=false; resizeStart=null; return; }
        if (resizingTimer) { resizingTimer=false; resizeStart=null; return; }
        if (draggingImage) { draggingImage=false; dragStart=null; return; }
        if (draggingText) { draggingText=false; dragStart=null; return; }
        if (draggingTimer) { draggingTimer=false; dragStart=null; return; }
        if (drawing) { drawing=false; try{ socket.send(JSON.stringify({ type:'stroke:end', payload:{ id: currentStroke ? currentStroke.id : null } })); }catch(e){} currentStroke=null; }
      } catch (err) { console.error('pointerup err', err); }
    });

    canvas.addEventListener('pointercancel', ()=> { isPanning=false; resizing=false; resizingText=false; resizingTimer=false; draggingImage=false; draggingText=false; draggingTimer=false; drawing=false; currentStroke=null; });

    viewportWrap.addEventListener('wheel', (e) => {
      try {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        const worldBefore = screenToWorld(mouse);
        const delta = (e.deltaY < 0) ? 0.12 : -0.12;
        transform.scale = Math.max(0.05, transform.scale * (1 + delta));
        const worldAfter = screenToWorld(mouse);
        transform.tx += worldBefore.x - worldAfter.x; transform.ty += worldBefore.y - worldAfter.y;
        STATE.viewport.scale = transform.scale;
        try { socket.send(JSON.stringify({ type:'viewport:update', payload: STATE.viewport })); } catch(e){}
        redraw();
      } catch (err) { console.error('wheel err', err); }
    }, { passive:false });

    function drawIncremental(stroke){ redraw(); }

    function redraw() {
      try {
        if (!canvas.width || !canvas.height) return;
        syncStreamPreviewToCanvas();
        ctx.clearRect(0,0,canvas.width,canvas.height);

        // draw non-GIF images on canvas
        for (const img of STATE.images) {
          if (!isGifUrl(img.url)) drawImageOnCanvas(img);
        }

        // draw strokes
        for (const s of STATE.strokes) drawStroke(s);
        for (const text of STATE.texts) drawText(text);
        for (const timer of STATE.timers) drawTimer(timer);

        // selection overlay for selected image
        if (selectedImageId) {
          const img = STATE.images.find(x => x.id === selectedImageId);
          if (img) {
            const sPos = worldToScreen({ x: img.x, y: img.y });
            const sW = (img.width || 300) * transform.scale;
            const sH = (img.height || 200) * transform.scale;
            ctx.save();
            ctx.strokeStyle = '#00ffcc'; ctx.lineWidth = 2;
            ctx.strokeRect(sPos.x, sPos.y, sW, sH);
            ctx.fillStyle = '#00ffcc';
            ctx.fillRect(sPos.x + sW - 24, sPos.y + sH - 24, 22, 22);
            ctx.fillStyle = '#071826'; ctx.font = '16px sans-serif';
            ctx.fillText('↘', sPos.x + sW - 21, sPos.y + sH - 6);
            // Botón siempre pegado a la esquina superior derecha de la imagen.
            ctx.fillStyle = 'rgba(2,6,18,.94)';
            ctx.fillRect(sPos.x + sW + 6, sPos.y - 30, 26, 26);
            ctx.strokeStyle = '#00ffcc'; ctx.strokeRect(sPos.x + sW + 6, sPos.y - 30, 26, 26);
            ctx.fillStyle = '#e6eef6'; ctx.font = '15px sans-serif';
            ctx.fillText(img.viewerVisible === false ? '○' : '◉', sPos.x + sW + 11, sPos.y - 11);
            ctx.restore();
          }
        }
        if (selectedTextId) {
          const text = STATE.texts.find(item => item.id === selectedTextId);
          if (text) drawSelectionBox(getTextBounds(text), text.viewerVisible !== false);
        }
        if (selectedTimerId) {
          const timer = STATE.timers.find(item => item.id === selectedTimerId);
          if (timer) drawSelectionBox(getTextBounds(getTimerDisplay(timer)), timer.viewerVisible !== false);
        }

        // safe zone
        const safeTop = worldToScreen({ x:0,y:0 });
        const safeW = 1920 * transform.scale;
        const safeH = 1080 * transform.scale;
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.setLineDash([6,6]); ctx.lineWidth=2;
        ctx.strokeRect(safeTop.x, safeTop.y, safeW, safeH);
        ctx.restore();

        // update DOM image overlays (GIFs and static images)
        updateDomImages();
      } catch (err) { console.error('redraw err', err); }
    }

    function drawStroke(stroke) {
      if (!stroke || !stroke.points || stroke.points.length===0) return;
      ctx.save();
      ctx.lineJoin='round'; ctx.lineCap='round';
      ctx.strokeStyle = stroke.color || '#ff0000';
      ctx.lineWidth = Math.max(1, stroke.width * transform.scale);
      ctx.beginPath();
      const p0 = worldToScreen(stroke.points[0]); ctx.moveTo(p0.x,p0.y);
      for (let i=1;i<stroke.points.length;i++){ const p = worldToScreen(stroke.points[i]); ctx.lineTo(p.x,p.y); }
      ctx.stroke(); ctx.restore();
    }

    function drawImageOnCanvas(img) {
      let image = imageCache.get(img.url);
      if (!image) { image = new Image(); image.crossOrigin='anonymous'; image.src = img.url; imageCache.set(img.url,image); }
      const sPos = worldToScreen({ x: img.x, y: img.y });
      const sW = (img.width || 300) * transform.scale; const sH = (img.height || 200) * transform.scale;
      try { ctx.drawImage(image, sPos.x, sPos.y, sW, sH); } catch(e){}
    }

    // DOM image overlays used for GIFs (and handled in same flow for simplicity)
    function updateDomImages() {
      const used = new Set();
      const rect = viewportWrap.getBoundingClientRect();

      for (const img of STATE.images) {
        // compute screen pos/size
        const screenPos = worldToScreen({ x: img.x, y: img.y });
        const sW = (img.width || 300) * transform.scale;
        const sH = (img.height || 200) * transform.scale;

        let el = domImageMap.get(img.id);
        if (!el) {
          el = document.createElement('img');
          el.style.position = 'absolute';
          el.style.pointerEvents = 'none'; // let canvas handle pointer events
          el.style.willChange = 'transform';
          el.crossOrigin = 'anonymous';
          el.src = img.url;
          imageLayer.appendChild(el);
          domImageMap.set(img.id, el);
        }

        // place element in screen coords relative to viewportWrap
        el.style.left = Math.round(screenPos.x) + 'px';
        el.style.top = Math.round(screenPos.y) + 'px';
        el.style.width = Math.max(1, Math.round(sW)) + 'px';
        el.style.height = Math.max(1, Math.round(sH)) + 'px';
        el.style.visibility = 'visible';
        used.add(img.id);
      }

      // remove DOM nodes for images no longer present
      for (const [id, el] of domImageMap.entries()) {
        if (!used.has(id)) {
          try { el.remove(); } catch (e) {}
          domImageMap.delete(id);
        }
      }
    }

    (function loop(){ redraw(); requestAnimationFrame(loop); })();

    // AUDIO helpers
    function playLocalAudioAsset(assetId, url) {
      stopLocalAudio(assetId);
      const a = new Audio(url); a.crossOrigin='anonymous'; a.volume = STATE.volume;
      a.play().catch(e => console.warn('play err', e));
      audioPlayers.set(assetId, a);
    }
    function stopLocalAudio(assetId) {
      const p = audioPlayers.get(assetId);
      if (p) { try { p.pause(); p.currentTime = 0; } catch(e){} audioPlayers.delete(assetId); }
    }
    function stopAllLocalAudio(){ for (const id of Array.from(audioPlayers.keys())) stopLocalAudio(id); }
    function setLocalVolume(v){ audioPlayers.forEach(p => { try{ p.volume = v; }catch(e){} }); }
    function getSoundAsset(slot) { return STATE.audio.slots && STATE.audio.slots[String(slot)]; }
    function playSoundSlot(slot) {
      const asset = getSoundAsset(slot);
      if (!asset) return;
      const cur = { url: asset.url, startedAtServer: Date.now(), slot: Number(slot), paused: false };
      STATE.audio.current = cur;
      try { socket.send(JSON.stringify({ type: 'audio:trigger', payload: cur })); } catch (e) {}
      playLocalAudioAsset(`slot-${slot}`, asset.url);
      updateSoundboardUI();
    }
    function drawText(item) {
      const pos = worldToScreen({ x: item.x || 0, y: item.y || 0 });
      ctx.save(); ctx.fillStyle = item.color || '#fff'; ctx.font = `${(item.size || 48) * transform.scale}px "${item.font || 'Arial'}"`; ctx.textBaseline = 'top';
      String(item.text || '').split('\n').forEach((line, index) => ctx.fillText(line, pos.x, pos.y + index * (item.size || 48) * transform.scale * 1.2));
      ctx.restore();
    }
    function getTextBounds(item) {
      const pos = worldToScreen({ x: item.x || 0, y: item.y || 0 });
      ctx.save(); ctx.font = `${(item.size || 48) * transform.scale}px "${item.font || 'Arial'}"`;
      const width = Math.max(...String(item.text || '').split('\n').map(line => ctx.measureText(line).width), 1);
      const height = String(item.text || '').split('\n').length * (item.size || 48) * transform.scale * 1.2;
      ctx.restore(); return { x: pos.x, y: pos.y, width, height };
    }
    function drawSelectionBox(box, visible) {
      ctx.save();
      ctx.strokeStyle = '#00ffcc'; ctx.lineWidth = 2; ctx.strokeRect(box.x, box.y, box.width, box.height);
      ctx.fillStyle = '#00ffcc'; ctx.fillRect(box.x + box.width - 24, box.y + box.height - 24, 22, 22);
      ctx.fillStyle = '#071826'; ctx.font = '16px sans-serif'; ctx.fillText('↘', box.x + box.width - 21, box.y + box.height - 6);
      ctx.fillStyle = 'rgba(2,6,18,.94)'; ctx.fillRect(box.x + box.width + 6, box.y - 30, 26, 26);
      ctx.strokeStyle = '#00ffcc'; ctx.strokeRect(box.x + box.width + 6, box.y - 30, 26, 26);
      ctx.fillStyle = '#e6eef6'; ctx.font = '15px sans-serif'; ctx.fillText(visible ? '◉' : '○', box.x + box.width + 11, box.y - 11);
      ctx.restore();
    }
    function getTimerDisplay(item) {
      const elapsed = Math.max(0, Math.floor((Date.now() - item.startedAtServer) / 1000));
      const seconds = item.mode === 'down' ? Math.max(0, (item.duration || 0) - elapsed) : elapsed;
      return { ...item, text: `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` };
    }
    function drawTimer(item) {
      drawText(getTimerDisplay(item));
    }
    function stopSoundboard() {
      stopAllLocalAudio();
      STATE.audio.current = null;
      try { socket.send(JSON.stringify({ type: 'audio:stop' })); } catch (e) {}
      updateSoundboardUI();
    }
    function toggleSoundboard() {
      const active = STATE.audio.current;
      if (!active) return;
      const player = audioPlayers.get(`slot-${active.slot}`);
      if (player && !player.paused) { player.pause(); active.paused = true; try { socket.send(JSON.stringify({ type: 'audio:pause' })); } catch(e) {} }
      else if (player) { player.play().catch(() => {}); active.paused = false; try { socket.send(JSON.stringify({ type: 'audio:resume', payload: active })); } catch(e) {} }
      updateSoundboardUI();
    }

    // Buttons
    btnClearLocal && btnClearLocal.addEventListener('click', () => {
      STATE.strokes = []; redraw(); publishSnapshot();
    });

    btnPush && btnPush.addEventListener('click', async () => {
      try {
        STATE.viewport.x=0; STATE.viewport.y=0; STATE.viewport.width=1920; STATE.viewport.height=1080;
        await publishSnapshot();
        alert('Snapshot enviado al servidor');
      } catch(e){ console.error(e); alert('Error enviando snapshot'); }
    });

    btnFetchState && btnFetchState.addEventListener('click', async () => {
      try {
        const r = await fetch('/state'); const j = await r.json();
        STATE = j.state; STATE.audio = { current: null, playlist: [], slots: {}, ...STATE.audio }; STATE.images = (STATE.images || []).map(img => ({ ...img, viewerVisible: img.viewerVisible !== false && img.visible !== false })); STATE.viewport.x=0; STATE.viewport.y=0; STATE.viewport.width=1920; STATE.viewport.height=1080; updateCanvasImagesUI(); updateSoundboardUI(); updateTextList(); updateTimerList(); redraw();
      } catch(e){ console.error('fetch state err', e); }
    });

    btnResetServer && btnResetServer.addEventListener('click', async () => {
      await fetch('/reset', { method:'POST' }); alert('Server reseteado');
    });
    btnShowStream && btnShowStream.addEventListener('click', showStreamPreview);
    btnHideStream && btnHideStream.addEventListener('click', () => { streamPreview.innerHTML = ''; streamPreview.style.display = 'none'; setStreamInteraction(false); });
    streamPlatform && streamPlatform.addEventListener('change', () => {
      streamSource.placeholder = streamPlatform.value === 'youtube' ? 'Enlace del directo o video de YouTube' : 'Canal o enlace del stream';
    });

    // Upload image -> library
    btnUploadImg && btnUploadImg.addEventListener('click', async () => {
      try {
        if (!imgFile.files || imgFile.files.length===0) { alert('Selecciona un archivo'); return; }
        const f = imgFile.files[0]; const form = new FormData(); form.append('file', f);
        const r = await fetch('/upload', { method:'POST', body: form });
        const j = await r.json();
        if (!j || !j.url) { alert('Error: servidor no devolvió URL'); return; }
        const url = j.url;
        const asset = { id: generateId(), url, name: f.name };
        STATE.assets.images.push(asset);
        // preload
        if (!imageCache.has(url)) { const im = new Image(); im.crossOrigin='anonymous'; im.src = url; imageCache.set(url,im); }
        try { socket.send(JSON.stringify({ type:'asset:image:add', payload: asset })); } catch(e){}
        updateImagesLibraryUI();
      } catch (e) { console.error('upload img err', e); alert('Error subiendo imagen'); }
    });

    // Upload audio -> library
    btnUploadAudio && btnUploadAudio.addEventListener('click', async () => {
      try {
        if (!audioFile.files || audioFile.files.length===0) { alert('Selecciona un archivo'); return; }
        const f = audioFile.files[0]; const form = new FormData(); form.append('file', f);
        const r = await fetch('/upload', { method:'POST', body: form });
        const j = await r.json();
        if (!j || !j.url) { alert('Error: servidor no devolvió URL'); return; }
        const url = j.url;
        const asset = { id: generateId(), url, name: f.name };
        STATE.assets.audio.push(asset);
        try { socket.send(JSON.stringify({ type:'asset:audio:add', payload: asset })); } catch(e){}
        updateAudioLibraryUI();
      } catch (e) { console.error('upload audio err', e); alert('Error subiendo audio'); }
    });

    // master volume control
    masterVolumeEl && masterVolumeEl.addEventListener('input', () => {
      const v = parseInt(masterVolumeEl.value,10)/100; STATE.volume = v; setLocalVolume(v);
      try { socket.send(JSON.stringify({ type:'volume:update', payload:{ volume: v } })); } catch(e){}
    });

    btnSoundStop && btnSoundStop.addEventListener('click', stopSoundboard);
    btnSoundPause && btnSoundPause.addEventListener('click', toggleSoundboard);
    window.addEventListener('keydown', (event) => {
      if (event.repeat || event.ctrlKey || event.altKey || event.metaKey || ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
      if (/^[0-9]$/.test(event.key)) { event.preventDefault(); playSoundSlot(event.key); }
    });

    document.querySelectorAll('.inner-tab').forEach(button => button.addEventListener('click', () => {
      const target = button.dataset.textTab;
      document.querySelectorAll('.inner-tab').forEach(tab => tab.classList.toggle('active', tab === button));
      document.querySelectorAll('.text-section').forEach(section => section.style.display = section.dataset.textTab === target ? '' : 'none');
    }));
    btnUploadFont && btnUploadFont.addEventListener('click', async () => {
      const file = fontFile.files && fontFile.files[0];
      if (!file) { alert('Selecciona una fuente .ttf, .otf, .woff o .woff2'); return; }
      const form = new FormData(); form.append('file', file);
      try {
        const response = await fetch('/upload', { method: 'POST', body: form }); const result = await response.json();
        if (!result.url) throw new Error('No se recibió URL');
        const name = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'Fuente personalizada';
        const font = { id: generateId(), name, url: result.url };
        STATE.assets.fonts.push(font); loadCustomFonts([font]); updateFontOptions();
        try { socket.send(JSON.stringify({ type: 'asset:font:add', payload: font })); } catch(e) {}
        paraFont.value = name; timerFont.value = name;
      } catch (error) { console.error(error); alert('No se pudo subir la fuente'); }
    });
    btnSavePara && btnSavePara.addEventListener('click', () => {
      if (!paraText.value.trim()) { alert('Escribe un texto primero'); return; }
      const item = { id: generateId(), text: paraText.value, color: paraColor.value, size: 48, font: paraFont.value, x: 100, y: 180, viewerVisible: false };
      STATE.texts.push(item); try { socket.send(JSON.stringify({ type: 'text:add', payload: item })); } catch(e) {}
      updateTextList(); redraw();
    });
    btnAddTimer && btnAddTimer.addEventListener('click', () => {
      const item = { id: generateId(), mode: timerMode.value, duration: Math.max(0, Number(timerSeconds.value) || 0), startedAtServer: Date.now(), color: timerColor.value, size: Number(timerFontSize.value) || 56, font: timerFont.value || 'Arial', x: Number(timerX.value) || 0, y: Number(timerY.value) || 0, viewerVisible: false };
      STATE.timers.push(item); try { socket.send(JSON.stringify({ type: 'timer:add', payload: item })); } catch(e) {}
      updateTimerList(); redraw();
    });

    // UNDO: remove last stroke else last image (and publish snapshot + persist)
    if (btnUndo) {
      btnUndo.addEventListener('click', async () => {
        try {
          console.log('[UNDO] clicked');
          if (STATE.strokes.length > 0) {
            const removed = STATE.strokes.pop();
            console.log('[UNDO] removed stroke', removed && removed.id);
          } else if (STATE.images.length > 0) {
            const removed = STATE.images.pop();
            console.log('[UNDO] removed image', removed && removed.id);
            // cleanup dom image if exists
            const el = domImageMap.get(removed.id);
            if (el) { try{ el.remove(); }catch(e){} domImageMap.delete(removed.id); }
          } else {
            console.log('[UNDO] nothing to remove');
          }

          // publish snapshot via WS and persist to server so viewers pick it up reliably
          try { socket.send(JSON.stringify({ type:'snapshot', payload: STATE })); } catch(e) { console.warn('ws send snapshot failed', e); }
          try {
            const r = await fetch('/state', { method:'POST', headers:{ 'Content-Type': 'application/json' }, body: JSON.stringify(STATE) });
            if (!r.ok) console.warn('persist state returned', r.status);
          } catch (err) { console.warn('persist snapshot error', err); }

          redraw();
        } catch (err) { console.error('undo handler err', err); }
      });
    }

    // CLEAN: wipe strokes+images (publish snapshot + persist)
    if (btnClean) {
      btnClean.addEventListener('click', async () => {
        try {
          console.log('[CLEAN] clicked');

          STATE.strokes = [];
          STATE.images = [];

          // remove dom image nodes
          domImageMap.forEach((el) => { try { el.remove(); } catch(e){} });
          domImageMap.clear();

          // publish snapshot via WS and persist to server so viewers pick it up reliably
          try { socket.send(JSON.stringify({ type:'snapshot', payload: STATE })); } catch(e) { console.warn('ws send snapshot failed', e); }
          try {
            const r = await fetch('/state', { method:'POST', headers:{ 'Content-Type': 'application/json' }, body: JSON.stringify(STATE) });
            if (!r.ok) console.warn('persist state returned', r.status);
          } catch (err) { console.warn('persist snapshot error', err); }

          redraw();
        } catch (err) { console.error('clean handler err', err); }
      });
    }

    // LIB UI
    function updateImagesLibraryUI() {
      imagesList.innerHTML = '';
      STATE.assets.images.forEach(a => {
        const el = document.createElement('div'); el.className='lib-item'; el.style.padding='6px'; el.style.borderBottom='1px solid rgba(255,255,255,0.03)';
        el.innerHTML = `<div style="display:flex;align-items:center;gap:8px;">
          <div style="flex:1;overflow:hidden"><small>${a.name}</small></div>
          <button data-id="${a.id}" class="btn-add">+</button>
          <button data-id="${a.id}" class="btn-delete">✖</button>
        </div>`;
        imagesList.appendChild(el);
        el.querySelector('.btn-add').addEventListener('click', () => {
          // add outside safe zone (to the right)
          const imgObj = { id: generateId(), url: a.url, x: 80, y: 80, width: 300, height: 200, viewerVisible: false };
          STATE.images.push(imgObj);
          if (!imageCache.has(a.url)) { const im = new Image(); im.crossOrigin='anonymous'; im.src=a.url; imageCache.set(a.url,im); }
          try { socket.send(JSON.stringify({ type:'image:add', payload: imgObj })); } catch(e){}
          selectedImageId = imgObj.id;
          updateCanvasImagesUI();
          redraw();
        });
        el.querySelector('.btn-delete').addEventListener('click', () => {
          try { socket.send(JSON.stringify({ type:'asset:image:delete', payload: a })); } catch(e){}
          STATE.assets.images = STATE.assets.images.filter(x=>x.id!==a.id);
          STATE.images = STATE.images.filter(x=>x.url!==a.url);
          updateImagesLibraryUI(); redraw();
        });
      });
    }

    function updateAudioLibraryUI() {
      audioList.innerHTML = '';
      STATE.assets.audio.forEach(a => {
        const el = document.createElement('div'); el.className='lib-item'; el.style.padding='6px'; el.style.borderBottom='1px solid rgba(255,255,255,0.03)';
        el.draggable = true;
        el.innerHTML = `<div style="display:flex;align-items:center;gap:8px;">
          <div style="flex:1;overflow:hidden"><small>${a.name}</small></div>
          <small class="small">Arrastrar</small>
        </div>`;
        audioList.appendChild(el);
        el.addEventListener('dragstart', event => { event.dataTransfer.setData('text/plain', a.id); event.dataTransfer.effectAllowed = 'copy'; });
      });
    }

    function updateCanvasImagesUI() {
      if (!canvasImagesList) return;
      canvasImagesList.innerHTML = '';
      if (!STATE.images.length) { canvasImagesList.innerHTML = '<p class="small">Todavía no hay imágenes en el canvas.</p>'; return; }
      STATE.images.forEach(img => {
        const row = document.createElement('div'); row.className = 'canvas-object';
        const visible = img.viewerVisible !== false;
        row.innerHTML = `<span class="object-name">${imageName(img)}</span><button class="select">Seleccionar</button><button class="toggle">${visible ? 'Ocultar en Viewer' : 'Mostrar en Viewer'}</button><button class="remove">✖</button>`;
        row.querySelector('.select').addEventListener('click', () => { selectedImageId = img.id; setTool('select'); redraw(); });
        row.querySelector('.toggle').addEventListener('click', () => { img.viewerVisible = !visible; try { socket.send(JSON.stringify({ type: 'image:update', payload: img })); } catch(e) {} updateCanvasImagesUI(); redraw(); });
        row.querySelector('.remove').addEventListener('click', () => { STATE.images = STATE.images.filter(item => item.id !== img.id); if (selectedImageId === img.id) selectedImageId = null; try { socket.send(JSON.stringify({ type: 'image:remove', payload: { id: img.id } })); } catch(e) {} updateCanvasImagesUI(); redraw(); });
        canvasImagesList.appendChild(row);
      });
    }

    function createOverlayRow(container, items, label, eventPrefix) {
      if (!container) return;
      container.innerHTML = '';
      if (!items.length) { container.innerHTML = `<p class="small">No hay ${label.toLowerCase()} todavía.</p>`; return; }
      items.forEach(item => {
        const visible = item.viewerVisible !== false;
        const row = document.createElement('div'); row.className = 'canvas-object';
        row.innerHTML = `<span class="object-name">${label}: ${item.text || (item.mode === 'down' ? 'Regresivo' : 'Ascendente')}</span>${eventPrefix === 'text' || eventPrefix === 'timer' ? '<button class="select">Seleccionar</button>' : ''}<button class="toggle">${visible ? 'Ocultar en Viewer' : 'Mostrar en Viewer'}</button><button class="remove">✖</button>`;
        if (eventPrefix === 'text') row.querySelector('.select').addEventListener('click', () => { selectedTextId = item.id; selectedImageId = null; setTool('select'); redraw(); });
        if (eventPrefix === 'timer') row.querySelector('.select').addEventListener('click', () => { selectedTimerId = item.id; selectedTextId = null; selectedImageId = null; setTool('select'); redraw(); });
        row.querySelector('.toggle').addEventListener('click', () => { item.viewerVisible = !visible; try { socket.send(JSON.stringify({ type: `${eventPrefix}:update`, payload: item })); } catch(e) {} createOverlayRow(container, items, label, eventPrefix); redraw(); });
        row.querySelector('.remove').addEventListener('click', () => { const index = items.findIndex(entry => entry.id === item.id); if (index >= 0) items.splice(index, 1); try { socket.send(JSON.stringify({ type: `${eventPrefix}:remove`, payload: { id: item.id } })); } catch(e) {} createOverlayRow(container, items, label, eventPrefix); redraw(); });
        container.appendChild(row);
      });
    }
    function updateTextList() { createOverlayRow(paraList, STATE.texts, 'Texto', 'text'); }
    function updateTimerList() { createOverlayRow(timerList, STATE.timers, 'Cronómetro', 'timer'); }

    function updateSoundboardUI() {
      if (!soundboard) return;
      soundboard.innerHTML = '';
      for (let slot = 0; slot <= 9; slot++) {
        const asset = getSoundAsset(slot);
        const button = document.createElement('button');
        button.type = 'button'; button.className = `sound-slot${asset ? '' : ' empty'}`;
        button.title = asset ? `${slot}: ${asset.name}` : `Slot ${slot}: arrastra un audio aquí`;
        button.innerHTML = `<span class="slot-number">${slot}</span><span class="slot-name">${asset ? asset.name : 'Arrastra audio'}</span>`;
        button.addEventListener('click', () => playSoundSlot(slot));
        button.addEventListener('dragover', event => { event.preventDefault(); button.classList.add('drag-over'); });
        button.addEventListener('dragleave', () => button.classList.remove('drag-over'));
        button.addEventListener('drop', event => {
          event.preventDefault(); button.classList.remove('drag-over');
          const assetId = event.dataTransfer.getData('text/plain');
          const selectedAsset = STATE.assets.audio.find(a => a.id === assetId);
          if (!selectedAsset) return;
          STATE.audio.slots[String(slot)] = selectedAsset;
          publishSnapshot(); updateSoundboardUI();
        });
        soundboard.appendChild(button);
      }
      const playing = STATE.audio.current && !STATE.audio.current.paused;
      if (btnSoundPause) btnSoundPause.textContent = playing ? 'Ⅱ' : '▶';
    }

    // initial
    updateImagesLibraryUI(); updateAudioLibraryUI(); updateFontOptions(); updateCanvasImagesUI(); updateTextList(); updateTimerList(); updateSoundboardUI(); fitCanvas();
    console.log('Editor inicializado correctamente.');

  } catch (err) {
    console.error('Error inicializando editor:', err);
    alert('Error al inicializar el editor. Mira consola para detalles.');
  }
});

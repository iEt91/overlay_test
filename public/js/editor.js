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
            STATE.assets = msg.state.assets;
            updateImagesLibraryUI();
            updateAudioLibraryUI();
          }
          if (msg.state.images) STATE.images = msg.state.images;
          if (msg.state.strokes) STATE.strokes = msg.state.strokes;
        } else if (msg.type === 'assets:update') {
          STATE.assets = msg.payload || STATE.assets;
          updateImagesLibraryUI();
          updateAudioLibraryUI();
        } else if (msg.type === 'audio:stop') {
          stopAllLocalAudio();
        } else if (msg.type === 'volume:update') {
          STATE.volume = msg.payload && msg.payload.volume != null ? msg.payload.volume : STATE.volume;
          setLocalVolume(STATE.volume);
        }
      } catch (e) { console.warn('ws parse', e); }
    });

    // DOM
    const canvas = document.getElementById('editorCanvas');
    const viewportWrap = document.getElementById('editorViewport');
    const imageLayer = document.getElementById('imageLayer');

    const toolBrushBtn = document.getElementById('toolBrush');
    const toolSelectBtn = document.getElementById('toolSelect');
    const brushColorEl = document.getElementById('brushColor');
    const brushSizeEl = document.getElementById('brushSize');
    const btnClearLocal = document.getElementById('btn-clear-local');
    const btnPush = document.getElementById('btn-push-state');
    const btnFetchState = document.getElementById('btn-fetch-state');
    const btnResetServer = document.getElementById('btn-reset-server');
    const imgFile = document.getElementById('imgFile');
    const btnUploadImg = document.getElementById('btn-upload-img');
    const imagesList = document.getElementById('imagesList');
    const audioFile = document.getElementById('audioFile');
    const btnUploadAudio = document.getElementById('btn-upload-audio');
    const audioList = document.getElementById('audioList');

    const masterVolumeEl = document.getElementById('masterVolume');
    const btnUndo = document.getElementById('btn-undo');
    const btnClean = document.getElementById('btn-clean');

    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabPanels = document.querySelectorAll('.tab-panel');

    const ctx = canvas.getContext('2d', { alpha: true });

    // STATE
    let STATE = {
      strokes: [],
      images: [],
      audio: { current: null, playlist: [] },
      assets: { images: [], audio: [] },
      viewport: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 },
      volume: 1.0
    };

    // tools
    let tool = 'brush';
    if (toolBrushBtn) toolBrushBtn.classList.add('active');
    toolBrushBtn && toolBrushBtn.addEventListener('click', () => { tool = 'brush'; toolBrushBtn.classList.add('active'); toolSelectBtn.classList.remove('active'); });
    toolSelectBtn && toolSelectBtn.addEventListener('click', () => { tool = 'select'; toolSelectBtn.classList.add('active'); toolBrushBtn.classList.remove('active'); });

    // transform/pan/zoom
    let transform = { scale: 1, tx: 0, ty: 0 };
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

    // tabs
    tabButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        tabButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const target = btn.getAttribute('data-tab');
        tabPanels.forEach(p => p.style.display = (p.getAttribute('data-tab') === target) ? '' : 'none');
      });
    });

    // pointer/drawing
    let drawing=false, currentStroke=null;
    let selectedImageId=null, draggingImage=false, dragStart=null, resizing=false, resizeStart=null;

    canvas.addEventListener('pointerdown', (e) => {
      try {
        if (e.button === 1) { isPanning = true; panStart = { x: e.clientX, y: e.clientY }; panStartTransform = { tx: transform.tx, ty: transform.ty }; canvas.style.cursor = 'grabbing'; return; }
        const rect = canvas.getBoundingClientRect();
        const screenPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        const worldPos = screenToWorld(screenPos);

        if (tool === 'select') {
          for (let i = STATE.images.length - 1; i >= 0; i--) {
            const img = STATE.images[i];
            const imgS = worldToScreen({ x: img.x, y: img.y });
            const sW = (img.width || 300) * transform.scale;
            const sH = (img.height || 200) * transform.scale;
            const hx = imgS.x + sW - 12, hy = imgS.y + sH - 12;
            if (screenPos.x >= hx && screenPos.x <= hx + 10 && screenPos.y >= hy && screenPos.y <= hy + 10) {
              selectedImageId = img.id; resizing = true; resizeStart = { mouse: screenPos, imgStart: { width: img.width || 300, height: img.height || 200 } }; return;
            }
            if (screenPos.x >= imgS.x && screenPos.x <= imgS.x + sW && screenPos.y >= imgS.y && screenPos.y <= imgS.y + sH) {
              selectedImageId = img.id; draggingImage = true;
              const offsetWorld = { x: worldPos.x - img.x, y: worldPos.y - img.y };
              dragStart = { mouse: screenPos, imgStart: { x: img.x, y: img.y }, offsetWorld }; return;
            }
          }
          selectedImageId = null; redraw(); return;
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
        if (draggingImage) { draggingImage=false; dragStart=null; return; }
        if (drawing) { drawing=false; try{ socket.send(JSON.stringify({ type:'stroke:end', payload:{ id: currentStroke ? currentStroke.id : null } })); }catch(e){} currentStroke=null; }
      } catch (err) { console.error('pointerup err', err); }
    });

    canvas.addEventListener('pointercancel', ()=> { isPanning=false; resizing=false; draggingImage=false; drawing=false; currentStroke=null; });

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
        ctx.clearRect(0,0,canvas.width,canvas.height);

        // draw non-GIF images on canvas
        for (const img of STATE.images) {
          if (!isGifUrl(img.url)) drawImageOnCanvas(img);
        }

        // draw strokes
        for (const s of STATE.strokes) drawStroke(s);

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
            ctx.fillRect(sPos.x + sW - 12, sPos.y + sH - 12, 10, 10);
            ctx.restore();
          }
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

    // Buttons
    btnClearLocal && btnClearLocal.addEventListener('click', () => {
      if (!confirm('Limpiar trazos locales?')) return;
      STATE.strokes = []; redraw(); try{ socket.send(JSON.stringify({ type:'snapshot', state: STATE })); } catch(e){}
    });

    btnPush && btnPush.addEventListener('click', async () => {
      try {
        STATE.viewport.x=0; STATE.viewport.y=0; STATE.viewport.width=1920; STATE.viewport.height=1080;
        try{ socket.send(JSON.stringify({ type:'snapshot', state: STATE })); } catch(e){}
        await fetch('/state', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(STATE) });
        alert('Snapshot enviado al servidor');
      } catch(e){ console.error(e); alert('Error enviando snapshot'); }
    });

    btnFetchState && btnFetchState.addEventListener('click', async () => {
      try {
        const r = await fetch('/state'); const j = await r.json();
        if (confirm('Sobrescribir estado local con lo del server?')) { STATE = j.state; STATE.viewport.x=0; STATE.viewport.y=0; STATE.viewport.width=1920; STATE.viewport.height=1080; redraw(); }
      } catch(e){ console.error('fetch state err', e); }
    });

    btnResetServer && btnResetServer.addEventListener('click', async () => {
      if (!confirm('Resetear server (dev)?')) return;
      await fetch('/reset', { method:'POST' }); alert('Server reseteado');
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
          try { socket.send(JSON.stringify({ type:'snapshot', state: STATE })); } catch(e) { console.warn('ws send snapshot failed', e); }
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
          if (!confirm('Limpiar todo el canvas (trazos e imágenes)?')) return;
          console.log('[CLEAN] user confirmed');

          STATE.strokes = [];
          STATE.images = [];

          // remove dom image nodes
          domImageMap.forEach((el) => { try { el.remove(); } catch(e){} });
          domImageMap.clear();

          // publish snapshot via WS and persist to server so viewers pick it up reliably
          try { socket.send(JSON.stringify({ type:'snapshot', state: STATE })); } catch(e) { console.warn('ws send snapshot failed', e); }
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
          const imgObj = { id: generateId(), url: a.url, x: 1920 + 40, y: 40, width: 300, height: 200 };
          STATE.images.push(imgObj);
          if (!imageCache.has(a.url)) { const im = new Image(); im.crossOrigin='anonymous'; im.src=a.url; imageCache.set(a.url,im); }
          try { socket.send(JSON.stringify({ type:'image:add', payload: imgObj })); } catch(e){}
          redraw();
        });
        el.querySelector('.btn-delete').addEventListener('click', () => {
          if (!confirm('Eliminar asset de la biblioteca?')) return;
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
        el.innerHTML = `<div style="display:flex;align-items:center;gap:8px;">
          <div style="flex:1;overflow:hidden"><small>${a.name}</small></div>
          <button data-id="${a.id}" class="play">Play</button>
          <button data-id="${a.id}" class="stop">Stop</button>
          <button data-id="${a.id}" class="push">Trigger</button>
          <button data-id="${a.id}" class="btn-delete">✖</button>
        </div>`;
        audioList.appendChild(el);
        el.querySelector('.play').addEventListener('click', ()=> playLocalAudioAsset(a.id, a.url));
        el.querySelector('.stop').addEventListener('click', ()=> { stopLocalAudio(a.id); try{ socket.send(JSON.stringify({ type:'audio:stop' })); }catch(e){} });
        el.querySelector('.push').addEventListener('click', ()=> {
          const cur = { url: a.url, startedAtServer: Date.now() };
          STATE.audio.current = cur;
          try { socket.send(JSON.stringify({ type:'audio:trigger', payload: cur })); } catch(e){}
          playLocalAudioAsset(a.id, a.url);
        });
        el.querySelector('.btn-delete').addEventListener('click', () => {
          if (!confirm('Eliminar audio de la biblioteca?')) return;
          try { socket.send(JSON.stringify({ type:'asset:audio:delete', payload: a })); } catch(e){}
          STATE.assets.audio = STATE.assets.audio.filter(x=>x.id!==a.id);
          updateAudioLibraryUI();
        });
      });
    }

    // initial
    updateImagesLibraryUI(); updateAudioLibraryUI(); fitCanvas();
    console.log('Editor inicializado correctamente.');

  } catch (err) {
    console.error('Error inicializando editor:', err);
    alert('Error al inicializar el editor. Mira consola para detalles.');
  }
});

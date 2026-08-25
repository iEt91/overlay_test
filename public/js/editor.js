// editor.js - GIF overlay + undo/clean robustos (mejora: persistencia / broadcast)
document.addEventListener('DOMContentLoaded', () => {
  try {
    const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
    const socket = new WebSocket(WS_URL);

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'hello', role: 'editor' }));
      console.log('WS editor connected');
      updateRealtimeStatus('Conectando a la sala…');
    });

    socket.addEventListener('close', (event) => {
      if (event && event.code === 4004) {
        alert('El streamer restableció la contraseña de la sala. Ingresá de nuevo con la nueva contraseña.');
        location.assign('/room/access');
        return;
      }
      const code = event && event.code ? ` (código ${event.code})` : '';
      updateRealtimeStatus(`Sin conexión en tiempo real${code}`, true);
    });
    socket.addEventListener('error', () => updateRealtimeStatus('Error de conexión en tiempo real', true));

    socket.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'room:connected' && msg.payload) {
          updateRealtimeStatus(`En tiempo real · Sala ${msg.payload.roomCode || 'privada'}`);
        } else if (msg.type === 'snapshot' && msg.state) {
          const previousAudioUrl = STATE.audio && STATE.audio.current && STATE.audio.current.url;
          if (msg.state.sceneDeck) STATE.sceneDeck = msg.state.sceneDeck;
          if (msg.state.assets) {
            STATE.assets = { images: [], audio: [], ...msg.state.assets };
            updateImagesLibraryUI();
            updateAudioLibraryUI();
          }
          if (msg.state.images) STATE.images = msg.state.images.map(img => ({ ...img, viewerVisible: img.viewerVisible !== false && img.visible !== false }));
          // Clonamos los datos recibidos: cada navegador conserva su propia
          // representación y siempre vuelve al estado canónico del proyecto.
          if (msg.state.strokes) STATE.strokes = msg.state.strokes.map(stroke => ({ ...stroke, points: (stroke.points || []).map(point => ({ ...point })) }));
          if (msg.state.texts) STATE.texts = msg.state.texts.map(text => ({ ...text }));
          if (msg.state.timers) STATE.timers = msg.state.timers.map(timer => ({ ...timer }));
          if (msg.state.audio) {
            STATE.audio = { current: null, playlist: [], slots: {}, ...msg.state.audio };
            // Al cambiar de escena, ningún sonido de la escena anterior debe
            // seguir reproduciéndose localmente en segundo plano.
            if (previousAudioUrl && (!STATE.audio.current || STATE.audio.current.url !== previousAudioUrl)) stopAllLocalAudio();
            updateAudioLibraryUI();
          }
          if (typeof msg.state.volume === 'number') {
            STATE.volume = msg.state.volume;
            setLocalVolume(STATE.volume);
            if (masterVolumeEl) masterVolumeEl.value = Math.round(STATE.volume * 100);
          }
          updateCanvasImagesUI();
          updateSoundboardUI();
          updateTextList(); updateTimerList(); updateSceneList();
          redraw();
        } else if (msg.type === 'project:settings' && msg.payload && PROJECT_INFO) {
          renderProjectInfo({ ...PROJECT_INFO, project: { ...PROJECT_INFO.project, ...msg.payload } });
        } else if (msg.type === 'assets:update') {
          STATE.assets = { images: [], audio: [], ...(msg.payload || STATE.assets) };
          updateImagesLibraryUI();
          updateAudioLibraryUI();
        } else if (msg.type === 'audio:stop') {
          STATE.audio.current = null;
          stopAllLocalAudio();
          updateSoundboardUI();
        } else if (msg.type === 'volume:update') {
          STATE.volume = msg.payload && msg.payload.volume != null ? msg.payload.volume : STATE.volume;
          setLocalVolume(STATE.volume);
          if (masterVolumeEl) masterVolumeEl.value = Math.round(STATE.volume * 100);
          updateSoundboardUI();
        } else if (msg.type === 'image:update' && msg.payload) {
          const index = STATE.images.findIndex(img => img.id === msg.payload.id);
          if (index >= 0) STATE.images[index] = { ...STATE.images[index], ...msg.payload };
          // La posición cambia muchas veces mientras se arrastra. No
          // reconstruimos la biblioteca en cada mensaje: sólo redibujamos.
          redraw();
        } else if (msg.type === 'image:remove' && msg.payload) {
          STATE.images = STATE.images.filter(img => img.id !== msg.payload.id);
          updateCanvasImagesUI(); redraw();
        } else if (msg.type === 'image:add' && msg.payload && !STATE.images.some(img => img.id === msg.payload.id)) {
          STATE.images.push({ ...msg.payload, viewerVisible: msg.payload.viewerVisible !== false && msg.payload.visible !== false });
          if (!imageCache.has(msg.payload.url)) {
            const image = new Image(); image.crossOrigin = 'anonymous'; image.src = msg.payload.url; imageCache.set(msg.payload.url, image);
          }
          updateCanvasImagesUI(); redraw();
        } else if (msg.type === 'stroke:start' && msg.payload && msg.payload.id) {
          if (!STATE.strokes.some(stroke => stroke.id === msg.payload.id)) {
            STATE.strokes.push({ ...msg.payload, points: [...(msg.payload.points || [])] });
          }
          redraw();
        } else if (msg.type === 'stroke:point' && msg.payload && msg.payload.id && msg.payload.point) {
          const stroke = STATE.strokes.find(item => item.id === msg.payload.id);
          if (stroke) {
            const lastPoint = stroke.points[stroke.points.length - 1];
            const point = msg.payload.point;
            if (!lastPoint || lastPoint.x !== point.x || lastPoint.y !== point.y) stroke.points.push(point);
          }
          redraw();
        } else if (msg.type === 'stroke:end') {
          redraw();
        } else if (msg.type === 'audio:trigger' && msg.payload) {
          STATE.audio.current = msg.payload;
          updateSoundboardUI();
        } else if (msg.type === 'audio:pause') {
          if (STATE.audio.current) STATE.audio.current.paused = true;
          updateSoundboardUI();
        } else if (msg.type === 'audio:resume') {
          STATE.audio.current = { ...(STATE.audio.current || {}), ...(msg.payload || {}), paused: false };
          updateSoundboardUI();
        }
      } catch (e) { console.warn('ws parse', e); }
    });

    // DOM
    const canvas = document.getElementById('editorCanvas');
    const viewportWrap = document.getElementById('editorViewport');
    const imageLayer = document.getElementById('imageLayer');

    const brushColorEl = document.getElementById('brushColor');
    const brushSizeEl = document.getElementById('brushSize');
    const brushColorLabel = document.getElementById('brushColorLabel');
    const brushSizeValue = document.getElementById('brushSizeValue');
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
    const volumeIcon = document.getElementById('volumeIcon');
    const btnUndo = document.getElementById('btn-undo');
    const btnClean = document.getElementById('btn-clean');
    const streamPreview = document.getElementById('streamPreview');
    const btnShowStream = document.getElementById('btn-show-stream');
    const btnHideStream = document.getElementById('btn-hide-stream');
    const accountSummary = document.getElementById('accountSummary');
    const linkedChannel = document.getElementById('linkedChannel');
    const viewerUrlStatus = document.getElementById('viewerUrlStatus');
    const btnCopyViewer = document.getElementById('btn-copy-viewer');
    const btnResetRoomPassword = document.getElementById('btn-reset-room-password');
    const btnOverlayVisibility = document.getElementById('btn-overlay-visibility');
    const chatEnabled = document.getElementById('chatEnabled');
    const twitchChatPanel = document.getElementById('twitchChatPanel');
    const twitchChatFrame = document.getElementById('twitchChatFrame');
    const btnCloseChat = document.getElementById('btn-close-chat');
    const btnCreateInvite = document.getElementById('btn-create-invite');
    const inviteStatus = document.getElementById('inviteStatus');
    const whitelistLogin = document.getElementById('whitelistLogin');
    const btnAddWhitelist = document.getElementById('btn-add-whitelist');
    const whitelistList = document.getElementById('whitelistList');
    const membersList = document.getElementById('membersList');
    const roomSummary = document.getElementById('roomSummary');
    const roomCode = document.getElementById('roomCode');
    const realtimeStatus = document.getElementById('realtimeStatus');
    const paraText = document.getElementById('paraText');
    const paraColor = document.getElementById('paraColor');
    const paraFont = document.getElementById('paraFont');
    const btnSavePara = document.getElementById('btn-save-para'); const paraList = document.getElementById('paraList');
    const timerMode = document.getElementById('timerMode'); const timerSeconds = document.getElementById('timerSeconds');
    const timerColor = document.getElementById('timerColor'); const timerFontSize = document.getElementById('timerFontSize'); const timerFont = document.getElementById('timerFont');
    const timerX = document.getElementById('timerX'); const timerY = document.getElementById('timerY'); const btnAddTimer = document.getElementById('btn-add-timer'); const timerList = document.getElementById('timerList');
    const sceneList = document.getElementById('sceneList');
    const sceneShortcutButtons = document.querySelectorAll('[data-scene-shortcut]');

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
      assets: { images: [], audio: [] },
      viewport: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 },
      volume: 1.0,
      sceneDeck: { activeSceneId: 'scene-1', scenes: [] }
    };
    let PROJECT_INFO = null;
    let latestViewerUrl = null;
    let chatDismissed = false;
    let activeSlotPopover = null;
    let activeSlotAnchor = null;

    function updateRealtimeStatus(message, offline = false) {
      if (!realtimeStatus || !roomSummary) return;
      realtimeStatus.textContent = message;
      roomSummary.classList.toggle('is-offline', offline);
    }

    // tools
    let tool = 'brush';
    function setTool(nextTool) {
      tool = nextTool;
      canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
    }
    setTool('brush');

    function updateBrushControls() {
      if (brushColorLabel) brushColorLabel.textContent = brushColorEl.value.toUpperCase();
      if (brushSizeValue) brushSizeValue.textContent = `${brushSizeEl.value} px`;
    }
    brushColorEl.addEventListener('input', updateBrushControls);
    brushSizeEl.addEventListener('input', updateBrushControls);
    document.querySelectorAll('.swatch-row [data-color]').forEach(swatch => swatch.addEventListener('click', () => {
      brushColorEl.value = swatch.dataset.color;
      updateBrushControls();
    }));
    updateBrushControls();

    // transform/pan/zoom
    let transform = { scale: 1, tx: 0, ty: 0 };
    let initialCanvasFit = false;
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
      if (!rect.width || !rect.height) return;
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';
      imageLayer.style.width = rect.width + 'px';
      imageLayer.style.height = rect.height + 'px';
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(rect.width * ratio);
      canvas.height = Math.floor(rect.height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      if (!initialCanvasFit) {
        const scale = Math.min(rect.width / 1920, rect.height / 1080) * 0.86;
        transform.scale = scale;
        transform.tx = (1920 - rect.width / scale) / 2;
        transform.ty = (1080 - rect.height / scale) / 2;
        initialCanvasFit = true;
      }
      redraw();
    }
    window.addEventListener('resize', fitCanvas);
    setTimeout(fitCanvas, 80);

    function worldToScreen(p) { return { x: (p.x - transform.tx) * transform.scale, y: (p.y - transform.ty) * transform.scale }; }
    function screenToWorld(p) { return { x: p.x / transform.scale + transform.tx, y: p.y / transform.scale + transform.ty }; }
    function generateId() { return Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36); }
    function isGifUrl(url) { return /\.gif(\?.*)?$/i.test(url); }
    function currentPreviewChannel() {
      return PROJECT_INFO && PROJECT_INFO.project && PROJECT_INFO.project.twitch_channel_login;
    }
    function showStreamPreview() {
      const channel = currentPreviewChannel();
      if (!channel) { alert('Todavía no se pudo cargar el canal vinculado.'); return; }
      streamPreview.innerHTML = '';
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
    }
    function setStreamInteraction(enabled) {
      // Solo Configuración deja el reproductor por encima para poder usar sus controles.
      streamPreview.classList.toggle('interactive', Boolean(enabled && streamPreview.children.length));
    }
    async function apiRequest(url, options = {}) {
      const response = await fetch(url, {
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        ...options
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || 'No se pudo completar la acción.');
      }
      return response.status === 204 ? null : response.json();
    }
    function setChatVisibility(enabled, options = {}) {
      if (!twitchChatPanel) return;
      const channel = currentPreviewChannel();
      if (!enabled || !channel) { twitchChatPanel.hidden = true; return; }
      if (twitchChatFrame && (options.refreshChannel || twitchChatFrame.dataset.channel !== channel)) {
        twitchChatFrame.src = `https://www.twitch.tv/embed/${encodeURIComponent(channel)}/chat?parent=${encodeURIComponent(location.hostname)}&darkpopout`;
        twitchChatFrame.dataset.channel = channel;
      }
      // Si alguien cerró el panel, una actualización del overlay (como el
      // botón de pánico) no debe volver a abrirlo por sorpresa.
      if (!chatDismissed || options.reveal) twitchChatPanel.hidden = false;
    }
    function setOverlayVisibility(enabled) {
      if (!btnOverlayVisibility) return;
      const visible = enabled !== false;
      btnOverlayVisibility.dataset.overlayVisible = String(visible);
      btnOverlayVisibility.setAttribute('aria-pressed', String(visible));
      const action = visible ? 'Ocultar overlay en el Viewer' : 'Restaurar overlay en el Viewer';
      btnOverlayVisibility.setAttribute('aria-label', action);
      btnOverlayVisibility.title = action;
    }
    function renderProjectInfo(payload) {
      PROJECT_INFO = payload;
      const project = payload.project;
      const owner = payload.role === 'owner';
      if (accountSummary) accountSummary.textContent = `@${payload.user.login} · ${owner ? 'streamer propietario' : 'invitado del proyecto'}`;
      if (roomSummary && roomCode && project.id) {
        roomCode.textContent = `#${String(project.id).slice(-8).toUpperCase()}`;
        roomSummary.hidden = false;
      }
      if (linkedChannel) linkedChannel.textContent = `Canal bloqueado: twitch.tv/${project.twitch_channel_login}`;
      document.querySelectorAll('.owner-only').forEach(el => { el.style.display = owner ? '' : 'none'; });
      if (chatEnabled) chatEnabled.checked = Boolean(project.chat_enabled);
      if (payload.viewerUrl) {
        latestViewerUrl = payload.viewerUrl;
        if (viewerUrlStatus) viewerUrlStatus.textContent = 'URL permanente lista. Configurala una vez en OBS y no cambia.';
      } else if (viewerUrlStatus && !latestViewerUrl) {
        viewerUrlStatus.textContent = owner
          ? 'No se pudo cargar la URL permanente del Viewer.'
          : 'El streamer propietario administra la URL privada del Viewer.';
      }
      setChatVisibility(Boolean(project.chat_enabled));
      setOverlayVisibility(project.overlay_enabled);
    }
    async function loadProjectInfo() {
      try {
        renderProjectInfo(await apiRequest('/api/project'));
        await Promise.all([loadMembers(), loadWhitelist()]);
      }
      catch (error) { if (accountSummary) accountSummary.textContent = error.message; }
    }
    function renderMembers(members) {
      if (!membersList) return;
      membersList.innerHTML = '';
      members.filter(member => member.active).forEach(member => {
        const row = document.createElement('div'); row.className = 'canvas-object';
        const name = document.createElement('span'); name.className = 'object-name';
        name.textContent = member.role === 'owner'
          ? `Streamer: @${member.user?.login || member.member_twitch_id}`
          : `Invitado: @${member.user?.login || member.member_twitch_id}`;
        row.appendChild(name);
        if (PROJECT_INFO?.role === 'owner' && member.role === 'editor') {
          const remove = document.createElement('button'); remove.className = 'remove'; remove.type = 'button'; remove.textContent = '×'; remove.title = 'Quitar invitado';
          remove.addEventListener('click', async () => {
            try { await apiRequest(`/api/project/members/${encodeURIComponent(member.member_twitch_id)}`, { method: 'DELETE' }); await loadMembers(); }
            catch (error) { alert(error.message); }
          });
          row.appendChild(remove);
        }
        membersList.appendChild(row);
      });
    }
    async function loadMembers() {
      try { const result = await apiRequest('/api/project/members'); renderMembers(result.members || []); }
      catch (_) { if (membersList) membersList.innerHTML = '<p class="small">No se pudo cargar los invitados.</p>'; }
    }
    function renderWhitelist(entries) {
      if (!whitelistList) return;
      whitelistList.innerHTML = '';
      if (!entries.length) {
        whitelistList.innerHTML = '<p class="small">Todavía no agregaste moderadores autorizados.</p>';
        return;
      }
      entries.forEach(entry => {
        const row = document.createElement('div'); row.className = 'canvas-object';
        const name = document.createElement('span'); name.className = 'object-name'; name.textContent = `@${entry.twitch_login}`;
        const remove = document.createElement('button'); remove.className = 'remove'; remove.type = 'button'; remove.textContent = '×'; remove.title = 'Quitar de la whitelist y revocar acceso';
        remove.addEventListener('click', async () => {
          try { await apiRequest(`/api/project/whitelist/${encodeURIComponent(entry.twitch_login)}`, { method: 'DELETE' }); await loadWhitelist(); }
          catch (error) { alert(error.message); }
        });
        row.append(name, remove); whitelistList.appendChild(row);
      });
    }
    async function loadWhitelist() {
      if (PROJECT_INFO?.role !== 'owner') return;
      try { const result = await apiRequest('/api/project/whitelist'); renderWhitelist(result.entries || []); }
      catch (_) { if (whitelistList) whitelistList.innerHTML = '<p class="small">No se pudo cargar la whitelist.</p>'; }
    }
    async function copyViewerUrl() {
      if (!latestViewerUrl) { alert('La URL permanente todavía no está disponible. Recargá el editor.'); return; }
      try { await navigator.clipboard.writeText(latestViewerUrl); if (viewerUrlStatus) viewerUrlStatus.textContent = 'URL copiada. Pegala como fuente de navegador en OBS.'; }
      catch (_) { alert('No se pudo copiar automáticamente.'); }
    }
    function publishSnapshot() {
      try { socket.send(JSON.stringify({ type: 'snapshot', payload: STATE })); } catch (e) {}
      return fetch('/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(STATE) })
        .catch(err => console.warn('No se pudo guardar el estado', err));
    }

    function sceneSummary(scene) {
      const content = scene && scene.state ? scene.state : {};
      const items = (content.images || []).length + (content.texts || []).length + (content.timers || []).length;
      const strokes = (content.strokes || []).length;
      if (!items && !strokes) return 'Vacía';
      const parts = [];
      if (items) parts.push(`${items} elemento${items === 1 ? '' : 's'}`);
      if (strokes) parts.push(`${strokes} trazo${strokes === 1 ? '' : 's'}`);
      return parts.join(' · ');
    }

    function updateSceneList() {
      if (!sceneList) return;
      const deck = STATE.sceneDeck || {};
      const scenes = Array.isArray(deck.scenes) ? deck.scenes : [];
      sceneList.innerHTML = '';
      scenes.forEach((scene, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `scene-card${scene.id === deck.activeSceneId ? ' active' : ''}`;
        button.setAttribute('aria-pressed', String(scene.id === deck.activeSceneId));
        button.innerHTML = `<span class="scene-number">${index + 1}</span><span class="scene-copy"><strong>${scene.name || `Escena ${index + 1}`}</strong><small>${sceneSummary(scene)}</small></span><span class="scene-status">${scene.id === deck.activeSceneId ? 'En vivo' : 'Cambiar'}</span>`;
        button.addEventListener('click', () => activateScene(scene.id));
        sceneList.appendChild(button);
      });
      updateSceneShortcuts();
    }

    function updateSceneShortcuts() {
      const deck = STATE.sceneDeck || {};
      sceneShortcutButtons.forEach(button => {
        const sceneId = button.dataset.sceneShortcut;
        const isActive = sceneId === deck.activeSceneId;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-pressed', String(isActive));
        button.title = isActive ? `Escena ${sceneId.slice(-1)} en vivo` : `Ir a Escena ${sceneId.slice(-1)}`;
      });
    }

    function activateScene(sceneId) {
      const deck = STATE.sceneDeck || {};
      if (sceneId === deck.activeSceneId) return;
      if (socket.readyState !== WebSocket.OPEN) { alert('No hay conexión en tiempo real. Volvé a intentarlo en un momento.'); return; }
      socket.send(JSON.stringify({ type: 'scene:activate', payload: { sceneId } }));
    }

    sceneShortcutButtons.forEach(button => button.addEventListener('click', () => activateScene(button.dataset.sceneShortcut)));

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
    let selectedImageId=null, selectedTextId=null, selectedTimerId=null, draggingImage=false, draggingText=false, draggingTimer=false, rotatingImage=false, dragStart=null, resizing=false, resizingText=false, resizingTimer=false, resizeStart=null;
    let pendingImageUpdate = null, imageUpdateTimer = null, lastImageUpdateAt = 0;
    const IMAGE_SYNC_INTERVAL = 65;

    function sendImageUpdate(img) {
      if (!img || socket.readyState !== WebSocket.OPEN) return;
      try { socket.send(JSON.stringify({ type: 'image:update', payload: { ...img } })); } catch (e) {}
    }

    function queueImageUpdate(img, immediate = false) {
      if (!img) return;
      pendingImageUpdate = { ...img };
      if (immediate) {
        if (imageUpdateTimer) { clearTimeout(imageUpdateTimer); imageUpdateTimer = null; }
        const next = pendingImageUpdate; pendingImageUpdate = null;
        lastImageUpdateAt = Date.now();
        sendImageUpdate(next);
        return;
      }
      if (imageUpdateTimer) return;
      const wait = Math.max(0, IMAGE_SYNC_INTERVAL - (Date.now() - lastImageUpdateAt));
      imageUpdateTimer = setTimeout(() => {
        imageUpdateTimer = null;
        const next = pendingImageUpdate; pendingImageUpdate = null;
        if (next) { lastImageUpdateAt = Date.now(); sendImageUpdate(next); }
      }, wait);
    }

    function flushImageUpdate() {
      if (imageUpdateTimer) { clearTimeout(imageUpdateTimer); imageUpdateTimer = null; }
      if (!pendingImageUpdate) return;
      const next = pendingImageUpdate; pendingImageUpdate = null;
      lastImageUpdateAt = Date.now();
      sendImageUpdate(next);
    }

    function imageGeometry(img) {
      const width = img.width || 300, height = img.height || 200;
      const centerWorld = { x: (img.x || 0) + width / 2, y: (img.y || 0) + height / 2 };
      const center = worldToScreen(centerWorld);
      const angle = Number(img.rotation) || 0;
      const radians = angle * Math.PI / 180;
      const cos = Math.cos(radians), sin = Math.sin(radians);
      const point = (x, y) => ({ x: center.x + x * cos - y * sin, y: center.y + x * sin + y * cos });
      const screenWidth = width * transform.scale, screenHeight = height * transform.scale;
      return {
        width, height, centerWorld, center, radians, screenWidth, screenHeight, point,
        eye: point(screenWidth / 2 + 19, -screenHeight / 2 - 17),
        remove: point(screenWidth / 2 - 13, -screenHeight / 2 - 17),
        mirror: point(screenWidth / 2 - 45, -screenHeight / 2 - 17),
        resize: point(screenWidth / 2 - 12, screenHeight / 2 - 12),
        rotate: point(0, -screenHeight / 2 - 38)
      };
    }

    function imageContainsWorldPoint(img, point) {
      const geometry = imageGeometry(img);
      const dx = point.x - geometry.centerWorld.x, dy = point.y - geometry.centerWorld.y;
      const cos = Math.cos(-geometry.radians), sin = Math.sin(-geometry.radians);
      const localX = dx * cos - dy * sin, localY = dx * sin + dy * cos;
      return Math.abs(localX) <= geometry.width / 2 && Math.abs(localY) <= geometry.height / 2;
    }

    function distanceBetween(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

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
            const geometry = imageGeometry(img);
            if (distanceBetween(screenPos, geometry.mirror) <= 19) {
              img.flipX = !img.flipX;
              queueImageUpdate(img, true);
              updateCanvasImagesUI(); redraw(); return;
            }
            if (distanceBetween(screenPos, geometry.remove) <= 19) {
              removeImageFromCanvas(img.id);
              return;
            }
            if (distanceBetween(screenPos, geometry.eye) <= 19) {
              img.viewerVisible = !img.viewerVisible;
              queueImageUpdate(img, true);
              updateCanvasImagesUI(); redraw(); return;
            }
            if (distanceBetween(screenPos, geometry.rotate) <= 18) {
              selectedImageId = img.id; selectedTextId = null; selectedTimerId = null; rotatingImage = true;
              resizeStart = { rotation: Number(img.rotation) || 0, pointerAngle: Math.atan2(worldPos.y - geometry.centerWorld.y, worldPos.x - geometry.centerWorld.x) };
              canvas.setPointerCapture?.(e.pointerId); redraw(); return;
            }
            if (distanceBetween(screenPos, geometry.resize) <= 20) {
              selectedImageId = img.id; selectedTextId = null; selectedTimerId = null; resizing = true; resizeStart = { mouse: screenPos, imgStart: { width: img.width || 300, height: img.height || 200 } }; return;
            }
            if (imageContainsWorldPoint(img, worldPos)) {
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
          redraw();
          return;
        }

        if (resizing && selectedImageId) {
          const img = STATE.images.find(x=>x.id===selectedImageId); if(!img) return;
          const dx = (screenPos.x - resizeStart.mouse.x)/transform.scale;
          const dy = (screenPos.y - resizeStart.mouse.y)/transform.scale;
          const angle = (Number(img.rotation) || 0) * Math.PI / 180;
          const localX = dx * Math.cos(angle) + dy * Math.sin(angle);
          const localY = -dx * Math.sin(angle) + dy * Math.cos(angle);
          img.width = Math.max(10, resizeStart.imgStart.width + localX);
          img.height = Math.max(10, resizeStart.imgStart.height + localY);
          queueImageUpdate(img);
          redraw(); return;
        }

        if (rotatingImage && selectedImageId) {
          const img = STATE.images.find(x => x.id === selectedImageId); if (!img) return;
          const geometry = imageGeometry(img);
          const pointerAngle = Math.atan2(worldPos.y - geometry.centerWorld.y, worldPos.x - geometry.centerWorld.x);
          img.rotation = Math.round(((resizeStart.rotation + (pointerAngle - resizeStart.pointerAngle) * 180 / Math.PI) % 360 + 360) % 360);
          queueImageUpdate(img);
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
          queueImageUpdate(img);
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
        if (resizing) { resizing=false; resizeStart=null; flushImageUpdate(); return; }
        if (rotatingImage) { rotatingImage=false; resizeStart=null; flushImageUpdate(); return; }
        if (resizingText) { resizingText=false; resizeStart=null; return; }
        if (resizingTimer) { resizingTimer=false; resizeStart=null; return; }
        if (draggingImage) { draggingImage=false; dragStart=null; flushImageUpdate(); return; }
        if (draggingText) { draggingText=false; dragStart=null; return; }
        if (draggingTimer) { draggingTimer=false; dragStart=null; return; }
        if (drawing) { drawing=false; try{ socket.send(JSON.stringify({ type:'stroke:end', payload:{ id: currentStroke ? currentStroke.id : null } })); }catch(e){} currentStroke=null; }
      } catch (err) { console.error('pointerup err', err); }
    });

    canvas.addEventListener('pointercancel', ()=> { flushImageUpdate(); isPanning=false; resizing=false; rotatingImage=false; resizingText=false; resizingTimer=false; draggingImage=false; draggingText=false; draggingTimer=false; drawing=false; currentStroke=null; });

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

        // Texto sobre las imágenes; pincel por encima de todo.
        for (const text of STATE.texts) drawText(text);
        for (const timer of STATE.timers) drawTimer(timer);
        for (const s of STATE.strokes) drawStroke(s);

        // selection overlay for selected image
        if (selectedImageId) {
          const img = STATE.images.find(x => x.id === selectedImageId);
          if (img) {
            const geometry = imageGeometry(img);
            const sW = geometry.screenWidth, sH = geometry.screenHeight;
            ctx.save();
            ctx.translate(geometry.center.x, geometry.center.y);
            ctx.rotate(geometry.radians);
            ctx.strokeStyle = '#00ffcc'; ctx.lineWidth = 2;
            ctx.strokeRect(-sW / 2, -sH / 2, sW, sH);
            ctx.fillStyle = '#00ffcc';
            ctx.fillRect(sW / 2 - 24, sH / 2 - 24, 22, 22);
            ctx.fillStyle = '#071826'; ctx.font = '16px sans-serif';
            ctx.fillText('↘', sW / 2 - 21, sH / 2 - 6);
            // Control de rotación: palito superior y círculo arrastrable.
            ctx.beginPath(); ctx.moveTo(0, -sH / 2); ctx.lineTo(0, -sH / 2 - 29); ctx.stroke();
            ctx.beginPath(); ctx.arc(0, -sH / 2 - 38, 9, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = '#071826'; ctx.lineWidth = 2; ctx.stroke();
            // Acciones de imagen: espejo, quitar del canvas y visibilidad.
            ctx.fillStyle = 'rgba(2,6,18,.94)';
            ctx.fillRect(sW / 2 - 58, -sH / 2 - 30, 26, 26);
            ctx.strokeStyle = '#00ffcc'; ctx.strokeRect(sW / 2 - 58, -sH / 2 - 30, 26, 26);
            drawMirrorIcon(sW / 2 - 58, -sH / 2 - 30);
            ctx.fillStyle = 'rgba(2,6,18,.94)';
            ctx.fillRect(sW / 2 - 26, -sH / 2 - 30, 26, 26);
            ctx.strokeStyle = '#00ffcc'; ctx.strokeRect(sW / 2 - 26, -sH / 2 - 30, 26, 26);
            drawTrashIcon(sW / 2 - 26, -sH / 2 - 30);
            ctx.fillStyle = 'rgba(2,6,18,.94)';
            ctx.fillRect(sW / 2 + 6, -sH / 2 - 30, 26, 26);
            ctx.strokeStyle = '#00ffcc'; ctx.strokeRect(sW / 2 + 6, -sH / 2 - 30, 26, 26);
            drawVisibilityIcon(sW / 2 + 6, -sH / 2 - 30, img.viewerVisible !== false);
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
      const geometry = imageGeometry(img);
      try {
        ctx.save(); ctx.translate(geometry.center.x, geometry.center.y); ctx.rotate(geometry.radians);
        ctx.scale(img.flipX ? -1 : 1, 1);
        ctx.drawImage(image, -geometry.screenWidth / 2, -geometry.screenHeight / 2, geometry.screenWidth, geometry.screenHeight);
        ctx.restore();
      } catch(e){}
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
        el.style.transformOrigin = 'center center';
        el.style.transform = `rotate(${Number(img.rotation) || 0}deg) scaleX(${img.flipX ? -1 : 1})`;
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
      a.addEventListener('ended', () => {
        if (audioPlayers.get(assetId) !== a) return;
        audioPlayers.delete(assetId);
        if (STATE.audio.current && `slot-${STATE.audio.current.slot}` === assetId) {
          STATE.audio.current = null;
          try { socket.send(JSON.stringify({ type: 'audio:stop' })); } catch (e) {}
          updateSoundboardUI();
        }
      });
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
      drawVisibilityIcon(box.x + box.width + 6, box.y - 30, visible);
      ctx.restore();
    }
    function drawVisibilityIcon(x, y, visible) {
      ctx.save();
      ctx.strokeStyle = '#e6eef6'; ctx.fillStyle = '#e6eef6'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.ellipse(x + 13, y + 13, 8.5, 5.5, 0, 0, Math.PI * 2); ctx.stroke();
      if (visible) {
        ctx.beginPath(); ctx.arc(x + 13, y + 13, 2.6, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.beginPath(); ctx.moveTo(x + 5, y + 5); ctx.lineTo(x + 21, y + 21); ctx.stroke();
      }
      ctx.restore();
    }
    function drawMirrorIcon(x, y) {
      ctx.save();
      ctx.strokeStyle = '#e6eef6'; ctx.lineWidth = 1.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(x + 6, y + 5); ctx.lineTo(x + 6, y + 21);
      ctx.moveTo(x + 10, y + 8); ctx.lineTo(x + 18, y + 13); ctx.lineTo(x + 10, y + 18);
      ctx.stroke(); ctx.restore();
    }
    function drawTrashIcon(x, y) {
      ctx.save();
      ctx.strokeStyle = '#e6eef6'; ctx.lineWidth = 1.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(x + 6, y + 8); ctx.lineTo(x + 20, y + 8);
      ctx.moveTo(x + 10, y + 8); ctx.lineTo(x + 11, y + 20); ctx.lineTo(x + 17, y + 20); ctx.lineTo(x + 18, y + 8);
      ctx.moveTo(x + 11, y + 5); ctx.lineTo(x + 17, y + 5);
      ctx.moveTo(x + 13, y + 12); ctx.lineTo(x + 13, y + 17);
      ctx.moveTo(x + 16, y + 12); ctx.lineTo(x + 16, y + 17);
      ctx.stroke(); ctx.restore();
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
        STATE = j.state; STATE.audio = { current: null, playlist: [], slots: {}, ...STATE.audio }; STATE.images = (STATE.images || []).map(img => ({ ...img, viewerVisible: img.viewerVisible !== false && img.visible !== false })); STATE.viewport.x=0; STATE.viewport.y=0; STATE.viewport.width=1920; STATE.viewport.height=1080; updateAudioLibraryUI(); updateCanvasImagesUI(); updateSoundboardUI(); updateTextList(); updateTimerList(); redraw();
      } catch(e){ console.error('fetch state err', e); }
    });

    btnResetServer && btnResetServer.addEventListener('click', async () => {
      await fetch('/reset', { method:'POST' }); alert('Server reseteado');
    });
    btnShowStream && btnShowStream.addEventListener('click', showStreamPreview);
    btnHideStream && btnHideStream.addEventListener('click', () => { streamPreview.innerHTML = ''; streamPreview.style.display = 'none'; setStreamInteraction(false); });
    btnCopyViewer && btnCopyViewer.addEventListener('click', copyViewerUrl);
    btnResetRoomPassword && btnResetRoomPassword.addEventListener('click', () => {
      location.assign('/room/access?reset=1');
    });
    btnOverlayVisibility && btnOverlayVisibility.addEventListener('click', async () => {
      if (!PROJECT_INFO) return;
      const visible = !PROJECT_INFO || PROJECT_INFO.project.overlay_enabled !== false;
      try {
        await apiRequest(visible ? '/api/project/panic' : '/api/project/restore', { method: 'POST' });
        renderProjectInfo({ ...PROJECT_INFO, project: { ...PROJECT_INFO.project, overlay_enabled: !visible } });
      } catch (error) { alert(error.message); }
    });
    chatEnabled && chatEnabled.addEventListener('change', async () => {
      try {
        const result = await apiRequest('/api/project/settings', { method: 'PATCH', body: JSON.stringify({ chatEnabled: chatEnabled.checked }) });
        if (chatEnabled.checked) chatDismissed = false;
        renderProjectInfo({ ...PROJECT_INFO, project: { ...PROJECT_INFO.project, ...result.project } });
      } catch (error) { chatEnabled.checked = !chatEnabled.checked; alert(error.message); }
    });
    btnCloseChat && btnCloseChat.addEventListener('click', async () => {
      chatDismissed = true;
      if (twitchChatPanel) twitchChatPanel.hidden = true;
      if (!chatEnabled || !chatEnabled.checked || !PROJECT_INFO || PROJECT_INFO.role !== 'owner') return;
      chatEnabled.checked = false;
      try {
        const result = await apiRequest('/api/project/settings', { method: 'PATCH', body: JSON.stringify({ chatEnabled: false }) });
        renderProjectInfo({ ...PROJECT_INFO, project: { ...PROJECT_INFO.project, ...result.project } });
      } catch (error) {
        chatDismissed = false;
        chatEnabled.checked = true;
        setChatVisibility(true, { reveal: true });
        alert(error.message);
      }
    });
    btnCreateInvite && btnCreateInvite.addEventListener('click', async () => {
      try {
        const result = await apiRequest('/api/project/invites', { method: 'POST' });
        await navigator.clipboard.writeText(result.inviteUrl);
        if (inviteStatus) inviteStatus.textContent = `Invitación copiada. Vence en ${result.expiresInDays} días.`;
      } catch (error) { alert(error.message); }
    });
    btnAddWhitelist && btnAddWhitelist.addEventListener('click', async () => {
      const login = whitelistLogin && whitelistLogin.value;
      try {
        const result = await apiRequest('/api/project/whitelist', { method: 'POST', body: JSON.stringify({ login }) });
        if (whitelistLogin) whitelistLogin.value = '';
        if (inviteStatus) inviteStatus.textContent = `@${result.login} fue agregado a la whitelist.`;
        await loadWhitelist();
      } catch (error) { alert(error.message); }
    });

    // Upload image -> library
    btnUploadImg && btnUploadImg.addEventListener('click', async () => {
      try {
        if (!imgFile.files || imgFile.files.length===0) { alert('Selecciona un archivo'); return; }
        const f = imgFile.files[0]; const form = new FormData(); form.append('file', f);
        if (f.size > 25 * 1024 * 1024) { alert('La imagen supera el límite de 25 MB.'); return; }
        const r = await fetch('/upload/image', { method:'POST', body: form });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.url) throw new Error(j.error || 'El servidor no pudo subir la imagen.');
        const url = j.url;
        const asset = { id: generateId(), url, name: f.name };
        STATE.assets.images.push(asset);
        // preload
        if (!imageCache.has(url)) { const im = new Image(); im.crossOrigin='anonymous'; im.src = url; imageCache.set(url,im); }
        try { socket.send(JSON.stringify({ type:'asset:image:add', payload: asset })); } catch(e){}
        updateImagesLibraryUI();
      } catch (e) { console.error('upload img err', e); alert(e.message || 'Error subiendo imagen'); }
    });

    // Upload audio -> library
    btnUploadAudio && btnUploadAudio.addEventListener('click', async () => {
      try {
        if (!audioFile.files || audioFile.files.length===0) { alert('Selecciona un archivo'); return; }
        const f = audioFile.files[0]; const form = new FormData(); form.append('file', f);
        if (f.size > 25 * 1024 * 1024) { alert('El audio supera el límite de 25 MB.'); return; }
        const r = await fetch('/upload/audio', { method:'POST', body: form });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.url) throw new Error(j.error || 'El servidor no pudo subir el audio.');
        const url = j.url;
        const asset = { id: generateId(), url, name: f.name };
        STATE.assets.audio.push(asset);
        try { socket.send(JSON.stringify({ type:'asset:audio:add', payload: asset })); } catch(e){}
        updateAudioLibraryUI();
      } catch (e) { console.error('upload audio err', e); alert(e.message || 'Error subiendo audio'); }
    });

    // master volume control
    masterVolumeEl && masterVolumeEl.addEventListener('input', () => {
      const v = parseInt(masterVolumeEl.value,10)/100; STATE.volume = v; setLocalVolume(v);
      try { socket.send(JSON.stringify({ type:'volume:update', payload:{ volume: v } })); } catch(e){}
    });

    btnSoundStop && btnSoundStop.addEventListener('click', stopSoundboard);
    btnSoundPause && btnSoundPause.addEventListener('click', toggleSoundboard);
    window.addEventListener('keydown', (event) => {
      const isTyping = ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
      if (!isTyping && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'z') {
        event.preventDefault(); btnUndo && btnUndo.click(); return;
      }
      if (event.repeat || event.ctrlKey || event.altKey || event.metaKey || isTyping) return;
      if (/^[0-9]$/.test(event.key)) { event.preventDefault(); playSoundSlot(event.key); }
    });

    document.querySelectorAll('.inner-tab').forEach(button => button.addEventListener('click', () => {
      const target = button.dataset.textTab;
      document.querySelectorAll('.inner-tab').forEach(tab => tab.classList.toggle('active', tab === button));
      document.querySelectorAll('.text-section').forEach(section => section.style.display = section.dataset.textTab === target ? '' : 'none');
    }));
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
        const el = document.createElement('div'); el.className = 'lib-item';
        const main = document.createElement('div'); main.className = 'library-item-main';
        const preview = document.createElement('img');
        preview.className = 'library-thumbnail'; preview.src = a.url; preview.alt = a.name; preview.title = a.name;
        preview.loading = 'lazy'; preview.addEventListener('error', () => { preview.classList.add('is-unavailable'); preview.alt = 'Vista previa no disponible'; });
        const actions = document.createElement('div'); actions.className = 'library-actions';
        const remove = createLibraryButton('btn-delete asset-delete', 'Eliminar de la biblioteca', trashIconMarkup());
        const add = createLibraryButton('btn-add', 'Agregar al canvas', '+');
        // La papelera quita el archivo de la biblioteca; el + queda a la
        // derecha para que sea la acción final y más habitual.
        actions.append(remove, add);
        main.append(preview, actions); el.append(main);
        imagesList.appendChild(el);
        add.addEventListener('click', () => {
          // add outside safe zone (to the right)
          const imgObj = { id: generateId(), url: a.url, x: 80, y: 80, width: 300, height: 200, rotation: 0, flipX: false, viewerVisible: false };
          STATE.images.push(imgObj);
          if (!imageCache.has(a.url)) { const im = new Image(); im.crossOrigin='anonymous'; im.src=a.url; imageCache.set(a.url,im); }
          try { socket.send(JSON.stringify({ type:'image:add', payload: imgObj })); } catch(e){}
          selectedImageId = imgObj.id;
          updateCanvasImagesUI();
          redraw();
        });
        remove.addEventListener('click', () => {
          try { socket.send(JSON.stringify({ type:'asset:image:delete', payload: a })); } catch(e){}
          STATE.assets.images = STATE.assets.images.filter(x=>x.id!==a.id);
          STATE.images = STATE.images.filter(x=>x.url!==a.url);
          updateImagesLibraryUI(); redraw();
        });
      });
    }

    function updateAudioLibraryUI() {
      closeSlotPopover();
      audioList.innerHTML = '';
      STATE.assets.audio.forEach(a => {
        const slots = Object.entries(STATE.audio.slots || {})
          .filter(([, assigned]) => assigned && (assigned.id === a.id || assigned.url === a.url))
          .map(([slot]) => slot);
        const el = document.createElement('div'); el.className = 'lib-item audio-library-item';
        el.draggable = true;
        const main = document.createElement('div'); main.className = 'library-item-main';
        const details = document.createElement('div'); details.className = 'library-item-details';
        const name = document.createElement('small'); name.className = 'library-item-name'; name.textContent = a.name; name.title = a.name;
        const actions = document.createElement('div'); actions.className = 'library-actions';
        const assignedSlotText = slots.length === 1 ? slots[0] : (slots.length > 1 ? `${slots[0]}+` : '');
        const assignTitle = slots.length ? `Asignado a: ${slots.join(', ')}. Cambiar slot` : 'Asignar a un slot';
        const assign = createLibraryButton('slot-assign', assignTitle, assignedSlotText || slotIconMarkup());
        assign.classList.toggle('has-slot', Boolean(assignedSlotText));
        const remove = createLibraryButton('btn-delete asset-delete', 'Eliminar audio de esta escena', trashIconMarkup());
        assign.addEventListener('click', event => {
          event.stopPropagation();
          if (activeSlotAnchor === assign) closeSlotPopover();
          else openSlotPopover(assign, a);
        });
        remove.addEventListener('click', () => {
          const wasPlaying = STATE.audio.current && STATE.audio.current.url === a.url;
          if (wasPlaying) stopAllLocalAudio();
          STATE.assets.audio = STATE.assets.audio.filter(item => item.id !== a.id);
          STATE.audio.playlist = (STATE.audio.playlist || []).filter(item => item.id !== a.id);
          Object.keys(STATE.audio.slots || {}).forEach(slot => {
            if (STATE.audio.slots[slot] && STATE.audio.slots[slot].id === a.id) delete STATE.audio.slots[slot];
          });
          if (wasPlaying) STATE.audio.current = null;
          try { socket.send(JSON.stringify({ type: 'asset:audio:delete', payload: a })); } catch (e) {}
          updateAudioLibraryUI(); updateSoundboardUI();
        });
        details.append(name); actions.append(assign, remove); main.append(details, actions); el.append(main);
        audioList.appendChild(el);
        el.addEventListener('dragstart', event => { event.dataTransfer.setData('text/plain', a.id); event.dataTransfer.effectAllowed = 'copy'; });
      });
    }

    function closeSlotPopover() {
      if (activeSlotPopover) activeSlotPopover.remove();
      activeSlotPopover = null;
      activeSlotAnchor = null;
    }

    function openSlotPopover(anchor, asset) {
      closeSlotPopover();
      const popover = document.createElement('div'); popover.className = 'slot-popover'; popover.setAttribute('role', 'menu');
      for (let slot = 0; slot <= 9; slot++) {
        const slotButton = document.createElement('button');
        slotButton.type = 'button'; slotButton.textContent = String(slot); slotButton.title = `Asignar a slot ${slot}`;
        slotButton.addEventListener('click', event => {
          event.stopPropagation();
          STATE.audio.slots[String(slot)] = asset;
          closeSlotPopover();
          publishSnapshot(); updateSoundboardUI(); updateAudioLibraryUI();
        });
        popover.appendChild(slotButton);
      }
      document.body.appendChild(popover);
      const anchorBox = anchor.getBoundingClientRect();
      const popoverBox = popover.getBoundingClientRect();
      const left = Math.max(8, Math.min(anchorBox.right - popoverBox.width, window.innerWidth - popoverBox.width - 8));
      const top = Math.max(8, Math.min(anchorBox.bottom + 6, window.innerHeight - popoverBox.height - 8));
      popover.style.left = `${Math.round(left)}px`; popover.style.top = `${Math.round(top)}px`;
      activeSlotPopover = popover; activeSlotAnchor = anchor;
    }

    document.addEventListener('pointerdown', event => {
      if (activeSlotPopover && !activeSlotPopover.contains(event.target) && event.target !== activeSlotAnchor) closeSlotPopover();
    }, true);

    function createLibraryButton(className, title, content) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = className; button.title = title; button.setAttribute('aria-label', title);
      button.innerHTML = content;
      return button;
    }

    function visibilityIconMarkup(visible) {
      const slash = visible ? '' : '<path d="M3 3l18 18" />';
      return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.2-5.5 9.5-5.5S21.5 12 21.5 12s-3.2 5.5-9.5 5.5S2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="2.4" />${slash}</svg>`;
    }

    function mirrorIconMarkup() {
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5v14M9 8l7 4-7 4V8ZM19 5v14" /></svg>';
    }

    function trashIconMarkup() {
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" /></svg>';
    }

    function slotIconMarkup() {
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 10h8M12 7v6M9 15h6" /></svg>';
    }

    function removeImageFromCanvas(imageId) {
      STATE.images = STATE.images.filter(item => item.id !== imageId);
      if (selectedImageId === imageId) selectedImageId = null;
      try { socket.send(JSON.stringify({ type: 'image:remove', payload: { id: imageId } })); } catch (e) {}
      updateCanvasImagesUI(); redraw();
    }

    function updateCanvasImagesUI() {
      if (!canvasImagesList) return;
      canvasImagesList.innerHTML = '';
      if (!STATE.images.length) { canvasImagesList.innerHTML = '<p class="small">Todavía no hay imágenes en el canvas.</p>'; return; }
      STATE.images.forEach(img => {
        const row = document.createElement('div'); row.className = 'canvas-object';
        const visible = img.viewerVisible !== false;
        const name = document.createElement('span'); name.className = 'object-name'; name.textContent = imageName(img); name.title = imageName(img);
        const select = createLibraryButton('select', 'Seleccionar imagen', 'Seleccionar');
        const actions = document.createElement('div'); actions.className = 'canvas-actions';
        const flip = createLibraryButton('flip mirror-toggle', 'Voltear horizontalmente', mirrorIconMarkup());
        const remove = createLibraryButton('remove canvas-remove', 'Quitar del canvas', trashIconMarkup());
        const toggle = createLibraryButton('toggle eye-toggle', visible ? 'Ocultar en Viewer' : 'Mostrar en Viewer', visibilityIconMarkup(visible));
        // Orden deliberado: espejo, quitar del canvas y visibilidad. Quitar
        // sólo afecta a la composición actual; el archivo queda en biblioteca.
        actions.append(flip, remove, toggle); row.append(name, select, actions);
        select.addEventListener('click', () => { selectedImageId = img.id; setTool('select'); redraw(); });
        toggle.addEventListener('click', () => { img.viewerVisible = !visible; queueImageUpdate(img, true); updateCanvasImagesUI(); redraw(); });
        flip.addEventListener('click', () => { img.flipX = !img.flipX; queueImageUpdate(img, true); redraw(); });
        remove.addEventListener('click', () => removeImageFromCanvas(img.id));
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
        row.innerHTML = `<span class="object-name">${label}: ${item.text || (item.mode === 'down' ? 'Regresivo' : 'Ascendente')}</span>${eventPrefix === 'text' || eventPrefix === 'timer' ? '<button class="select">Seleccionar</button>' : ''}<button class="toggle eye-toggle" title="${visible ? 'Ocultar en Viewer' : 'Mostrar en Viewer'}" aria-label="${visible ? 'Ocultar en Viewer' : 'Mostrar en Viewer'}">${visibilityIconMarkup(visible)}</button><button class="remove">✖</button>`;
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
          publishSnapshot(); updateSoundboardUI(); updateAudioLibraryUI();
        });
        soundboard.appendChild(button);
      }
      const playing = STATE.audio.current && !STATE.audio.current.paused;
      if (btnSoundPause) {
        btnSoundPause.innerHTML = playing
          ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="6" width="3.5" height="12" rx=".8"/><rect x="13.5" y="6" width="3.5" height="12" rx=".8"/></svg>'
          : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7V5Z"/></svg>';
        btnSoundPause.title = playing ? 'Pausar' : 'Reproducir';
        btnSoundPause.setAttribute('aria-label', btnSoundPause.title);
      }
      if (volumeIcon) {
        const muted = STATE.volume <= 0;
        volumeIcon.innerHTML = muted
          ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h4l5 4V6L8 10H4Z"/><path d="m17 10 4 4m0-4-4 4"/></svg>'
          : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h4l5 4V6L8 10H4Z"/><path d="M16 9.5a4 4 0 0 1 0 5"/><path d="M18.8 6.8a8 8 0 0 1 0 10.4"/></svg>';
      }
    }

    // initial
    updateImagesLibraryUI(); updateAudioLibraryUI(); updateCanvasImagesUI(); updateTextList(); updateTimerList(); updateSceneList(); updateSoundboardUI(); fitCanvas(); loadProjectInfo();
    console.log('Editor inicializado correctamente.');

  } catch (err) {
    console.error('Error inicializando editor:', err);
    alert('Error al inicializar el editor. Mira consola para detalles.');
  }
});

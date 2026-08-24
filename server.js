// server.js
// Servidor con WebSocket básico para broadcast entre editors y viewers.
// Estado en memoria para MVP (ahora con biblioteca de assets).

require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cors = require('cors');
const http = require('http');
const session = require('express-session');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const TWITCH_REDIRECT_URI = process.env.TWITCH_REDIRECT_URI || `http://localhost:${PORT}/auth/twitch/callback`;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const SUPABASE_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET?.trim();
// Sólo para pruebas internas: permite al propietario previsualizar otro canal
// sin cambiar el canal real del proyecto ni exponer esa opción a invitados.
const ALLOW_TEST_CHANNEL_OVERRIDE = process.env.ALLOW_TEST_CHANNEL_OVERRIDE === 'true';

// La clave de sesión debe existir únicamente en .env. Nunca se envía al navegador.
const SESSION_SECRET = process.env.SESSION_SECRET;
// Firma exclusiva de los enlaces permanentes del Viewer. Si todavía no se
// configura, se mantiene la compatibilidad usando SESSION_SECRET.
const VIEWER_URL_SECRET = process.env.VIEWER_URL_SECRET || SESSION_SECRET || 'development-viewer-secret';
const isProduction = process.env.NODE_ENV === 'production';
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7;
const ROOM_PASSWORD_MIN_LENGTH = 10;
const ROOM_PASSWORD_MAX_LENGTH = 128;
const supabaseAdmin = SUPABASE_URL && SUPABASE_SECRET_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  })
  : null;

function sessionExpiry(sessionData) {
  const expires = sessionData?.cookie?.expires ? new Date(sessionData.cookie.expires) : null;
  return expires && !Number.isNaN(expires.getTime())
    ? expires.toISOString()
    : new Date(Date.now() + SESSION_MAX_AGE_MS).toISOString();
}

// La sesión del editor no queda en la memoria del proceso. Así sobrevive a un
// reinicio o redeploy del servidor sin guardar tokens de Twitch.
class SupabaseSessionStore extends session.Store {
  constructor(client) {
    super();
    this.client = client;
  }

  get(sid, callback) {
    this.client.from('app_sessions').select('session, expires_at').eq('sid', sid).maybeSingle()
      .then(({ data, error }) => {
        if (error) return callback(error);
        if (!data || new Date(data.expires_at).getTime() <= Date.now()) {
          if (data) this.destroy(sid, () => {});
          return callback(null, null);
        }
        callback(null, data.session);
      })
      .catch(callback);
  }

  set(sid, sessionData, callback = () => {}) {
    this.client.from('app_sessions').upsert({
      sid,
      session: sessionData,
      expires_at: sessionExpiry(sessionData),
      updated_at: new Date().toISOString()
    }, { onConflict: 'sid' })
      .then(({ error }) => callback(error || null))
      .catch(callback);
  }

  touch(sid, sessionData, callback = () => {}) {
    this.set(sid, sessionData, callback);
  }

  destroy(sid, callback = () => {}) {
    this.client.from('app_sessions').delete().eq('sid', sid)
      .then(({ error }) => callback(error || null))
      .catch(callback);
  }
}

// Las subidas locales se conservan como respaldo durante la transición. Al
// configurar SUPABASE_STORAGE_BUCKET, los archivos nuevos pasan a Storage.
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const useSupabaseStorage = Boolean(supabaseAdmin && SUPABASE_STORAGE_BUCKET);

// Las subidas se publican para que el Viewer pueda usarlas, por lo que se
// aceptan únicamente los formatos que realmente utiliza el editor.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const UPLOAD_RULES = {
  image: {
    label: 'imagen',
    extensions: new Set(['.jpg', '.jpeg', '.jfif', '.png', '.gif', '.webp']),
    mimeTypes: new Set(['image/jpeg', 'image/pjpeg', 'image/png', 'image/gif', 'image/webp'])
  },
  audio: {
    label: 'audio',
    extensions: new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.webm']),
    mimeTypes: new Set([
      'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/mp4',
      'audio/x-m4a', 'audio/aac', 'audio/x-aac', 'audio/webm'
    ])
  }
};

const localUploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // No conservamos el nombre que llega desde el navegador para no publicar
    // nombres arbitrarios. La extensión fue validada antes por Multer.
    cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`);
  }
});
const uploadStorage = useSupabaseStorage ? multer.memoryStorage() : localUploadStorage;

function createUpload(kind) {
  const rules = UPLOAD_RULES[kind];
  return multer({
    storage: uploadStorage,
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    fileFilter: (req, file, cb) => {
      const extension = path.extname(file.originalname).toLowerCase();
      if (!rules.extensions.has(extension) || !rules.mimeTypes.has(file.mimetype)) {
        return cb(new Error(`Solo se permiten archivos de ${rules.label} compatibles.`));
      }
      cb(null, true);
    }
  });
}

const imageUpload = createUpload('image');
const audioUpload = createUpload('audio');

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.set('trust proxy', 1);

// Render consulta esta ruta para confirmar que el proceso Node sigue vivo.
// No expone datos de usuarios ni requiere sesión.
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

const sessionMiddleware = session({
  name: 'tango.sid',
  secret: SESSION_SECRET || 'development-only-change-me-before-launch',
  store: supabaseAdmin ? new SupabaseSessionStore(supabaseAdmin) : undefined,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    maxAge: SESSION_MAX_AGE_MS
  }
});
app.use(sessionMiddleware);

function twitchIsConfigured() {
  return Boolean(TWITCH_CLIENT_ID && TWITCH_CLIENT_SECRET && SESSION_SECRET && supabaseAdmin);
}

function twitchConfigurationError(res) {
  return res.status(503).send('Falta configurar Twitch. Revisá el archivo .env local.');
}

const SCENE_LIMIT = 3;

function emptySceneContent() {
  return {
    strokes: [],
    images: [],
    texts: [],
    timers: [],
    audio: { current: null, playlist: [], slots: {} },
    // La biblioteca de sonidos es parte de la escena, igual que sus slots.
    // Así una escena no hereda los audios cargados en otra.
    audioAssets: [],
    viewport: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 },
    volume: 1,
    updatedAt: Date.now()
  };
}

function emptyAssets() {
  return { images: [], audio: [] };
}

function normalizeSceneContent(incoming, fallback = emptySceneContent()) {
  const value = incoming && typeof incoming === 'object' ? incoming : {};
  return {
    strokes: Array.isArray(value.strokes) ? value.strokes : fallback.strokes,
    images: Array.isArray(value.images) ? value.images : fallback.images,
    texts: Array.isArray(value.texts) ? value.texts : fallback.texts,
    timers: Array.isArray(value.timers) ? value.timers : fallback.timers,
    audio: value.audio && typeof value.audio === 'object' ? value.audio : fallback.audio,
    audioAssets: Array.isArray(value.audioAssets) ? value.audioAssets : fallback.audioAssets,
    viewport: value.viewport && typeof value.viewport === 'object' ? value.viewport : fallback.viewport,
    volume: typeof value.volume === 'number' ? Math.max(0, Math.min(1, value.volume)) : fallback.volume,
    updatedAt: Date.now()
  };
}

function normalizeAssets(incoming, fallback = emptyAssets()) {
  const value = incoming && typeof incoming === 'object' ? incoming : {};
  return {
    images: Array.isArray(value.images) ? value.images : fallback.images,
    audio: Array.isArray(value.audio) ? value.audio : fallback.audio
  };
}

function sceneIdAt(index) {
  return `scene-${index + 1}`;
}

function emptySceneDeck(firstScene = emptySceneContent()) {
  return {
    activeSceneId: 'scene-1',
    scenes: Array.from({ length: SCENE_LIMIT }, (_, index) => ({
      id: sceneIdAt(index),
      name: `Escena ${index + 1}`,
      state: index === 0 ? normalizeSceneContent(firstScene) : emptySceneContent()
    }))
  };
}

function normalizeSceneDeck(incoming, legacyContent) {
  if (!incoming || typeof incoming !== 'object' || !Array.isArray(incoming.scenes)) {
    return emptySceneDeck(legacyContent);
  }
  const fallback = emptySceneContent();
  const scenes = Array.from({ length: SCENE_LIMIT }, (_, index) => {
    const id = sceneIdAt(index);
    const supplied = incoming.scenes.find(scene => scene && scene.id === id);
    return {
      id,
      name: `Escena ${index + 1}`,
      state: normalizeSceneContent(supplied && supplied.state, fallback)
    };
  });
  const activeSceneId = scenes.some(scene => scene.id === incoming.activeSceneId)
    ? incoming.activeSceneId
    : 'scene-1';
  return { activeSceneId, scenes };
}

function activeSceneFromDeck(deck) {
  return deck.scenes.find(scene => scene.id === deck.activeSceneId) || deck.scenes[0];
}

function materializeScene(deck, assets) {
  const activeScene = activeSceneFromDeck(deck);
  const content = normalizeSceneContent(activeScene.state);
  const globalAssets = normalizeAssets(assets);
  return {
    ...content,
    // Las imágenes permanecen en una biblioteca común; los audios se obtienen
    // de la escena activa para que el soundboard sea independiente.
    assets: { images: globalAssets.images, audio: content.audioAssets },
    sceneDeck: deck,
    updatedAt: Date.now()
  };
}

function emptyScene() {
  const deck = emptySceneDeck();
  return materializeScene(deck, emptyAssets());
}

function syncActiveSceneToDeck(state) {
  const deck = normalizeSceneDeck(state.sceneDeck, normalizeSceneContent(state));
  const activeScene = activeSceneFromDeck(deck);
  const content = normalizeSceneContent(state, activeScene.state);
  content.audioAssets = Array.isArray(state.assets && state.assets.audio)
    ? state.assets.audio
    : activeScene.state.audioAssets;
  activeScene.state = content;
  state.sceneDeck = deck;
  state.updatedAt = Date.now();
  return state;
}

function activateScene(state, sceneId) {
  syncActiveSceneToDeck(state);
  if (!state.sceneDeck.scenes.some(scene => scene.id === sceneId)) return state;
  state.sceneDeck.activeSceneId = sceneId;
  return materializeScene(state.sceneDeck, state.assets);
}

function normalizeScene(incoming, fallback = emptyScene()) {
  const value = incoming && typeof incoming === 'object' ? incoming : {};
  const fallbackState = fallback && typeof fallback === 'object' ? fallback : emptyScene();
  const legacyContent = normalizeSceneContent(value, normalizeSceneContent(fallbackState));
  // Migración silenciosa: los proyectos anteriores tenían una única biblioteca
  // de audio global. La conservamos dentro de Escena 1, sin copiarla a las demás.
  if (!value.sceneDeck && value.assets && Array.isArray(value.assets.audio)) {
    legacyContent.audioAssets = value.assets.audio;
  }
  const deck = normalizeSceneDeck(value.sceneDeck, legacyContent);
  const assets = normalizeAssets(value.assets, fallbackState.assets);
  // También cubre estados guardados por la primera versión de escenas, donde
  // el deck ya existía pero la biblioteca de audio aún era global.
  const storedActiveScene = value.sceneDeck && Array.isArray(value.sceneDeck.scenes)
    ? value.sceneDeck.scenes.find(scene => scene && scene.id === deck.activeSceneId)
    : null;
  if (Array.isArray(assets.audio) && (!storedActiveScene || !Array.isArray(storedActiveScene.state && storedActiveScene.state.audioAssets))) {
    activeSceneFromDeck(deck).state.audioAssets = assets.audio;
  }
  return materializeScene(deck, { images: assets.images, audio: [] });
}

// El cliente sólo puede actualizar la composición activa: las otras escenas se
// conservan en el servidor para que un snapshot viejo no pueda sobrescribirlas.
function applyActiveSceneSnapshot(incoming, fallback) {
  const state = normalizeScene(fallback);
  const content = normalizeSceneContent(incoming, normalizeSceneContent(state));
  if (incoming && incoming.assets && Array.isArray(incoming.assets.audio)) {
    content.audioAssets = incoming.assets.audio;
  }
  Object.assign(state, content);
  const incomingAssets = normalizeAssets(incoming && incoming.assets, state.assets);
  state.assets = { images: incomingAssets.images, audio: content.audioAssets };
  return syncActiveSceneToDeck(state);
}

const projectStateCache = new Map();
const pendingSceneSaves = new Map();
const pendingAuditUpdates = new Map();

function hashOpaqueToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function persistentViewerToken(project) {
  const signature = crypto.createHmac('sha256', VIEWER_URL_SECRET)
    .update(`${project.id}:${project.viewer_token_hash}`)
    .digest('base64url');
  return `v1.${project.id}.${signature}`;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizeRoomPassword(value) {
  if (typeof value !== 'string') return null;
  const password = value.trim();
  if (password.length < ROOM_PASSWORD_MIN_LENGTH || password.length > ROOM_PASSWORD_MAX_LENGTH) return null;
  return password;
}

function scryptPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

async function hashRoomPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const derivedKey = await scryptPassword(password, salt);
  return `scrypt-v1.${salt}.${derivedKey.toString('base64url')}`;
}

async function verifyRoomPassword(password, encodedHash) {
  const [version, salt, storedKey] = String(encodedHash || '').split('.');
  if (version !== 'scrypt-v1' || !salt || !storedKey) return false;
  const derivedKey = await scryptPassword(password, salt);
  const expected = Buffer.from(storedKey, 'base64url');
  return expected.length === derivedKey.length && crypto.timingSafeEqual(expected, derivedKey);
}

async function getProjectRoomSecurity(projectId) {
  const result = await supabaseAdmin.from('projects')
    .select('id, owner_twitch_id, twitch_channel_login, room_password_hash, room_password_updated_at')
    .eq('id', projectId)
    .maybeSingle();
  return databaseError(result, 'No se pudo validar la seguridad de la sala.');
}

function hasVerifiedRoomAccess(sessionData, project) {
  const access = sessionData && sessionData.roomAccess;
  if (!access || access.projectId !== project.id || !project.room_password_hash) return false;
  const verifiedAt = Date.parse(access.passwordUpdatedAt || '');
  const currentAt = Date.parse(project.room_password_updated_at || '');
  return Number.isFinite(verifiedAt) && Number.isFinite(currentAt) && verifiedAt === currentAt;
}

function saveSession(req) {
  return new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
}

function viewerUrlForProject(req, project) {
  return `${requestOrigin(req)}/viewer/${persistentViewerToken(project)}`;
}

function databaseError(result, message) {
  if (result && result.error) {
    console.error(message, result.error.message);
    throw new Error(message);
  }
  return result && result.data;
}

async function upsertTwitchUser(user) {
  const result = await supabaseAdmin.from('twitch_users').upsert({
    twitch_id: user.id,
    login: user.login,
    display_name: user.display_name,
    profile_image_url: user.profile_image_url || null
  }, { onConflict: 'twitch_id' });
  databaseError(result, 'No se pudo guardar la cuenta de Twitch.');
}

async function ensureOwnerProject(user) {
  await upsertTwitchUser(user);
  const existing = await supabaseAdmin.from('projects')
    .select('*')
    .eq('owner_twitch_id', user.id)
    .maybeSingle();
  const project = databaseError(existing, 'No se pudo buscar el proyecto.');
  if (project) return { project, role: 'owner', viewerToken: null };

  const viewerToken = crypto.randomBytes(32).toString('base64url');
  const created = await supabaseAdmin.from('projects').insert({
    owner_twitch_id: user.id,
    twitch_channel_id: user.id,
    twitch_channel_login: user.login,
    viewer_token_hash: hashOpaqueToken(viewerToken),
    trial_ends_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  }).select('*').single();
  const newProject = databaseError(created, 'No se pudo crear el proyecto de Tango GG.');

  const membership = await supabaseAdmin.from('project_members').insert({
    project_id: newProject.id,
    member_twitch_id: user.id,
    role: 'owner',
    joined_at: new Date().toISOString()
  });
  databaseError(membership, 'No se pudo crear el rol de streamer.');

  const scene = await supabaseAdmin.from('project_scenes').insert({
    project_id: newProject.id,
    state: emptyScene(),
    updated_by_twitch_id: user.id
  });
  databaseError(scene, 'No se pudo crear la escena inicial.');

  await recordAudit(newProject.id, user.id, 'project.created');
  return { project: newProject, role: 'owner', viewerToken: persistentViewerToken(newProject) };
}

async function validateProjectInvite(token, user) {
  await upsertTwitchUser(user);
  const inviteResult = await supabaseAdmin.from('project_invites')
    .select('id, project_id, expires_at, accepted_by_twitch_id, accepted_at')
    .eq('token_hash', hashOpaqueToken(token))
    .is('revoked_at', null)
    .maybeSingle();
  const invite = databaseError(inviteResult, 'No se pudo validar la invitación.');
  if (!invite || new Date(invite.expires_at) <= new Date()) throw new Error('La invitación ya no es válida.');
  if (invite.accepted_by_twitch_id && invite.accepted_by_twitch_id !== user.id) {
    throw new Error('Esta invitación ya fue utilizada por otra cuenta de Twitch.');
  }

  const existing = await getActiveMembership(invite.project_id, user.id);
  return { invite, project: { id: invite.project_id }, existingRole: existing ? existing.role : null };
}

async function acceptProjectInvite(token, user) {
  const validated = await validateProjectInvite(token, user);
  const { invite } = validated;

  const existingResult = await supabaseAdmin.from('project_members')
    .select('role, active')
    .eq('project_id', invite.project_id)
    .eq('member_twitch_id', user.id)
    .maybeSingle();
  const existing = databaseError(existingResult, 'No se pudo validar la membresía.');
  if (!existing) {
    const memberResult = await supabaseAdmin.from('project_members').insert({
      project_id: invite.project_id,
      member_twitch_id: user.id,
      role: 'editor',
      joined_at: new Date().toISOString()
    });
    databaseError(memberResult, 'No se pudo añadir el invitado.');
  } else if (!existing.active) {
    const memberResult = await supabaseAdmin.from('project_members').update({ active: true, joined_at: new Date().toISOString() })
      .eq('project_id', invite.project_id)
      .eq('member_twitch_id', user.id);
    databaseError(memberResult, 'No se pudo reactivar el invitado.');
  }

  if (!invite.accepted_at) {
    const accepted = await supabaseAdmin.from('project_invites').update({
      accepted_by_twitch_id: user.id,
      accepted_at: new Date().toISOString()
    }).eq('id', invite.id);
    databaseError(accepted, 'No se pudo completar la invitación.');
    await recordAudit(invite.project_id, user.id, 'member.invite_accepted');
  }
  return { project: { id: invite.project_id }, role: existing ? existing.role : 'editor', viewerToken: null };
}

async function getActiveMembership(projectId, twitchId) {
  const result = await supabaseAdmin.from('project_members')
    .select('role, active')
    .eq('project_id', projectId)
    .eq('member_twitch_id', twitchId)
    .eq('active', true)
    .maybeSingle();
  return databaseError(result, 'No se pudo validar el acceso al proyecto.');
}

async function loadProjectScene(projectId) {
  if (projectStateCache.has(projectId)) return projectStateCache.get(projectId);
  const result = await supabaseAdmin.from('project_scenes')
    .select('state')
    .eq('project_id', projectId)
    .single();
  const scene = databaseError(result, 'No se pudo cargar la escena.');
  const state = normalizeScene(scene.state);
  projectStateCache.set(projectId, state);
  return state;
}

async function saveProjectScene(projectId, actorTwitchId) {
  const state = projectStateCache.get(projectId);
  if (!state) return;
  syncActiveSceneToDeck(state);
  const result = await supabaseAdmin.from('project_scenes').update({
    state: normalizeScene(state),
    updated_by_twitch_id: actorTwitchId || null
  }).eq('project_id', projectId);
  databaseError(result, 'No se pudo guardar la escena.');
}

function scheduleSceneSave(projectId, actorTwitchId) {
  const pending = pendingSceneSaves.get(projectId);
  if (pending) {
    pending.actorTwitchId = actorTwitchId || pending.actorTwitchId;
    return;
  }
  const entry = { actorTwitchId, timer: null };
  entry.timer = setTimeout(async () => {
    pendingSceneSaves.delete(projectId);
    try { await saveProjectScene(projectId, entry.actorTwitchId); }
    catch (error) { console.error('Autosave de escena falló:', error.message); }
  }, 60_000);
  pendingSceneSaves.set(projectId, entry);
}

async function recordAudit(projectId, actorTwitchId, action, entityType = null, entityId = null, metadata = {}) {
  const result = await supabaseAdmin.from('audit_events').insert({
    project_id: projectId,
    actor_twitch_id: actorTwitchId || null,
    action,
    entity_type: entityType,
    entity_id: entityId,
    metadata
  });
  databaseError(result, 'No se pudo registrar la acción.');
}

function scheduleAuditUpdate(projectId, actorTwitchId, action, entityId = null) {
  const key = `${projectId}:${actorTwitchId}:${action}:${entityId || ''}`;
  clearTimeout(pendingAuditUpdates.get(key));
  pendingAuditUpdates.set(key, setTimeout(() => {
    pendingAuditUpdates.delete(key);
    recordAudit(projectId, actorTwitchId, action, null, entityId).catch(() => {});
  }, 1200));
}

async function requireEditorApi(req, res, next) {
  if (!req.session.user || !req.session.projectId) return res.status(401).json({ error: 'Iniciá sesión con Twitch.' });
  try {
    const membership = await getActiveMembership(req.session.projectId, req.session.user.id);
    if (!membership) return res.status(403).json({ error: 'Ya no tenés acceso a este proyecto.' });
    const project = await getProjectRoomSecurity(req.session.projectId);
    if (!project || !hasVerifiedRoomAccess(req.session, project)) {
      return res.status(403).json({ error: 'Ingresá la contraseña de la sala para continuar.' });
    }
    req.projectAccess = { projectId: req.session.projectId, role: membership.role };
    next();
  } catch (_) {
    res.status(503).json({ error: 'No se pudo validar el acceso al proyecto.' });
  }
}

async function requireOwnerApi(req, res, next) {
  await requireEditorApi(req, res, () => {
    if (req.projectAccess.role !== 'owner') return res.status(403).json({ error: 'Solo el streamer puede hacer esta acción.' });
    next();
  });
}

async function requireEditorPage(req, res, next) {
  if (!req.session.user || !req.session.projectId) return res.redirect('/auth/twitch');
  try {
    const membership = await getActiveMembership(req.session.projectId, req.session.user.id);
    if (!membership) return res.redirect('/auth/twitch');
    const project = await getProjectRoomSecurity(req.session.projectId);
    if (!project || !hasVerifiedRoomAccess(req.session, project)) return res.redirect('/room/access');
    req.projectAccess = { projectId: req.session.projectId, role: membership.role };
    next();
  } catch (_) {
    res.status(503).send('No se pudo validar el acceso al proyecto. Volvé a intentarlo.');
  }
}

async function findViewerProject(token) {
  if (!token) return null;
  const stableMatch = String(token).match(/^v1\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{40,})$/i);
  if (stableMatch) {
    const result = await supabaseAdmin.from('projects')
      .select('id, viewer_token_hash, overlay_enabled, subscription_status, trial_ends_at')
      .eq('id', stableMatch[1])
      .maybeSingle();
    const project = databaseError(result, 'No se pudo validar el Viewer.');
    if (!project || !safeEqual(stableMatch[2], persistentViewerToken(project).split('.')[2])) return null;
    if (project.subscription_status === 'suspended' || project.subscription_status === 'canceled') return null;
    if (project.subscription_status === 'trialing' && project.trial_ends_at && new Date(project.trial_ends_at) <= new Date()) return null;
    delete project.viewer_token_hash;
    return project;
  }
  // Compatibilidad con los enlaces temporales emitidos por versiones previas.
  if (token.length < 30) return null;
  const result = await supabaseAdmin.from('projects')
    .select('id, overlay_enabled, subscription_status, trial_ends_at')
    .eq('viewer_token_hash', hashOpaqueToken(token))
    .maybeSingle();
  const project = databaseError(result, 'No se pudo validar el Viewer.');
  if (!project || project.subscription_status === 'suspended' || project.subscription_status === 'canceled') return null;
  if (project.subscription_status === 'trialing' && project.trial_ends_at && new Date(project.trial_ends_at) <= new Date()) return null;
  return project;
}

// Inicia OAuth con Authorization Code Grant. El state evita que un sitio externo
// pueda completar un inicio de sesión iniciado desde otro navegador (CSRF).
app.get('/auth/twitch', (req, res) => {
  if (!twitchIsConfigured()) return twitchConfigurationError(res);

  const state = crypto.randomBytes(32).toString('hex');
  req.session.twitchOAuthState = state;

  const authorizationUrl = new URL('https://id.twitch.tv/oauth2/authorize');
  authorizationUrl.searchParams.set('client_id', TWITCH_CLIENT_ID);
  authorizationUrl.searchParams.set('redirect_uri', TWITCH_REDIRECT_URI);
  authorizationUrl.searchParams.set('response_type', 'code');
  // Sólo usamos Twitch para comprobar la identidad. No solicitamos correo ni
  // permisos de chat, moderación o administración que Tango GG no utiliza.
  authorizationUrl.searchParams.set('state', state);
  // Guardamos explícitamente antes de salir a Twitch. Sin esto, algunos
  // navegadores pueden volver del OAuth antes de que la sesión temporal que
  // contiene `state` haya quedado escrita, provocando un falso error CSRF.
  req.session.save((saveError) => {
    if (saveError) return res.status(500).send('No se pudo preparar el inicio de sesión de Twitch. Volvé a intentarlo.');
    res.redirect(authorizationUrl.toString());
  });
});

app.get('/auth/twitch/callback', async (req, res) => {
  if (!twitchIsConfigured()) return twitchConfigurationError(res);
  const { code, state, error, error_description: errorDescription } = req.query;

  if (error) return res.status(400).send(`Twitch canceló la autorización: ${errorDescription || error}`);
  if (!code || !state || state !== req.session.twitchOAuthState) {
    return res.status(400).send('No se pudo validar el inicio de sesión de Twitch. Volvé a intentarlo.');
  }

  try {
    const tokenResponse = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: TWITCH_CLIENT_ID,
        client_secret: TWITCH_CLIENT_SECRET,
        code: String(code),
        grant_type: 'authorization_code',
        redirect_uri: TWITCH_REDIRECT_URI
      })
    });
    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok || !tokens.access_token) {
      console.error('Twitch token exchange failed:', tokens);
      return res.status(502).send('Twitch no pudo completar la autorización. Volvé a intentarlo.');
    }

    const userResponse = await fetch('https://api.twitch.tv/helix/users', {
      headers: {
        'Client-Id': TWITCH_CLIENT_ID,
        Authorization: `Bearer ${tokens.access_token}`
      }
    });
    const userPayload = await userResponse.json();
    const user = userPayload && userPayload.data && userPayload.data[0];
    if (!userResponse.ok || !user) {
      console.error('Twitch user lookup failed:', userPayload);
      return res.status(502).send('No se pudo obtener la cuenta de Twitch. Volvé a intentarlo.');
    }

    const pendingInviteToken = req.session.pendingInviteToken;
    // La invitación se valida ahora, pero no añade aún a la whitelist. El alta
    // de miembro sucede recién cuando esa misma cuenta supera la contraseña de
    // la sala en /room/access.
    const inviteAccess = pendingInviteToken
      ? await validateProjectInvite(pendingInviteToken, user)
      : null;
    const projectAccess = inviteAccess || await ensureOwnerProject(user);

    req.session.regenerate((sessionError) => {
      if (sessionError) return res.status(500).send('No se pudo crear la sesión. Volvé a intentarlo.');
      req.session.user = {
        id: user.id,
        login: user.login,
        displayName: user.display_name,
        profileImageUrl: user.profile_image_url
      };
      // El token OAuth se usa únicamente arriba para consultar la identidad y
      // luego se descarta. La sesión conserva sólo los datos mínimos del usuario.
      req.session.projectId = projectAccess.project.id;
      req.session.projectRole = projectAccess.role || projectAccess.existingRole || 'pending';
      req.session.pendingInviteToken = pendingInviteToken || null;
      // El token del Viewer solo se conserva una vez en la sesión del dueño.
      // Luego se podrá rotar desde la configuración sin revelar el anterior.
      req.session.newViewerToken = projectAccess.viewerToken || null;
      req.session.save((saveError) => {
        if (saveError) return res.status(500).send('No se pudo guardar la sesión. Volvé a intentarlo.');
        res.redirect('/room/access');
      });
    });
  } catch (error) {
    console.error('Twitch OAuth callback error:', error);
    res.status(500).send('Ocurrió un error al conectar con Twitch. Volvé a intentarlo.');
  }
});

app.get('/api/auth/me', (req, res) => {
  res.json({ authenticated: Boolean(req.session.user), user: req.session.user || null });
});

async function getRoomAccessCandidate(req) {
  if (!req.session.user || !req.session.projectId) return null;
  const project = await getProjectRoomSecurity(req.session.projectId);
  if (!project) return null;
  const membership = await getActiveMembership(project.id, req.session.user.id);
  let pendingInvite = null;
  if (!membership && req.session.pendingInviteToken) {
    pendingInvite = await validateProjectInvite(req.session.pendingInviteToken, req.session.user);
    if (pendingInvite.project.id !== project.id) pendingInvite = null;
  }
  if (!membership && !pendingInvite) return null;
  return { project, membership, pendingInvite };
}

async function requireRoomAccessPage(req, res, next) {
  if (!req.session.user || !req.session.projectId) return res.redirect('/auth/twitch');
  try {
    const access = await getRoomAccessCandidate(req);
    if (!access) return res.redirect('/auth/twitch');
    req.roomAccessCandidate = access;
    next();
  } catch (_) {
    res.status(503).send('No se pudo abrir la sala. Volvé a intentarlo.');
  }
}

app.get('/room/access', requireRoomAccessPage, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room-access.html'));
});

app.get('/api/room/access', async (req, res) => {
  try {
    const access = await getRoomAccessCandidate(req);
    if (!access) return res.status(403).json({ error: 'Necesitás una invitación válida para entrar a esta sala.' });
    const isOwner = access.membership && access.membership.role === 'owner';
    res.json({
      roomCode: String(access.project.id).slice(-8).toUpperCase(),
      channelLogin: access.project.twitch_channel_login,
      user: req.session.user,
      isOwner,
      pendingInvitation: Boolean(access.pendingInvite),
      needsPasswordSetup: !access.project.room_password_hash,
      passwordVerified: hasVerifiedRoomAccess(req.session, access.project)
    });
  } catch (_) {
    res.status(503).json({ error: 'No se pudo cargar la sala.' });
  }
});

app.post('/api/room/password', async (req, res) => {
  try {
    const access = await getRoomAccessCandidate(req);
    if (!access || !access.membership || access.membership.role !== 'owner') {
      return res.status(403).json({ error: 'Solo el streamer propietario puede crear la contraseña.' });
    }
    if (access.project.room_password_hash) return res.status(409).json({ error: 'La sala ya tiene una contraseña configurada.' });
    const password = normalizeRoomPassword(req.body && req.body.password);
    const confirmation = req.body && req.body.confirmation;
    if (!password) return res.status(400).json({ error: `La contraseña debe tener entre ${ROOM_PASSWORD_MIN_LENGTH} y ${ROOM_PASSWORD_MAX_LENGTH} caracteres.` });
    if (password !== confirmation) return res.status(400).json({ error: 'Las contraseñas no coinciden.' });
    const roomPasswordHash = await hashRoomPassword(password);
    const updatedAt = new Date().toISOString();
    const result = await supabaseAdmin.from('projects').update({
      room_password_hash: roomPasswordHash,
      room_password_updated_at: updatedAt,
      updated_at: updatedAt
    }).eq('id', access.project.id).select('id, room_password_updated_at').single();
    const securedProject = databaseError(result, 'No se pudo proteger la sala.');
    req.session.roomAccess = { projectId: access.project.id, passwordUpdatedAt: securedProject.room_password_updated_at || null };
    req.session.projectRole = 'owner';
    await saveSession(req);
    await recordAudit(access.project.id, req.session.user.id, 'room.password_set');
    res.status(201).json({ redirect: '/editor.html' });
  } catch (error) {
    console.error('Room password setup error:', error.message);
    res.status(500).json({ error: 'No se pudo crear la contraseña de la sala.' });
  }
});

app.post('/api/room/unlock', async (req, res) => {
  try {
    const access = await getRoomAccessCandidate(req);
    if (!access) return res.status(403).json({ error: 'Necesitás una invitación válida para entrar a esta sala.' });
    if (!access.project.room_password_hash) {
      return res.status(409).json({ error: 'El streamer todavía no configuró la contraseña de la sala.' });
    }
    const password = normalizeRoomPassword(req.body && req.body.password);
    if (!password || !await verifyRoomPassword(password, access.project.room_password_hash)) {
      return res.status(401).json({ error: 'La contraseña de la sala no es correcta.' });
    }
    let membership = access.membership;
    if (!membership) {
      const accepted = await acceptProjectInvite(req.session.pendingInviteToken, req.session.user);
      membership = { role: accepted.role, active: true };
    }
    req.session.roomAccess = {
      projectId: access.project.id,
      passwordUpdatedAt: access.project.room_password_updated_at || null
    };
    req.session.projectRole = membership.role;
    req.session.pendingInviteToken = null;
    await saveSession(req);
    res.json({ redirect: '/editor.html' });
  } catch (error) {
    const known = /invitación|No se pudo validar la invitación/i.test(error.message || '');
    if (known) return res.status(403).json({ error: error.message });
    console.error('Room unlock error:', error.message);
    res.status(500).json({ error: 'No se pudo validar el acceso a la sala.' });
  }
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('tango.sid');
    res.status(204).end();
  });
});

// El editor siempre requiere una sesión Twitch válida.
app.get('/editor.html', requireEditorPage, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'editor.html'));
});

// El Viewer privado recibe un token impredecible. No existe un Viewer genérico.
app.get('/viewer/:token', async (req, res) => {
  try {
    const project = await findViewerProject(req.params.token);
    if (!project) return res.status(404).send('El enlace del Viewer no es válido o ya no está activo.');
    const viewerHtml = fs.readFileSync(path.join(__dirname, 'public', 'viewer.html'), 'utf8');
    const bootstrap = `<script>window.__TANGO_VIEWER_TOKEN__=${JSON.stringify(req.params.token)};</script>`;
    res.type('html').send(viewerHtml.replace('</head>', `${bootstrap}</head>`));
  } catch (_) {
    res.status(503).send('No se pudo abrir el Viewer. Volvé a intentarlo.');
  }
});

app.get('/viewer.html', (_req, res) => {
  res.status(404).send('Usá el enlace privado del Viewer generado para tu proyecto.');
});

// El resto de archivos visuales sigue siendo estático; ninguna clave sale del servidor.
app.use(express.static(path.join(__dirname, 'public')));

let STATE = emptyScene();
let ACTIVE_PROJECT_ID = null;

app.get('/state', requireEditorApi, async (req, res) => {
  try {
    const state = await loadProjectScene(req.projectAccess.projectId);
    res.json({ serverTime: Date.now(), state });
  } catch (_) {
    res.status(503).json({ error: 'No se pudo cargar la escena.' });
  }
});

app.post('/state', requireEditorApi, async (req, res) => {
  if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'No body' });
  try {
    const projectId = req.projectAccess.projectId;
    const fallback = await loadProjectScene(projectId);
    const state = applyActiveSceneSnapshot(req.body, fallback);
    projectStateCache.set(projectId, state);
    await saveProjectScene(projectId, req.session.user.id);
    broadcastWS({ type: 'snapshot', state }, null, projectId);
    recordAudit(projectId, req.session.user.id, 'scene.saved').catch(() => {});
    res.json({ ok: true, serverTime: state.updatedAt });
  } catch (_) {
    res.status(503).json({ error: 'No se pudo guardar la escena.' });
  }
});

function uploadAsset(upload) {
  return (req, res) => {
    upload.single('file')(req, res, async (error) => {
      if (error) {
        if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'El archivo supera el límite de 25 MB.' });
        }
        return res.status(415).json({ error: error.message || 'No se pudo validar el archivo.' });
      }
      if (!req.file) return res.status(400).json({ error: 'Seleccioná un archivo para subir.' });

      let publicUrl;
      if (useSupabaseStorage) {
        const extension = path.extname(req.file.originalname).toLowerCase();
        const objectPath = `${req.projectAccess.projectId}/${crypto.randomUUID()}${extension}`;
        const { error: storageError } = await supabaseAdmin.storage
          .from(SUPABASE_STORAGE_BUCKET)
          .upload(objectPath, req.file.buffer, {
            cacheControl: '31536000',
            contentType: req.file.mimetype,
            upsert: false
          });
        if (storageError) {
          console.error('No se pudo subir el archivo a Supabase Storage:', storageError.message);
          return res.status(503).json({ error: 'No se pudo guardar el archivo. Volvé a intentarlo.' });
        }
        publicUrl = supabaseAdmin.storage.from(SUPABASE_STORAGE_BUCKET).getPublicUrl(objectPath).data.publicUrl;
      } else {
        publicUrl = `/uploads/${req.file.filename}`;
      }

      // El evento WebSocket asset:*:add deja el registro detallado (imagen o
      // audio) sólo cuando realmente se incorpora a la biblioteca compartida.
      res.json({ url: publicUrl });
    });
  };
}

// Solo alguien con acceso al proyecto puede cargar imágenes y audios para su overlay.
app.post('/upload/image', requireEditorApi, uploadAsset(imageUpload));
app.post('/upload/audio', requireEditorApi, uploadAsset(audioUpload));

app.post('/reset', requireOwnerApi, async (req, res) => {
  try {
    const projectId = req.projectAccess.projectId;
    const state = emptyScene();
    projectStateCache.set(projectId, state);
    await saveProjectScene(projectId, req.session.user.id);
    broadcastWS({ type: 'snapshot', state }, null, projectId);
    recordAudit(projectId, req.session.user.id, 'scene.reset').catch(() => {});
    res.json({ ok: true });
  } catch (_) {
    res.status(503).json({ error: 'No se pudo reiniciar la escena.' });
  }
});

function requestOrigin(req) {
  // Las rutas Express tienen req.get()/req.protocol; las conexiones WebSocket
  // reciben el IncomingMessage nativo de Node. Ambos formatos deben soportarse.
  const header = (name) => typeof req.get === 'function' ? req.get(name) : req.headers?.[name.toLowerCase()];
  const forwardedProtocol = header('x-forwarded-proto');
  const protocol = String(
    forwardedProtocol || req.protocol || (req.socket?.encrypted ? 'https' : 'http')
  ).split(',')[0].trim();
  const host = header('host') || `localhost:${PORT}`;
  return `${protocol}://${host}`;
}

app.get('/api/project', requireEditorApi, async (req, res) => {
  try {
    const result = await supabaseAdmin.from('projects')
      .select('id, twitch_channel_login, chat_enabled, stream_preview_enabled, overlay_enabled, subscription_status, trial_ends_at, viewer_token_hash')
      .eq('id', req.projectAccess.projectId)
      .single();
    const project = databaseError(result, 'No se pudo cargar el proyecto.');
    req.session.newViewerToken = null;
    req.session.save(() => {});
    const { viewer_token_hash, ...projectForClient } = project;
    res.json({
      project: projectForClient,
      role: req.projectAccess.role,
      user: req.session.user,
      testChannelOverrideEnabled: req.projectAccess.role === 'owner' && ALLOW_TEST_CHANNEL_OVERRIDE,
      viewerUrl: req.projectAccess.role === 'owner' ? viewerUrlForProject(req, project) : null
    });
  } catch (_) {
    res.status(503).json({ error: 'No se pudo cargar la configuración del proyecto.' });
  }
});

app.post('/api/project/viewer-token', requireOwnerApi, async (req, res) => {
  try {
    const viewerToken = crypto.randomBytes(32).toString('base64url');
    const result = await supabaseAdmin.from('projects').update({
      viewer_token_hash: hashOpaqueToken(viewerToken),
      viewer_token_created_at: new Date().toISOString()
    }).eq('id', req.projectAccess.projectId).select('id, viewer_token_hash').single();
    const project = databaseError(result, 'No se pudo renovar el Viewer.');
    wss.clients.forEach(client => {
      if (client.role === 'viewer' && client.projectId === req.projectAccess.projectId) client.close(4002, 'El enlace del Viewer fue renovado');
    });
    recordAudit(req.projectAccess.projectId, req.session.user.id, 'viewer.token_rotated').catch(() => {});
    res.json({ viewerUrl: viewerUrlForProject(req, project) });
  } catch (_) {
    res.status(503).json({ error: 'No se pudo renovar el enlace del Viewer.' });
  }
});

app.patch('/api/project/settings', requireOwnerApi, async (req, res) => {
  const changes = {};
  if (typeof req.body.chatEnabled === 'boolean') changes.chat_enabled = req.body.chatEnabled;
  if (typeof req.body.streamPreviewEnabled === 'boolean') changes.stream_preview_enabled = req.body.streamPreviewEnabled;
  if (!Object.keys(changes).length) return res.status(400).json({ error: 'No hay cambios válidos.' });
  try {
    const result = await supabaseAdmin.from('projects').update(changes)
      .eq('id', req.projectAccess.projectId)
      .select('chat_enabled, stream_preview_enabled, overlay_enabled')
      .single();
    const project = databaseError(result, 'No se pudo guardar la configuración.');
    broadcastWS({ type: 'project:settings', payload: project }, null, req.projectAccess.projectId);
    recordAudit(req.projectAccess.projectId, req.session.user.id, 'project.settings_updated').catch(() => {});
    res.json({ project });
  } catch (_) {
    res.status(503).json({ error: 'No se pudo guardar la configuración.' });
  }
});

app.post('/api/project/panic', requireEditorApi, async (req, res) => {
  try {
    const result = await supabaseAdmin.from('projects').update({ overlay_enabled: false })
      .eq('id', req.projectAccess.projectId)
      .select('overlay_enabled')
      .single();
    const project = databaseError(result, 'No se pudo activar el modo pánico.');
    wss.clients.forEach(client => {
      if (client.role === 'viewer' && client.projectId === req.projectAccess.projectId) client.overlayEnabled = false;
    });
    const empty = emptyScene();
    broadcastViewerWS({ type: 'snapshot', state: empty }, req.projectAccess.projectId);
    broadcastWS({ type: 'project:settings', payload: project }, null, req.projectAccess.projectId);
    recordAudit(req.projectAccess.projectId, req.session.user.id, 'overlay.panic_enabled').catch(() => {});
    res.status(204).end();
  } catch (_) {
    res.status(503).json({ error: 'No se pudo activar el modo pánico.' });
  }
});

app.post('/api/project/restore', requireEditorApi, async (req, res) => {
  try {
    const projectId = req.projectAccess.projectId;
    const result = await supabaseAdmin.from('projects').update({ overlay_enabled: true })
      .eq('id', projectId)
      .select('overlay_enabled')
      .single();
    const project = databaseError(result, 'No se pudo restaurar el overlay.');
    wss.clients.forEach(client => {
      if (client.role === 'viewer' && client.projectId === projectId) client.overlayEnabled = true;
    });
    const state = await loadProjectScene(projectId);
    broadcastViewerWS({ type: 'snapshot', state }, projectId);
    broadcastWS({ type: 'project:settings', payload: project }, null, projectId);
    recordAudit(projectId, req.session.user.id, 'overlay.restored').catch(() => {});
    res.status(204).end();
  } catch (_) {
    res.status(503).json({ error: 'No se pudo restaurar el overlay.' });
  }
});

app.get('/api/project/members', requireEditorApi, async (req, res) => {
  try {
    const result = await supabaseAdmin.from('project_members')
      .select('member_twitch_id, role, active, joined_at')
      .eq('project_id', req.projectAccess.projectId)
      .order('created_at', { ascending: true });
    const members = databaseError(result, 'No se pudo cargar los invitados.');
    const ids = members.map(member => member.member_twitch_id);
    const usersResult = ids.length
      ? await supabaseAdmin.from('twitch_users').select('twitch_id, login, display_name').in('twitch_id', ids)
      : { data: [], error: null };
    const users = databaseError(usersResult, 'No se pudo cargar los perfiles.');
    const usersById = new Map(users.map(user => [user.twitch_id, user]));
    res.json({ members: members.map(member => ({ ...member, user: usersById.get(member.member_twitch_id) || null })) });
  } catch (_) {
    res.status(503).json({ error: 'No se pudo cargar los invitados.' });
  }
});

app.get('/api/project/audit', requireEditorApi, async (req, res) => {
  try {
    // Nunca se acepta un projectId desde el navegador: se usa exclusivamente
    // el proyecto que el servidor ya validó para esta sesión.
    const eventsResult = await supabaseAdmin.from('audit_events')
      .select('id, actor_twitch_id, action, entity_type, entity_id, created_at')
      .eq('project_id', req.projectAccess.projectId)
      .order('created_at', { ascending: false })
      .limit(30);
    const events = databaseError(eventsResult, 'No se pudo cargar la actividad.');
    const actorIds = [...new Set(events.map(event => event.actor_twitch_id).filter(Boolean))];
    const usersResult = actorIds.length
      ? await supabaseAdmin.from('twitch_users').select('twitch_id, login, display_name').in('twitch_id', actorIds)
      : { data: [], error: null };
    const users = databaseError(usersResult, 'No se pudieron cargar los perfiles de actividad.');
    const usersById = new Map(users.map(user => [user.twitch_id, user]));
    res.json({
      events: events.map(event => ({
        id: event.id,
        action: event.action,
        entityType: event.entity_type,
        entityId: event.entity_id,
        createdAt: event.created_at,
        actor: event.actor_twitch_id ? usersById.get(event.actor_twitch_id) || { twitch_id: event.actor_twitch_id } : null
      }))
    });
  } catch (_) {
    res.status(503).json({ error: 'No se pudo cargar la actividad del proyecto.' });
  }
});

app.post('/api/project/invites', requireOwnerApi, async (req, res) => {
  try {
    const projectId = req.projectAccess.projectId;
    const countResult = await supabaseAdmin.from('project_members')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('role', 'editor')
      .eq('active', true);
    databaseError(countResult, 'No se pudo comprobar el límite de invitados.');
    if ((countResult.count || 0) >= 2) return res.status(409).json({ error: 'Ya tenés dos invitados activos.' });

    const token = crypto.randomBytes(32).toString('base64url');
    const result = await supabaseAdmin.from('project_invites').insert({
      project_id: projectId,
      token_hash: hashOpaqueToken(token),
      created_by_twitch_id: req.session.user.id,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    });
    databaseError(result, 'No se pudo crear la invitación.');
    recordAudit(projectId, req.session.user.id, 'member.invite_created').catch(() => {});
    res.json({ inviteUrl: `${requestOrigin(req)}/invite/${token}`, expiresInDays: 7 });
  } catch (_) {
    res.status(503).json({ error: 'No se pudo crear la invitación.' });
  }
});

app.delete('/api/project/members/:twitchId', requireOwnerApi, async (req, res) => {
  if (req.params.twitchId === req.session.user.id) return res.status(400).json({ error: 'El streamer no puede quitarse a sí mismo.' });
  try {
    const result = await supabaseAdmin.from('project_members').update({ active: false })
      .eq('project_id', req.projectAccess.projectId)
      .eq('member_twitch_id', req.params.twitchId)
      .eq('role', 'editor');
    databaseError(result, 'No se pudo quitar el invitado.');
    wss.clients.forEach(client => {
      if (client.role === 'editor' && client.projectId === req.projectAccess.projectId && client.twitchId === req.params.twitchId) client.close(4003, 'Acceso revocado');
    });
    recordAudit(req.projectAccess.projectId, req.session.user.id, 'member.removed', 'member', req.params.twitchId).catch(() => {});
    res.status(204).end();
  } catch (_) {
    res.status(503).json({ error: 'No se pudo quitar el invitado.' });
  }
});

app.get('/invite/:token', (req, res) => {
  if (!req.params.token || req.params.token.length < 30) return res.status(404).send('Invitación no válida.');
  req.session.pendingInviteToken = req.params.token;
  req.session.save(() => res.redirect('/auth/twitch'));
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function broadcastWS(obj, except = null, projectId = ACTIVE_PROJECT_ID) {
  // Todas las instantáneas deben incluir el estado recién actualizado de la
  // escena activa. Sin esto, la tarjeta de Escena 1 podía llegar desfasada.
  if (obj && obj.type === 'snapshot' && obj.state) syncActiveSceneToDeck(obj.state);
  const raw = JSON.stringify(obj);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client !== except && client.projectId === projectId && (client.role !== 'viewer' || client.overlayEnabled)) {
      client.send(raw);
    }
  });
}

function broadcastViewerWS(obj, projectId) {
  const raw = JSON.stringify(obj);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.role === 'viewer' && client.projectId === projectId) client.send(raw);
  });
}

function isAllowedWebSocketOrigin(req) {
  // Los navegadores normales siempre informan Origin. Se acepta su ausencia
  // para no romper la fuente de navegador de OBS, que puede omitirlo.
  const origin = req.headers.origin;
  return !origin || origin === requestOrigin(req);
}

// WS protocol: el servidor valida identidad/rol antes de entregar una escena.
wss.on('connection', (ws, req) => {
  if (!isAllowedWebSocketOrigin(req)) return ws.close(1008, 'Origen no permitido');
  // express-session puede tardar unos milisegundos en leer la sesión. El
  // navegador, en cambio, envía "hello" apenas abre el socket. Conservamos
  // esos primeros mensajes para no perder la presentación del editor.
  const earlyMessages = [];
  const queueEarlyMessage = (message) => earlyMessages.push(message);
  ws.on('message', queueEarlyMessage);
  sessionMiddleware(req, {}, (sessionError) => {
    if (sessionError) {
      ws.off('message', queueEarlyMessage);
      return ws.close(1011, 'No se pudo validar la sesión');
    }
    ws.isAlive = true;
    ws.role = 'unknown';
    ws.projectId = null;
    ws.isReady = false;
    ws.readyPromise = null;

    ws.on('pong', () => ws.isAlive = true);

    ws.off('message', queueEarlyMessage);
    const handleIncomingMessage = async (msg) => {
    let data;
    try { data = JSON.parse(msg); } catch (e) { return; }

    // Un editor autenticado puede llegar a enviar una acción antes del mensaje
    // de presentación por una carrera del navegador. Conservamos esa acción,
    // completamos primero la autenticación con la sesión HTTP ya validada y
    // luego la procesamos normalmente.
    let deferredMessage = null;
    if (data.type !== 'hello' && !ws.readyPromise) {
      deferredMessage = data;
      data = { type: 'hello', role: 'editor' };
    }

    if (data.type === 'hello') {
      if (ws.readyPromise) {
        try { await ws.readyPromise; } catch (_) {}
        return;
      }
      // La validación de membresía consulta Supabase y es asíncrona. Mientras
      // termina, el navegador puede enviar el primer trazo: lo hacemos esperar
      // a esta misma promesa en vez de cerrarlo erróneamente como no autorizado.
      ws.readyPromise = (async () => {
        try {
        if (data.role === 'editor') {
          if (!req.session.user || !req.session.projectId) return ws.close(1008, 'Iniciá sesión con Twitch');
          const membership = await getActiveMembership(req.session.projectId, req.session.user.id);
          if (!membership) return ws.close(1008, 'No tenés acceso a este proyecto');
          const roomSecurity = await getProjectRoomSecurity(req.session.projectId);
          if (!roomSecurity || !hasVerifiedRoomAccess(req.session, roomSecurity)) {
            return ws.close(1008, 'Contraseña de sala requerida');
          }
          ws.role = 'editor';
          ws.twitchId = req.session.user.id;
          ws.projectId = req.session.projectId;
          ws.projectRole = membership.role;
        } else if (data.role === 'viewer') {
          const viewerToken = new URL(req.url, 'http://localhost').searchParams.get('viewer_token');
          const project = await findViewerProject(viewerToken);
          if (!project) return ws.close(1008, 'Viewer no válido');
          ws.role = 'viewer';
          ws.projectId = project.id;
          ws.viewerSessionId = crypto.randomUUID();
          wss.clients.forEach(client => {
            if (client !== ws && client.role === 'viewer' && client.projectId === project.id) client.close(4001, 'El Viewer se abrió en otra fuente');
          });
          await supabaseAdmin.from('project_viewer_sessions').upsert({
            project_id: project.id,
            session_id: ws.viewerSessionId,
            last_seen_at: new Date().toISOString()
          });
          ws.overlayEnabled = project.overlay_enabled;
        } else {
          return ws.close(1008, 'Rol inválido');
        }

        const state = await loadProjectScene(ws.projectId);
        ws.state = state;
        ws.isReady = true;
        if (ws.role === 'editor') {
          ws.send(JSON.stringify({
            type: 'room:connected',
            payload: { roomCode: String(ws.projectId).slice(-8).toUpperCase(), role: ws.projectRole }
          }));
        }
        ws.send(JSON.stringify({ type: 'snapshot', state: ws.role === 'viewer' && !ws.overlayEnabled ? emptyScene() : state }));
      } catch (error) {
        console.error('WebSocket hello error:', error.message);
        ws.close(1011, 'No se pudo abrir el proyecto');
        throw error;
      }
      })();
      try { await ws.readyPromise; } catch (_) {}
      if (!deferredMessage) return;
      data = deferredMessage;
    }

    if (ws.readyPromise && !ws.isReady) {
      try { await ws.readyPromise; } catch (_) { return; }
    }
    if (ws.role !== 'editor' || !ws.projectId || !ws.state || !ws.isReady) return ws.close(1008, 'No autorizado');
    ACTIVE_PROJECT_ID = ws.projectId;
    // La escena compartida del proyecto es la única fuente de verdad. No usamos
    // una copia vieja de otro socket, porque un editor podría sobrescribir
    // cambios recientes hechos por un moderador distinto.
    STATE = projectStateCache.get(ws.projectId) || ws.state;

    switch (data.type) {
      case 'scene:activate': {
        const sceneId = data.payload && String(data.payload.sceneId || '');
        if (!STATE.sceneDeck || !STATE.sceneDeck.scenes.some(scene => scene.id === sceneId)) break;
        STATE = activateScene(STATE, sceneId);
        broadcastWS({ type: 'snapshot', state: STATE }, null);
        recordAudit(ws.projectId, ws.twitchId, 'scene.activated', 'scene', sceneId).catch(() => {});
        break;
      }

      // stroke events
      case 'stroke:start':
        if (data.payload) {
          STATE.strokes.push(data.payload);
          STATE.updatedAt = Date.now();
        }
        // El autor ya añadió este punto a su canvas local. Reenviarlo de vuelta
        // con retraso desordena el trazo predicho localmente; sólo lo necesitan
        // los demás editores y el Viewer.
        broadcastWS(data, ws);
        break;
      case 'stroke:point':
        if (data.payload && data.payload.id && data.payload.point) {
          const s = STATE.strokes.find(x => x.id === data.payload.id);
          if (s) s.points.push(data.payload.point);
          STATE.updatedAt = Date.now();
        }
        broadcastWS(data, ws);
        break;
      case 'stroke:end':
        STATE.updatedAt = Date.now();
        // Los puntos se transmiten en vivo mientras se dibuja. Al soltar el
        // pincel enviamos además la escena autoritativa completa para que dos
        // editores nunca terminen mostrando versiones distintas del trazo.
        broadcastWS({ type: 'snapshot', state: STATE }, null);
        break;

      // image/canvas events
      case 'image:add':
        if (data.payload) {
          STATE.images.push(data.payload);
          STATE.updatedAt = Date.now();
        }
        // Una imagen afecta tanto al editor como al Viewer. Enviar el estado
        // completo evita que un editor que estaba conectándose quede con una
        // biblioteca/canvas parcial por haber perdido un evento incremental.
        broadcastWS({ type: 'snapshot', state: STATE }, null);
        break;
      case 'image:update':
        if (data.payload && data.payload.id) {
          const idx = STATE.images.findIndex(x => x.id === data.payload.id);
          if (idx >= 0) {
            STATE.images[idx] = Object.assign({}, STATE.images[idx], data.payload);
            STATE.updatedAt = Date.now();
          }
        }
        // Durante el arrastre se reciben muchas actualizaciones. Reenviamos
        // sólo la imagen modificada a los demás clientes: el autor ya la
        // actualizó localmente y una escena completa por píxel genera lag.
        broadcastWS({ type: 'image:update', payload: data.payload }, ws);
        break;
      case 'image:remove':
        if (data.payload && data.payload.id) {
          STATE.images = STATE.images.filter(x => x.id !== data.payload.id);
          STATE.updatedAt = Date.now();
        }
        broadcastWS({ type: 'snapshot', state: STATE }, null);
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
          syncActiveSceneToDeck(STATE);
          STATE.assets.images = STATE.assets.images.filter(x => x.id !== data.payload.id);
          // La biblioteca es común a las tres escenas: al borrar un archivo,
          // se lo retira de cada composición para que no reaparezca al cambiar.
          STATE.sceneDeck.scenes.forEach(scene => {
            scene.state.images = (scene.state.images || []).filter(x => x.url !== data.payload.url);
          });
          STATE = materializeScene(STATE.sceneDeck, STATE.assets);
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
          syncActiveSceneToDeck(STATE);
          STATE.assets.audio = STATE.assets.audio.filter(x => x.id !== data.payload.id);
          // El archivo sólo existe en la biblioteca de la escena actual, por
          // eso sus asignaciones no deben modificar ninguna otra escena.
          STATE.audio.playlist = (STATE.audio.playlist || []).filter(x => x.id !== data.payload.id);
          Object.keys(STATE.audio.slots || {}).forEach(slot => {
            if (STATE.audio.slots[slot] && STATE.audio.slots[slot].id === data.payload.id) delete STATE.audio.slots[slot];
          });
          if (STATE.audio.current && STATE.audio.current.url === data.payload.url) STATE.audio.current = null;
          syncActiveSceneToDeck(STATE);
          STATE = materializeScene(STATE.sceneDeck, STATE.assets);
          STATE.updatedAt = Date.now();
        }
        broadcastWS({ type: 'snapshot', state: STATE }, null);
        break;

      // viewport
      case 'viewport:update':
        // El encuadre es una preferencia visual local. Nunca debe cambiar la
        // vista de los demás editores ni formar parte de la escena compartida.
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
          STATE = applyActiveSceneSnapshot(data.payload, STATE);
        }
        broadcastWS({ type: 'snapshot', state: STATE }, null);
        break;

      default:
        broadcastWS(data, null);
    }
    syncActiveSceneToDeck(STATE);
    projectStateCache.set(ws.projectId, STATE);
    // Todos los sockets del mismo proyecto comparten la misma referencia en
    // memoria: el próximo cambio siempre parte del estado más reciente.
    wss.clients.forEach(client => {
      if (client.projectId === ws.projectId) client.state = STATE;
    });
    scheduleSceneSave(ws.projectId, ws.twitchId);

    const auditable = new Set([
      'stroke:end',
      'image:add', 'image:update', 'image:remove',
      'asset:image:add', 'asset:image:delete',
      'asset:audio:add', 'asset:audio:delete',
      'text:add', 'text:update', 'text:remove',
      'timer:add', 'timer:update', 'timer:remove',
      'audio:trigger', 'audio:stop', 'audio:pause', 'audio:resume'
    ]);
    if (auditable.has(data.type)) {
      const action = data.type.replace(':', '.');
      const entityId = data.payload && data.payload.id ? String(data.payload.id) : null;
      if (data.type.endsWith(':update')) scheduleAuditUpdate(ws.projectId, ws.twitchId, action, entityId);
      else recordAudit(ws.projectId, ws.twitchId, action, null, entityId).catch(() => {});
    }
    };

    ws.on('message', handleIncomingMessage);
    // Los mensajes llegaron antes de que la sesión terminara de cargarse.
    // Se procesan en el mismo orden en que los envió el navegador.
    earlyMessages.forEach(message => { void handleIncomingMessage(message); });

    ws.on('error', (error) => {
      console.error(`WebSocket error en sala ${ws.projectId || 'desconocida'}:`, error.message);
    });

    ws.on('close', (code, reason) => {
      const closeReason = reason && reason.length ? reason.toString() : 'sin motivo';
      console.warn(`WebSocket cerrado: sala=${ws.projectId || 'desconocida'} usuario=${ws.twitchId || 'anónimo'} código=${code} motivo=${closeReason}`);
      if (ws.role === 'viewer' && ws.projectId && ws.viewerSessionId) {
        supabaseAdmin.from('project_viewer_sessions')
          .delete()
          .eq('project_id', ws.projectId)
          .eq('session_id', ws.viewerSessionId)
          .then(() => {})
          .catch(() => {});
      }
    });
  });
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
  console.log(`Tango GG server listening on http://localhost:${PORT}`);
  console.log('Editor: http://localhost:' + PORT + '/editor.html (requiere Twitch)');
  console.log('Viewer: se genera como enlace privado desde Configuración.');
});

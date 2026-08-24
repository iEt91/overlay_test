const title = document.getElementById('accessTitle');
const description = document.getElementById('accessDescription');
const form = document.getElementById('roomForm');
const password = document.getElementById('roomPassword');
const confirmation = document.getElementById('roomPasswordConfirmation');
const confirmationWrap = document.getElementById('confirmationWrap');
const submitButton = document.getElementById('submitButton');
const formError = document.getElementById('formError');
const roomBadge = document.getElementById('roomBadge');
const roomCode = document.getElementById('roomCode');
let setupMode = false;

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'No se pudo completar el acceso.');
  return data;
}

function showError(message) {
  formError.hidden = !message;
  formError.textContent = message || '';
}

async function loadAccess() {
  try {
    const data = await api('/api/room/access');
    roomCode.textContent = `#${data.roomCode}`;
    roomBadge.hidden = false;
    setupMode = Boolean(data.needsPasswordSetup);
    if (data.passwordVerified) return location.assign('/editor.html');
    if (setupMode) {
      title.textContent = 'Protegé tu sala';
      description.textContent = 'Elegí una contraseña. La necesitarán también los moderadores que aceptes con una invitación.';
      confirmationWrap.hidden = false;
      password.autocomplete = 'new-password';
      submitButton.innerHTML = 'Crear sala privada <span aria-hidden="true">→</span>';
    } else {
      title.textContent = 'Ingresá a la sala';
      description.textContent = data.pendingInvitation
        ? 'Tu invitación de Twitch fue validada. Ingresá la contraseña para sumarte a la whitelist de esta sala.'
        : 'Ingresá la contraseña para abrir el Telestrator.';
      submitButton.innerHTML = 'Abrir Telestrator <span aria-hidden="true">→</span>';
    }
    form.hidden = false;
    password.focus();
  } catch (error) {
    title.textContent = 'No pudimos abrir la sala';
    description.textContent = error.message;
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  showError('');
  submitButton.disabled = true;
  try {
    const body = { password: password.value };
    let result;
    if (setupMode) {
      body.confirmation = confirmation.value;
      result = await api('/api/room/password', { method: 'POST', body: JSON.stringify(body) });
    } else {
      result = await api('/api/room/unlock', { method: 'POST', body: JSON.stringify(body) });
    }
    password.value = '';
    confirmation.value = '';
    location.assign(result.redirect || '/editor.html');
  } catch (error) {
    showError(error.message);
    submitButton.disabled = false;
  }
});

loadAccess();

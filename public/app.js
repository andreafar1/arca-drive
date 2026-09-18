const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let token = localStorage.getItem('arca_token');
let refreshToken = localStorage.getItem('arca_refresh_token');
let user = null;
let view = 'files';
let currentFolder = null;
let folderHistory = [];
let searchTimer;
let draggedEntry = null;
let uploadInProgress = false;

async function api(url, options = {}, retry = true) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401 && refreshToken && retry && url !== '/api/auth/refresh') {
    const refreshed = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken })
    });
    if (refreshed.ok) {
      const session = await refreshed.json();
      token = session.accessToken;
      refreshToken = session.refreshToken;
      localStorage.setItem('arca_token', token);
      localStorage.setItem('arca_refresh_token', refreshToken);
      return api(url, options, false);
    }
    logout(false);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Operazione non riuscita');
  }
  if (response.status === 204) return null;
  return response.json();
}

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('show');
  setTimeout(() => $('#toast').classList.remove('show'), 2600);
}

function formatSize(bytes) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

async function loadStorage() {
  try {
    const storage = await api('/api/storage');
    $('#diskPercent').textContent = `${storage.diskUsedPercent}%`;
    $('#diskBar').style.width = `${Math.min(storage.diskUsedPercent, 100)}%`;
    $('#arcaUsage').textContent = formatSize(storage.filesBytes);
    $('#diskFree').textContent = formatSize(storage.freeBytes);
    $('#fileCount').textContent = storage.fileCount;
  } catch {
    $('#diskPercent').textContent = '—';
  }
}

function formatDate(value) {
  return new Intl.DateTimeFormat('it-IT', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

async function init() {
  const status = await api('/api/setup/status');
  if (!status.configured) {
    $('#authIntro').textContent = 'Crea il primo account amministratore.';
    $('#nameField').classList.remove('hidden');
    $('#authSubmit').textContent = 'Configura Arca Drive';
    $('#authForm').dataset.mode = 'setup';
    return;
  }
  if (token) {
    try {
      user = await api('/api/me');
      showApp();
      return;
    } catch {}
  }
  $('#authForm').dataset.mode = 'login';
}

$('#authForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('#authError').textContent = '';
  try {
    const setup = event.currentTarget.dataset.mode === 'setup';
    const result = await api(setup ? '/api/setup' : '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        name: $('#name').value,
        email: $('#email').value,
        password: $('#password').value,
        deviceName: `Browser su ${navigator.userAgentData?.platform || navigator.platform || 'dispositivo'}`,
        platform: 'web'
      })
    });
    token = result.token;
    refreshToken = result.refreshToken;
    user = result.user;
    localStorage.setItem('arca_token', token);
    localStorage.setItem('arca_refresh_token', refreshToken);
    showApp();
  } catch (error) {
    $('#authError').textContent = error.message;
  }
});

function showApp() {
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#userName').textContent = user.name;
  $('#userRole').textContent = user.role;
  $('#initials').textContent = user.name.split(/\s+/).map(x => x[0]).join('').slice(0, 2).toUpperCase();
  $$('.admin-only').forEach(element => element.classList.toggle('hidden', user.role !== 'admin'));
  $('.upload').classList.toggle('hidden', user.role === 'viewer');
  $('.upload-top').classList.toggle('hidden', user.role === 'viewer');
  $('#newFolder').classList.toggle('hidden', user.role === 'viewer');
  updateFolderLocation();
  loadStorage();
  loadEntries();
}

function logout(notifyServer = true) {
  if (notifyServer && token) {
    fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  }
  localStorage.removeItem('arca_token');
  localStorage.removeItem('arca_refresh_token');
  location.reload();
}

async function loadEntries() {
  if (view === 'people') return loadUsers();
  const query = new URLSearchParams();
  if (view === 'trash') query.set('trash', 'true');
  if (view === 'images') query.set('images', 'true');
  if (currentFolder && view !== 'trash') query.set('parentId', currentFolder.id);
  const q = $('#search').value.trim();
  if (q) query.set('q', q);
  try {
    const entries = await api(`/api/entries?${query}`);
    $('#rows').innerHTML = entries.map(entry => `
      <div class="file-row" data-id="${entry.id}">
        <div class="file-name"><i class="${entry.kind === 'file' ? (entry.mime_type?.includes('pdf') ? 'pdf' : entry.mime_type?.startsWith('image/') ? 'image' : '') : ''}">${entry.kind === 'folder' ? '▰' : entry.mime_type?.includes('pdf') ? 'PDF' : 'DOC'}</i><strong></strong></div>
        <span></span><span>${formatDate(entry.updated_at)}</span><span>${formatSize(Number(entry.size_bytes))}</span>
        <button aria-label="Azioni">•••</button>
      </div>`).join('');
    entries.forEach((entry, index) => {
      const row = $$('#rows .file-row')[index];
      row.draggable = user.role !== 'viewer';
      row.querySelector('.file-name strong').textContent = entry.name;
      row.children[1].textContent = entry.owner_name;
      row.addEventListener('dragstart', event => {
        draggedEntry = entry;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', entry.id);
        row.classList.add('dragging');
        if (currentFolder) $('#rootDrop').classList.remove('hidden');
      });
      row.addEventListener('dragend', () => {
        draggedEntry = null;
        row.classList.remove('dragging');
        $('#rootDrop').classList.add('hidden');
        $$('.drop-target').forEach(element => element.classList.remove('drop-target'));
      });
      if (entry.kind === 'folder') {
        row.addEventListener('dragover', event => {
          if (!draggedEntry || draggedEntry.id === entry.id) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          row.classList.add('drop-target');
        });
        row.addEventListener('dragleave', event => {
          if (!row.contains(event.relatedTarget)) row.classList.remove('drop-target');
        });
        row.addEventListener('drop', async event => {
          event.preventDefault();
          row.classList.remove('drop-target');
          if (!draggedEntry || draggedEntry.id === entry.id) return;
          await moveEntry(draggedEntry, entry.id);
        });
      }
      row.addEventListener('click', event => {
        if (event.target.tagName === 'BUTTON' || view === 'trash') return entryAction(entry);
        if (entry.kind === 'folder') {
          folderHistory.push(currentFolder);
          currentFolder = entry;
          updateFolderLocation();
          loadEntries();
        } else {
          preview(entry);
        }
      });
    });
    $('#empty').style.display = entries.length ? 'none' : 'block';
  } catch (error) {
    toast(error.message);
  }
}

function updateFolderLocation() {
  const insideFolder = Boolean(currentFolder);
  $('#folderBack').classList.toggle('hidden', !insideFolder);
  $('#title').textContent = insideFolder ? currentFolder.name : 'I miei file';
  renderBreadcrumb();
}

function renderBreadcrumb() {
  const breadcrumb = $('#breadcrumb');
  breadcrumb.replaceChildren();
  if (view !== 'files') {
    const label = document.createElement('span');
    label.textContent = view === 'images' ? 'Raccolte' : 'Spazio aziendale';
    breadcrumb.append(label);
    return;
  }

  const folders = folderHistory.filter(Boolean);
  const levels = [{ name: 'I miei file', folder: null }, ...folders.map(folder => ({ name: folder.name, folder }))];
  if (currentFolder) levels.push({ name: currentFolder.name, folder: currentFolder });

  levels.forEach((level, index) => {
    const isCurrent = index === levels.length - 1;
    const item = document.createElement(isCurrent ? 'span' : 'button');
    item.textContent = level.name;
    if (!isCurrent) {
      item.type = 'button';
      item.addEventListener('click', () => {
        if (level.folder === null) {
          currentFolder = null;
          folderHistory = [];
        } else {
          const targetIndex = folders.findIndex(folder => folder.id === level.folder.id);
          currentFolder = level.folder;
          folderHistory = [null, ...folders.slice(0, targetIndex)];
        }
        updateFolderLocation();
        loadEntries();
      });
    }
    breadcrumb.append(item);
    if (!isCurrent) {
      const separator = document.createElement('span');
      separator.className = 'breadcrumb-separator';
      separator.textContent = '/';
      breadcrumb.append(separator);
    }
  });
}

$('#folderBack').addEventListener('click', () => {
  currentFolder = folderHistory.pop() || null;
  updateFolderLocation();
  loadEntries();
});

async function moveEntry(entry, parentId) {
  try {
    await api(`/api/entries/${entry.id}/move`, {
      method: 'PATCH',
      body: JSON.stringify({ parentId })
    });
    toast(`“${entry.name}” spostato`);
    draggedEntry = null;
    $('#rootDrop').classList.add('hidden');
    loadEntries();
  } catch (error) {
    toast(error.message);
  }
}

async function preview(entry) {
  $('#previewName').textContent = entry.name;
  const url = `/api/entries/${entry.id}/content`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) return toast('Impossibile aprire il file');
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  $('#download').href = objectUrl;
  $('#download').download = entry.name;
  if (entry.mime_type === 'application/pdf') {
    $('#viewer').innerHTML = `<iframe title="Anteprima PDF"></iframe>`;
    $('#viewer iframe').src = objectUrl;
  } else if (entry.mime_type?.startsWith('image/')) {
    $('#viewer').innerHTML = '<img alt="Anteprima">';
    $('#viewer img').src = objectUrl;
  } else {
    $('#viewer').innerHTML = '<div class="generic"><strong>Anteprima non disponibile</strong><i></i><i></i><i></i><p>Puoi scaricare il documento.</p></div>';
  }
  $('#preview').classList.add('open');
}

function openModal(tag, title, body, submit) {
  $('#modalTag').textContent = tag;
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = body;
  $('#confirm').classList.remove('hidden');
  $('#confirm').textContent = 'Conferma';
  $('#modalForm').onsubmit = async event => {
    event.preventDefault();
    try {
      await submit();
      closeModal();
    } catch (error) {
      toast(error.message);
    }
  };
  $('#modal').classList.add('open');
}

function closeModal() {
  $('#modal').classList.remove('open');
}

function entryAction(entry) {
  if (view === 'trash') {
    openModal('RIPRISTINO', 'Ripristina elemento', `<p>Ripristinare <strong></strong>?</p>`, async () => {
      await api(`/api/entries/${entry.id}/restore`, { method: 'POST' });
      toast('Elemento ripristinato');
      loadStorage();
      loadEntries();
    });
    $('#modalBody strong').textContent = entry.name;
    return;
  }
  openModal('AZIONI', entry.name, `
    <div class="action-list">
      <button type="button" id="chooseMove"><span>↪</span><div><strong>Sposta in un’altra cartella</strong><small>Scegli una nuova posizione</small></div></button>
      <button type="button" id="chooseTrash" class="danger"><span>♲</span><div><strong>Sposta nel cestino</strong><small>Potrai ripristinarlo in seguito</small></div></button>
    </div>`, async () => {});
  $('#confirm').classList.add('hidden');
  $('#chooseMove').onclick = () => chooseDestination(entry);
  $('#chooseTrash').onclick = () => confirmTrash(entry);
}

async function chooseDestination(entry) {
  try {
    const folders = await api('/api/folders');
    openModal('SPOSTA', 'Scegli la destinazione', '<label class="field">Cartella<select id="destination"><option value="">I miei file</option></select></label>', async () => {
      const parentId = $('#destination').value || null;
      await moveEntry(entry, parentId);
    });
    const select = $('#destination');
    folders.filter(folder => folder.id !== entry.id).forEach(folder => {
      const option = document.createElement('option');
      option.value = folder.id;
      option.textContent = folder.name;
      if (folder.id === entry.parent_id) option.disabled = true;
      select.append(option);
    });
  } catch (error) {
    toast(error.message);
  }
}

function confirmTrash(entry) {
  openModal('CESTINO', 'Sposta nel cestino', '<p>Spostare <strong></strong> nel cestino?</p>', async () => {
    await api(`/api/entries/${entry.id}`, { method: 'DELETE' });
    toast('Elemento spostato nel cestino');
    loadStorage();
    loadEntries();
  });
  $('#modalBody strong').textContent = entry.name;
}

$('#newFolder').addEventListener('click', () => openModal('NUOVA CARTELLA', 'Crea una cartella', '<label class="field">Nome<input id="folderName" required maxlength="255"></label>', async () => {
  await api('/api/folders', {
    method: 'POST',
    body: JSON.stringify({ name: $('#folderName').value, parentId: currentFolder?.id || null })
  });
  toast('Cartella creata');
  loadEntries();
}));

function setUploadProgress(percent, detail = '') {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  $('#uploadProgressPercent').textContent = `${value}%`;
  $('#uploadProgressDetail').textContent = detail;
  $('#uploadProgressBar').style.width = `${value}%`;
  $('.upload-progress-track').setAttribute('aria-valuenow', value);
}

function sendFiles(form, files, retry = true) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/files');
    request.setRequestHeader('Authorization', `Bearer ${token}`);
    request.responseType = 'json';
    request.upload.addEventListener('progress', event => {
      if (!event.lengthComputable) return;
      const sent = formatSize(event.loaded);
      const total = formatSize(event.total);
      setUploadProgress((event.loaded / event.total) * 100, `${files.length} file · ${sent} di ${total}`);
    });
    request.addEventListener('load', async () => {
      if (request.status >= 200 && request.status < 300) return resolve(request.response);
      if (request.status === 401 && refreshToken && retry) {
        try {
          await api('/api/me');
          return resolve(await sendFiles(form, files, false));
        } catch {}
      }
      reject(new Error(request.response?.error || 'Caricamento non riuscito'));
    });
    request.addEventListener('error', () => reject(new Error('Connessione interrotta durante il caricamento')));
    request.addEventListener('abort', () => reject(new Error('Caricamento annullato')));
    request.send(form);
  });
}

$('#upload').addEventListener('change', async event => {
  const files = [...event.target.files];
  if (!files.length || uploadInProgress) return;
  const form = new FormData();
  files.forEach(file => form.append('files', file));
  if (currentFolder) form.append('parentId', currentFolder.id);
  uploadInProgress = true;
  event.target.disabled = true;
  $('#uploadProgress').classList.remove('hidden');
  $('#uploadProgressTitle').textContent = files.length === 1 ? files[0].name : `Caricamento di ${files.length} file`;
  setUploadProgress(0, 'Preparazione…');
  try {
    await sendFiles(form, files);
    setUploadProgress(100, 'Completato');
    toast('Caricamento completato');
    loadStorage();
    loadEntries();
  } catch (error) {
    toast(error.message);
  } finally {
    uploadInProgress = false;
    event.target.disabled = false;
    setTimeout(() => $('#uploadProgress').classList.add('hidden'), 900);
  }
  event.target.value = '';
});

async function loadUsers() {
  try {
    const users = await api('/api/users');
    $('#users').innerHTML = users.map(item => `<div class="user-row"><strong></strong><span>${item.role}</span><small>${formatDate(item.created_at)}</small></div>`).join('');
    users.forEach((item, index) => $$('#users .user-row strong')[index].textContent = `${item.name} · ${item.email}`);
  } catch (error) {
    toast(error.message);
  }
}

$('#newUser').addEventListener('click', () => openModal('NUOVO UTENTE', 'Crea un account', `
  <label class="field">Nome<input id="newName" required></label>
  <label class="field">Email<input id="newEmail" type="email" required></label>
  <label class="field">Password iniziale<input id="newPassword" type="password" minlength="10" required></label>
  <label class="field">Ruolo<select id="newRole"><option value="member">Collaboratore</option><option value="viewer">Visualizzatore</option><option value="admin">Amministratore</option></select></label>`, async () => {
  await api('/api/users', { method: 'POST', body: JSON.stringify({ name: $('#newName').value, email: $('#newEmail').value, password: $('#newPassword').value, role: $('#newRole').value }) });
  toast('Utente creato');
  loadUsers();
}));

$$('.nav').forEach(button => button.addEventListener('click', () => {
  view = button.dataset.view;
  currentFolder = null;
  folderHistory = [];
  $$('.nav').forEach(item => item.classList.toggle('active', item === button));
  $('#people').classList.toggle('hidden', view !== 'people');
  $('#drive').classList.toggle('hidden', view === 'people');
  $('#newFolder').classList.toggle('hidden', view !== 'files');
  $('#title').textContent = view === 'files' ? 'I miei file' : view === 'images' ? 'Immagini' : view === 'trash' ? 'Cestino' : 'Persone';
  $('#empty').textContent = view === 'images' ? 'Non ci sono ancora immagini.' : view === 'trash' ? 'Il cestino è vuoto.' : 'Questa cartella è vuota.';
  renderBreadcrumb();
  $('#folderBack').classList.add('hidden');
  $('#sidebar').classList.remove('open');
  loadEntries();
}));

$('#search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadEntries, 250);
});
$('#rootDrop').addEventListener('dragover', event => {
  if (!draggedEntry) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  $('#rootDrop').classList.add('drop-target');
});
$('#rootDrop').addEventListener('dragleave', () => $('#rootDrop').classList.remove('drop-target'));
$('#rootDrop').addEventListener('drop', async event => {
  event.preventDefault();
  $('#rootDrop').classList.remove('drop-target');
  if (draggedEntry) await moveEntry(draggedEntry, null);
});
$('#menu').onclick = () => $('#sidebar').classList.toggle('open');
$('#logout').onclick = logout;
$('#closePreview').onclick = () => $('#preview').classList.remove('open');
$('#closeModal').onclick = $('#cancel').onclick = closeModal;
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    closeModal();
    $('#preview').classList.remove('open');
  }
});

init().catch(error => {
  $('#authError').textContent = error.message;
});

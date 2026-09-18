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
let visibleEntries = [];
let previewEntryIndex = -1;
let previewObjectUrl = null;
let previewTouchStartX = null;
let previewRenderId = 0;
const selectedEntries = new Map();
let pdfjsPromise = null;

function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('/vendor/pdfjs/pdf.min.mjs').then(pdfjs => {
      pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

function hasDraggedFiles(event) {
  return [...(event.dataTransfer?.types || [])].includes('Files');
}

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
    visibleEntries = entries;
    selectedEntries.clear();
    $('#selectAll').disabled = user.role === 'viewer' || view === 'trash';
    updateSelectionToolbar();
    $('#rows').innerHTML = entries.map(entry => `
      <div class="file-row" data-id="${entry.id}">
        <span><input class="entry-select" type="checkbox" aria-label="Seleziona elemento"></span>
        <div class="file-name"><i class="${entry.kind === 'file' ? (entry.mime_type?.includes('pdf') ? 'pdf' : entry.mime_type?.startsWith('image/') ? 'image' : '') : ''}">${entry.kind === 'folder' ? '▰' : entry.mime_type?.includes('pdf') ? 'PDF' : entry.mime_type?.startsWith('image/') ? 'IMG' : 'DOC'}</i><strong></strong></div>
        <span class="entry-owner"></span><span>${formatDate(entry.updated_at)}</span><span>${formatSize(Number(entry.size_bytes))}</span>
        <button class="entry-actions" aria-label="Azioni">•••</button>
      </div>`).join('');
    entries.forEach((entry, index) => {
      const row = $$('#rows .file-row')[index];
      row.draggable = user.role !== 'viewer' && !entry.is_system;
      row.querySelector('.file-name strong').textContent = entry.name;
      row.querySelector('.entry-owner').textContent = entry.owner_name;
      const checkbox = row.querySelector('.entry-select');
      checkbox.disabled = user.role === 'viewer' || view === 'trash' || entry.is_system;
      checkbox.addEventListener('click', event => event.stopPropagation());
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedEntries.set(entry.id, entry);
        else selectedEntries.delete(entry.id);
        row.classList.toggle('selected', checkbox.checked);
        updateSelectionToolbar();
      });
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
          if (hasDraggedFiles(event)) {
            if (user.role === 'viewer') return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            row.classList.add('drop-target');
            return;
          }
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
          event.stopPropagation();
          row.classList.remove('drop-target');
          const files = [...event.dataTransfer.files];
          if (files.length) {
            if (user.role !== 'viewer') await uploadFiles(files, entry.id);
            return;
          }
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

function updateSelectionToolbar() {
  const count = selectedEntries.size;
  const selectableCount = visibleEntries.filter(entry => !entry.is_system).length;
  $('#selectAll').disabled = user.role === 'viewer' || view === 'trash' || selectableCount === 0;
  $('#selectedCount').textContent = count;
  $('#bulkActions').classList.toggle('hidden', count === 0);
  $('#selectAll').checked = selectableCount > 0 && count === selectableCount;
  $('#selectAll').indeterminate = count > 0 && count < selectableCount;
}

function clearSelection() {
  selectedEntries.clear();
  $$('.entry-select').forEach(checkbox => { checkbox.checked = false; });
  $$('.file-row.selected').forEach(row => row.classList.remove('selected'));
  updateSelectionToolbar();
}

$('#selectAll').addEventListener('change', event => {
  if (event.target.disabled) return;
  const checked = event.target.checked;
  visibleEntries.filter(entry => !entry.is_system).forEach(entry => checked ? selectedEntries.set(entry.id, entry) : selectedEntries.delete(entry.id));
  $$('.entry-select:not(:disabled)').forEach(checkbox => { checkbox.checked = checked; });
  $$('.entry-select:not(:disabled)').forEach(checkbox => checkbox.closest('.file-row').classList.toggle('selected', checked));
  updateSelectionToolbar();
});

$('#clearSelection').addEventListener('click', clearSelection);

$('#bulkMove').addEventListener('click', async () => {
  const entries = [...selectedEntries.values()];
  try {
    const folders = await api('/api/folders');
    openModal('SPOSTA ELEMENTI', `Sposta ${entries.length} elementi`, '<label class="field">Cartella<select id="bulkDestination"><option value="">I miei file</option></select></label>', async () => {
      const parentId = $('#bulkDestination').value || null;
      await Promise.all(entries.map(entry => api(`/api/entries/${entry.id}/move`, {
        method: 'PATCH',
        body: JSON.stringify({ parentId })
      })));
      toast(`${entries.length} elementi spostati`);
      clearSelection();
      loadEntries();
    });
    const selectedIds = new Set(entries.map(entry => entry.id));
    folders.filter(folder => !selectedIds.has(folder.id)).forEach(folder => {
      const option = document.createElement('option');
      option.value = folder.id;
      option.textContent = folder.name;
      $('#bulkDestination').append(option);
    });
  } catch (error) {
    toast(error.message);
  }
});

$('#bulkTrash').addEventListener('click', () => {
  const entries = [...selectedEntries.values()];
  openModal('CESTINO', 'Sposta gli elementi nel cestino', `<p>Spostare nel cestino <strong>${entries.length} elementi</strong>?</p>`, async () => {
    await Promise.all(entries.map(entry => api(`/api/entries/${entry.id}`, { method: 'DELETE' })));
    toast(`${entries.length} elementi spostati nel cestino`);
    clearSelection();
    loadStorage();
    loadEntries();
  });
});

function updateFolderLocation() {
  const insideFolder = Boolean(currentFolder);
  $('#folderBack').classList.toggle('hidden', !insideFolder);
  $('#newFolder').classList.toggle('hidden', user.role === 'viewer' || view !== 'files' || currentFolder?.is_system);
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
  const renderId = ++previewRenderId;
  previewEntryIndex = visibleEntries.findIndex(item => item.id === entry.id);
  $('#previewName').textContent = entry.name;
  const url = `/api/entries/${entry.id}/content`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) return toast('Impossibile aprire il file');
  const blob = await response.blob();
  if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
  const objectUrl = URL.createObjectURL(blob);
  previewObjectUrl = objectUrl;
  $('#download').href = objectUrl;
  $('#download').download = entry.name;
  if (entry.mime_type === 'application/pdf') {
    $('#viewer').innerHTML = '<div class="pdf-loading">Caricamento PDF…</div>';
    renderPdf(blob, renderId).catch(error => {
      if (renderId !== previewRenderId) return;
      console.error(error);
      $('#viewer').innerHTML = '<div class="generic"><strong>Anteprima PDF non disponibile</strong><i></i><i></i><i></i><p>Puoi scaricare il documento.</p></div>';
    });
  } else if (entry.mime_type?.startsWith('image/')) {
    $('#viewer').innerHTML = '<img alt="Anteprima">';
    $('#viewer img').src = objectUrl;
  } else {
    $('#viewer').innerHTML = '<div class="generic"><strong>Anteprima non disponibile</strong><i></i><i></i><i></i><p>Puoi scaricare il documento.</p></div>';
  }
  updatePreviewNavigation();
  $('#preview').classList.add('open');
}

async function renderPdf(blob, renderId) {
  const pdfjs = await getPdfjs();
  const document = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
  if (renderId !== previewRenderId) return;

  const pages = window.document.createElement('div');
  pages.className = 'pdf-pages';
  $('#viewer').replaceChildren(pages);

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    if (renderId !== previewRenderId) return;
    const page = await document.getPage(pageNumber);
    const original = page.getViewport({ scale: 1 });
    const availableWidth = Math.max(240, $('#viewer').clientWidth - 24);
    const cssScale = Math.min(2, availableWidth / original.width);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale: cssScale * pixelRatio });
    const canvas = window.document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${Math.floor(viewport.width / pixelRatio)}px`;
    canvas.style.height = `${Math.floor(viewport.height / pixelRatio)}px`;
    canvas.setAttribute('aria-label', `Pagina ${pageNumber} di ${document.numPages}`);
    pages.append(canvas);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  }
}

function updatePreviewNavigation() {
  const showGallery = view === 'images' && visibleEntries.length > 1 && previewEntryIndex >= 0;
  $('#previewNav').classList.toggle('hidden', !showGallery);
  if (!showGallery) return;
  $('#previewCounter').textContent = `${previewEntryIndex + 1} di ${visibleEntries.length}`;
  $('#previousImage').disabled = previewEntryIndex === 0;
  $('#nextImage').disabled = previewEntryIndex === visibleEntries.length - 1;
}

function navigatePreview(direction) {
  const nextIndex = previewEntryIndex + direction;
  if (view !== 'images' || nextIndex < 0 || nextIndex >= visibleEntries.length) return;
  preview(visibleEntries[nextIndex]);
}

function openModal(tag, title, body, submit) {
  $('#modalTag').textContent = tag;
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = body;
  $('#confirm').classList.remove('hidden');
  $('#confirm').classList.remove('danger-confirm');
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
  if (entry.is_system) {
    toast('La cartella Immagini è fissa');
    return;
  }
  if (view === 'trash') {
    openModal('CESTINO', entry.name, `
      <div class="action-list">
        <button type="button" id="chooseRestore"><span>↶</span><div><strong>Ripristina</strong><small>Riporta l’elemento nella posizione originale</small></div></button>
        <button type="button" id="choosePermanentDelete" class="danger"><span>×</span><div><strong>Elimina definitivamente</strong><small>Questa operazione non può essere annullata</small></div></button>
      </div>`, async () => {});
    $('#confirm').classList.add('hidden');
    $('#chooseRestore').onclick = () => confirmRestore(entry);
    $('#choosePermanentDelete').onclick = () => confirmPermanentDelete(entry);
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

function confirmRestore(entry) {
  openModal('RIPRISTINO', 'Ripristina elemento', '<p>Ripristinare <strong></strong>?</p>', async () => {
    await api(`/api/entries/${entry.id}/restore`, { method: 'POST' });
    toast('Elemento ripristinato');
    loadStorage();
    loadEntries();
  });
  $('#modalBody strong').textContent = entry.name;
}

function confirmPermanentDelete(entry) {
  openModal('ELIMINAZIONE DEFINITIVA', 'Elimina definitivamente', '<p>Eliminare definitivamente <strong></strong>? L’operazione non può essere annullata.</p>', async () => {
    await api(`/api/entries/${entry.id}/permanent`, { method: 'DELETE' });
    toast('Elemento eliminato definitivamente');
    loadStorage();
    loadEntries();
  });
  $('#modalBody strong').textContent = entry.name;
  $('#confirm').textContent = 'Elimina definitivamente';
  $('#confirm').classList.add('danger-confirm');
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

async function uploadFiles(files, parentId = currentFolder?.id || null) {
  if (!files.length || uploadInProgress) return;
  const form = new FormData();
  files.forEach(file => form.append('files', file));
  if (view === 'images' && !parentId) form.append('collection', 'images');
  else if (parentId) form.append('parentId', parentId);
  uploadInProgress = true;
  $('#upload').disabled = true;
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
    $('#upload').disabled = false;
    setTimeout(() => $('#uploadProgress').classList.add('hidden'), 900);
  }
}

$('#upload').addEventListener('change', async event => {
  await uploadFiles([...event.target.files]);
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
document.addEventListener('dragover', event => {
  if (hasDraggedFiles(event)) event.preventDefault();
});
document.addEventListener('drop', event => {
  if (event.dataTransfer?.files.length) {
    event.preventDefault();
    $('#drive').classList.remove('external-drop-target');
  }
});
$('#drive').addEventListener('dragover', event => {
  if (!hasDraggedFiles(event) || user.role === 'viewer') return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  $('#drive').classList.add('external-drop-target');
});
$('#drive').addEventListener('dragleave', event => {
  if (!$('#drive').contains(event.relatedTarget)) $('#drive').classList.remove('external-drop-target');
});
$('#drive').addEventListener('drop', async event => {
  const files = [...event.dataTransfer.files];
  if (!files.length) return;
  event.preventDefault();
  $('#drive').classList.remove('external-drop-target');
  if (user.role !== 'viewer') await uploadFiles(files);
});
$('#menu').onclick = () => $('#sidebar').classList.toggle('open');
$('#logout').onclick = logout;
$('#closePreview').onclick = () => {
  previewRenderId += 1;
  $('#preview').classList.remove('open');
};
$('#previousImage').onclick = () => navigatePreview(-1);
$('#nextImage').onclick = () => navigatePreview(1);
$('#viewer').addEventListener('touchstart', event => {
  previewTouchStartX = event.changedTouches[0]?.clientX ?? null;
}, { passive: true });
$('#viewer').addEventListener('touchend', event => {
  if (previewTouchStartX === null) return;
  const distance = (event.changedTouches[0]?.clientX ?? previewTouchStartX) - previewTouchStartX;
  previewTouchStartX = null;
  if (Math.abs(distance) < 45) return;
  navigatePreview(distance < 0 ? 1 : -1);
}, { passive: true });
$('#closeModal').onclick = $('#cancel').onclick = closeModal;
document.addEventListener('keydown', event => {
  if ($('#preview').classList.contains('open') && event.key === 'ArrowLeft') navigatePreview(-1);
  if ($('#preview').classList.contains('open') && event.key === 'ArrowRight') navigatePreview(1);
  if (event.key === 'Escape') {
    previewRenderId += 1;
    closeModal();
    $('#preview').classList.remove('open');
  }
});

init().catch(error => {
  $('#authError').textContent = error.message;
});

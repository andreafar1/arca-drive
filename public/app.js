const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let token = localStorage.getItem('arca_token');
let user = null;
let view = 'files';
let currentFolder = null;
let searchTimer;

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401 && token) logout();
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
        password: $('#password').value
      })
    });
    token = result.token;
    user = result.user;
    localStorage.setItem('arca_token', token);
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
  $('#newFolder').classList.toggle('hidden', user.role === 'viewer');
  loadEntries();
}

function logout() {
  localStorage.removeItem('arca_token');
  location.reload();
}

async function loadEntries() {
  if (view === 'people') return loadUsers();
  const query = new URLSearchParams();
  if (view === 'trash') query.set('trash', 'true');
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
      row.querySelector('.file-name strong').textContent = entry.name;
      row.children[1].textContent = entry.owner_name;
      row.addEventListener('click', event => {
        if (event.target.tagName === 'BUTTON' || view === 'trash') return entryAction(entry);
        if (entry.kind === 'folder') {
          currentFolder = entry;
          $('#breadcrumb').textContent = 'I miei file /';
          $('#title').textContent = entry.name;
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
      loadEntries();
    });
    $('#modalBody strong').textContent = entry.name;
    return;
  }
  openModal('CESTINO', 'Sposta nel cestino', '<p>Spostare questo elemento nel cestino?</p>', async () => {
    await api(`/api/entries/${entry.id}`, { method: 'DELETE' });
    toast('Elemento spostato nel cestino');
    loadEntries();
  });
}

$('#newFolder').addEventListener('click', () => openModal('NUOVA CARTELLA', 'Crea una cartella', '<label class="field">Nome<input id="folderName" required maxlength="255"></label>', async () => {
  await api('/api/folders', {
    method: 'POST',
    body: JSON.stringify({ name: $('#folderName').value, parentId: currentFolder?.id || null })
  });
  toast('Cartella creata');
  loadEntries();
}));

$('#upload').addEventListener('change', async event => {
  const form = new FormData();
  [...event.target.files].forEach(file => form.append('files', file));
  if (currentFolder) form.append('parentId', currentFolder.id);
  try {
    await api('/api/files', { method: 'POST', body: form });
    toast('Caricamento completato');
    loadEntries();
  } catch (error) {
    toast(error.message);
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
  $$('.nav').forEach(item => item.classList.toggle('active', item === button));
  $('#people').classList.toggle('hidden', view !== 'people');
  $('#drive').classList.toggle('hidden', view === 'people');
  $('#newFolder').classList.toggle('hidden', view !== 'files');
  $('#title').textContent = view === 'files' ? 'I miei file' : view === 'trash' ? 'Cestino' : 'Persone';
  $('#breadcrumb').textContent = 'Spazio aziendale /';
  $('#sidebar').classList.remove('open');
  loadEntries();
}));

$('#search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadEntries, 250);
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

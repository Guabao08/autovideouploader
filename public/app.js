const status = document.querySelector('#status');
const projectsEl = document.querySelector('#projects');
const signinEl = document.querySelector('#signin');
const costEl = document.querySelector('#cost');
let idToken = sessionStorage.getItem('idToken') || null;

function authHeaders() { return idToken ? { authorization: `Bearer ${idToken}` } : {}; }

async function handleCredential(response) {
  idToken = response.credential;
  sessionStorage.setItem('idToken', idToken);
  signinEl.style.display = 'none';
  load();
}
window.handleCredential = handleCredential;

async function initSignIn() {
  const config = await (await fetch('/api/config')).json();
  if (!config.googleClientId) { status.textContent = 'Server has no Google client configured.'; return; }
  window.google?.accounts.id.initialize({ client_id: config.googleClientId, callback: handleCredential });
  window.google?.accounts.id.renderButton(signinEl, { theme: 'outline', size: 'large' });
  if (!idToken) signinEl.style.display = 'block';
}

async function loadCost() {
  const r = await fetch('/api/cost', { headers: authHeaders() });
  if (!r.ok) return;
  const c = await r.json();
  costEl.textContent = `Spend: $${c.projected.toFixed(2)} / $${c.ceiling} ceiling${c.warning ? ` · ${c.warning.toUpperCase()}` : ''}`;
  costEl.className = c.warning || '';
}

async function load() {
  const r = await fetch('/api/projects', { headers: authHeaders() });
  if (r.status === 401 || r.status === 403) { idToken = null; sessionStorage.removeItem('idToken'); signinEl.style.display = 'block'; return; }
  const data = await r.json();
  projectsEl.innerHTML = data.map(p => `<article class="project" data-id="${p.id}">
    <span>${p.filename}<br><small>${p.state}${p.duplicateOf ? ' · duplicate source' : ''}</small></span>
    <button class="approve">Approve/Send</button>
    <button class="retry">Retry</button>
    <a href="/api/projects/${p.id}/download" target="_blank">Download</a>
    <button class="delete">Delete</button>
  </article>`).join('') || '<p>No projects yet.</p>';
  loadCost();
}

projectsEl.addEventListener('click', async e => {
  const article = e.target.closest('.project');
  if (!article) return;
  const id = article.dataset.id;
  if (e.target.matches('.delete')) { await fetch(`/api/projects/${id}`, { method: 'DELETE', headers: authHeaders() }); return load(); }
  if (e.target.matches('.retry')) { await fetch(`/api/projects/${id}/retry`, { method: 'POST', headers: authHeaders() }); return load(); }
  if (e.target.matches('.approve')) {
    const r = await fetch(`/api/projects/${id}/approve`, { method: 'POST', headers: authHeaders() });
    const d = await r.json();
    status.textContent = d.error || 'Sent for approval.';
    return load();
  }
});

const CHUNK_SIZE = 5 * 1024 * 1024;
async function uploadFile(file, meta) {
  const created = await (await fetch('/api/uploads', { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify({ filename: file.name, sizeBytes: file.size }) })).json();
  if (created.errors) return { errors: created.errors };
  let offset = 0;
  while (offset < file.size) {
    const chunk = file.slice(offset, offset + CHUNK_SIZE);
    const r = await fetch(`/api/uploads/${created.id}?offset=${offset}`, { method: 'PUT', headers: authHeaders(), body: chunk });
    const d = await r.json();
    if (!r.ok) return { errors: [d.error] };
    offset = d.receivedBytes;
    status.textContent = `Uploading… ${Math.round((offset / file.size) * 100)}%`;
  }
  const r = await fetch(`/api/uploads/${created.id}/complete`, { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify(meta) });
  return await r.json();
}

document.querySelector('#upload').onclick = async () => {
  const f = document.querySelector('#video').files[0];
  if (!f) return status.textContent = 'Choose a video first.';
  const v = document.createElement('video');
  v.preload = 'metadata';
  v.onloadedmetadata = async () => {
    const meta = { filename: f.name, durationSeconds: v.duration, width: v.videoWidth, height: v.videoHeight, mime: f.type };
    const d = await uploadFile(f, meta);
    status.textContent = d.errors ? d.errors.join(' ') : 'Upload complete, queued for processing.';
    load();
  };
  v.src = URL.createObjectURL(f);
};

initSignIn();
load();

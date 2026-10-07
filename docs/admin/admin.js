import { fetchContent, DRAFT_KEY, esc, slugify, stripTags } from '../js/store.js';
import {
  verifyLogin, newCredentials, encryptSecret, decryptSecret, detectLocal, guessRepo,
  localBackend, githubBackend, prepareImage,
} from './lib.js';

const SESSION_KEY = 'envoy.admin.session';
const DRAFT_BASE_KEY = 'envoy.admin.draftBase';
const SESSION_HOURS = 8;
const app = document.getElementById('app');
const dialog = document.getElementById('dialog');

const state = {
  admin: null,
  published: null,
  draft: null,
  token: null,
  password: null,
  user: null,
  isLocal: false,
  busy: false,
  uploadCache: {},
  failures: 0,
  conflict: false,
};

const R = (path = '') => `admin/#/${path}`;
const uid = (prefix) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const clone = (v) => JSON.parse(JSON.stringify(v));
const snapshot = (c) => JSON.stringify({ ...c, updatedAt: null });

/* ================================================================== boot */
boot().catch((err) => {
  console.error(err);
  app.innerHTML = `<div class="login__form"><div class="login__card"><h1>Admin unavailable</h1><p class="login__error">${esc(err.message)}</p></div></div>`;
});

async function boot() {
  const [admin, published, isLocal] = await Promise.all([
    fetch(`data/admin.json?v=${Date.now()}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetchContent(),
    detectLocal(),
  ]);
  state.admin = admin;
  state.published = published;
  state.isLocal = isLocal;

  const session = readSession();
  if (session && admin && session.user === admin.username) {
    state.user = session.user;
    state.token = session.token || null;
    enterApp();
  } else {
    renderLogin();
  }
}

function readSession() {
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    if (!s || s.exp < Date.now()) return null;
    return s;
  } catch {
    return null;
  }
}

function writeSession() {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ user: state.user, token: state.token, exp: Date.now() + SESSION_HOURS * 3600e3 }));
  } catch {}
}

/* ================================================================== login */
function renderLogin(message = '') {
  const configured = state.admin?.passwordHash;
  app.innerHTML = `
    <div class="login">
      <div class="login__art">
        <img src="assets/img/logo.png" alt="Envoy">
        <p class="login__quote">Everything becomes clearer as we learn.</p>
        <span class="login__foot">Envoy editorial admin</span>
      </div>
      <div class="login__form">
        <form class="login__card" id="login-form" autocomplete="on">
          <div><h1>Sign in</h1><p>Edit articles, pages and site settings.</p></div>
          ${!configured ? `<div class="notice notice--warn"><i class="ph-bold ph-warning"></i><p>No admin account is set up yet. In the project folder run <span class="code">node tools/set-password.mjs admin "your-password"</span> and reload.</p></div>` : ''}
          ${message ? `<div class="login__error" role="alert">${esc(message)}</div>` : ''}
          <div class="field"><label for="u">Username</label><input class="input" id="u" name="username" autocomplete="username" required autofocus></div>
          <div class="field"><label for="p">Password</label><input class="input" id="p" name="password" type="password" autocomplete="current-password" required></div>
          <button class="btn btn--block" type="submit" ${configured ? '' : 'disabled'}>Sign in</button>
          <a class="link-btn" href="./"><i class="ph-bold ph-arrow-left"></i>Back to the site</a>
        </form>
      </div>
    </div>`;

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = form.querySelector('button');
    const username = form.username.value;
    const password = form.password.value;
    btn.disabled = true;
    btn.textContent = 'Checking…';
    // Slow down repeated guesses.
    if (state.failures > 2) await new Promise((r) => setTimeout(r, Math.min(8000, 1000 * 2 ** (state.failures - 3))));
    const ok = await verifyLogin(state.admin, username, password).catch(() => false);
    if (!ok) {
      state.failures += 1;
      renderLogin('That username and password do not match.');
      return;
    }
    state.failures = 0;
    state.user = state.admin.username;
    state.password = password;
    state.token = state.admin.token ? await decryptSecret(state.admin.token, password) : null;
    writeSession();
    enterApp();
  });
}

function logout() {
  sessionStorage.removeItem(SESSION_KEY);
  state.user = null;
  state.password = null;
  state.token = null;
  location.hash = '';
  renderLogin();
}

/* ================================================================== draft */
function loadDraft() {
  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch {}
  if (draft && Array.isArray(draft.posts)) {
    const base = localStorage.getItem(DRAFT_BASE_KEY);
    state.conflict = Boolean(base && base !== state.published.updatedAt) && isDirty(draft);
    return draft;
  }
  return clone(state.published);
}

function isDirty(draft = state.draft) {
  return snapshot(draft) !== snapshot(state.published);
}

let saveTimer;
function changed() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistDraft, 250);
  updateStatus();
}

function persistDraft() {
  clearTimeout(saveTimer);
  try {
    if (isDirty()) {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(state.draft));
      if (!localStorage.getItem(DRAFT_BASE_KEY)) localStorage.setItem(DRAFT_BASE_KEY, state.published.updatedAt || '');
    } else {
      localStorage.removeItem(DRAFT_KEY);
      localStorage.removeItem(DRAFT_BASE_KEY);
    }
  } catch (err) {
    toast('Could not save the draft in this browser (storage full?). Publish or export to keep your changes.', 'error');
  }
}
addEventListener('beforeunload', persistDraft);

function discardDraft() {
  localStorage.removeItem(DRAFT_KEY);
  localStorage.removeItem(DRAFT_BASE_KEY);
  state.draft = clone(state.published);
  state.conflict = false;
}

/* ================================================================== backend */
function backend() {
  if (state.isLocal) return localBackend;
  const gh = state.admin?.github;
  if (state.token && gh?.owner && gh?.repo) return githubBackend(gh, state.token);
  return null;
}

async function publish() {
  const be = backend();
  if (!be) {
    toast('Publishing is not connected yet. Set it up under Publishing.', 'error');
    location.hash = '#/publish';
    return;
  }
  if (!isDirty()) { toast('Nothing new to publish.'); return; }
  state.busy = true;
  updateStatus();
  try {
    const out = { ...state.draft, updatedAt: new Date().toISOString() };
    await be.write('data/content.json', JSON.stringify(out, null, 1), { message: `Publish site content (${state.user})` });
    state.published = clone(out);
    state.draft = clone(out);
    discardDraft();
    toast(be.name === 'github' ? 'Published. GitHub Pages usually shows the update within a minute or two.' : 'Saved to docs/data/content.json.');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    state.busy = false;
    updateStatus();
    route();
  }
}

async function saveAdmin(next) {
  const be = backend();
  const text = JSON.stringify(next, null, 2) + '\n';
  if (!be) {
    download('admin.json', text, 'application/json');
    toast('No publishing connection: downloaded admin.json. Replace docs/data/admin.json in your repository with it.');
    state.admin = next;
    return;
  }
  await be.write('data/admin.json', text, { message: 'Update admin settings' });
  state.admin = next;
}

async function uploadImage(file, { maxWidth = 1600, folder = 'uploads' } = {}) {
  if (!file.type.startsWith('image/')) throw new Error('Please choose an image file.');
  const img = await prepareImage(file, maxWidth);
  const dataUrl = `data:${img.mime};base64,${img.base64}`;
  const be = backend();
  if (!be) {
    toast('Image embedded in the content file because publishing is not connected. Connect publishing to store images as files.');
    return dataUrl;
  }
  const d = new Date();
  const base = slugify(file.name.replace(/\.[^.]+$/, '')) || 'image';
  const path = `assets/${folder}/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${base}-${Math.random().toString(36).slice(2, 6)}.${img.ext}`;
  await be.write(path, img.base64, { base64: true, message: `Upload ${path}` });
  state.uploadCache[path] = dataUrl;
  return path;
}

const imgSrc = (path) => (path ? state.uploadCache[path] || path : '');

/* ================================================================== ui helpers */
function toast(message, type = 'info') {
  const t = document.createElement('div');
  t.className = `toast ${type === 'error' ? 'toast--error' : ''}`;
  t.innerHTML = `<i class="ph-bold ${type === 'error' ? 'ph-warning-circle' : 'ph-check-circle'}"></i><span>${esc(message)}</span>`;
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), type === 'error' ? 7000 : 3500);
}

function openDialog(html, onSubmit) {
  dialog.innerHTML = `<form method="dialog">${html}</form>`;
  const form = dialog.querySelector('form');
  return new Promise((resolve) => {
    let result = null;
    form.addEventListener('submit', (e) => {
      const submitter = e.submitter;
      if (submitter?.value === 'cancel') { result = null; return; }
      result = onSubmit ? onSubmit(form) : true;
    });
    dialog.addEventListener('close', () => resolve(result), { once: true });
    dialog.showModal();
    form.querySelector('[autofocus]')?.focus();
  });
}

function confirmDialog({ title, body = '', confirm = 'Confirm', danger = false }) {
  return openDialog(`
    <h3>${esc(title)}</h3>${body ? `<p>${body}</p>` : ''}
    <div class="dialog-actions"><button class="btn btn--ghost" value="cancel">Cancel</button><button class="btn ${danger ? 'btn--danger' : ''}" value="ok" autofocus>${esc(confirm)}</button></div>`).then(Boolean);
}

function promptDialog({ title, label, value = '', placeholder = '', hint = '' }) {
  return openDialog(`
    <h3>${esc(title)}</h3>
    <div class="field"><label for="dlg-in">${esc(label)}</label><input class="input" id="dlg-in" name="v" value="${esc(value)}" placeholder="${esc(placeholder)}" autofocus>${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</div>
    <div class="dialog-actions"><button class="btn btn--ghost" value="cancel">Cancel</button><button class="btn" value="ok">OK</button></div>`, (f) => f.v.value.trim());
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
  target[last] = value;
}

const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// Two-way bind inputs carrying data-k="path" to obj.
function bind(root, obj, onChange) {
  root.querySelectorAll('[data-k]').forEach((el) => {
    const path = el.dataset.k;
    const val = getPath(obj, path);
    if (el.type === 'checkbox') el.checked = Boolean(val);
    else if (el.dataset.type === 'datetime') el.value = toLocalInput(val);
    else el.value = val ?? '';
    const evt = el.tagName === 'SELECT' || el.type === 'checkbox' || el.dataset.type === 'datetime' ? 'change' : 'input';
    el.addEventListener(evt, () => {
      let v;
      if (el.type === 'checkbox') v = el.checked;
      else if (el.type === 'number') v = el.value === '' ? null : Number(el.value);
      else if (el.dataset.type === 'datetime') v = el.value ? new Date(el.value).toISOString() : getPath(obj, path);
      else v = el.value;
      setPath(obj, path, v);
      onChange?.(path, v, el);
      changed();
    });
  });
}

function autoGrow(el) {
  const fit = () => { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; };
  el.addEventListener('input', fit);
  requestAnimationFrame(fit);
}

function mountImage(el, obj, path, { maxWidth = 1600, empty = 'No image', onChange } = {}) {
  const render = () => {
    const val = getPath(obj, path) || '';
    el.innerHTML = `
      <div class="image-field__preview">${val ? `<img src="${esc(imgSrc(val))}" alt="">` : `<span>${esc(empty)}</span>`}</div>
      <div class="image-field__actions">
        <label class="btn btn--sm btn--ghost"><i class="ph-bold ph-upload-simple"></i>${val ? 'Replace' : 'Upload'}<input type="file" accept="image/*" hidden></label>
        <button type="button" class="btn btn--sm btn--ghost" data-url><i class="ph-bold ph-link"></i>URL</button>
        ${val ? '<button type="button" class="btn btn--sm btn--ghost" data-remove aria-label="Remove image"><i class="ph-bold ph-trash"></i></button>' : ''}
      </div>
      ${val && !val.startsWith('data:') ? `<span class="hint mono" style="word-break:break-all">${esc(val)}</span>` : ''}`;
    el.querySelector('input[type=file]').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const label = e.target.closest('label');
      label.lastChild.textContent = '';
      label.firstChild.className = 'ph-bold ph-circle-notch';
      try {
        set(await uploadImage(file, { maxWidth }));
      } catch (err) {
        toast(err.message, 'error');
        render();
      }
    });
    el.querySelector('[data-url]').addEventListener('click', async () => {
      const v = await promptDialog({ title: 'Image URL', label: 'Address of the image', value: val.startsWith('data:') ? '' : val, placeholder: 'https://… or assets/img/…' });
      if (v !== null) set(v);
    });
    el.querySelector('[data-remove]')?.addEventListener('click', () => set(''));
  };
  const set = (v) => {
    setPath(obj, path, v);
    onChange?.(v);
    changed();
    render();
  };
  el.classList.add('image-field');
  render();
}

function toEmbedUrl(url) {
  try {
    const u = new URL(url);
    if (/youtu\.be$/.test(u.hostname)) return `https://www.youtube.com/embed/${u.pathname.slice(1)}`;
    if (/youtube\.com$/.test(u.hostname)) {
      if (u.pathname.startsWith('/embed/')) return url;
      const id = u.searchParams.get('v') || u.pathname.split('/').pop();
      return `https://www.youtube.com/embed/${id}`;
    }
    if (/vimeo\.com$/.test(u.hostname)) {
      if (u.hostname.startsWith('player.')) return url;
      return `https://player.vimeo.com/video/${u.pathname.split('/').filter(Boolean).pop()}`;
    }
  } catch {}
  return null;
}

function mountEditor(el, html, onChange, placeholder = 'Write the story…') {
  if (!window.Quill) {
    el.innerHTML = `<textarea class="textarea" style="min-height:360px;font-family:var(--mono)">${esc(html)}</textarea><span class="hint">The rich text editor did not load; editing raw HTML.</span>`;
    el.querySelector('textarea').addEventListener('input', (e) => { onChange(e.target.value); changed(); });
    return;
  }
  el.classList.add('rte');
  el.innerHTML = '<div></div>';
  const quill = new window.Quill(el.firstChild, {
    theme: 'snow',
    placeholder,
    modules: {
      toolbar: {
        container: [
          [{ header: [2, 3, 4, false] }],
          ['bold', 'italic', 'underline', 'link'],
          [{ list: 'ordered' }, { list: 'bullet' }, 'blockquote'],
          [{ align: [] }],
          ['image', 'video', 'clean'],
        ],
        handlers: {
          image() {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.onchange = async () => {
              const file = input.files[0];
              if (!file) return;
              try {
                const path = await uploadImage(file);
                const range = quill.getSelection(true);
                quill.insertEmbed(range.index, 'image', imgSrc(path), 'user');
                quill.setSelection(range.index + 1);
                // Store the file path rather than the inline preview data.
                quill.root.querySelectorAll(`img[src="${imgSrc(path)}"]`).forEach((im) => { if (path !== imgSrc(path)) im.setAttribute('src', path); });
                emit();
              } catch (err) {
                toast(err.message, 'error');
              }
            };
            input.click();
          },
          async video() {
            const url = await promptDialog({ title: 'Embed a video', label: 'YouTube or Vimeo link', placeholder: 'https://www.youtube.com/watch?v=…' });
            if (!url) return;
            const embed = toEmbedUrl(url);
            if (!embed) { toast('Only YouTube and Vimeo links can be embedded.', 'error'); return; }
            const range = quill.getSelection(true);
            quill.insertEmbed(range.index, 'video', embed, 'user');
            quill.setSelection(range.index + 1);
          },
        },
      },
    },
  });
  if (html) quill.clipboard.dangerouslyPasteHTML(html, 'silent');
  const emit = () => {
    const out = quill.getText().trim() || quill.root.querySelector('img,iframe') ? quill.root.innerHTML : '';
    onChange(out);
    changed();
  };
  quill.on('text-change', emit);
}

/* ================================================================== shell */
const NAV = [
  ['Content', [
    ['dashboard', 'Dashboard', 'ph-squares-four'],
    ['articles', 'Articles', 'ph-newspaper', () => state.draft.posts.length],
    ['homepage', 'Homepage', 'ph-layout'],
    ['pages', 'Pages', 'ph-file-text', () => state.draft.pages.length],
  ]],
  ['Library', [
    ['categories', 'Categories', 'ph-tag', () => state.draft.categories.length],
    ['authors', 'Authors', 'ph-users', () => state.draft.authors.length],
  ]],
  ['Site', [
    ['navigation', 'Menus', 'ph-list'],
    ['settings', 'Settings', 'ph-sliders-horizontal'],
    ['publish', 'Publishing & account', 'ph-cloud-arrow-up'],
  ]],
];

function enterApp() {
  state.draft = loadDraft();
  app.innerHTML = `
    <div class="shell" id="shell">
      <aside class="side" id="side"></aside>
      <div style="min-width:0">
        <header class="topbar-admin">
          <button class="icon-btn menu-btn" id="menu-btn" aria-label="Open navigation"><i class="ph-bold ph-list"></i></button>
          <h1 id="view-title"><span></span></h1>
          <div class="spacer"></div>
          <span id="status"></span>
          <a class="btn btn--ghost btn--sm hide-sm" id="preview-btn" href="./?preview=1#/" target="_blank" rel="noopener"><i class="ph-bold ph-eye"></i>Preview</a>
          <button class="btn btn--sm" id="publish-btn"><i class="ph-bold ph-cloud-arrow-up"></i>Publish</button>
        </header>
        <div id="view" class="view"></div>
      </div>
    </div>`;
  document.getElementById('publish-btn').addEventListener('click', publish);
  document.getElementById('preview-btn').addEventListener('click', persistDraft);
  document.getElementById('menu-btn').addEventListener('click', () => document.getElementById('shell').classList.toggle('nav-open'));
  addEventListener('hashchange', route);
  addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      persistDraft();
      toast('Draft saved in this browser. Use Publish to make it live.');
    }
  });
  route();
}

function renderSide(current) {
  const side = document.getElementById('side');
  side.innerHTML = `
    <div class="side__brand"><img src="assets/img/logo.png" alt="Envoy"><span>Admin</span></div>
    ${NAV.map(([label, items]) => `
      <nav class="side__group" aria-label="${label}">
        <div class="side__label">${label}</div>
        ${items.map(([key, text, icon, count]) => `<a href="${R(key)}" ${current === key ? 'aria-current="page"' : ''}><i class="ph-bold ${icon}"></i>${text}${count ? `<span class="count">${count()}</span>` : ''}</a>`).join('')}
      </nav>`).join('')}
    <div class="side__foot">
      <a href="./" target="_blank" rel="noopener"><i class="ph-bold ph-arrow-square-out"></i>View site</a>
      <a href="${R(current)}" id="theme-btn"><i class="ph-bold ph-circle-half"></i>Toggle theme</a>
      <a href="${R(current)}" id="logout-btn"><i class="ph-bold ph-sign-out"></i>Sign out <span class="count">${esc(state.user)}</span></a>
    </div>`;
  side.querySelector('#logout-btn').addEventListener('click', (e) => { e.preventDefault(); logout(); });
  side.querySelector('#theme-btn').addEventListener('click', (e) => {
    e.preventDefault();
    const cur = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('envoy.theme', next); } catch {}
  });
  side.addEventListener('click', (e) => { if (e.target.closest('a')) document.getElementById('shell')?.classList.remove('nav-open'); });
}

function updateStatus() {
  const el = document.getElementById('status');
  if (!el) return;
  const dirty = isDirty();
  el.innerHTML = state.busy
    ? '<span class="status status--busy">Publishing</span>'
    : `<span class="status ${dirty ? 'status--dirty' : 'status--clean'}">${dirty ? 'Unpublished changes' : 'Up to date'}</span>`;
  const btn = document.getElementById('publish-btn');
  if (btn) btn.disabled = state.busy || !dirty;
}

function setTitle(text) {
  document.querySelector('#view-title span').textContent = text;
  document.title = `${text} – Envoy Admin`;
}

let leaveHook = null;
function route() {
  if (!state.user) return;
  leaveHook?.();
  leaveHook = null;
  const [section = 'dashboard', param] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  const view = document.getElementById('view');
  renderSide(section);
  updateStatus();
  const views = { dashboard: viewDashboard, articles: viewArticles, homepage: viewHomepage, pages: viewPages, categories: viewCategories, authors: viewAuthors, navigation: viewNavigation, settings: viewSettings, publish: viewPublish };
  (views[section] || viewDashboard)(view, param);
  view.prepend(...conflictNotice());
  scrollTo(0, 0);
}

function conflictNotice() {
  if (!state.conflict) return [];
  const div = document.createElement('div');
  div.className = 'notice notice--warn';
  div.innerHTML = `<i class="ph-bold ph-warning"></i><div><p>The live site was published from somewhere else after you started these changes. Publishing now will replace that version with yours.</p>
    <div class="actions"><button class="btn btn--sm" data-a="discard">Discard my changes</button><button class="btn btn--sm btn--ghost" data-a="keep">Keep my changes</button></div></div>`;
  div.querySelector('[data-a=discard]').onclick = () => { discardDraft(); route(); };
  div.querySelector('[data-a=keep]').onclick = () => { state.conflict = false; localStorage.setItem(DRAFT_BASE_KEY, state.published.updatedAt || ''); div.remove(); };
  return [div];
}

function head(title, desc = '', actions = '') {
  return `<div class="view-head"><div><h2>${esc(title)}</h2>${desc ? `<p>${desc}</p>` : ''}</div>${actions ? `<div class="view-actions">${actions}</div>` : ''}</div>`;
}

/* ================================================================== dashboard */
function viewDashboard(view) {
  setTitle('Dashboard');
  const d = state.draft;
  const published = d.posts.filter((p) => p.status === 'published');
  const drafts = d.posts.filter((p) => p.status !== 'published');
  const recent = [...d.posts].sort((a, b) => new Date(b.updated || b.date) - new Date(a.updated || a.date)).slice(0, 6);
  const be = backend();
  view.innerHTML = `
    ${head(`Welcome back${state.user ? `, ${state.user}` : ''}`, 'Changes you make are kept as a draft in this browser until you publish them.', `<a class="btn" href="${R('articles/new')}"><i class="ph-bold ph-plus"></i>New article</a>`)}
    ${connectionNotice(be)}
    <div class="bento">
      <a class="card stat" href="${R('articles')}"><span class="stat__label">Published<i class="ph-bold ph-newspaper"></i></span><span class="stat__value">${published.length}</span><span class="hint">articles live on the site</span></a>
      <a class="card stat" href="${R('articles')}"><span class="stat__label">Drafts<i class="ph-bold ph-note-pencil"></i></span><span class="stat__value">${drafts.length}</span><span class="hint">not visible to readers</span></a>
      <a class="card stat" href="${R('authors')}"><span class="stat__label">Authors<i class="ph-bold ph-users"></i></span><span class="stat__value">${d.authors.length}</span><span class="hint">contributors on file</span></a>
      <a class="card stat" href="${R('categories')}"><span class="stat__label">Categories<i class="ph-bold ph-tag"></i></span><span class="stat__value">${d.categories.length}</span><span class="hint">sections and tags</span></a>
      <div class="card stat span-2">
        <span class="stat__label">Recently edited<i class="ph-bold ph-clock-counter-clockwise"></i></span>
        <ul class="recent">${recent.map((p) => `<li><img class="mini-thumb" src="${esc(imgSrc(p.image))}" alt="" onerror="this.style.visibility='hidden'"><a class="t" href="${R(`articles/${p.id}`)}">${esc(p.title || 'Untitled')}</a>${statusPill(p)}</li>`).join('')}</ul>
      </div>
      <div class="card stat span-2">
        <span class="stat__label">Quick actions<i class="ph-bold ph-lightning"></i></span>
        <div class="stack--sm" style="margin-top:6px">
          <a class="link-btn" href="${R('homepage')}"><i class="ph-bold ph-layout"></i>Choose the homepage lead stories</a>
          <a class="link-btn" href="${R('pages/purpose')}"><i class="ph-bold ph-file-text"></i>Edit the Purpose page</a>
          <a class="link-btn" href="${R('navigation')}"><i class="ph-bold ph-list"></i>Change the menu</a>
          <a class="link-btn" href="${R('settings')}"><i class="ph-bold ph-sliders-horizontal"></i>Update logo, tagline and social links</a>
          <a class="link-btn" href="./?preview=1#/" target="_blank" rel="noopener"><i class="ph-bold ph-eye"></i>Preview the site with your changes</a>
        </div>
        <div class="divider"></div>
        <span class="hint">Live content last published ${esc(new Date(state.published.updatedAt).toLocaleString())}</span>
      </div>
    </div>`;
}

function connectionNotice(be) {
  if (be?.name === 'local') return `<div class="notice notice--info"><i class="ph-bold ph-hard-drives"></i><p>Running on the local dev server: Publish writes straight to <span class="code">docs/data/content.json</span>. Commit and push to update GitHub Pages.</p></div>`;
  if (be?.name === 'github') return `<div class="notice notice--ok"><i class="ph-bold ph-github-logo"></i><p>Connected to ${esc(be.label)}. Publish commits your changes to the repository.</p></div>`;
  return `<div class="notice notice--warn"><i class="ph-bold ph-plug"></i><div><p>Publishing is not connected, so changes stay in this browser. Add a GitHub token to publish from anywhere.</p><div class="actions"><a class="btn btn--sm" href="${R('publish')}">Set up publishing</a></div></div></div>`;
}

function statusPill(p) {
  if (p.status !== 'published') return '<span class="pill pill--yellow">Draft</span>';
  if (new Date(p.date) > new Date()) return '<span class="pill pill--blue">Scheduled</span>';
  return '<span class="pill pill--green">Published</span>';
}

/* ================================================================== articles */
const listState = { q: '', status: '', cat: '', author: '', page: 1 };

function viewArticles(view, param) {
  if (param) return editArticle(view, param);
  setTitle('Articles');
  const d = state.draft;
  view.innerHTML = `
    ${head('Articles', 'Every story on the site. Drafts and scheduled articles are hidden from readers.', `<a class="btn" href="${R('articles/new')}"><i class="ph-bold ph-plus"></i>New article</a>`)}
    <div class="toolbar">
      <input class="input" type="search" id="f-q" placeholder="Search titles" value="${esc(listState.q)}" aria-label="Search articles">
      <select class="select" id="f-status" aria-label="Status"><option value="">All statuses</option><option value="published">Published</option><option value="draft">Draft</option><option value="scheduled">Scheduled</option></select>
      <select class="select" id="f-cat" aria-label="Category"><option value="">All categories</option>${d.categories.map((c) => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join('')}</select>
      <select class="select" id="f-author" aria-label="Author"><option value="">All authors</option>${[...d.authors].sort((a, b) => a.name.localeCompare(b.name)).map((a) => `<option value="${esc(a.slug)}">${esc(a.name)}</option>`).join('')}</select>
    </div>
    <div id="table"></div>`;
  const f = (id) => view.querySelector(id);
  f('#f-status').value = listState.status;
  f('#f-cat').value = listState.cat;
  f('#f-author').value = listState.author;
  const update = () => {
    listState.q = f('#f-q').value;
    listState.status = f('#f-status').value;
    listState.cat = f('#f-cat').value;
    listState.author = f('#f-author').value;
    renderTable();
  };
  f('#f-q').addEventListener('input', () => { listState.page = 1; update(); });
  ['#f-status', '#f-cat', '#f-author'].forEach((s) => f(s).addEventListener('change', () => { listState.page = 1; update(); }));

  function renderTable() {
    const now = new Date();
    const q = listState.q.toLowerCase();
    const rows = [...d.posts]
      .filter((p) => !q || p.title.toLowerCase().includes(q) || p.slug.includes(q))
      .filter((p) => !listState.cat || p.categories.includes(listState.cat))
      .filter((p) => !listState.author || p.author === listState.author)
      .filter((p) => {
        if (!listState.status) return true;
        if (listState.status === 'draft') return p.status !== 'published';
        if (listState.status === 'scheduled') return p.status === 'published' && new Date(p.date) > now;
        return p.status === 'published' && new Date(p.date) <= now;
      })
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    const per = 25;
    const pages = Math.max(1, Math.ceil(rows.length / per));
    listState.page = Math.min(listState.page, pages);
    const slice = rows.slice((listState.page - 1) * per, listState.page * per);
    const authorName = (slug) => d.authors.find((a) => a.slug === slug)?.name || slug;
    const catName = (slug) => d.categories.find((c) => c.slug === slug)?.name || slug;
    f('#table').innerHTML = rows.length ? `
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Title</th><th>Author</th><th>Categories</th><th>Date</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${slice.map((p) => `<tr>
          <td><div class="title-cell"><img class="mini-thumb" src="${esc(imgSrc(p.image))}" alt="" onerror="this.style.visibility='hidden'"><div><a href="${R(`articles/${p.id}`)}">${esc(p.title || 'Untitled')}</a><div class="hint mono">${esc(p.slug)}</div></div></div></td>
          <td>${esc(authorName(p.author))}</td>
          <td><span class="hint">${p.categories.map(catName).map(esc).join(', ')}</span></td>
          <td class="mono" style="white-space:nowrap">${new Date(p.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
          <td>${statusPill(p)}</td>
          <td><div class="row-actions">
            <a class="icon-btn" href="${R(`articles/${p.id}`)}" aria-label="Edit"><i class="ph-bold ph-pencil-simple"></i></a>
            <a class="icon-btn" href="./?preview=1#/article/${encodeURIComponent(p.slug)}" target="_blank" rel="noopener" aria-label="Preview"><i class="ph-bold ph-eye"></i></a>
            <button class="icon-btn" data-dup="${p.id}" aria-label="Duplicate"><i class="ph-bold ph-copy"></i></button>
            <button class="icon-btn" data-del="${p.id}" aria-label="Delete"><i class="ph-bold ph-trash"></i></button>
          </div></td></tr>`).join('')}</tbody>
      </table></div>
      <div class="table-foot"><span>${rows.length} article${rows.length === 1 ? '' : 's'}</span>
        ${pages > 1 ? `<span class="input-row"><button class="btn btn--ghost btn--sm" data-pg="-1" ${listState.page === 1 ? 'disabled' : ''}>Previous</button><span class="mono">${listState.page} / ${pages}</span><button class="btn btn--ghost btn--sm" data-pg="1" ${listState.page === pages ? 'disabled' : ''}>Next</button></span>` : ''}
      </div>` : '<div class="list-empty">No articles match these filters.</div>';
    f('#table').querySelectorAll('[data-pg]').forEach((b) => b.addEventListener('click', () => { listState.page += Number(b.dataset.pg); renderTable(); }));
    f('#table').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => deleteArticle(b.dataset.del).then((ok) => ok && renderTable())));
    f('#table').querySelectorAll('[data-dup]').forEach((b) => b.addEventListener('click', () => duplicateArticle(b.dataset.dup)));
  }
  renderTable();
}

function uniqueSlug(list, slug, selfId) {
  let base = slug || 'untitled';
  let out = base;
  let n = 2;
  while (list.some((x) => x.slug === out && x.id !== selfId)) out = `${base}-${n++}`;
  return out;
}

async function deleteArticle(id) {
  const p = state.draft.posts.find((x) => x.id === id);
  if (!p) return false;
  const ok = await confirmDialog({ title: 'Delete this article?', body: `“${esc(p.title || 'Untitled')}” will be removed when you publish. This cannot be undone after publishing.`, confirm: 'Delete', danger: true });
  if (!ok) return false;
  state.draft.posts = state.draft.posts.filter((x) => x.id !== id);
  removeFromHome(id);
  changed();
  renderSide('articles');
  toast('Article deleted.');
  return true;
}

function duplicateArticle(id) {
  const src = state.draft.posts.find((x) => x.id === id);
  if (!src) return;
  const copy = { ...clone(src), id: uid('p'), title: `${src.title} (copy)`, status: 'draft', date: new Date().toISOString(), updated: new Date().toISOString() };
  copy.slug = uniqueSlug(state.draft.posts, slugify(copy.title));
  state.draft.posts.unshift(copy);
  changed();
  location.hash = `#/articles/${copy.id}`;
}

function removeFromHome(id) {
  const h = state.draft.home;
  for (const key of ['slider', 'trailing', 'highlights', 'popular', 'missed']) if (Array.isArray(h[key])) h[key] = h[key].filter((x) => x !== id);
  if (h.ticker?.ids) h.ticker.ids = h.ticker.ids.filter((x) => x !== id);
}

const PLACEMENTS = [
  ['slider', 'Homepage lead slider'],
  ['trailing', 'Beside the lead (2 slots)'],
  ['highlights', 'Highlights carousel'],
  ['popular', 'Popular News'],
  ['missed', 'You May Have Missed'],
  ['ticker', 'Top-bar ticker (manual mode)'],
];

function editArticle(view, id) {
  const d = state.draft;
  let p;
  if (id === 'new') {
    const now = new Date().toISOString();
    p = { id: uid('p'), slug: '', title: '', excerpt: '', body: '', image: '', imageCaption: '', imageAlt: '', categories: [], author: d.authors.find((a) => a.slug === 'admin') ? 'admin' : d.authors[0]?.slug || '', date: now, updated: now, readTime: null, status: 'draft', sourceUrl: '' };
    d.posts.unshift(p);
    history.replaceState(null, '', R(`articles/${p.id}`));
  } else {
    p = d.posts.find((x) => x.id === id);
  }
  if (!p) {
    view.innerHTML = `${head('Article not found')}<a class="btn" href="${R('articles')}">Back to articles</a>`;
    return;
  }
  setTitle(p.title || 'New article');
  let slugTouched = Boolean(p.slug);

  leaveHook = () => {
    if (!p.title.trim() && !stripTags(p.body || '').trim() && !p.excerpt.trim()) {
      d.posts = d.posts.filter((x) => x !== p);
      removeFromHome(p.id);
      changed();
    }
  };

  const inList = (key) => (key === 'ticker' ? d.home.ticker?.ids || [] : d.home[key] || []).includes(p.id);

  view.innerHTML = `
    <div class="view-head" style="margin-bottom:16px"><a class="link-btn" href="${R('articles')}"><i class="ph-bold ph-arrow-left"></i>All articles</a>
      <div class="view-actions">
        <a class="btn btn--ghost btn--sm" id="pv" href="./?preview=1#/article/${encodeURIComponent(p.slug)}" target="_blank" rel="noopener"><i class="ph-bold ph-eye"></i>Preview</a>
        <button class="btn btn--ghost btn--sm" id="dup"><i class="ph-bold ph-copy"></i>Duplicate</button>
        <button class="btn btn--danger btn--sm" id="del"><i class="ph-bold ph-trash"></i>Delete</button>
      </div>
    </div>
    <div class="editor">
      <div class="stack">
        <textarea class="input input--title" rows="1" data-k="title" placeholder="Headline" aria-label="Headline"></textarea>
        <div class="field"><label for="slug">URL slug</label>
          <div class="input-row"><span class="hint mono">#/article/</span><input class="input mono" id="slug" data-k="slug"><button class="btn btn--ghost btn--sm" type="button" id="reslug" title="Generate from headline"><i class="ph-bold ph-arrows-clockwise"></i></button></div>
        </div>
        <div class="field"><label for="excerpt">Summary</label><textarea class="textarea" id="excerpt" data-k="excerpt" rows="3" placeholder="One or two sentences shown on listings and under the headline."></textarea></div>
        <div class="field"><span class="label">Story</span><div id="body"></div>
          <span class="hint">If the story is left empty, the article page shows the summary and links to the source URL for the full text.</span></div>
      </div>
      <div class="editor__side">
        <section class="panel stack--sm">
          <h3>Publishing</h3>
          <div class="field"><label for="st">Status</label><select class="select" id="st" data-k="status"><option value="published">Published</option><option value="draft">Draft</option></select></div>
          <div class="field"><label for="dt">Publish date</label><input class="input" id="dt" type="datetime-local" data-type="datetime" data-k="date"><span class="hint">A future date schedules the article.</span></div>
          <div class="field"><label for="rt">Reading time (minutes)</label><input class="input" id="rt" type="number" min="1" data-k="readTime" placeholder="Automatic"></div>
        </section>
        <section class="panel stack--sm">
          <h3>Byline and sections</h3>
          <div class="field"><label for="au">Author</label><select class="select" id="au" data-k="author">${[...d.authors].sort((a, b) => a.name.localeCompare(b.name)).map((a) => `<option value="${esc(a.slug)}">${esc(a.name)}</option>`).join('')}</select></div>
          <div class="field"><span class="label">Categories</span><div class="cat-list" id="cats"></div>
            <div class="input-row"><input class="input" id="newcat" placeholder="New category"><button class="btn btn--ghost btn--sm" type="button" id="addcat">Add</button></div></div>
        </section>
        <section class="panel stack--sm">
          <h3>Featured image</h3>
          <div id="img"></div>
          <div class="field"><label for="cap">Caption / credit</label><input class="input" id="cap" data-k="imageCaption"></div>
          <div class="field"><label for="alt">Alt text</label><input class="input" id="alt" data-k="imageAlt" placeholder="Describe the image for screen readers"></div>
        </section>
        <section class="panel stack--sm">
          <h3>Homepage placement</h3>
          ${PLACEMENTS.map(([key, label]) => `<label class="check"><input type="checkbox" data-place="${key}" ${inList(key) ? 'checked' : ''}>${label}</label>`).join('')}
        </section>
        <section class="panel stack--sm">
          <h3>Source</h3>
          <div class="field"><label for="src">Original article URL</label><input class="input" id="src" data-k="sourceUrl" placeholder="https://"></div>
        </section>
      </div>
    </div>`;

  const $ = (s) => view.querySelector(s);
  bind(view, p, (path, v) => {
    p.updated = new Date().toISOString();
    if (path === 'title') {
      setTitle(v || 'New article');
      if (!slugTouched) { p.slug = uniqueSlug(d.posts, slugify(v), p.id); $('#slug').value = p.slug; }
    }
    if (path === 'slug') { slugTouched = true; }
    $('#pv').href = `./?preview=1#/article/${encodeURIComponent(p.slug)}`;
  });
  $('#slug').addEventListener('change', () => { p.slug = uniqueSlug(d.posts, slugify(p.slug) || slugify(p.title), p.id); $('#slug').value = p.slug; changed(); });
  $('#reslug').addEventListener('click', () => { p.slug = uniqueSlug(d.posts, slugify(p.title), p.id); $('#slug').value = p.slug; slugTouched = true; changed(); });
  autoGrow($('.input--title'));
  mountEditor($('#body'), p.body, (html) => { p.body = html; p.updated = new Date().toISOString(); });
  mountImage($('#img'), p, 'image', { empty: 'No featured image' });

  const renderCats = () => {
    $('#cats').innerHTML = d.categories.map((c) => `<label class="check"><input type="checkbox" value="${esc(c.slug)}" ${p.categories.includes(c.slug) ? 'checked' : ''}>${esc(c.name)}</label>`).join('');
    $('#cats').querySelectorAll('input').forEach((cb) => cb.addEventListener('change', () => {
      p.categories = cb.checked ? [...p.categories, cb.value] : p.categories.filter((s) => s !== cb.value);
      changed();
    }));
  };
  renderCats();
  $('#addcat').addEventListener('click', () => {
    const name = $('#newcat').value.trim();
    if (!name) return;
    let cat = d.categories.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!cat) {
      cat = { id: uid('c'), slug: uniqueSlug(d.categories, slugify(name)), name, description: '' };
      d.categories.push(cat);
    }
    if (!p.categories.includes(cat.slug)) p.categories.push(cat.slug);
    $('#newcat').value = '';
    changed();
    renderCats();
  });

  view.querySelectorAll('[data-place]').forEach((cb) => cb.addEventListener('change', () => {
    const key = cb.dataset.place;
    if (key === 'ticker') {
      d.home.ticker ??= { mode: 'manual', count: 6, ids: [] };
      d.home.ticker.ids = cb.checked ? [...(d.home.ticker.ids || []), p.id] : d.home.ticker.ids.filter((x) => x !== p.id);
    } else {
      d.home[key] = cb.checked ? [...(d.home[key] || []), p.id] : (d.home[key] || []).filter((x) => x !== p.id);
    }
    changed();
  }));

  $('#del').addEventListener('click', async () => { if (await deleteArticle(p.id)) { leaveHook = null; location.hash = '#/articles'; } });
  $('#dup').addEventListener('click', () => duplicateArticle(p.id));
  if (id === 'new') $('.input--title').focus();
}

/* ================================================================== homepage */
function postListEditor(el, getList, setList, { max = 0 } = {}) {
  const d = state.draft;
  const render = () => {
    const ids = getList() || [];
    const posts = ids.map((id) => d.posts.find((p) => p.id === id)).filter(Boolean);
    const options = [...d.posts].filter((p) => !ids.includes(p.id)).sort((a, b) => new Date(b.date) - new Date(a.date));
    el.innerHTML = `
      <div class="list-editor">${posts.length ? posts.map((p, i) => `
        <div class="list-item"><span class="num">${String(i + 1).padStart(2, '0')}</span>
          <div style="min-width:0"><div class="t">${esc(p.title || 'Untitled')}</div><div class="sub">${p.status !== 'published' ? 'Draft · ' : ''}${new Date(p.date).toLocaleDateString()}</div></div>
          <div class="row-actions">
            <button class="icon-btn" data-up="${i}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}><i class="ph-bold ph-arrow-up"></i></button>
            <button class="icon-btn" data-down="${i}" aria-label="Move down" ${i === posts.length - 1 ? 'disabled' : ''}><i class="ph-bold ph-arrow-down"></i></button>
            <button class="icon-btn" data-rm="${i}" aria-label="Remove"><i class="ph-bold ph-x"></i></button>
          </div></div>`).join('') : '<div class="list-empty">No articles selected.</div>'}</div>
      ${!max || posts.length < max ? `<div class="picker"><select class="select" aria-label="Article to add"><option value="">Add an article…</option>${options.map((p) => `<option value="${p.id}">${esc(p.title || 'Untitled')}</option>`).join('')}</select><button class="btn btn--ghost btn--sm" type="button" data-add>Add</button></div>` : `<span class="hint">Maximum of ${max} reached.</span>`}`;
    const live = posts.map((p) => p.id);
    const commit = (next) => { setList(next); changed(); render(); };
    el.querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', () => { const i = +b.dataset.up; const n = [...live]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; commit(n); }));
    el.querySelectorAll('[data-down]').forEach((b) => b.addEventListener('click', () => { const i = +b.dataset.down; const n = [...live]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; commit(n); }));
    el.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => commit(live.filter((_, i) => i !== +b.dataset.rm))));
    el.querySelector('[data-add]')?.addEventListener('click', () => {
      const v = el.querySelector('select').value;
      if (v) commit([...live, v]);
    });
  };
  render();
}

const WIDGETS = { magazine: 'Magazine cover', highlights: 'Highlights carousel', popular: 'Popular News', categoryList: 'Category list (numbered)', categoryGrid: 'Category grid' };

function viewHomepage(view) {
  setTitle('Homepage');
  const d = state.draft;
  const h = d.home;
  h.ticker ??= { mode: 'latest', count: 6, ids: [] };
  h.categoryList ??= { title: '', category: '', count: 6 };
  h.categoryGrid ??= { title: '', category: '', count: 3 };
  h.widgets ??= Object.keys(WIDGETS);
  const catOptions = `<option value="">None</option>${d.categories.map((c) => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join('')}`;

  view.innerHTML = `
    ${head('Homepage', 'Choose which stories lead the front page and what appears in the sidebar. The main list always shows the newest published articles.', `<a class="btn btn--ghost" href="./?preview=1#/" target="_blank" rel="noopener"><i class="ph-bold ph-eye"></i>Preview</a>`)}
    <div class="grid-2" style="align-items:start">
      <div class="stack">
        <section class="panel"><div class="panel-head"><div><h3>Lead slider</h3><p class="hint">The large rotating story at the top. The first article shows first.</p></div></div><div id="l-slider"></div>
          <div class="field" style="margin-top:14px"><label for="si">Seconds per slide</label><input class="input" id="si" type="number" min="3" max="30" data-k="sliderInterval" placeholder="8" style="max-width:120px"></div></section>
        <section class="panel"><div class="panel-head"><div><h3>Beside the lead</h3><p class="hint">Two stories stacked to the right of the slider.</p></div></div><div id="l-trailing"></div></section>
        <section class="panel"><div class="panel-head"><div><h3>You May Have Missed</h3><p class="hint">Grid band above the footer.</p></div></div>
          <div class="field" style="margin-bottom:12px"><label for="mt">Section title</label><input class="input" id="mt" data-k="missedTitle" placeholder="You May Have Missed"></div><div id="l-missed"></div></section>
        <section class="panel stack--sm"><h3>Latest stories list</h3>
          <div class="grid-2"><div class="field"><label for="lt">Section title</label><input class="input" id="lt" data-k="latestTitle" placeholder="Latest Stories"></div>
          <div class="field"><label for="pp">Stories per page</label><input class="input" id="pp" type="number" min="3" max="50" data-k="perPage"></div></div></section>
      </div>
      <div class="stack">
        <section class="panel stack--sm"><h3>Top-bar ticker</h3>
          <div class="grid-2"><div class="field"><label for="tm">Source</label><select class="select" id="tm" data-k="ticker.mode"><option value="latest">Newest articles</option><option value="manual">Chosen articles</option><option value="off">Hidden</option></select></div>
          <div class="field"><label for="tc">Number of newest</label><input class="input" id="tc" type="number" min="1" max="20" data-k="ticker.count"></div></div>
          <div id="l-ticker"></div></section>
        <section class="panel"><div class="panel-head"><div><h3>Sidebar widgets</h3><p class="hint">Order and visibility on the homepage, category, search and page sidebars.</p></div></div><div id="widgets"></div></section>
        <section class="panel"><div class="panel-head"><div><h3>Highlights</h3><p class="hint">Rotating carousel in the sidebar.</p></div></div>
          <div class="field" style="margin-bottom:12px"><label for="ht">Widget title</label><input class="input" id="ht" data-k="highlightsTitle" placeholder="Highlights"></div><div id="l-highlights"></div></section>
        <section class="panel"><div class="panel-head"><div><h3>Popular News</h3><p class="hint">Numbered list in the sidebar.</p></div></div>
          <div class="field" style="margin-bottom:12px"><label for="pt">Widget title</label><input class="input" id="pt" data-k="popularTitle" placeholder="Popular News"></div><div id="l-popular"></div></section>
        <section class="panel stack--sm"><h3>Category list widget</h3>
          <div class="grid-3"><div class="field"><label for="clt">Title</label><input class="input" id="clt" data-k="categoryList.title"></div>
          <div class="field"><label for="clc">Category</label><select class="select" id="clc" data-k="categoryList.category">${catOptions}</select></div>
          <div class="field"><label for="cln">Articles</label><input class="input" id="cln" type="number" min="1" max="12" data-k="categoryList.count"></div></div></section>
        <section class="panel stack--sm"><h3>Category grid widget</h3>
          <div class="grid-3"><div class="field"><label for="cgt">Title</label><input class="input" id="cgt" data-k="categoryGrid.title"></div>
          <div class="field"><label for="cgc">Category</label><select class="select" id="cgc" data-k="categoryGrid.category">${catOptions}</select></div>
          <div class="field"><label for="cgn">Articles</label><input class="input" id="cgn" type="number" min="1" max="12" data-k="categoryGrid.count"></div></div></section>
      </div>
    </div>`;
  bind(view, h, (path) => { if (path === 'ticker.mode') renderTicker(); });
  for (const key of ['slider', 'trailing', 'highlights', 'popular', 'missed']) {
    postListEditor(view.querySelector(`#l-${key}`), () => h[key], (v) => { h[key] = v; }, { max: key === 'trailing' ? 2 : 0 });
  }
  const renderTicker = () => {
    const el = view.querySelector('#l-ticker');
    if (h.ticker.mode !== 'manual') { el.innerHTML = ''; return; }
    postListEditor(el, () => h.ticker.ids, (v) => { h.ticker.ids = v; });
  };
  renderTicker();

  const renderWidgets = () => {
    const el = view.querySelector('#widgets');
    const order = [...h.widgets, ...Object.keys(WIDGETS).filter((k) => !h.widgets.includes(k))];
    el.innerHTML = `<div class="list-editor">${order.map((k, i) => `
      <div class="list-item"><span class="num">${String(i + 1).padStart(2, '0')}</span>
        <label class="check"><input type="checkbox" data-on="${k}" ${h.widgets.includes(k) ? 'checked' : ''}>${WIDGETS[k]}</label>
        <div class="row-actions"><button class="icon-btn" data-up="${i}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}><i class="ph-bold ph-arrow-up"></i></button><button class="icon-btn" data-down="${i}" aria-label="Move down" ${i === order.length - 1 ? 'disabled' : ''}><i class="ph-bold ph-arrow-down"></i></button></div>
      </div>`).join('')}</div>`;
    const commit = (nextOrder) => { h.widgets = nextOrder.filter((k) => el.querySelector(`[data-on="${k}"]`).checked); changed(); renderWidgets(); };
    el.querySelectorAll('[data-on]').forEach((cb) => cb.addEventListener('change', () => commit(order)));
    el.querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', () => { const i = +b.dataset.up; const n = [...order]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; commit(n); }));
    el.querySelectorAll('[data-down]').forEach((b) => b.addEventListener('click', () => { const i = +b.dataset.down; const n = [...order]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; commit(n); }));
  };
  renderWidgets();
}

/* ================================================================== categories */
const COLORS = [['', 'Automatic'], ['blue', 'Blue'], ['green', 'Green'], ['yellow', 'Yellow'], ['red', 'Red'], ['gray', 'Gray']];

function viewCategories(view) {
  setTitle('Categories');
  const d = state.draft;
  const count = (slug) => d.posts.filter((p) => p.categories.includes(slug)).length;
  view.innerHTML = `
    ${head('Categories', 'Sections readers can browse. Category pages live at <span class="code">#/category/slug</span>.')}
    <section class="panel" style="margin-bottom:16px"><form class="input-row" id="add"><input class="input" name="name" placeholder="New category name" required><button class="btn" type="submit"><i class="ph-bold ph-plus"></i>Add category</button></form></section>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Name</th><th>Slug</th><th>Description</th><th>Tag colour</th><th>Articles</th><th><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${[...d.categories].sort((a, b) => a.name.localeCompare(b.name)).map((c) => `<tr data-id="${esc(c.id)}">
        <td><input class="input" data-k="name" aria-label="Name" style="min-width:150px"></td>
        <td><input class="input mono" data-k="slug" aria-label="Slug" style="min-width:140px"></td>
        <td><input class="input" data-k="description" aria-label="Description" style="min-width:200px"></td>
        <td><select class="select" data-k="color" aria-label="Tag colour">${COLORS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></td>
        <td class="mono">${count(c.slug)}</td>
        <td><div class="row-actions"><a class="icon-btn" href="./?preview=1#/category/${encodeURIComponent(c.slug)}" target="_blank" rel="noopener" aria-label="Preview"><i class="ph-bold ph-eye"></i></a><button class="icon-btn" data-del aria-label="Delete"><i class="ph-bold ph-trash"></i></button></div></td>
      </tr>`).join('')}</tbody></table></div>`;

  view.querySelectorAll('tr[data-id]').forEach((tr) => {
    const c = d.categories.find((x) => x.id === tr.dataset.id);
    let oldSlug = c.slug;
    bind(tr, c);
    tr.querySelector('[data-k=slug]').addEventListener('change', (e) => {
      const next = uniqueSlug(d.categories, slugify(e.target.value) || slugify(c.name), c.id);
      c.slug = next;
      e.target.value = next;
      renameCategory(oldSlug, next);
      oldSlug = next;
      changed();
    });
    tr.querySelector('[data-del]').addEventListener('click', async () => {
      const n = count(c.slug);
      const ok = await confirmDialog({ title: `Delete “${esc(c.name)}”?`, body: n ? `${n} article${n === 1 ? '' : 's'} will lose this category. The articles themselves are kept.` : 'No articles use this category.', confirm: 'Delete', danger: true });
      if (!ok) return;
      d.categories = d.categories.filter((x) => x !== c);
      d.posts.forEach((p) => { p.categories = p.categories.filter((s) => s !== c.slug); });
      for (const k of ['categoryList', 'categoryGrid']) if (d.home[k]?.category === c.slug) d.home[k].category = '';
      d.nav = d.nav.filter((n) => !(n.type === 'category' && n.target === c.slug));
      if (d.footerNav) d.footerNav = d.footerNav.filter((n) => !(n.type === 'category' && n.target === c.slug));
      changed();
      route();
    });
  });
  view.querySelector('#add').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    d.categories.push({ id: uid('c'), slug: uniqueSlug(d.categories, slugify(name)), name, description: '' });
    changed();
    route();
    toast(`Added “${name}”.`);
  });
}

function renameCategory(from, to) {
  const d = state.draft;
  d.posts.forEach((p) => { p.categories = p.categories.map((s) => (s === from ? to : s)); });
  for (const k of ['categoryList', 'categoryGrid']) if (d.home[k]?.category === from) d.home[k].category = to;
  for (const list of [d.nav, d.footerNav || []]) list.forEach((n) => { if (n.type === 'category' && n.target === from) n.target = to; });
}

/* ================================================================== authors */
let authorQuery = '';
function viewAuthors(view, param) {
  if (param) return editAuthor(view, param);
  setTitle('Authors');
  const d = state.draft;
  const count = (slug) => d.posts.filter((p) => p.author === slug).length;
  view.innerHTML = `
    ${head('Authors', 'Bylines, photos and short bios shown on articles and the Authors page.', `<button class="btn" id="new"><i class="ph-bold ph-plus"></i>New author</button>`)}
    <div class="toolbar"><input class="input" type="search" id="q" placeholder="Search authors" value="${esc(authorQuery)}" aria-label="Search authors"></div>
    <div id="table"></div>`;
  const renderTable = () => {
    const q = authorQuery.toLowerCase();
    const list = [...d.authors].filter((a) => !q || a.name.toLowerCase().includes(q)).sort((a, b) => count(b.slug) - count(a.slug) || a.name.localeCompare(b.name));
    view.querySelector('#table').innerHTML = `<div class="table-wrap"><table class="table">
      <thead><tr><th>Name</th><th>Role</th><th>Articles</th><th>Visibility</th><th><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${list.map((a) => `<tr>
        <td><div class="title-cell">${a.avatar ? `<img class="avatar" style="width:32px;height:32px" src="${esc(imgSrc(a.avatar))}" alt="">` : `<span class="avatar" style="width:32px;height:32px">${esc(a.name.split(' ').map((w) => w[0]).join('').slice(0, 2))}</span>`}<div><a href="${R(`authors/${encodeURIComponent(a.id)}`)}">${esc(a.name)}</a><div class="hint mono">${esc(a.slug)}</div></div></div></td>
        <td><span class="hint">${esc(a.role || '')}</span></td>
        <td class="mono">${count(a.slug)}</td>
        <td>${a.hidden ? '<span class="pill">Hidden</span>' : '<span class="pill pill--green">Listed</span>'}</td>
        <td><div class="row-actions"><a class="icon-btn" href="${R(`authors/${encodeURIComponent(a.id)}`)}" aria-label="Edit"><i class="ph-bold ph-pencil-simple"></i></a></div></td>
      </tr>`).join('')}</tbody></table></div><div class="table-foot"><span>${list.length} author${list.length === 1 ? '' : 's'}</span></div>`;
  };
  view.querySelector('#q').addEventListener('input', (e) => { authorQuery = e.target.value; renderTable(); });
  view.querySelector('#new').addEventListener('click', async () => {
    const name = await promptDialog({ title: 'New author', label: 'Full name' });
    if (!name) return;
    const a = { id: uid('a'), slug: uniqueSlug(d.authors, slugify(name)), name, avatar: '', role: '', bio: '', twitter: '', linkedin: '', website: '' };
    d.authors.push(a);
    changed();
    location.hash = `#/authors/${encodeURIComponent(a.id)}`;
  });
  renderTable();
}

function editAuthor(view, id) {
  const d = state.draft;
  const a = d.authors.find((x) => x.id === id);
  if (!a) { view.innerHTML = `${head('Author not found')}<a class="btn" href="${R('authors')}">Back to authors</a>`; return; }
  setTitle(a.name);
  const n = d.posts.filter((p) => p.author === a.slug).length;
  view.innerHTML = `
    <div class="view-head" style="margin-bottom:16px"><a class="link-btn" href="${R('authors')}"><i class="ph-bold ph-arrow-left"></i>All authors</a>
      <div class="view-actions"><a class="btn btn--ghost btn--sm" href="./?preview=1#/author/${encodeURIComponent(a.slug)}" target="_blank" rel="noopener"><i class="ph-bold ph-eye"></i>Preview</a><button class="btn btn--danger btn--sm" id="del"><i class="ph-bold ph-trash"></i>Delete</button></div></div>
    <div class="editor">
      <div class="panel stack">
        <div class="grid-2"><div class="field"><label for="n">Name</label><input class="input" id="n" data-k="name"></div>
        <div class="field"><label for="s">Slug</label><input class="input mono" id="s" data-k="slug"><span class="hint">${n} article${n === 1 ? '' : 's'} use this byline.</span></div></div>
        <div class="field"><label for="r">Role or title</label><input class="input" id="r" data-k="role" placeholder="e.g. Senior Correspondent"></div>
        <div class="field"><label for="b">Short bio</label><textarea class="textarea" id="b" data-k="bio" rows="5"></textarea></div>
        <div class="grid-3"><div class="field"><label for="tw">X / Twitter URL</label><input class="input" id="tw" data-k="twitter"></div>
        <div class="field"><label for="li">LinkedIn URL</label><input class="input" id="li" data-k="linkedin"></div>
        <div class="field"><label for="w">Website</label><input class="input" id="w" data-k="website"></div></div>
        <div class="grid-2"><label class="check"><input type="checkbox" data-k="hidden">Hide from the Authors page</label>
        <div class="field"><label for="o">Sort priority</label><input class="input" id="o" type="number" data-k="order" placeholder="0"><span class="hint">Higher numbers appear first on the Authors page.</span></div></div>
      </div>
      <div class="editor__side"><section class="panel stack--sm"><h3>Photo</h3><div id="av" class="image-field--square"></div></section></div>
    </div>`;
  let oldSlug = a.slug;
  bind(view, a, (path) => { if (path === 'name') setTitle(a.name); });
  view.querySelector('#s').addEventListener('change', (e) => {
    const next = uniqueSlug(d.authors, slugify(e.target.value) || slugify(a.name), a.id);
    a.slug = next;
    e.target.value = next;
    d.posts.forEach((p) => { if (p.author === oldSlug) p.author = next; });
    oldSlug = next;
    changed();
  });
  mountImage(view.querySelector('#av'), a, 'avatar', { maxWidth: 600, empty: 'No photo' });
  view.querySelector('#del').addEventListener('click', async () => {
    const others = d.authors.filter((x) => x !== a);
    const fallback = others.find((x) => x.slug === 'admin') || others[0];
    const ok = await confirmDialog({ title: `Delete ${esc(a.name)}?`, body: n ? `${n} article${n === 1 ? '' : 's'} will be credited to ${esc(fallback?.name || 'no one')} instead.` : 'This author has no articles.', confirm: 'Delete', danger: true });
    if (!ok) return;
    d.posts.forEach((p) => { if (p.author === a.slug) p.author = fallback?.slug || ''; });
    d.authors = others;
    changed();
    location.hash = '#/authors';
  });
}

/* ================================================================== pages */
function viewPages(view, param) {
  if (param) return editPage(view, param);
  setTitle('Pages');
  const d = state.draft;
  const inNav = (slug) => d.nav.some((n) => n.type === 'page' && n.target === slug);
  view.innerHTML = `
    ${head('Pages', 'Standalone pages such as Purpose, Contacts and Envoy TV.', `<button class="btn" id="new"><i class="ph-bold ph-plus"></i>New page</button>`)}
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Title</th><th>Address</th><th>In menu</th><th><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${d.pages.map((p) => `<tr>
        <td><div class="title-cell"><a href="${R(`pages/${encodeURIComponent(p.id)}`)}">${esc(p.title)}</a></div></td>
        <td class="mono">#/${esc(p.slug)}</td>
        <td>${inNav(p.slug) ? '<span class="pill pill--green">Yes</span>' : '<span class="pill">No</span>'}</td>
        <td><div class="row-actions"><a class="icon-btn" href="${R(`pages/${encodeURIComponent(p.id)}`)}" aria-label="Edit"><i class="ph-bold ph-pencil-simple"></i></a><a class="icon-btn" href="./?preview=1#/${encodeURIComponent(p.slug)}" target="_blank" rel="noopener" aria-label="Preview"><i class="ph-bold ph-eye"></i></a></div></td>
      </tr>`).join('')}</tbody></table></div>`;
  view.querySelector('#new').addEventListener('click', async () => {
    const title = await promptDialog({ title: 'New page', label: 'Page title' });
    if (!title) return;
    const reserved = ['article', 'category', 'author', 'authors', 'search', 'page'];
    let slug = slugify(title);
    if (reserved.includes(slug)) slug += '-page';
    const p = { id: uid('pg'), slug: uniqueSlug(d.pages, slug), title, body: '', sidebar: true };
    d.pages.push(p);
    changed();
    location.hash = `#/pages/${encodeURIComponent(p.id)}`;
  });
}

function editPage(view, id) {
  const d = state.draft;
  const p = d.pages.find((x) => x.id === id || x.slug === id);
  if (!p) { view.innerHTML = `${head('Page not found')}<a class="btn" href="${R('pages')}">Back to pages</a>`; return; }
  setTitle(p.title);
  const inNav = () => d.nav.some((n) => n.type === 'page' && n.target === p.slug);
  view.innerHTML = `
    <div class="view-head" style="margin-bottom:16px"><a class="link-btn" href="${R('pages')}"><i class="ph-bold ph-arrow-left"></i>All pages</a>
      <div class="view-actions"><a class="btn btn--ghost btn--sm" id="pv" href="./?preview=1#/${encodeURIComponent(p.slug)}" target="_blank" rel="noopener"><i class="ph-bold ph-eye"></i>Preview</a><button class="btn btn--danger btn--sm" id="del"><i class="ph-bold ph-trash"></i>Delete</button></div></div>
    <div class="editor">
      <div class="stack">
        <textarea class="input input--title" rows="1" data-k="title" aria-label="Page title"></textarea>
        <div id="body"></div>
      </div>
      <div class="editor__side"><section class="panel stack--sm"><h3>Page settings</h3>
        <div class="field"><label for="s">Address</label><div class="input-row"><span class="hint mono">#/</span><input class="input mono" id="s" data-k="slug"></div></div>
        <label class="check"><input type="checkbox" data-k="sidebar">Show the sidebar widgets</label>
        <label class="check"><input type="checkbox" id="nav" ${inNav() ? 'checked' : ''}>Show in the main menu</label>
      </section></div>
    </div>`;
  let oldSlug = p.slug;
  bind(view, p, (path) => { if (path === 'title') setTitle(p.title); });
  autoGrow(view.querySelector('.input--title'));
  view.querySelector('#s').addEventListener('change', (e) => {
    const next = uniqueSlug(d.pages, slugify(e.target.value) || slugify(p.title), p.id);
    p.slug = next;
    e.target.value = next;
    for (const list of [d.nav, d.footerNav || []]) list.forEach((n) => { if (n.type === 'page' && n.target === oldSlug) n.target = next; });
    oldSlug = next;
    view.querySelector('#pv').href = `./?preview=1#/${encodeURIComponent(next)}`;
    changed();
  });
  view.querySelector('#nav').addEventListener('change', (e) => {
    if (e.target.checked) d.nav.push({ label: p.title, type: 'page', target: p.slug });
    else d.nav = d.nav.filter((n) => !(n.type === 'page' && n.target === p.slug));
    changed();
  });
  mountEditor(view.querySelector('#body'), p.body, (html) => { p.body = html; }, 'Write the page…');
  view.querySelector('#del').addEventListener('click', async () => {
    const ok = await confirmDialog({ title: `Delete “${esc(p.title)}”?`, body: 'Menu links to this page are removed too.', confirm: 'Delete', danger: true });
    if (!ok) return;
    d.pages = d.pages.filter((x) => x !== p);
    d.nav = d.nav.filter((n) => !(n.type === 'page' && n.target === p.slug));
    if (d.footerNav) d.footerNav = d.footerNav.filter((n) => !(n.type === 'page' && n.target === p.slug));
    changed();
    location.hash = '#/pages';
  });
}

/* ================================================================== navigation */
const NAV_TYPES = [['home', 'Homepage'], ['category', 'Category'], ['page', 'Page'], ['authors', 'Authors list'], ['article', 'Article'], ['url', 'Web address']];

function navEditor(el, getList, setList) {
  const d = state.draft;
  const targetField = (item, i) => {
    if (item.type === 'category') return `<select class="select" data-target="${i}" aria-label="Category">${d.categories.map((c) => `<option value="${esc(c.slug)}" ${c.slug === item.target ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`;
    if (item.type === 'page') return `<select class="select" data-target="${i}" aria-label="Page">${d.pages.map((p) => `<option value="${esc(p.slug)}" ${p.slug === item.target ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}</select>`;
    if (item.type === 'article') return `<select class="select" data-target="${i}" aria-label="Article">${d.posts.map((p) => `<option value="${esc(p.slug)}" ${p.slug === item.target ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}</select>`;
    if (item.type === 'url') return `<input class="input" data-target="${i}" value="${esc(item.target)}" placeholder="https://" aria-label="Address">`;
    return '<span class="hint">No target needed</span>';
  };
  const render = () => {
    const list = getList();
    el.innerHTML = `<div class="list-editor">${list.map((item, i) => `
      <div class="list-item list-item--nav"><span class="num">${String(i + 1).padStart(2, '0')}</span>
        <input class="input" data-label="${i}" value="${esc(item.label)}" aria-label="Label">
        <select class="select nav-type" data-type="${i}" aria-label="Link type">${NAV_TYPES.map(([v, l]) => `<option value="${v}" ${v === item.type ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <div class="nav-target">${targetField(item, i)}</div>
        ${item.type === 'url' ? `<label class="check" title="Open in a new tab"><input type="checkbox" data-tab="${i}" ${item.newTab !== false ? 'checked' : ''}>New tab</label>` : '<span></span>'}
        <div class="row-actions">
          <button class="icon-btn" data-up="${i}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}><i class="ph-bold ph-arrow-up"></i></button>
          <button class="icon-btn" data-down="${i}" aria-label="Move down" ${i === list.length - 1 ? 'disabled' : ''}><i class="ph-bold ph-arrow-down"></i></button>
          <button class="icon-btn" data-rm="${i}" aria-label="Remove"><i class="ph-bold ph-x"></i></button>
        </div>
      </div>`).join('') || '<div class="list-empty">The menu is empty.</div>'}</div>
      <button class="btn btn--ghost btn--sm" style="margin-top:12px" data-add><i class="ph-bold ph-plus"></i>Add link</button>`;
    const commit = (next, rerender = true) => { setList(next); changed(); if (rerender) render(); };
    el.querySelectorAll('[data-label]').forEach((inp) => inp.addEventListener('input', () => { list[+inp.dataset.label].label = inp.value; commit(list, false); }));
    el.querySelectorAll('[data-type]').forEach((sel) => sel.addEventListener('change', () => {
      const item = list[+sel.dataset.type];
      item.type = sel.value;
      item.target = sel.value === 'category' ? d.categories[0]?.slug || '' : sel.value === 'page' ? d.pages[0]?.slug || '' : sel.value === 'article' ? d.posts[0]?.slug || '' : '';
      commit(list);
    }));
    el.querySelectorAll('[data-target]').forEach((t) => t.addEventListener(t.tagName === 'SELECT' ? 'change' : 'input', () => { list[+t.dataset.target].target = t.value; commit(list, false); }));
    el.querySelectorAll('[data-tab]').forEach((cb) => cb.addEventListener('change', () => { list[+cb.dataset.tab].newTab = cb.checked; commit(list, false); }));
    el.querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', () => { const i = +b.dataset.up; [list[i - 1], list[i]] = [list[i], list[i - 1]]; commit(list); }));
    el.querySelectorAll('[data-down]').forEach((b) => b.addEventListener('click', () => { const i = +b.dataset.down; [list[i + 1], list[i]] = [list[i], list[i + 1]]; commit(list); }));
    el.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => commit(list.filter((_, i) => i !== +b.dataset.rm))));
    el.querySelector('[data-add]').addEventListener('click', () => commit([...list, { label: 'New link', type: 'url', target: '', newTab: true }]));
  };
  render();
}

function viewNavigation(view) {
  setTitle('Menus');
  const d = state.draft;
  view.innerHTML = `
    ${head('Menus', 'Links in the main navigation bar, mobile menu and footer.')}
    <section class="panel"><div class="panel-head"><div><h3>Main menu</h3><p class="hint">Shown under the masthead and in the mobile menu.</p></div></div><div id="main-nav"></div></section>
    <section class="panel"><div class="panel-head"><div><h3>Footer menu</h3></div></div>
      <label class="check" style="margin-bottom:14px"><input type="checkbox" id="same" ${d.footerNav ? '' : 'checked'}>Use the main menu in the footer</label>
      <div id="foot-nav"></div></section>`;
  navEditor(view.querySelector('#main-nav'), () => d.nav, (v) => { d.nav = v; });
  const renderFoot = () => {
    const el = view.querySelector('#foot-nav');
    if (!d.footerNav) { el.innerHTML = ''; return; }
    navEditor(el, () => d.footerNav, (v) => { d.footerNav = v; });
  };
  view.querySelector('#same').addEventListener('change', (e) => {
    d.footerNav = e.target.checked ? null : clone(d.nav);
    changed();
    renderFoot();
  });
  renderFoot();
}

/* ================================================================== settings */
const NETWORKS = ['linkedin', 'x', 'facebook', 'instagram', 'youtube', 'tiktok', 'threads', 'bluesky', 'email', 'rss', 'website'];

function viewSettings(view) {
  setTitle('Settings');
  const s = state.draft.site;
  s.magazine ??= {};
  s.social ??= [];
  view.innerHTML = `
    ${head('Site settings', 'Branding, masthead, footer and the links that appear on every page.')}
    <div class="editor">
      <div class="stack">
        <section class="panel stack"><h3>Identity</h3>
          <div class="grid-2"><div class="field"><label for="t">Site name</label><input class="input" id="t" data-k="title"></div>
          <div class="field"><label for="tg">Tagline</label><input class="input" id="tg" data-k="tagline"></div></div>
          <div class="field"><label for="ds">Description</label><textarea class="textarea" id="ds" data-k="description" rows="2"></textarea><span class="hint">Used by search engines and link previews.</span></div>
          <div class="grid-2"><div class="field"><label for="il">Masthead label</label><input class="input" id="il" data-k="issueLabel" placeholder="e.g. Issue No. 05 · Fall 2026"><span class="hint">Small text on the left of the masthead (optional).</span></div>
          <div class="field"><label for="th">Default theme</label><select class="select" id="th" data-k="defaultTheme"><option value="system">Follow the reader’s device</option><option value="light">Light</option><option value="dark">Dark</option></select></div></div>
          <label class="check"><input type="checkbox" data-k="showClock">Show the date and time in the top bar</label>
        </section>
        <section class="panel stack"><h3>Subscribe button</h3>
          <div class="grid-2"><div class="field"><label for="sl">Label</label><input class="input" id="sl" data-k="subscribeLabel"></div>
          <div class="field"><label for="su">Link</label><input class="input" id="su" data-k="subscribeUrl" placeholder="#/subscribe or https://…"><span class="hint">Leave empty to hide the button.</span></div></div>
        </section>
        <section class="panel stack"><h3>Magazine widget</h3>
          <div class="grid-2"><div class="field"><label for="mt">Title</label><input class="input" id="mt" data-k="magazine.title"></div>
          <div class="field"><label for="mc">Link text</label><input class="input" id="mc" data-k="magazine.cta" placeholder="Read the current issue"></div></div>
          <div class="field"><label for="mu">Link to the digital edition</label><input class="input" id="mu" data-k="magazine.url"></div>
          <div class="field"><span class="label">Cover image</span><div id="mag" class="image-field--contain"></div></div>
        </section>
        <section class="panel stack"><h3>Social links</h3><div id="social"></div></section>
        <section class="panel stack"><h3>Footer</h3>
          <div class="grid-2"><div class="field"><label for="ft">Copyright line</label><input class="input" id="ft" data-k="footerText"></div>
          <div class="field"><label for="fn">Footer note</label><input class="input" id="fn" data-k="footerNote"></div></div>
        </section>
      </div>
      <div class="editor__side">
        <section class="panel stack--sm"><h3>Logo</h3><div id="logo" class="image-field--contain"></div>
          <label class="check"><input type="checkbox" data-k="showLogo">Show the logo image (otherwise the site name is set in type)</label></section>
      </div>
    </div>`;
  bind(view, s);
  mountImage(view.querySelector('#logo'), s, 'logo', { maxWidth: 1200, empty: 'No logo' });
  mountImage(view.querySelector('#mag'), s, 'magazine.image', { maxWidth: 1000, empty: 'No cover' });

  const renderSocial = () => {
    const el = view.querySelector('#social');
    el.innerHTML = `<div class="list-editor">${s.social.map((item, i) => `
      <div class="list-item" style="grid-template-columns:160px minmax(0,1fr) auto">
        <select class="select" data-net="${i}" aria-label="Network">${NETWORKS.map((n) => `<option value="${n}" ${n === item.network ? 'selected' : ''}>${n}</option>`).join('')}</select>
        <input class="input" data-url="${i}" value="${esc(item.url)}" placeholder="https://" aria-label="Profile address">
        <button class="icon-btn" data-rm="${i}" aria-label="Remove"><i class="ph-bold ph-x"></i></button>
      </div>`).join('') || '<div class="list-empty">No social links.</div>'}</div>
      <button class="btn btn--ghost btn--sm" style="margin-top:12px" data-add><i class="ph-bold ph-plus"></i>Add link</button>`;
    el.querySelectorAll('[data-net]').forEach((x) => x.addEventListener('change', () => { s.social[+x.dataset.net].network = x.value; changed(); }));
    el.querySelectorAll('[data-url]').forEach((x) => x.addEventListener('input', () => { s.social[+x.dataset.url].url = x.value; changed(); }));
    el.querySelectorAll('[data-rm]').forEach((x) => x.addEventListener('click', () => { s.social.splice(+x.dataset.rm, 1); changed(); renderSocial(); }));
    el.querySelector('[data-add]').addEventListener('click', () => { s.social.push({ network: 'website', url: '' }); changed(); renderSocial(); });
  };
  renderSocial();
}

/* ================================================================== publishing & account */
function viewPublish(view) {
  setTitle('Publishing & account');
  const admin = state.admin;
  const gh = { owner: '', repo: '', branch: 'main', root: 'docs', ...(guessRepo() || {}), ...Object.fromEntries(Object.entries(admin.github || {}).filter(([, v]) => v)) };
  const be = backend();
  const needPassword = !state.password;
  const pwField = (id) => (needPassword ? `<div class="field"><label for="${id}">Your current password</label><input class="input" id="${id}" type="password" autocomplete="current-password" required><span class="hint">Needed to encrypt the token. You signed in earlier in this session, so it is not kept in memory.</span></div>` : '');

  view.innerHTML = `
    ${head('Publishing & account', 'How changes reach the live site, plus your sign-in details and backups.')}
    ${connectionNotice(be)}
    <div class="grid-2" style="align-items:start">
      <div class="stack">
        <section class="panel">
          <div class="panel-head"><div><h3>GitHub connection</h3><p class="hint">The admin commits <span class="code">${esc(gh.root || '')}/data/content.json</span> and uploaded images to this repository. GitHub Pages then rebuilds the site.</p></div></div>
          <form class="stack--sm" id="gh">
            <div class="grid-2"><div class="field"><label for="go">Owner</label><input class="input" id="go" name="owner" value="${esc(gh.owner)}" placeholder="github-username"></div>
            <div class="field"><label for="gr">Repository</label><input class="input" id="gr" name="repo" value="${esc(gh.repo)}" placeholder="envoy-magazine-site"></div></div>
            <div class="grid-2"><div class="field"><label for="gb">Branch</label><input class="input" id="gb" name="branch" value="${esc(gh.branch)}"></div>
            <div class="field"><label for="gf">Site folder</label><input class="input" id="gf" name="root" value="${esc(gh.root)}"><span class="hint">Folder GitHub Pages serves. Use <span class="code">docs</span>, or leave empty for the repository root.</span></div></div>
            <div class="field"><label for="gt">Personal access token</label><input class="input" id="gt" name="token" type="password" autocomplete="off" placeholder="${admin.token ? 'Saved (encrypted). Enter a new token to replace it.' : 'github_pat_…'}">
              <span class="hint">Create a fine-grained token at github.com → Settings → Developer settings, limited to this repository with <strong>Contents: Read and write</strong>. It is stored encrypted with your password.</span></div>
            ${pwField('gp')}
            <div class="input-row"><button class="btn" type="submit">Save connection</button><button class="btn btn--ghost" type="button" id="test">Test</button>${admin.token ? '<button class="btn btn--ghost" type="button" id="forget">Remove token</button>' : ''}</div>
          </form>
        </section>
        <section class="panel stack--sm">
          <h3>Working locally</h3>
          <p class="hint">Run <span class="code">npm run dev</span> in the project folder and open <span class="code">http://localhost:4173/admin/</span>. Publish then writes files straight into <span class="code">docs/</span>; commit and push them with git.</p>
        </section>
      </div>
      <div class="stack">
        <section class="panel">
          <div class="panel-head"><div><h3>Sign-in details</h3><p class="hint">Saved as a salted hash in <span class="code">data/admin.json</span>.</p></div></div>
          <form class="stack--sm" id="acct">
            <div class="field"><label for="un">Username</label><input class="input" id="un" name="username" value="${esc(admin.username)}" autocomplete="username" required></div>
            <div class="field"><label for="cp">Current password</label><input class="input" id="cp" name="current" type="password" autocomplete="current-password" required></div>
            <div class="grid-2"><div class="field"><label for="np">New password</label><input class="input" id="np" name="next" type="password" autocomplete="new-password" minlength="10"></div>
            <div class="field"><label for="np2">Repeat new password</label><input class="input" id="np2" name="next2" type="password" autocomplete="new-password"></div></div>
            <span class="hint">At least 10 characters. Leave the new password empty to change only the username.</span>
            <div><button class="btn" type="submit">Update sign-in</button></div>
          </form>
        </section>
        <section class="panel stack--sm">
          <h3>Backup and restore</h3>
          <p class="hint">Download the content (including unpublished changes) as JSON, or load a previous export.</p>
          <div class="input-row" style="flex-wrap:wrap">
            <button class="btn btn--ghost" id="export"><i class="ph-bold ph-download-simple"></i>Export content</button>
            <label class="btn btn--ghost"><i class="ph-bold ph-upload-simple"></i>Import content<input type="file" accept="application/json,.json" id="import" hidden></label>
          </div>
          <div class="divider"></div>
          <h3>Unpublished changes</h3>
          <p class="hint">${isDirty() ? 'You have changes that are not live yet.' : 'Everything matches the live site.'}</p>
          <div><button class="btn btn--danger" id="discard" ${isDirty() ? '' : 'disabled'}><i class="ph-bold ph-arrow-counter-clockwise"></i>Discard unpublished changes</button></div>
        </section>
      </div>
    </div>`;

  const $ = (s) => view.querySelector(s);

  $('#gh').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const password = state.password || f.querySelector('#gp')?.value;
    const next = clone(state.admin);
    next.github = { owner: f.owner.value.trim(), repo: f.repo.value.trim(), branch: f.branch.value.trim() || 'main', root: f.root.value.trim().replace(/^\/|\/$/g, '') };
    const newToken = f.token.value.trim();
    try {
      if (newToken) {
        if (!password || !(await verifyLogin(state.admin, state.admin.username, password))) throw new Error('Your password is incorrect.');
        state.password = password;
        next.token = await encryptSecret(newToken, password);
        state.token = newToken;
        writeSession();
      }
      await saveAdmin(next);
      toast('Connection saved.');
      route();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#test').addEventListener('click', async () => {
    const f = $('#gh');
    const token = f.token.value.trim() || state.token;
    if (!token) { toast('Enter a token first.', 'error'); return; }
    try {
      const repo = await githubBackend({ owner: f.owner.value.trim(), repo: f.repo.value.trim(), branch: f.branch.value.trim(), root: f.root.value.trim() }, token).test();
      toast(`Connected to ${repo.full_name}. Token can write.`);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#forget')?.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Remove the saved token?', body: 'Publishing from the browser will stop until a new token is added.', confirm: 'Remove', danger: true });
    if (!ok) return;
    const next = clone(state.admin);
    next.token = null;
    try {
      await saveAdmin(next);
      state.token = null;
      writeSession();
      toast('Token removed.');
      route();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#acct').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const username = f.username.value.trim();
    const current = f.current.value;
    const nextPw = f.next.value;
    try {
      if (!(await verifyLogin(state.admin, state.admin.username, current))) throw new Error('Current password is incorrect.');
      if (nextPw && nextPw !== f.next2.value) throw new Error('The new passwords do not match.');
      if (nextPw && nextPw.length < 10) throw new Error('Use at least 10 characters.');
      const password = nextPw || current;
      const creds = await newCredentials(username, password);
      const next = { ...clone(state.admin), ...creds };
      const token = state.token || (state.admin.token ? await decryptSecret(state.admin.token, current) : null);
      next.token = token ? await encryptSecret(token, password) : null;
      await saveAdmin(next);
      state.user = username;
      state.password = password;
      state.token = token;
      writeSession();
      toast('Sign-in details updated.');
      route();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#export').addEventListener('click', () => {
    const stamp = new Date().toISOString().slice(0, 10);
    download(`envoy-content-${stamp}.json`, JSON.stringify(state.draft, null, 1), 'application/json');
  });

  $('#import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.posts) || !data.site) throw new Error('This file does not look like an Envoy content export.');
      const ok = await confirmDialog({ title: 'Replace current content?', body: `The import has ${data.posts.length} articles and ${data.pages?.length || 0} pages. It replaces your working copy; nothing goes live until you publish.`, confirm: 'Import' });
      if (!ok) return;
      for (const key of ['nav', 'categories', 'authors', 'pages']) data[key] ??= [];
      data.home ??= {};
      state.draft = data;
      changed();
      toast('Content imported. Review it, then publish.');
      route();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#discard').addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Discard all unpublished changes?', body: 'Your working copy will be reset to what is live on the site.', confirm: 'Discard', danger: true });
    if (!ok) return;
    discardDraft();
    toast('Changes discarded.');
    route();
  });
}

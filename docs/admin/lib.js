// Admin infrastructure: password hashing, token encryption, and the two
// publishing backends (local dev server, GitHub Contents API).
//
// Security model: the site is static, so admin.json is public. It holds only a
// salted PBKDF2 hash of the password and the GitHub token encrypted with a key
// derived from that same password. Publishing needs the decrypted token, so
// nobody can change the live site without knowing the password.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64 = {
  from(bytes) {
    let s = '';
    const arr = new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i += 0x8000) s += String.fromCharCode(...arr.subarray(i, i + 0x8000));
    return btoa(s);
  },
  to(str) {
    return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
  },
  text(str) {
    return b64.from(enc.encode(str));
  },
};

const ITERATIONS = 310000;

async function baseKey(password) {
  return crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits', 'deriveKey']);
}

export async function hashPassword(password, saltB64, iterations = ITERATIONS) {
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: b64.to(saltB64), iterations, hash: 'SHA-256' },
    await baseKey(password),
    256,
  );
  return b64.from(bits);
}

export async function verifyLogin(admin, username, password) {
  if (!admin?.passwordHash || !admin?.kdf?.salt) return false;
  const hash = await hashPassword(password, admin.kdf.salt, admin.kdf.iterations || ITERATIONS);
  // constant-time-ish comparison
  const a = hash;
  const b = admin.passwordHash;
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0 && username.trim() === admin.username;
}

export async function newCredentials(username, password) {
  const salt = b64.from(crypto.getRandomValues(new Uint8Array(16)));
  return {
    username: username.trim(),
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt },
    passwordHash: await hashPassword(password, salt),
  };
}

async function aesKey(password, salt, usage) {
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    await baseKey(password),
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

export async function encryptSecret(secret, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(password, salt, 'encrypt'), enc.encode(secret));
  return { salt: b64.from(salt), iv: b64.from(iv), data: b64.from(data) };
}

export async function decryptSecret(box, password) {
  if (!box?.data) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64.to(box.iv) },
      await aesKey(password, b64.to(box.salt), 'decrypt'),
      b64.to(box.data),
    );
    return dec.decode(plain);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ backends */

export async function detectLocal() {
  try {
    const res = await fetch('__local/ping', { cache: 'no-store' });
    if (!res.ok) return false;
    const json = await res.json();
    return json.mode === 'local';
  } catch {
    return false;
  }
}

export function guessRepo() {
  const host = location.hostname;
  if (!host.endsWith('.github.io')) return null;
  const owner = host.split('.')[0];
  const seg = location.pathname.split('/').filter(Boolean)[0];
  return { owner, repo: seg && seg !== 'admin' ? seg : `${owner}.github.io` };
}

export const localBackend = {
  name: 'local',
  label: 'Local files',
  async write(path, content, { base64 = false } = {}) {
    const res = await fetch('__local/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content, encoding: base64 ? 'base64' : 'utf8' }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `Save failed (${res.status})`);
    return json;
  },
};

export function githubBackend({ owner, repo, branch = 'main', root = 'docs' }, token) {
  const api = 'https://api.github.com';
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const full = (path) => [root, path].filter(Boolean).join('/').replace(/\/+/g, '/').replace(/^\//, '');
  const url = (path) => `${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${full(path).split('/').map(encodeURIComponent).join('/')}`;

  async function sha(path) {
    const res = await fetch(`${url(path)}?ref=${encodeURIComponent(branch)}&t=${Date.now()}`, { headers, cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(await errorText(res));
    return (await res.json()).sha;
  }

  return {
    name: 'github',
    label: `GitHub · ${owner}/${repo}@${branch}`,
    async test() {
      const res = await fetch(`${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { headers });
      if (!res.ok) throw new Error(await errorText(res));
      const json = await res.json();
      if (json.permissions && !json.permissions.push) throw new Error('This token can read the repository but cannot write to it.');
      return json;
    },
    async write(path, content, { base64 = false, message } = {}) {
      const body = {
        message: message || `Update ${path} from admin panel`,
        content: base64 ? content : b64.text(content),
        branch,
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        const current = await sha(path);
        if (current) body.sha = current;
        const res = await fetch(url(path), { method: 'PUT', headers, body: JSON.stringify(body) });
        if (res.ok) return res.json();
        if (res.status === 409 && attempt === 0) continue; // sha raced, retry once
        throw new Error(await errorText(res));
      }
    },
  };
}

async function errorText(res) {
  let msg = `GitHub responded ${res.status}`;
  try {
    const j = await res.json();
    if (j.message) msg += `: ${j.message}`;
  } catch {}
  if (res.status === 401) msg += ' (the token is invalid or expired)';
  if (res.status === 404) msg += ' (check owner, repository, branch, and that the token can access it)';
  return msg;
}

/* ------------------------------------------------------------------ images */

// Downscale and re-encode an uploaded image in the browser before saving it.
export async function prepareImage(file, maxWidth = 1600) {
  if (file.type === 'image/svg+xml' || file.type === 'image/gif') {
    const buf = await file.arrayBuffer();
    return { base64: b64.from(buf), ext: file.type === 'image/gif' ? 'gif' : 'svg', mime: file.type };
  }
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxWidth / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  const keepAlpha = file.type === 'image/png';
  if (!keepAlpha) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const mime = keepAlpha ? 'image/png' : 'image/jpeg';
  const blob = await new Promise((r) => canvas.toBlob(r, mime, 0.85));
  return { base64: b64.from(await blob.arrayBuffer()), ext: keepAlpha ? 'png' : 'jpg', mime };
}

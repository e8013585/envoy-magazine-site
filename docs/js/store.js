// Content access helpers shared by the public site and the admin panel.

export const DRAFT_KEY = 'envoy.admin.draft';

export async function fetchContent(base = '') {
  const res = await fetch(`${base}data/content.json?v=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not load content (${res.status})`);
  return res.json();
}

export function readDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function createStore(content, { includeDrafts = false } = {}) {
  const now = Date.now();
  const isLive = (p) => includeDrafts || (p.status === 'published' && new Date(p.date).getTime() <= now + 60_000);
  const posts = [...(content.posts || [])].filter(isLive).sort((a, b) => new Date(b.date) - new Date(a.date));
  const byId = new Map(posts.map((p) => [p.id, p]));
  const bySlug = new Map(posts.map((p) => [p.slug, p]));
  const cats = new Map((content.categories || []).map((c) => [c.slug, c]));
  const authors = new Map((content.authors || []).map((a) => [a.slug, a]));
  const pages = new Map((content.pages || []).map((p) => [p.slug, p]));

  const counts = new Map();
  for (const p of posts) counts.set(p.author, (counts.get(p.author) || 0) + 1);

  return {
    content,
    site: content.site || {},
    home: content.home || {},
    posts,
    post: (slug) => bySlug.get(slug),
    postById: (id) => byId.get(id),
    pick: (ids = []) => ids.map((id) => byId.get(id)).filter(Boolean),
    category: (slug) => cats.get(slug),
    categories: () => [...cats.values()],
    inCategory: (slug) => posts.filter((p) => (p.categories || []).includes(slug)),
    author: (slug) => authors.get(slug),
    authors: () => [...authors.values()],
    byAuthor: (slug) => posts.filter((p) => p.author === slug),
    authorCount: (slug) => counts.get(slug) || 0,
    page: (slug) => pages.get(slug),
    search(q) {
      const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
      if (!terms.length) return [];
      return posts
        .map((p) => {
          const author = authors.get(p.author)?.name || '';
          const hay = `${p.title} ${p.excerpt} ${author} ${(p.categories || []).map((c) => cats.get(c)?.name || c).join(' ')} ${stripTags(p.body || '')}`.toLowerCase();
          let score = 0;
          for (const t of terms) {
            if (!hay.includes(t)) return null;
            if (p.title.toLowerCase().includes(t)) score += 3;
            score += 1;
          }
          return { p, score };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .map((r) => r.p);
    },
  };
}

export function stripTags(html) {
  return String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function readingTime(post) {
  if (post.readTime) return post.readTime;
  const words = stripTags(post.body || post.excerpt || '').split(' ').length;
  return Math.max(1, Math.round(words / 220));
}

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function slugify(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-')
    .slice(0, 90);
}

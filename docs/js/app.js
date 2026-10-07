import { fetchContent, readDraft, createStore, esc, readingTime } from './store.js';

const preview = new URLSearchParams(location.search).has('preview');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (sel, root = document) => root.querySelector(sel);
const main = $('#main');
let S;
let timers = [];

const SOCIAL_ICONS = {
  linkedin: 'ph-linkedin-logo', x: 'ph-x-logo', twitter: 'ph-x-logo', facebook: 'ph-facebook-logo',
  instagram: 'ph-instagram-logo', youtube: 'ph-youtube-logo', tiktok: 'ph-tiktok-logo',
  threads: 'ph-threads-logo', bluesky: 'ph-butterfly', email: 'ph-envelope-simple', rss: 'ph-rss', website: 'ph-globe',
};
const TAG_COLORS = ['blue', 'green', 'yellow', 'red', 'gray'];

/* ------------------------------------------------------------------ boot */
init().catch((err) => {
  console.error(err);
  main.innerHTML = `<div class="container section"><div class="empty"><h2>Something went wrong</h2><p>${esc(err.message)}</p></div></div>`;
});

async function init() {
  let content = null;
  if (preview) content = readDraft();
  const usingDraft = Boolean(content);
  if (!content) content = await fetchContent();
  S = createStore(content, { includeDrafts: usingDraft });
  renderChrome();
  if (preview && readDraft()) {
    document.body.insertAdjacentHTML('beforeend', `<div class="preview-bar" role="status">Previewing unpublished changes <a href="admin/">Back to admin</a></div>`);
  }
  addEventListener('hashchange', route);
  route();
}

/* ------------------------------------------------------------------ helpers */
const postUrl = (p) => `#/article/${encodeURIComponent(p.slug)}`;
const catUrl = (slug) => `#/category/${encodeURIComponent(slug)}`;
const authorUrl = (slug) => `#/author/${encodeURIComponent(slug)}`;

function navHref(item) {
  switch (item.type) {
    case 'home': return '#/';
    case 'category': return catUrl(item.target);
    case 'page': return `#/${item.target}`;
    case 'authors': return '#/authors';
    case 'article': return `#/article/${item.target}`;
    default: return item.target || '#/';
  }
}

function img(path) {
  if (!path) return '';
  return path;
}

function tagColor(slug) {
  const cat = S.category(slug);
  if (cat?.color && TAG_COLORS.includes(cat.color)) return cat.color;
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TAG_COLORS[h % 4];
}

function tags(post, max = 2) {
  const list = (post.categories || []).slice(0, max);
  if (!list.length) return '';
  return `<div class="tags">${list.map((slug) => {
    const name = S.category(slug)?.name || slug;
    return `<a class="tag tag--${tagColor(slug)}" href="${catUrl(slug)}">${esc(name)}</a>`;
  }).join('')}</div>`;
}

function formatDate(iso, { relative = true } = {}) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diff = (Date.now() - d.getTime()) / 1000;
  if (relative && diff >= 0 && diff < 60 * 60 * 24 * 30) {
    const units = [[86400, 'day'], [3600, 'hour'], [60, 'minute']];
    for (const [s, name] of units) {
      const n = Math.floor(diff / s);
      if (n >= 1) return `${n} ${name}${n > 1 ? 's' : ''} ago`;
    }
    return 'just now';
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function initials(name = '') {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

function avatar(author, cls = '') {
  if (!author) return '';
  if (author.avatar) return `<img class="avatar ${cls}" src="${esc(img(author.avatar))}" alt="" loading="lazy">`;
  return `<span class="avatar ${cls}" aria-hidden="true">${esc(initials(author.name))}</span>`;
}

function meta(post, { author = true, date = true, read = false } = {}) {
  const a = S.author(post.author);
  const parts = [];
  if (author && a) parts.push(`<a class="author" href="${authorUrl(a.slug)}">${avatar(a)}${esc(a.name)}</a>`);
  if (date) parts.push(`<time datetime="${esc(post.date)}" title="${esc(new Date(post.date).toLocaleString())}">${formatDate(post.date)}</time>`);
  if (read) parts.push(`<span>${readingTime(post)} min read</span>`);
  return `<div class="meta">${parts.join('')}</div>`;
}

function thumb(post, { eager = false, sizes = '' } = {}) {
  if (!post.image) return `<div class="thumb thumb--empty" aria-hidden="true">${esc((S.site.title || 'e')[0])}</div>`;
  return `<div class="thumb"><img src="${esc(img(post.image))}" alt="${esc(post.imageAlt || '')}" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" ${sizes}></div>`;
}

function headline(post, tag = 'h2') {
  return `<${tag} class="headline"><a href="${postUrl(post)}">${esc(post.title)}</a></${tag}>`;
}

function socialLinks(list = []) {
  return list.filter((s) => s.url).map((s) => `<a class="icon-btn" href="${esc(s.url)}" target="_blank" rel="noopener" aria-label="${esc(s.network)}"><i class="ph-bold ${SOCIAL_ICONS[s.network] || 'ph-globe'}"></i></a>`).join('');
}

function logo(cls = '') {
  const site = S.site;
  if (site.showLogo !== false && site.logo) return `<img class="${cls}" src="${esc(img(site.logo))}" alt="${esc(site.title || 'Home')}">`;
  return `<span class="brand__title">${esc(site.title || '')}</span>`;
}

function sanitize(html) {
  if (window.DOMPurify) {
    if (!sanitize.hooked) {
      window.DOMPurify.addHook('uponSanitizeElement', (node, data) => {
        if (data.tagName === 'iframe') {
          const src = node.getAttribute('src') || '';
          if (!/^https:\/\/(www\.)?(youtube\.com|youtube-nocookie\.com|player\.vimeo\.com)\//.test(src)) node.remove();
        }
      });
      window.DOMPurify.addHook('afterSanitizeAttributes', (node) => {
        if (node.tagName === 'A' && /^https?:/i.test(node.getAttribute('href') || '') && !node.getAttribute('href').startsWith(location.origin)) {
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener');
        }
      });
      sanitize.hooked = true;
    }
    return window.DOMPurify.sanitize(html, { ADD_TAGS: ['iframe'], ADD_ATTR: ['allow', 'allowfullscreen', 'frameborder', 'target'] });
  }
  // Fallback if the CDN script failed to load: drop scripts, handlers and javascript: URLs.
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  doc.querySelectorAll('script,style,object,embed,iframe,form').forEach((n) => n.remove());
  doc.querySelectorAll('*').forEach((n) => [...n.attributes].forEach((a) => {
    if (/^on/i.test(a.name) || /^\s*javascript:/i.test(a.value)) n.removeAttribute(a.name);
  }));
  return doc.body.firstChild.innerHTML;
}

function setTitle(title, description) {
  document.title = title ? `${title} – ${capitalize(S.site.title || 'Envoy')}` : `${capitalize(S.site.title || 'Envoy')} – ${S.site.tagline || ''}`;
  const m = $('meta[name="description"]');
  if (m) m.setAttribute('content', description || S.site.description || '');
}
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}

/* ------------------------------------------------------------------ chrome */
function renderChrome() {
  const site = S.site;
  $('#brand').innerHTML = `<a class="brand__logo" href="#/" aria-label="${esc(site.title)} home">${logo()}</a>${site.tagline ? `<p class="brand__tagline">${esc(site.tagline)}</p>` : ''}`;
  $('#nav-brand').innerHTML = logo();
  $('#drawer-brand').innerHTML = logo();
  $('#footer-brand').innerHTML = `${logo()}${site.tagline ? `<p>${esc(site.tagline)}</p>` : ''}`;
  $('#issue-label').textContent = site.issueLabel || '';
  $('#masthead-right').innerHTML = site.subscribeUrl ? `<a class="btn" href="${esc(site.subscribeUrl)}"><i class="ph-bold ph-envelope-simple"></i>${esc(site.subscribeLabel || 'Subscribe')}</a>` : '';
  $('#social-top').innerHTML = socialLinks(site.social);
  $('#social-bottom').innerHTML = socialLinks(site.social);
  $('#footer-text').textContent = [site.footerText, site.footerNote].filter(Boolean).join('  ·  ');

  const navItem = (item) => {
    const ext = item.type === 'url' && /^https?:/.test(item.target);
    return `<li><a href="${esc(navHref(item))}" ${ext ? `class="ext" target="${item.newTab === false ? '_self' : '_blank'}" rel="noopener"` : ''}>${esc(item.label)}</a></li>`;
  };
  const nav = S.content.nav || [];
  $('#menu').innerHTML = nav.map(navItem).join('');
  $('#drawer-menu').innerHTML = nav.map(navItem).join('');
  $('#footer-menu').innerHTML = (S.content.footerNav || nav).map(navItem).join('');
  $('#drawer-extra').innerHTML = `${site.subscribeUrl ? `<a class="btn" href="${esc(site.subscribeUrl)}">${esc(site.subscribeLabel || 'Subscribe')}</a>` : ''}<div style="display:flex;gap:4px;margin-top:16px">${socialLinks(site.social)}</div>`;

  // clock
  const clock = $('#clock');
  if (site.showClock === false) clock.hidden = true;
  const tick = () => {
    const d = new Date();
    $('.date', clock).textContent = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    $('.time', clock).textContent = d.toLocaleTimeString('en-US');
  };
  tick();
  setInterval(tick, 1000);

  // ticker
  const t = S.home.ticker || {};
  const items = t.mode === 'manual' && t.ids?.length ? S.pick(t.ids) : S.posts.slice(0, t.count || 6);
  if (items.length && t.mode !== 'off') {
    const html = items.map((p) => `<a href="${postUrl(p)}">${esc(p.title)}</a>`).join('');
    const track = $('#ticker .ticker__track');
    track.innerHTML = html + html.replace(/<a /g, '<a tabindex="-1" aria-hidden="true" ');
    track.style.setProperty('--ticker-duration', `${Math.max(30, items.reduce((n, p) => n + p.title.length, 0) / 6)}s`);
    $('#ticker').hidden = false;
  }

  // theme
  const themeBtn = $('#theme-toggle');
  const currentTheme = () => document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  if (!document.documentElement.hasAttribute('data-theme') && site.defaultTheme && site.defaultTheme !== 'system') {
    document.documentElement.setAttribute('data-theme', site.defaultTheme);
  }
  const syncThemeIcon = () => { themeBtn.innerHTML = `<i class="ph-bold ${currentTheme() === 'dark' ? 'ph-sun' : 'ph-moon'}"></i>`; };
  syncThemeIcon();
  themeBtn.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('envoy.theme', next); } catch {}
    syncThemeIcon();
  });

  // search
  const panel = $('#search-panel');
  const toggle = $('#search-toggle');
  toggle.addEventListener('click', () => {
    const open = panel.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', open);
    if (open) $('#search-input').focus();
  });
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#search-input').value.trim();
    if (!q) return;
    panel.classList.remove('is-open');
    toggle.setAttribute('aria-expanded', 'false');
    location.hash = `#/search/${encodeURIComponent(q)}`;
  });

  // drawer
  const drawer = $('#drawer');
  const openBtn = $('#menu-open');
  const setDrawer = (open) => {
    drawer.classList.toggle('is-open', open);
    drawer.setAttribute('aria-hidden', !open);
    openBtn.setAttribute('aria-expanded', open);
    document.body.style.overflow = open ? 'hidden' : '';
    if (open) $('[data-close]', drawer.querySelector('.drawer__panel'))?.focus();
  };
  openBtn.addEventListener('click', () => setDrawer(true));
  drawer.addEventListener('click', (e) => { if (e.target.closest('[data-close]') || e.target.closest('a')) setDrawer(false); });
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    setDrawer(false);
    panel.classList.remove('is-open');
  });

  // back to top, shown once the masthead scrolls away
  const toTop = $('#to-top');
  toTop.addEventListener('click', () => scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' }));
  new IntersectionObserver(([entry]) => toTop.classList.toggle('is-visible', !entry.isIntersecting)).observe($('.topbar'));
}

function markActiveNav(hash) {
  document.querySelectorAll('#menu a, #drawer-menu a').forEach((a) => {
    const href = a.getAttribute('href');
    const active = href === hash || (href !== '#/' && hash.startsWith(href + '/'));
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

/* ------------------------------------------------------------------ router */
function route() {
  timers.forEach(clearInterval);
  timers = [];
  document.body.classList.remove('is-article');
  const hash = location.hash || '#/';
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [head, a, b] = parts;
  const num = (v) => Math.max(1, parseInt(v, 10) || 1);

  let html;
  if (!head) html = viewHome(1);
  else if (head === 'page' && a) html = viewHome(num(a));
  else if (head === 'article') html = viewArticle(a);
  else if (head === 'category') html = viewCategory(a, num(b));
  else if (head === 'author') html = viewAuthor(a, num(b));
  else if (head === 'authors') html = viewAuthors();
  else if (head === 'search') html = viewSearch(a || '');
  else html = viewPage(head);

  main.innerHTML = html;
  markActiveNav(hash.split('/').slice(0, 3).join('/'));
  if (!route.first) route.first = true;
  else { scrollTo(0, 0); main.focus({ preventScroll: true }); }
  hydrate();
}

/* ------------------------------------------------------------------ views */
function viewHome(page) {
  const home = S.home;
  const perPage = home.perPage || 10;
  const slider = S.pick(home.slider);
  const trailing = S.pick(home.trailing);
  const exclude = new Set(page === 1 ? [] : []);
  const list = S.posts.filter((p) => !exclude.has(p.id));
  const pageCount = Math.max(1, Math.ceil(list.length / perPage));
  const slice = list.slice((page - 1) * perPage, page * perPage);
  setTitle(page > 1 ? `Latest – page ${page}` : '');

  const banner = page === 1 && (slider.length || trailing.length) ? `
    <section class="banner" aria-label="Top stories">
      <div class="container">
        <div class="banner__grid">
          ${slider.length ? heroSlider(slider) : '<div></div>'}
          <div class="trailing">
            ${trailing.map((p, i) => `
              <article class="trail reveal" style="--i:${i + 1}">
                <a href="${postUrl(p)}" tabindex="-1" aria-hidden="true">${thumb(p)}</a>
                ${tags(p)}
                ${headline(p, 'h3')}
                ${meta(p)}
              </article>`).join('')}
          </div>
        </div>
      </div>
    </section>` : '';

  const missed = page === 1 ? S.pick(home.missed) : [];
  const missedHtml = missed.length ? `
    <section class="band section" aria-labelledby="missed-title">
      <div class="container">
        <div class="section-head"><h2 class="section-title" id="missed-title">${esc(home.missedTitle || 'You May Have Missed')}</h2></div>
        <div class="grid-4">
          ${missed.map((p, i) => `
            <article class="tile reveal" style="--i:${i % 4}">
              <a href="${postUrl(p)}" tabindex="-1" aria-hidden="true">${thumb(p)}</a>
              <div style="display:grid;gap:10px">${tags(p, 1)}${headline(p, 'h3')}${meta(p, { author: false })}</div>
            </article>`).join('')}
        </div>
      </div>
    </section>` : '';

  return `${banner}
    <section class="section">
      <div class="container layout">
        <div>
          <div class="section-head"><h2 class="section-title">${page > 1 ? `Latest · Page ${page}` : esc(home.latestTitle || 'Latest Stories')}</h2></div>
          ${storyList(slice)}
          ${pagination(page, pageCount, (n) => (n === 1 ? '#/' : `#/page/${n}`))}
        </div>
        ${sidebar()}
      </div>
    </section>
    ${missedHtml}`;
}

function heroSlider(slides) {
  return `
    <div class="hero" data-hero>
      <div class="hero__slides">
        ${slides.map((p, i) => `
          <article class="hero__slide ${i === 0 ? 'is-active' : ''}" aria-roledescription="slide" aria-label="${i + 1} of ${slides.length}">
            <a href="${postUrl(p)}" tabindex="-1" aria-hidden="true">${thumb(p, { eager: i === 0 })}</a>
            <div class="hero__body">
              <div class="hero__top">${tags(p, 3)}${meta(p, { author: false })}</div>
              ${headline(p, i === 0 ? 'h1' : 'h2')}
              ${p.excerpt ? `<p class="excerpt">${esc(p.excerpt)}</p>` : ''}
              ${meta(p, { date: false, read: true })}
            </div>
          </article>`).join('')}
      </div>
      ${slides.length > 1 ? `
        <div class="hero__progress"><span></span></div>
        <div class="hero__controls" style="margin-top:12px">
          <button type="button" data-prev aria-label="Previous story"><i class="ph-bold ph-arrow-left"></i></button>
          <span class="hero__count" aria-live="polite">01 / ${String(slides.length).padStart(2, '0')}</span>
          <button type="button" data-next aria-label="Next story"><i class="ph-bold ph-arrow-right"></i></button>
        </div>` : ''}
    </div>`;
}

function storyList(posts) {
  if (!posts.length) return `<div class="empty"><h2>Nothing here yet</h2><p>New stories will appear here once they are published.</p></div>`;
  return `<div class="story-list">${posts.map((p, i) => `
    <article class="story reveal" style="--i:${i % 3}">
      <a href="${postUrl(p)}" tabindex="-1" aria-hidden="true">${thumb(p)}</a>
      <div class="story__body">
        ${tags(p)}
        ${headline(p)}
        ${meta(p, { read: true })}
        ${p.excerpt ? `<p class="excerpt">${esc(p.excerpt)}</p>` : ''}
        <a class="read-more" href="${postUrl(p)}">Read full story <i class="ph-bold ph-arrow-right"></i><span class="sr-only">: ${esc(p.title)}</span></a>
      </div>
    </article>`).join('')}</div>`;
}

function pagination(page, count, link) {
  if (count <= 1) return '';
  const nums = new Set([1, count, page - 1, page, page + 1].filter((n) => n >= 1 && n <= count));
  const sorted = [...nums].sort((a, b) => a - b);
  let out = '';
  if (page > 1) out += `<a href="${link(page - 1)}" aria-label="Previous page"><i class="ph-bold ph-arrow-left"></i></a>`;
  sorted.forEach((n, i) => {
    if (i && n - sorted[i - 1] > 1) out += '<span class="gap">…</span>';
    out += n === page ? `<span aria-current="page">${n}</span>` : `<a href="${link(n)}">${n}</a>`;
  });
  if (page < count) out += `<a href="${link(page + 1)}" aria-label="Next page"><i class="ph-bold ph-arrow-right"></i></a>`;
  return `<nav class="pagination" aria-label="Pagination">${out}</nav>`;
}

function sidebar() {
  const home = S.home;
  const order = home.widgets || ['magazine', 'highlights', 'popular', 'categoryList', 'categoryGrid'];
  const w = {
    magazine() {
      const m = S.site.magazine;
      if (!m?.image) return '';
      return `<section class="card widget widget--magazine">
        <div class="section-head"><h2 class="section-title">${esc(m.title || 'Magazine')}</h2></div>
        <a href="${esc(m.url || '#')}" target="_blank" rel="noopener">
          <div class="thumb"><img src="${esc(img(m.image))}" alt="Envoy magazine covers" loading="lazy"></div>
          <span class="read-more">${esc(m.cta || 'Read the current issue')} <i class="ph-bold ph-arrow-up-right"></i></span>
        </a>
      </section>`;
    },
    highlights() {
      const list = S.pick(home.highlights);
      if (!list.length) return '';
      return `<section class="card widget">
        <div class="section-head"><h2 class="section-title">${esc(home.highlightsTitle || 'Highlights')}</h2></div>
        <div class="carousel" data-carousel aria-roledescription="carousel">
          ${list.map((p, i) => `<article class="carousel__item ${i === 0 ? 'is-active' : ''}">
            <a href="${postUrl(p)}" tabindex="-1" aria-hidden="true">${thumb(p)}</a>
            ${tags(p)}${headline(p, 'h3')}${meta(p, { author: false })}
          </article>`).join('')}
          ${list.length > 1 ? `<div class="dots">${list.map((_, i) => `<button type="button" aria-label="Show highlight ${i + 1}" aria-current="${i === 0}"></button>`).join('')}</div>` : ''}
        </div>
      </section>`;
    },
    popular() {
      const list = S.pick(home.popular);
      if (!list.length) return '';
      return `<section class="card widget">
        <div class="section-head"><h2 class="section-title">${esc(home.popularTitle || 'Popular News')}</h2></div>
        <ol class="ranked">${list.map((p, i) => `<li>
          <span class="num">${String(i + 1).padStart(2, '0')}</span>
          <a href="${postUrl(p)}" tabindex="-1" aria-hidden="true">${thumb(p)}</a>
          <div>${headline(p, 'h3')}${tags(p, 1)}</div>
        </li>`).join('')}</ol>
      </section>`;
    },
    categoryList() {
      const cfg = home.categoryList;
      if (!cfg?.category) return '';
      const list = S.inCategory(cfg.category).slice(0, cfg.count || 6);
      if (!list.length) return '';
      const [first, ...rest] = list;
      return `<section class="card widget">
        <div class="section-head"><h2 class="section-title">${esc(cfg.title || S.category(cfg.category)?.name)}</h2><a class="section-link" href="${catUrl(cfg.category)}">All</a></div>
        <article class="lead-mini"><a href="${postUrl(first)}" tabindex="-1" aria-hidden="true">${thumb(first)}</a>${headline(first, 'h3')}${meta(first)}</article>
        <ol class="ranked ranked--text">${rest.map((p, i) => `<li><span class="num">${String(i + 2).padStart(2, '0')}</span><div>${headline(p, 'h3')}${meta(p, { author: false })}</div></li>`).join('')}</ol>
      </section>`;
    },
    categoryGrid() {
      const cfg = home.categoryGrid;
      if (!cfg?.category) return '';
      const list = S.inCategory(cfg.category).slice(0, cfg.count || 3);
      if (!list.length) return '';
      return `<section class="card widget">
        <div class="section-head"><h2 class="section-title">${esc(cfg.title || S.category(cfg.category)?.name)}</h2><a class="section-link" href="${catUrl(cfg.category)}">All</a></div>
        <div class="mini-grid">${list.map((p) => `<article class="mini"><a href="${postUrl(p)}" tabindex="-1" aria-hidden="true">${thumb(p)}</a><div>${headline(p, 'h3')}</div></article>`).join('')}</div>
      </section>`;
    },
  };
  return `<aside class="sidebar" aria-label="Sidebar">${order.map((k) => w[k]?.() || '').join('')}</aside>`;
}

function viewArticle(slug) {
  const p = S.post(slug);
  if (!p) return notFound();
  document.body.classList.add('is-article');
  setTitle(p.title, p.excerpt);
  const a = S.author(p.author);
  const related = (p.categories || []).flatMap((c) => S.inCategory(c)).filter((x, i, arr) => x.id !== p.id && arr.indexOf(x) === i).slice(0, 3);
  const fill = related.length < 3 ? S.posts.filter((x) => x.id !== p.id && !related.includes(x)).slice(0, 3 - related.length) : [];
  const more = [...related, ...fill];
  const shareUrl = encodeURIComponent(location.href);
  const shareTitle = encodeURIComponent(p.title);
  const hasBody = Boolean(p.body && p.body.replace(/<[^>]+>/g, '').trim());

  return `
    <article>
      <header class="container">
        <div class="article-head">
          <p class="eyebrow"><a href="#/">Home</a><span>/</span>${p.categories?.[0] ? `<a href="${catUrl(p.categories[0])}">${esc(S.category(p.categories[0])?.name || p.categories[0])}</a>` : ''}</p>
          <h1 class="page-title">${esc(p.title)}</h1>
          ${p.excerpt ? `<p class="article-dek">${esc(p.excerpt)}</p>` : ''}
          ${meta(p, { read: true })}
        </div>
      </header>
      ${p.image ? `<figure class="article-hero container" style="margin-top:0">${thumb(p, { eager: true })}${p.imageCaption ? `<figcaption>${esc(p.imageCaption)}</figcaption>` : ''}</figure>` : ''}
      <div class="container">
        <div class="article-wrap">
          ${tags(p, 6)}
          <div class="prose" style="margin-top:24px">
            ${hasBody ? sanitize(p.body) : ''}
          </div>
          ${!hasBody && p.sourceUrl ? `
            <div class="lede-note">
              <i class="ph-bold ph-newspaper"></i>
              <div><p>The full text of this story is published on the original Envoy website.</p>
              <a class="btn btn--sm" href="${esc(p.sourceUrl)}" target="_blank" rel="noopener">Read the full article <i class="ph-bold ph-arrow-up-right"></i></a></div>
            </div>` : ''}
          <div class="share">
            <span class="share__label">Share</span>
            <a class="icon-btn" href="https://x.com/intent/post?url=${shareUrl}&text=${shareTitle}" target="_blank" rel="noopener" aria-label="Share on X"><i class="ph-bold ph-x-logo"></i></a>
            <a class="icon-btn" href="https://www.linkedin.com/sharing/share-offsite/?url=${shareUrl}" target="_blank" rel="noopener" aria-label="Share on LinkedIn"><i class="ph-bold ph-linkedin-logo"></i></a>
            <a class="icon-btn" href="https://www.facebook.com/sharer/sharer.php?u=${shareUrl}" target="_blank" rel="noopener" aria-label="Share on Facebook"><i class="ph-bold ph-facebook-logo"></i></a>
            <a class="icon-btn" href="mailto:?subject=${shareTitle}&body=${shareUrl}" aria-label="Share by email"><i class="ph-bold ph-envelope-simple"></i></a>
            <button class="icon-btn" type="button" data-copy aria-label="Copy link"><i class="ph-bold ph-link-simple"></i></button>
          </div>
          ${a ? `<div class="card author-box">
            <a href="${authorUrl(a.slug)}">${avatar(a, 'avatar--lg')}</a>
            <div><p class="eyebrow" style="margin-bottom:6px">Written by</p><h3><a href="${authorUrl(a.slug)}">${esc(a.name)}</a></h3>
            ${a.role ? `<p>${esc(a.role)}</p>` : ''}${a.bio ? `<p>${esc(a.bio)}</p>` : ''}
            <a class="read-more" href="${authorUrl(a.slug)}">More from ${esc(a.name.split(' ')[0])} <i class="ph-bold ph-arrow-right"></i></a></div>
          </div>` : ''}
        </div>
      </div>
    </article>
    ${more.length ? `<section class="band section">
      <div class="container">
        <div class="section-head"><h2 class="section-title">Related Stories</h2></div>
        <div class="grid-4" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr))">
          ${more.map((x, i) => `<article class="tile reveal" style="--i:${i}"><a href="${postUrl(x)}" tabindex="-1" aria-hidden="true">${thumb(x)}</a><div style="display:grid;gap:10px">${tags(x, 1)}${headline(x, 'h3')}${meta(x, { author: false })}</div></article>`).join('')}
        </div>
      </div>
    </section>` : ''}`;
}

function listPage({ eyebrow, title, desc, posts, page, link, extra = '' }) {
  const perPage = S.home.perPage || 10;
  const count = Math.max(1, Math.ceil(posts.length / perPage));
  return `
    <div class="container">
      <header class="page-head">
        ${eyebrow ? `<p class="eyebrow">${eyebrow}</p>` : ''}
        ${extra || `<h1 class="page-title">${esc(title)}</h1>`}
        ${desc ? `<p class="page-desc">${esc(desc)}</p>` : ''}
      </header>
      <div class="layout" style="padding-bottom:72px">
        <div>${storyList(posts.slice((page - 1) * perPage, page * perPage))}${pagination(page, count, link)}</div>
        ${sidebar()}
      </div>
    </div>`;
}

function viewCategory(slug, page) {
  const cat = S.category(slug);
  if (!cat) return notFound();
  const posts = S.inCategory(slug);
  setTitle(cat.name, cat.description);
  return listPage({
    eyebrow: `<a href="#/">Home</a><span>/</span>Category<span>/</span>${posts.length} ${posts.length === 1 ? 'story' : 'stories'}`,
    title: cat.name, desc: cat.description, posts, page,
    link: (n) => (n === 1 ? catUrl(slug) : `${catUrl(slug)}/${n}`),
  });
}

function viewAuthor(slug, page) {
  const a = S.author(slug);
  if (!a) return notFound();
  const posts = S.byAuthor(slug);
  setTitle(a.name, a.bio);
  const links = [['twitter', 'ph-x-logo'], ['linkedin', 'ph-linkedin-logo'], ['website', 'ph-globe']]
    .filter(([k]) => a[k]).map(([k, icon]) => `<a class="icon-btn" style="border:1px solid var(--border)" href="${esc(a[k])}" target="_blank" rel="noopener" aria-label="${k}"><i class="ph-bold ${icon}"></i></a>`).join('');
  return listPage({
    eyebrow: `<a href="#/authors">Authors</a><span>/</span>${posts.length} ${posts.length === 1 ? 'story' : 'stories'}`,
    posts, page,
    link: (n) => (n === 1 ? authorUrl(slug) : `${authorUrl(slug)}/${n}`),
    extra: `<div class="author-profile">${avatar(a, 'avatar--xl')}<div><h1 class="page-title">${esc(a.name)}</h1>${a.role ? `<p class="page-desc" style="margin-top:8px">${esc(a.role)}</p>` : ''}${a.bio ? `<p class="page-desc">${esc(a.bio)}</p>` : ''}${links ? `<div class="author-links">${links}</div>` : ''}</div></div>`,
  });
}

function viewAuthors() {
  setTitle('Authors');
  const list = S.authors().filter((a) => !a.hidden).sort((x, y) => (y.order ?? 0) - (x.order ?? 0) || S.authorCount(y.slug) - S.authorCount(x.slug) || x.name.localeCompare(y.name));
  return `
    <div class="container">
      <header class="page-head">
        <p class="eyebrow"><a href="#/">Home</a><span>/</span>${list.length} contributors</p>
        <h1 class="page-title">Authors</h1>
        <p class="page-desc">${esc(S.home.authorsIntro || 'The correspondents, editors and contributors who report for Envoy.')}</p>
      </header>
      <div class="authors-grid" style="padding-bottom:72px">
        ${list.map((a, i) => {
          const n = S.authorCount(a.slug);
          return `<a class="card author-card ${i === 0 ? 'author-card--feature' : ''} reveal" style="--i:${i % 4}" href="${authorUrl(a.slug)}">
            ${avatar(a)}
            <div style="display:grid;gap:6px"><h3>${esc(a.name)}</h3><span class="count">${n ? `${n} ${n === 1 ? 'story' : 'stories'}` : esc(a.role || 'Contributor')}</span>
            <span class="read-more">View stories <i class="ph-bold ph-arrow-right"></i></span></div>
          </a>`;
        }).join('')}
      </div>
    </div>`;
}

function viewSearch(q) {
  setTitle(q ? `Search: ${q}` : 'Search');
  const results = S.search(q);
  return `
    <div class="container">
      <header class="page-head">
        <p class="eyebrow">Search<span>/</span>${results.length} result${results.length === 1 ? '' : 's'}</p>
        <h1 class="page-title">${q ? `“${esc(q)}”` : 'Search'}</h1>
        <form class="search-inline" style="margin-top:24px;display:flex;gap:10px;max-width:560px" data-search>
          <label class="sr-only" for="q2">Search</label>
          <input id="q2" type="search" value="${esc(q)}" placeholder="Search Envoy" style="flex:1;height:44px;padding:0 14px;border:1px solid var(--border-strong);border-radius:6px;background:var(--surface)">
          <button class="btn" type="submit">Search</button>
        </form>
      </header>
      <div class="layout" style="padding-bottom:72px">
        <div>${results.length ? storyList(results) : `<div class="empty"><h2>No matches</h2><p>Try a different word, a country, or an author’s name.</p></div>`}</div>
        ${sidebar()}
      </div>
    </div>`;
}

function viewPage(slug) {
  const page = S.page(slug);
  if (!page) return notFound();
  setTitle(page.title);
  const body = `<div class="prose prose--page">${sanitize(page.body || '')}</div>`;
  return `
    <div class="container">
      <header class="page-head">
        <p class="eyebrow"><a href="#/">Home</a><span>/</span>${esc(page.title)}</p>
        <h1 class="page-title">${esc(page.title)}</h1>
      </header>
      <div class="layout ${page.sidebar ? '' : 'layout--full'}" style="padding-bottom:72px">
        <div class="${page.sidebar ? '' : 'article-wrap'}" style="${page.sidebar ? 'max-width:760px' : 'padding-top:0'}">${body}</div>
        ${page.sidebar ? sidebar() : ''}
      </div>
    </div>`;
}

function notFound() {
  setTitle('Not found');
  return `<div class="container section"><div class="empty"><h2>Page not found</h2><p>The page you were looking for has moved or no longer exists.</p><p style="margin-top:20px"><a class="btn" href="#/">Back to the homepage</a></p></div></div>`;
}

/* ------------------------------------------------------------------ behaviour */
function hydrate() {
  // scroll reveal
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { e.target.classList.add('is-visible'); io.unobserve(e.target); }
    }
  }, { rootMargin: '0px 0px -40px 0px' });
  main.querySelectorAll('.reveal').forEach((el) => io.observe(el));

  // hero slider
  const hero = main.querySelector('[data-hero]');
  if (hero) {
    const slides = [...hero.querySelectorAll('.hero__slide')];
    const count = hero.querySelector('.hero__count');
    const bar = hero.querySelector('.hero__progress span');
    let i = 0;
    let paused = false;
    const interval = (S.home.sliderInterval || 8) * 1000;
    hero.style.setProperty('--hero-interval', `${interval / 1000}s`);
    const show = (n) => {
      slides[i].classList.remove('is-active');
      i = (n + slides.length) % slides.length;
      slides[i].classList.add('is-active');
      if (count) count.textContent = `${String(i + 1).padStart(2, '0')} / ${String(slides.length).padStart(2, '0')}`;
      restartBar();
    };
    const restartBar = () => {
      if (!bar || reduceMotion) return;
      bar.classList.remove('run');
      void bar.offsetWidth;
      if (!paused) bar.classList.add('run');
    };
    hero.querySelector('[data-prev]')?.addEventListener('click', () => show(i - 1));
    hero.querySelector('[data-next]')?.addEventListener('click', () => show(i + 1));
    if (slides.length > 1 && !reduceMotion) {
      hero.addEventListener('mouseenter', () => { paused = true; bar?.classList.remove('run'); });
      hero.addEventListener('mouseleave', () => { paused = false; restartBar(); });
      hero.addEventListener('focusin', () => { paused = true; });
      hero.addEventListener('focusout', () => { paused = false; });
      restartBar();
      timers.push(setInterval(() => { if (!paused && !document.hidden) show(i + 1); }, interval));
    }
  }

  // highlight carousels
  main.querySelectorAll('[data-carousel]').forEach((c) => {
    const items = [...c.querySelectorAll('.carousel__item')];
    const dots = [...c.querySelectorAll('.dots button')];
    let i = 0;
    const show = (n) => {
      items[i].classList.remove('is-active');
      dots[i]?.setAttribute('aria-current', 'false');
      i = n % items.length;
      items[i].classList.add('is-active');
      dots[i]?.setAttribute('aria-current', 'true');
    };
    dots.forEach((d, n) => d.addEventListener('click', () => show(n)));
    let hover = false;
    c.addEventListener('mouseenter', () => { hover = true; });
    c.addEventListener('mouseleave', () => { hover = false; });
    if (items.length > 1 && !reduceMotion) timers.push(setInterval(() => { if (!hover && !document.hidden) show(i + 1); }, 6000));
  });

  main.querySelector('[data-copy]')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); toast('Link copied'); } catch { toast('Copy failed'); }
  });

  main.querySelector('[data-search]')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = e.target.querySelector('input').value.trim();
    if (q) location.hash = `#/search/${encodeURIComponent(q)}`;
  });
}

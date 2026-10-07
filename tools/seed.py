"""
Builds docs/data/content.json and docs/assets/img/* from the saved
envoymag.com pages in ../envoymag-com-webpage-saves.

Usage:  python tools/seed.py            (requires beautifulsoup4 + Pillow)

Re-running overwrites docs/data/content.json, so only run it to reset the
site to the imported baseline. Day-to-day edits happen in the admin panel.
"""
import glob
import json
import os
import re
import sys
import urllib.parse
from datetime import datetime, timezone

from bs4 import BeautifulSoup, NavigableString
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAVES = os.path.join(ROOT, "envoymag-com-webpage-saves")
DOCS = os.path.join(ROOT, "docs")
IMG_DIR = os.path.join(DOCS, "assets", "img")

HOME_FILE = "envoy - ... everything becomes clearer as we learn.html"


def soup(name):
    with open(os.path.join(SAVES, name), encoding="utf-8") as f:
        return BeautifulSoup(f, "html.parser")


def last_segment(url):
    parts = urllib.parse.urlparse(url).path.strip("/").split("/")
    return parts[-1] if parts and parts[-1] else ""


def local_file(src):
    if not src or not src.startswith("./"):
        return None
    path = os.path.join(SAVES, urllib.parse.unquote(src[2:]))
    return path if os.path.exists(path) else None


def save_image(src_path, dest_rel, max_w):
    """Copy an image into docs/, downscaling and normalising format."""
    dest_abs = os.path.join(DOCS, dest_rel)
    os.makedirs(os.path.dirname(dest_abs), exist_ok=True)
    im = Image.open(src_path)
    if im.width > max_w:
        im = im.resize((max_w, round(im.height * max_w / im.width)), Image.LANCZOS)
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGB", im.size, (255, 255, 255))
        bg.paste(im, mask=im.split()[-1])
        im = bg
    else:
        im = im.convert("RGB")
    im.save(dest_abs, "JPEG", quality=84, optimize=True, progressive=True)
    return dest_rel.replace(os.sep, "/")


ALLOWED = {"p", "strong", "b", "em", "i", "a", "br", "h2", "h3", "h4", "ul", "ol", "li", "blockquote"}


def clean_html(el):
    """Reduce WordPress / page-builder markup to plain semantic HTML."""

    def walk(node):
        out = []
        for c in node.children:
            if isinstance(c, NavigableString):
                out.append(str(c).replace("<", "&lt;").replace(">", "&gt;"))
                continue
            inner = walk(c)
            name = c.name
            if name == "b":
                name = "strong"
            if name == "i":
                name = "em"
            if name not in ALLOWED:
                out.append(inner)
                continue
            if name == "br":
                out.append("<br>")
                continue
            if name == "a":
                href = c.get("href", "")
                out.append(f'<a href="{href}">{inner}</a>')
                continue
            if name == "h2":
                name = "h3"
            if name in ("p", "h3", "h4") and not re.sub(r"<br>|\s|&nbsp;", "", inner):
                continue
            out.append(f"<{name}>{inner}</{name}>")
        return "".join(out)

    html = walk(el)
    html = re.sub(r"\s*\n\s*", " ", html)
    html = re.sub(r"(?:<br>\s*)+</(p|h3|h4)>", r"</>", html)
    html = re.sub(r"</(p|h3|h4|ul|ol|blockquote)>\s*", r"</\1>\n", html)
    return html.strip()


# ---------------------------------------------------------------- posts
posts = {}
for fn in sorted(glob.glob(os.path.join(SAVES, "*.html"))):
    with open(fn, encoding="utf-8") as f:
        s = BeautifulSoup(f, "html.parser")
    for a in s.select(".post-title a"):
        url = a.get("href", "")
        if "envoymag.com" not in url:
            continue
        box = a
        for _ in range(8):
            box = box.parent
            if box is None:
                break
            cls = box.get("class") or []
            if box.name == "article" or {"post-item", "slide-item", "carousel-item"} & set(cls):
                break
        if box is None:
            box = a.parent.parent
        p = posts.setdefault(url, {
            "url": url, "title": a.get_text(" ", strip=True), "cats": {}, "author": None,
            "dates": [], "updated": [], "imgs": set(), "excerpt": "", "read": None,
        })
        for ca in box.select(".post-categories a"):
            p["cats"][last_segment(ca.get("href", ""))] = ca.get_text(strip=True)
        au = box.select_one(".author_name")
        if au and not p["author"]:
            p["author"] = (last_segment(au.get("href", "")), au.get_text(strip=True))
        for t in box.select("time.entry-date"):
            if t.get("datetime"):
                p["dates"].append(t["datetime"])
        for t in box.select("time.updated"):
            if t.get("datetime"):
                p["updated"].append(t["datetime"])
        for im in box.select("img"):
            for attr in ("src", "data-src"):
                lf = local_file(im.get(attr))
                if lf:
                    p["imgs"].add(lf)
        ex = box.select_one(".post-excerpt")
        if ex:
            text = ex.get_text(" ", strip=True)
            if len(text) > len(p["excerpt"]):
                p["excerpt"] = text
        rt = box.select_one(".read-time")
        if rt:
            p["read"] = rt.get_text(strip=True)


def norm_title(t):
    return re.sub(r"\s{2,}", " ", t).strip()


def slugify(t):
    t = t.lower()
    t = re.sub(r"[^\w\s-]", "", t)
    return re.sub(r"[\s_-]+", "-", t).strip("-")



def short_teaser(text, limit=200):
    """Keep only the opening sentence of an imported teaser as the summary."""
    text = re.sub(r"\s*(\[…\]|\[\.\.\.\]|…)$", "", text).strip()
    # first sentence end that is not an abbreviation such as "No." or "U.S."
    for m in re.finditer(r"[.!?][\"”’]?(?=\s+[A-Z“\"]|$)", text):
        end = m.end()
        if end >= 40 and not re.search(r"\b(No|Mr|Mrs|Ms|Dr|St|U\.S|U\.N)\.$", text[:end]):
            if end <= limit:
                return text[:end]
            break
    if len(text) <= limit:
        return text
    return text[:limit].rsplit(" ", 1)[0].rstrip(",;:") + "…"


categories = {}
post_list = []
url_to_id = {}
for i, (url, p) in enumerate(sorted(posts.items(), key=lambda kv: max(kv[1]["dates"] or [""]), reverse=True)):
    slug = last_segment(url) or slugify(p["title"])
    pid = f"p{i + 1:03d}"
    url_to_id[url] = pid
    for cslug, cname in p["cats"].items():
        categories.setdefault(cslug, cname)
    image = ""
    if p["imgs"]:
        best = max(p["imgs"], key=lambda f: Image.open(f).width)
        image = save_image(best, os.path.join("assets", "img", "posts", f"{slug}.jpg"), 1400)
    date = max(p["dates"]) if p["dates"] else "2026-01-01T00:00:00+00:00"
    updated = max(p["updated"]) if p["updated"] else date
    excerpt = short_teaser(p["excerpt"])
    read = int(re.sub(r"\D", "", p["read"] or "") or 0) or None
    post_list.append({
        "id": pid,
        "slug": slug,
        "title": norm_title(p["title"]),
        "excerpt": excerpt,
        "body": "",
        "image": image,
        "imageCaption": "",
        "categories": list(p["cats"].keys()),
        "author": p["author"][0] if p["author"] else "admin",
        "date": date,
        "updated": updated,
        "readTime": read,
        "status": "published",
        "sourceUrl": url,
    })

# ---------------------------------------------------------------- authors
authors = []
s = soup("Authors - envoy.html")
for item in s.select(".authors-list-item"):
    a = item.select_one(".authors-list-item-title a")
    slug = last_segment(a["href"])
    avatar = ""
    im = item.select_one("img")
    if im:
        for attr in ("src", "data-src"):
            lf = local_file(im.get(attr))
            if lf:
                avatar = save_image(lf, os.path.join("assets", "img", "authors", f"{slug}.jpg"), 480)
                break
    bio = item.select_one(".authors-list-item-excerpt")
    authors.append({
        "id": slug, "slug": slug, "name": a.get_text(strip=True), "avatar": avatar,
        "role": "", "bio": bio.get_text(" ", strip=True) if bio else "",
        "twitter": "", "linkedin": "", "website": "",
    })
known = {a["slug"] for a in authors}
for p in posts.values():
    if p["author"] and p["author"][0] not in known:
        authors.append({"id": p["author"][0], "slug": p["author"][0], "name": p["author"][1], "avatar": "",
                        "role": "", "bio": "", "twitter": "", "linkedin": "", "website": ""})
        known.add(p["author"][0])
for a in authors:
    if a["slug"] == "admin":
        a["role"] = "Editorial desk"

# ---------------------------------------------------------------- categories
cat_list = []
for cslug, cname in categories.items():
    cat_list.append({"id": cslug, "slug": cslug, "name": cname, "description": ""})
for extra_slug, extra_name in (("featured", "Featured"),):
    if extra_slug not in categories:
        cat_list.append({"id": extra_slug, "slug": extra_slug, "name": extra_name, "description": ""})
cat_list.sort(key=lambda c: c["name"].lower().lstrip("#"))

# ---------------------------------------------------------------- pages
contacts = soup("Contacts - envoy.html").select_one("main#primary .entry-content")
pages = [
    {"id": "purpose", "slug": "purpose", "title": "Purpose", "sidebar": True,
     # A short summary of the two letters on the original page; paste the full
     # letters in through Admin > Pages > Purpose if you hold the rights to them.
     "body": "<p><strong>From the Editor-in-Chief</strong></p>\n"
             "<p>Envoy covers the United Nations as a mirror of the wider world: the place where global tensions "
             "surface, power is negotiated, and the effects of conflict, climate shocks and economic instability meet. "
             "Its reporting draws on a global network of correspondents who take readers inside the rooms where "
             "decisions are shaped, explaining not only what happens but why it matters.</p>\n"
             "<p>The magazine is growing its online and social presence, holding events, and building ties with "
             "students and universities, especially in New York City. Readers, diplomats, UN officials and "
             "journalists are invited to share story ideas and tell the editors what Envoy should investigate next.</p>\n"
             "<p>Stéphanie Fillion<br>Editor-in-Chief</p>\n"
             "<p><strong>From the Founder</strong></p>\n"
             "<p>Envoy was launched to explore the landscape of global affairs and the forces shaping the world. "
             "It now reaches readers in bookstores across the United States and Canada, and serves as a platform for "
             "dialogue and engagement on the work of the United Nations, climate action, peace and security, and the "
             "Sustainable Development Goals.</p>\n"
             "<p>Razi Canikligil<br>President &amp; Founder, Envoy Magazine</p>"},
    {"id": "contacts", "slug": "contacts", "title": "Contacts", "body": clean_html(contacts), "sidebar": False},
    {"id": "envoy-tv", "slug": "envoy-tv", "title": "Envoy TV",
     "body": "<p>Video interviews, conversations and coverage from the Envoy newsroom.</p>\n"
             "<p>Add episodes from the admin panel: open Pages, choose Envoy TV, and use the video button "
             "in the editor toolbar to embed a YouTube or Vimeo link.</p>", "sidebar": True},
    {"id": "subscribe", "slug": "subscribe", "title": "Subscribe",
     "body": "<p>Get Envoy in print and online. Each issue brings reporting on the United Nations, "
             "diplomacy and global affairs from our network of correspondents.</p>\n"
             "<p>Read the current digital edition through the Magazine link in the menu, or contact the "
             "editorial office from the Contacts page for subscription enquiries.</p>", "sidebar": True},
]

# ---------------------------------------------------------------- homepage
hs = soup(HOME_FILE)


def ids(selector):
    out = []
    for a in hs.select(selector):
        pid = url_to_id.get(a.get("href"))
        if pid and pid not in out:
            out.append(pid)
    return out


home = {
    "slider": ids(".main-banner-slider .slide-item:not(.slick-cloned) .post-title a"),
    "trailing": ids(".main-banner-trailing-posts .post-title a"),
    "ticker": {"mode": "manual", "count": 6, "ids": ids(".bb-bldr--normal .row-one a")},
    "highlights": ids("#newsmatic_carousel_widget-2 .post-title a"),
    "popular": ids("#newsmatic_popular_posts_widget-2 .post-title a"),
    "missed": ids("#bottom-full-width-section .post-title a"),
    "categoryList": {"title": "World Affairs", "category": "world-affairs", "count": 6},
    "categoryGrid": {"title": "Culture", "category": "culture", "count": 3},
    "perPage": 10,
    "widgets": ["magazine", "highlights", "popular", "categoryList", "categoryGrid"],
}
# The live homepage slider rotates the lead story with the two trailing ones.
for pid in home["trailing"]:
    if pid not in home["slider"]:
        home["slider"].append(pid)

# ---------------------------------------------------------------- site assets
os.makedirs(IMG_DIR, exist_ok=True)
home_files = os.path.join(SAVES, HOME_FILE.replace(".html", "_files"))
Image.open(os.path.join(home_files, "logo.png")).save(os.path.join(IMG_DIR, "logo.png"), optimize=True)
save_image(os.path.join(home_files, "envoy-mag.jpeg"), os.path.join("assets", "img", "magazine.jpg"), 900)

nav = [
    {"label": "Home", "type": "home", "target": ""},
    {"label": "Culture", "type": "category", "target": "culture"},
    {"label": "Featured", "type": "category", "target": "featured"},
    {"label": "World Affairs", "type": "category", "target": "world-affairs"},
    {"label": "Purpose", "type": "page", "target": "purpose"},
    {"label": "Authors", "type": "authors", "target": ""},
    {"label": "Magazine", "type": "url", "target": "https://library.emagazines.com/Account/ExpressLogin?plid=439", "newTab": True},
    {"label": "Contacts", "type": "page", "target": "contacts"},
    {"label": "Envoy TV", "type": "page", "target": "envoy-tv"},
    {"label": "Donate", "type": "url", "target": "https://www.zeffy.com/en-US/donation-form/donate-become-our-special-envoy", "newTab": True},
]

content = {
    "version": 1,
    "updatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
    "site": {
        "title": "envoy",
        "tagline": "… everything becomes clearer as we learn",
        "description": "Envoy is a magazine on the United Nations, diplomacy and global affairs.",
        "logo": "assets/img/logo.png",
        "showLogo": True,
        "subscribeLabel": "Subscribe",
        "subscribeUrl": "#/subscribe",
        "magazine": {
            "title": "Magazine",
            "image": "assets/img/magazine.jpg",
            "url": "https://preview.emagazines.com/envoy/20250301/index.html",
        },
        "social": [
            {"network": "linkedin", "url": "https://www.linkedin.com/company/envoymag/"},
            {"network": "x", "url": "https://x.com/envoyUNEMAG"},
        ],
        "footerText": "Envoy 2026.",
        "footerNote": "Published by UNEMAG, a non-profit 501(c)(3) organization.",
        "showClock": True,
        "defaultTheme": "light",
    },
    "nav": nav,
    "footerNav": None,
    "home": home,
    "categories": cat_list,
    "authors": authors,
    "posts": post_list,
    "pages": pages,
}

with open(os.path.join(DOCS, "data", "content.json"), "w", encoding="utf-8") as f:
    json.dump(content, f, ensure_ascii=False, indent=1)

print(f"posts={len(post_list)} authors={len(authors)} categories={len(cat_list)} pages={len(pages)}")
print("home:", {k: (len(v) if isinstance(v, list) else v) for k, v in home.items()})
sys.exit(0)

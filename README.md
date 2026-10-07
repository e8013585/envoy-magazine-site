# Envoy magazine site

A static, admin-editable rebuild of envoymag.com. It runs on GitHub Pages with no server and no build step.

```
docs/                 <- the website (GitHub Pages serves this folder)
  index.html          public site (hash routes: #/article/…, #/category/…, #/authors, #/purpose …)
  admin/              admin panel (username + password)
  data/content.json   all articles, pages, authors, categories, menus and settings
  data/admin.json     admin username, salted password hash, GitHub settings, encrypted token
  assets/             images (imported ones in img/, admin uploads in uploads/)
server.mjs            local dev server with a save-to-disk API for the admin
tools/seed.py         rebuilds content.json and images from envoymag-com-webpage-saves/
tools/set-password.mjs  sets the admin username/password from the command line
```

## Run locally

```bash
npm run dev
```

- Site: http://localhost:4173/
- Admin: http://localhost:4173/admin/

The first admin password is in `ADMIN-CREDENTIALS.txt` (git-ignored). When you run the admin locally, **Publish** writes straight to `docs/`. Commit and push those files afterwards.

To change the password from the command line:

```bash
node tools/set-password.mjs admin "a-long-new-password"
```

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository.
2. In the repository, open **Settings → Pages**. Set the source to **Deploy from a branch**, choose `main` and the `/docs` folder, and save.
3. The site goes live at `https://<user>.github.io/<repo>/`. The admin panel is at `…/<repo>/admin/`.

## Publishing from the live admin panel

GitHub Pages can only serve files, so the live admin publishes by committing to the repository through the GitHub API:

1. Create a fine-grained personal access token at github.com → Settings → Developer settings. Limit it to this repository and give it **Contents: Read and write**.
2. Sign in to `/admin/` and open **Publishing & account**. Check the owner, repository, branch and folder (`docs`), paste the token and save.
3. After that, **Publish** commits `docs/data/content.json`, and image uploads go to `docs/assets/uploads/`. Pages rebuilds in a minute or two.

Until you publish, edits are saved as a draft in that browser. **Preview** shows the site with your draft applied.

## How the admin is secured

- `admin.json` is public, like everything else on a static site. It contains only a PBKDF2-SHA-256 hash of the password (310,000 iterations, random salt). Use a long password.
- The GitHub token is encrypted with AES-GCM, using a key derived from the password. Changing the live site therefore needs the password itself, not just a way past the login screen.
- Article and page HTML is sanitised with DOMPurify before it is displayed. Video embeds are limited to YouTube and Vimeo.

## Content notes

`tools/seed.py` imported 50 articles, 79 authors, 21 categories, and the Contacts page from the saved pages. Titles, images and bylines are carried over. Article summaries are the opening sentence of each teaser, and every article links to its original URL for the full text. The Purpose page holds a short summary of the two letters on the original page. You can paste in full article bodies or the complete letters through the admin editor.

Running `npm run seed` resets `docs/data/content.json` to the imported baseline. That discards any edits published locally.

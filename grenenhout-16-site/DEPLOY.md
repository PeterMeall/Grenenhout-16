# Deploying Grenenhout 16

## 1. Finish the Firebase setup (if you haven't already)

- Firestore Database created, in production mode ✓ (you did this)
- Authentication → Sign-in method → **Anonymous** enabled ✓ (you did this)
- Config pasted into `firebase-config.js` ✓ (done, already in this folder)

**One thing left:** open **Firestore Database → Rules** in the Firebase console, delete whatever's there, and paste in the contents of `firestore.rules` (also in this folder), then click **Publish**. Without this, the database will silently reject every read and write — this is what actually keeps the checklist private to people who load the page, instead of open to the whole internet.

## 2. Create the GitHub repo

1. Go to https://github.com/new
2. Name it whatever you like (e.g. `grenenhout-16`)
3. Keep it **Public** (GitHub Pages on a free account needs the repo to be public — the checklist itself isn't linked from anywhere, so nobody will stumble onto it, but don't put anything in here you wouldn't want technically-findable)
4. Don't add a README/gitignore/license — leave it empty
5. Click **Create repository**

## 3. Upload the files

On the new repo's page, click **"uploading an existing file"** (or drag-and-drop). Upload everything in this folder, **keeping the folder structure** — i.e. the `assets/` folder needs to go in as a folder, not have its contents dumped loose at the top level. GitHub's drag-and-drop upload preserves folder structure if you drag the whole folder in at once.

Files/folders to upload:
- `index.html`
- `style.css`
- `app.js`
- `firebase-config.js`
- `assets-data.js`
- `seed-data.js`
- `assets/` (the whole folder, with `rooms/`, `plans/`, `icons/` inside it)

You don't need to upload `firestore.rules` or this `DEPLOY.md` — they're just for your reference, not part of the live site (though there's no harm including them either).

Commit the upload.

## 4. Turn on GitHub Pages

1. In the repo, go to **Settings → Pages**
2. Under "Build and deployment", set **Source** to **"Deploy from a branch"**
3. Branch: **main**, folder: **/ (root)**
4. Click **Save**
5. Give it a minute or two, then refresh that Pages settings page — it'll show you the live URL, something like `https://yourusername.github.io/grenenhout-16/`

## 5. Try it

Open that URL on your phone. Add to Home Screen if you like — it'll work properly this time, no sign-in needed, and anything you or Arjen add shows up on the other's phone within a second or two automatically.

Send Arjen the same URL — no account needed on his end either.

## Updating it later

Any time you want a change (new room photos, a style tweak, another feature) — just ask me, and I'll hand you an updated set of files to re-upload the same way (GitHub will ask if you want to replace the existing files — say yes). The checklist *data* itself (rooms, items, prices, ticked boxes) lives in Firebase, completely separate from these files, so re-uploading the site never touches or resets your actual list.

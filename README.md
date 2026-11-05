# 🏈 67 Bowls

A small website with a menu for **Retro Bowl** and **Retro Bowl College**. It saves your progress automatically and lets you download backups. If you want, you can also turn on cloud saves to play on more than one device.

## What's in here

| Path | What it is |
|---|---|
| `server.js` | The web server (Node + Express) |
| `games.json` | The list of games on the menu (titles, colors) |
| `games/pro/` | Retro Bowl (played at `/play/pro`) |
| `games/college/` | **Put the Retro Bowl College game files here** (played at `/play/college`) |
| `public/` | The menu, the play page, and the save system |
| `render.yaml` | One-click setup for Render |

## 1. Add the game files

The game files are **not included**. Retro Bowl and Retro Bowl College belong to New Star Games, so you need to supply HTML5 builds you're allowed to use.

Copy each game's HTML5 files into its folder so you end up with:

```
games/pro/index.html        (plus its html5game/ folder)
games/college/index.html    (plus its html5game/ folder)
```

Commit and push them to GitHub. If a game's folder is empty, the menu shows "Game files not added yet" for that game.

> Want a game to load from another website instead? Add `"url": "https://..."` to that game in `games.json`. That site keeps its own saves, so the backup and cloud features won't work for that game.

## 2. Put it on Render (onrender.com)

1. Push this repo to GitHub. Make sure the branch you deploy has the game files in it.
2. Go to <https://render.com> and sign up or log in. Signing in with GitHub is easiest.
3. Click **New +** → **Blueprint**.
4. Pick this repository (`retro-bowl-and-retro-bowl-college`) and click **Connect**. If it isn't listed, click "Configure account" and give Render access to the repo.
5. Render reads `render.yaml` and shows a web service called **67-bowls**. Click **Apply** (or **Deploy Blueprint**).
6. Wait a minute or two for the build to finish. Your site will be at **https://67-bowls.onrender.com**. If that name is taken, Render adds a few letters to the end, and the link appears at the top of the service page.

**Doing it by hand instead of with a Blueprint:** click **New +** → **Web Service**, pick the repo, then set:
- **Name:** `67-bowls`
- **Language / Runtime:** Node
- **Branch:** the branch with your game files
- **Build Command:** `npm install`
- **Start Command:** `npm start`
- **Instance Type:** Free

Then click **Create Web Service**.

**Updating the site:** every push to that branch on GitHub redeploys the site automatically.

**Free plan note:** the free plan goes to sleep after about 15 minutes with no visitors. The first visit after that takes 30–60 seconds to load. This does **not** affect saves.

## 3. How saving works

- **Automatic:** when the game saves (just like on the real game), the data is kept in your browser on this site. Close the tab, come back tomorrow, and click **Continue**. The bar at the top of the play page shows when it last saved.
- **Each game has its own save.** Retro Bowl and Retro Bowl College can't overwrite each other.
- **Backups:** use the **⬇ Backup** button while playing, or **Download** under "Your saves" on the menu, to get a save file. Use **Load file** to bring it back, even on a different computer.
- Saves are kept **per browser**. Clearing browsing data, or using incognito/private mode, removes them. Download a backup now and then if that worries you.

### Optional: cloud saves (play on any device)

Cloud saves give you a save code like `HS33Z-F5VVD`. Enter it on any device to get your saves there. They need storage that survives restarts, so on Render you need a paid instance with a disk:

1. On your Render service, go to **Settings → Instance Type** and pick **Starter**.
2. Go to **Disks → Add Disk**. Set **Mount Path** to `/var/data` and **Size** to 1 GB, then save.
3. Go to **Environment → Add Environment Variable**. Set **Key** to `DATA_DIR` and **Value** to `/var/data`, then save. The service redeploys.
4. A **Cloud saves** panel now appears on the menu.

If `DATA_DIR` isn't set, the cloud panel stays hidden and everything else still works.

## Run it on your own computer

```bash
npm install
npm start            # http://localhost:3000
# with cloud saves:
DATA_DIR=./data npm start
```

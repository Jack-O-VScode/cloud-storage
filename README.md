# Cloud Storage

A self-hosted, Google-Drive-style file storage web app: folders, drag-and-drop
upload/download, rename/move/trash, search, per-file share links, and
multi-user support with an admin panel. Built to run comfortably on a
Raspberry Pi, storing files directly on the Pi's own disk (e.g. your 64GB
microSD).

## Stack

- **Backend**: Node.js + Express. Files are stored as opaque blobs on disk;
  folder structure, filenames, and sharing live in a single `metadata.json`
  (no database server to run or cross-compile on ARM).
- **Frontend**: React + Vite, built to static assets and served by the same
  Express server (one process, one port).
- **Auth**: cookie-based sessions (JWT), bcrypt-hashed passwords. First run
  walks you through creating an admin account; the admin can add more users
  from the "Manage users" panel, each with their own isolated drive.

## Can a Raspberry Pi 3B+ with a 64GB microSD actually run this?

Yes, for personal/small-household use. The app itself is lightweight (a
small Express server + a static SPA) and easily runs within the Pi 3B+'s
1GB of RAM. Some things worth knowing before you commit to it long-term:

- **microSD write endurance & speed.** SD cards wear out faster than SSDs
  under heavy sustained writes and are noticeably slower, especially for
  large files or many small files at once. For a few users storing docs,
  photos, and the occasional video, this is fine. If you plan to store a
  lot of data or write to it constantly, consider attaching a USB 3
  SSD/flash drive to the Pi instead and pointing `DATA_DIR` at that — the
  app doesn't care where the volume is mounted.
- **64GB is your real ceiling.** The storage usage bar in the sidebar
  reflects actual free space on the disk `DATA_DIR` lives on, so you'll see
  it fill up as you approach 64GB (minus whatever the OS partition uses).
- **Single point of failure.** One microSD card holding the only copy of
  irreplaceable files (photos, documents) is risky — cards can and do fail.
  Consider an occasional backup to another drive or cloud storage for
  anything you can't afford to lose.
- **Remote access.** By default this only listens on your local network.
  To reach it from outside your house, don't just port-forward the raw
  HTTP port to the internet. Use either:
  - A reverse proxy (e.g. [Caddy](https://caddyproxy.com) or
    [nginx](https://nginx.org)) in front of it with a real TLS certificate, or
  - A private overlay network like [Tailscale](https://tailscale.com) or
    [WireGuard](https://www.wireguard.com), which avoids exposing anything
    to the public internet at all. This is the easiest and safest option
    for a personal Pi server.

## Running it on the Raspberry Pi (Docker, recommended)

1. Install Docker on Raspberry Pi OS:

   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker $USER
   # log out and back in for the group change to take effect
   ```

2. Mount your storage (skip this if you're just using the main SD card's
   free space — then you can point `DATA_DIR` at a plain folder). If you're
   using a separate USB drive, format and mount it, e.g.:

   ```bash
   lsblk                      # find your device, e.g. /dev/sda1
   sudo mkdir -p /mnt/storage
   sudo mount /dev/sda1 /mnt/storage
   # add it to /etc/fstab so it remounts on reboot
   ```

3. Clone this repo onto the Pi and configure it:

   ```bash
   git clone <this-repo-url> cloud-storage
   cd cloud-storage
   cp .env.example .env
   # edit .env: set JWT_SECRET (openssl rand -hex 32) and DATA_DIR
   ```

4. Build and start:

   ```bash
   docker compose up -d --build
   ```

   The first build compiles the React frontend, which can take a few
   minutes on a Pi 3B+. If the build gets killed (out of memory), add a
   swap file first:

   ```bash
   sudo dphys-swapfile swapoff
   sudo sed -i 's/CONF_SWAPSIZE=.*/CONF_SWAPSIZE=1024/' /etc/dphys-swapfile
   sudo dphys-swapfile setup && sudo dphys-swapfile swapon
   ```

5. Visit `http://<pi-ip>:3000` from another device on your network. You'll
   be prompted to create the admin account on first load.

To update after pulling new code: `docker compose up -d --build`.

## Running it without Docker

Requires Node.js 20+ (install via [NodeSource](https://github.com/nodesource/distributions)
or `nvm`).

```bash
cd web && npm install && npm run build   # builds into ../server/public
cd ../server && npm install
DATA_DIR=/mnt/storage/cloud-storage-data JWT_SECRET=$(openssl rand -hex 32) npm start
```

To keep it running across reboots, set it up as a systemd service:

```ini
# /etc/systemd/system/cloud-storage.service
[Unit]
Description=Cloud Storage
After=network.target

[Service]
WorkingDirectory=/home/pi/cloud-storage/server
ExecStart=/usr/bin/node src/index.js
Environment=DATA_DIR=/mnt/storage/cloud-storage-data
Environment=JWT_SECRET=replace-with-a-real-secret
Environment=PORT=3000
Restart=on-failure
User=pi

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now cloud-storage
```

## Local development

```bash
# terminal 1
cd server && npm install && DATA_DIR=./data JWT_SECRET=dev-secret npm start

# terminal 2 (proxies /api to the server above)
cd web && npm install && npm run dev
```

Open `http://localhost:5173`.

## Configuration reference (environment variables)

| Variable          | Default        | Description                                                        |
| ------------------ | -------------- | ------------------------------------------------------------------ |
| `JWT_SECRET`        | *(random)*     | Secret used to sign session cookies. Set a fixed value in prod, or every restart logs everyone out. |
| `DATA_DIR`          | `./data`       | Where `metadata.json` and uploaded file blobs are stored.           |
| `PORT`              | `3000`         | Port the server listens on.                                         |
| `MAX_UPLOAD_BYTES`  | `21474836480`  | Max size of a single uploaded file (default 20GB).                  |
| `FORCE_HTTPS`       | `false`        | Set `true` only if a reverse proxy in front of this terminates TLS, so cookies are marked `Secure`. |

## Notes on the design

- Folders are virtual: a file/folder record just has a `parentId`, so
  renaming/moving is a metadata update, not a filesystem operation. Files on
  disk are named by a random id, decoupled from the user-visible name/path.
- Trash is soft-delete; "Empty trash" / "Delete forever" is what actually
  removes files from disk.
- Share links are unguessable tokens with no expiry by default — anyone
  with the link can view/download that one file, same trust model as
  "anyone with the link" on Google Drive. Revoke a link any time from the
  file's menu.

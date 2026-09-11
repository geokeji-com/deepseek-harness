# Multi-user web deployment

This directory contains an optional deployment layer for running multiple
isolated DeepSeek Harness web accounts behind one HTTPS endpoint. It keeps the
upstream source tree clean and starts one Harness process per account.

The current implementation is designed for a small single-host deployment. It
uses one Unix account plus application-level path isolation. It is not a
kernel security boundary between mutually hostile users.

## Architecture

- `server/` contains the authentication manager, reverse proxy, per-user
  backend lifecycle, path policy, shared Skill synchronization, and systemd
  user services.
- `tools/` contains the workspace migration utility.
- `patches/` contains the build-time patch that keeps remote settings
  Host-backed after the edge proxy authenticates the browser.
- `nginx/` contains a reference TLS reverse-proxy configuration.
- `local-manager/` contains an optional macOS launcher for status, logs,
  source mirroring, Skill publishing, and SFTP-backed workspace sync.

Each user receives:

- an independent `DSH_HOME`, settings, credentials view, sessions, and
  workspace;
- a password-backed login using the same public URL;
- a signed 30-day cookie bound to the user ID and client IP;
- an on-demand Harness process on a dedicated loopback port.

Skills, profiles, plugins, and agent presets are shared read-only. Shared
projects live in the configured `SHARED_PROJECTS_ROOT`. The canonical
instruction file is generated once and symlinked into every user's Harness
home and workspace.

## Host requirements

- Linux with systemd user services enabled.
- Node.js and pnpm.
- Nginx with a TLS certificate for the public host.
- Python 3 for file locking in the workspace migration utility.
- `rsync` for optional state migration and local workspace synchronization.

The installer defaults to a single Unix user named `dsh`. Paths are currently
constants in the server scripts, so review them before deploying to another
account or directory layout.

## Install

1. Build DeepSeek Harness in the source checkout.
2. Create `~/.config/deepseek-harness/auth.env` with the existing owner
   password hash and cookie secret:

   ```bash
   AUTH_PASSWORD_SCRYPT=<salt-hex>:<scrypt-hex>
   AUTH_COOKIE_SECRET=<32-byte-base64url-secret>
   ```

3. Run the installer from this directory:

   ```bash
   deploy/multiuser/server/install.sh
   ```

4. Install the reference Nginx configuration after replacing the public host
   and certificate paths:

   ```bash
   sudo install -m 0644 \
     deploy/multiuser/nginx/nginx.conf \
     /etc/nginx/nginx.conf
   sudo nginx -t
   sudo systemctl reload nginx
   ```

The installer creates four users: `owner`, `member2`, `member3`, and
`member4`. Generated passwords are written only to the mode `0600` file
`~/.config/deepseek-harness/multiuser/new-user-passwords.txt`.

## User administration

```bash
dsh-user-admin list
dsh-user-admin add analyst 3094
dsh-user-admin rotate analyst
dsh-user-admin disable analyst
dsh-user-admin enable analyst
```

Adding or enabling a user writes a new password only to the command output.
The server stores the scrypt hash in `users.json`. Rotating one user's password
invalidates only that user's existing browser cookies; other users remain
signed in.

The source checkout remains on the official repository and is updated with:

```bash
deepseek-harness-update
```

The update script refuses a dirty checkout, applies the remote-settings patch
only for the build, and does not restart the service after a failed build. A
failed update restores the previous revision and rebuilds its dependencies and
artifacts before exiting.

## Local manager

Copy `local-manager/` to a convenient location, then create its private
configuration:

```bash
cp config/server.env.example config/server.env
$EDITOR config/server.env
./dsh-web status
./dsh-web logs owner
./dsh-web skills sync
./dsh-web sync pull owner
```

Pull and push commands use a dry run by default. `--mirror` enables deletion
with timestamped backups. The launcher never stores passwords, cookie
secrets, or model API keys.

## Verification

Run the deployment tests from the repository root:

```bash
node --test \
  deploy/multiuser/server/*.test.mjs \
  deploy/multiuser/tools/*.test.mjs
```

The tests cover path isolation, shared-resource write rejection, shared
instruction symlinks, Skill snapshot imports, and workspace migration.

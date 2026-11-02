# Versioned release helper

`release-hrt.sh` switches the API and the web build by atomically moving a symlink,
so a release never overwrites the files the running service is using. A failed server
switch puts the previous release back and restarts it.

## Artifacts

- Server: a tarball whose root contains `dist/` (with `index.cjs`) and `schema.sql`.
- Web: a tarball whose root contains `index.html` and `assets/`.

Each release is extracted to `<root>/releases/<version>/` and refuses to run if that
directory already exists.

## One-time bootstrap

The server unit must run the versioned path before the helper can switch releases.

```bash
sudo install -d /srv/hrt/releases/2.4.0
sudo mv /srv/hrt/dist /srv/hrt/releases/2.4.0/dist
sudo mv /srv/hrt/schema.sql /srv/hrt/releases/2.4.0/schema.sql
sudo ln -s releases/2.4.0 /srv/hrt/current
sudo install -d /etc/systemd/system/hrt-server.service.d
sudo tee /etc/systemd/system/hrt-server.service.d/10-release.conf >/dev/null <<'EOF'
[Service]
ExecStart=
# Keep the node binary the existing unit already uses (on this host it is
# /opt/node-v24.22.1-linux-arm64/bin/node, not /usr/bin/node).
ExecStart=/opt/node-v24.22.1-linux-arm64/bin/node /srv/hrt/current/dist/index.cjs http
WorkingDirectory=/srv/hrt/current
EOF
sudo systemctl daemon-reload && sudo systemctl restart hrt-server
```

Web (the Caddy root stays `/srv/hrt-web`, now a symlink):

```bash
sudo install -d /srv/hrt-web-releases
sudo mv /srv/hrt-web /srv/hrt-web-releases/2.4.0   # keeps .well-known and other dotfiles
sudo ln -s /srv/hrt-web-releases/2.4.0 /srv/hrt-web
```

## Deploy and roll back

```bash
release-hrt.sh server deploy /tmp/hrt-server-2.5.0.tgz 2.5.0
release-hrt.sh server rollback 2.4.0
release-hrt.sh web deploy /tmp/hrt-web-2.5.0.tgz 2.5.0
release-hrt.sh web rollback 2.4.0
release-hrt.sh check
```

The server switch restarts the unit and then requires the API health endpoint, the web
root and a `401` from `/api/records`; any failure restores the previous release.

## Rollback and the restore generation

A rollback to a build without the restore-generation gate is refused when any account
has `restore_generation > 0`: such a build would let a stale client overwrite a
restored account. The safe target is this release with `RESTORE_ENABLED` unset, which
keeps the gate and only turns the replace route off. When the preflight cannot be read,
the rollback is refused rather than assumed safe.

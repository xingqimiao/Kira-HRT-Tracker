echo '=== credentials dir support ==='
systemctl --version | head -1
echo '=== the two keys present? (names only) ==='
sudo bash -c 'grep -cE "^(ENCRYPTION_KEY|SERVER_DEK_KEY)=" /srv/hrt/.env'
echo '=== key lengths (no values) ==='
sudo bash -c 'awk -F= "/^(ENCRYPTION_KEY|SERVER_DEK_KEY)=/ {print \$1\" length=\"length(\$2)}" /srv/hrt/.env'
echo '=== is systemd-creds available ==='
which systemd-creds
echo '=== host key present ==='
sudo ls -la /var/lib/systemd/credential.secret 2>/dev/null || echo 'no host key yet (created on first encrypt)'

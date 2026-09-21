set -e
echo '=== backup the unit ==='
sudo cp /etc/systemd/system/hrt-server.service /root/hrt-server.service.bak-$(date -u +%Y%m%d-%H%M%S)
echo '=== add the two credentials, keep EnvironmentFile ==='
sudo python3 - <<'PY'
p = '/etc/systemd/system/hrt-server.service'
s = open(p).read()
if 'LoadCredentialEncrypted' in s:
    print('already present')
else:
    anchor = 'EnvironmentFile=/srv/hrt/.env'
    assert s.count(anchor) == 1, s.count(anchor)
    add = (anchor + '\n'
           + '# The two keys that must not sit on the same disk as the database. They are'\n
           + '# encrypted with systemd-creds and decrypted into a tmpfs directory for the'\n
           + '# lifetime of the process; the .env lines above stay as the fallback until a'\n
           + '# run proves the credentials are read. config.ts prefers the credential.'\n
           + 'LoadCredentialEncrypted=ENCRYPTION_KEY'/'' '\n'
           + 'LoadCredentialEncrypted=SERVER_DEK_KEY'\n')
    open(p, 'w').write(s.replace(anchor, add))
    print('patched')
PY
sudo systemctl daemon-reload
echo '=== validate ==='
sudo systemd-analyze verify /etc/systemd/system/hrt-server.service 2>&1 | head -5 || true
echo '=== unit now ==='
sudo grep -n -E 'EnvironmentFile|LoadCredential' /etc/systemd/system/hrt-server.service

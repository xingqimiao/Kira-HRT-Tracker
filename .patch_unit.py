p = '/etc/systemd/system/hrt-server.service'
s = open(p).read()
if 'LoadCredentialEncrypted' in s:
    print('already present')
else:
    anchor = 'EnvironmentFile=/srv/hrt/.env'
    assert s.count(anchor) == 1, s.count(anchor)
    add = (
        anchor + '\n'
        '# The two keys that must not sit on the same disk as the database. systemd keeps\n'
        '# them encrypted and decrypts them into a tmpfs directory for the lifetime of the\n'
        '# process. The .env lines above stay as the fallback until a run proves the\n'
        '# credentials are read; config.ts prefers the credential when both are present.\n'
        'LoadCredentialEncrypted=ENCRYPTION_KEY\n'
        'LoadCredentialEncrypted=SERVER_DEK_KEY\n'
    )
    open(p, 'w').write(s.replace(anchor, add))
    print('patched')

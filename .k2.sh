echo '=== generate the two encrypted credentials ==='
sudo install -d -m 700 -o root -g root /etc/credstore.encrypted
sudo bash -c 'set -a; . /srv/hrt/.env; set +a; printf %s "$ENCRYPTION_KEY" | systemd-creds encrypt --name=ENCRYPTION_KEY - /etc/credstore.encrypted/ENCRYPTION_KEY'
sudo bash -c 'set -a; . /srv/hrt/.env; set +a; printf %s "$SERVER_DEK_KEY" | systemd-creds encrypt --name=SERVER_DEK_KEY - /etc/credstore.encrypted/SERVER_DEK_KEY'
echo '=== stored (encrypted) ==='
sudo ls -la /etc/credstore.encrypted/
echo '=== prove it is not plaintext ==='
sudo bash -c 'grep -c "$(grep ^ENCRYPTION_KEY= /srv/hrt/.env | cut -d= -f2-)" /etc/credstore.encrypted/ENCRYPTION_KEY 2>/dev/null || echo 0'
echo '=== and that systemd can decrypt it back to the right value ==='
sudo systemd-creds decrypt /etc/credstore.encrypted/ENCRYPTION_KEY - | wc -c
sudo bash -c 'a=$(systemd-creds decrypt /etc/credstore.encrypted/ENCRYPTION_KEY -); b=$(grep ^ENCRYPTION_KEY= /srv/hrt/.env | cut -d= -f2-); [ "$a" = "$b" ] && echo MATCH || echo MISMATCH'

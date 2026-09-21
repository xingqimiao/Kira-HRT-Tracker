cd /tmp && rm -rf h5 && mkdir h5 && tar -xzf hrt-web-5.tar.gz -C h5
echo '=== staged ==='
grep -o 'assets/index-[A-Za-z0-9_.-]*' h5/index.html
ls h5/ | grep -E '^sw-'
sudo rsync -a --delete /tmp/h5/ /srv/hrt-web/
NEWSW=$(ls /srv/hrt-web/ | grep -E '^sw-' | head -1)
echo "new sw: $NEWSW"
for old in sw-11902fe.js sw-35e4dd0.js sw-7ebba7b.js sw-c331f8e.js sw-a195288.js; do sudo cp "/srv/hrt-web/$NEWSW" "/srv/hrt-web/$old"; done
sudo chmod 644 /srv/hrt-web/sw-*.js /srv/hrt-web/index.html
echo '=== live refs ==='
grep -o 'assets/index-[A-Za-z0-9_.-]*' /srv/hrt-web/index.html
ls /srv/hrt-web/ | grep -E '^sw-'

cd /tmp && rm -rf h6 && mkdir h6 && tar -xzf h6.tgz -C h6
sudo rsync -a --delete /tmp/h6/ /srv/hrt-web/
NEWSW=$(ls /srv/hrt-web/ | grep -E '^sw-' | head -1)
echo "new sw: $NEWSW"
for old in sw-11902fe.js sw-35e4dd0.js sw-7ebba7b.js sw-c331f8e.js sw-a195288.js sw-0f08e5b.js; do sudo cp "/srv/hrt-web/$NEWSW" "/srv/hrt-web/$old"; done
sudo chmod 644 /srv/hrt-web/sw-*.js /srv/hrt-web/index.html
grep -o 'assets/index-[A-Za-z0-9_.-]*' /srv/hrt-web/index.html
sudo cp /srv/hrt/dist/index.cjs /srv/hrt/dist/index.cjs.bak-mcpfix
sudo install -o hrt -g hrt -m 644 /tmp/h6-index.cjs /srv/hrt/dist/index.cjs
sudo install -o hrt -g hrt -m 644 /tmp/h6-schema.sql /srv/hrt/schema.sql
sudo systemctl restart hrt-server
sleep 6
systemctl is-active hrt-server
curl -s http://127.0.0.1:8788/hrt/mcp/health; echo

#!/bin/sh
# Installs a VoiceRecon package on this machine as a user would, checks that it works, and purges it
# again (the data stay). CI runs it on Ubuntu (.github/workflows/ci.yml and release.yml); it needs
# sudo, systemd and the internet (Node.js from NodeSource), and port 3000.
#   sh packaging/deb/test-install.sh dist/voicerecon_<version>_amd64.deb
set -eu
deb=$(realpath "$1")
cpu=$(dpkg-deb --field "$deb" Architecture | sed 's/amd64/x64/')

echo '== The package'
dpkg-deb --info "$deb"
dpkg-deb --contents "$deb" | grep -E "bin/voicerecon|voicerecon\.service|voicerecon\.env|sherpa-onnx-linux-$cpu/sherpa-onnx\.node"

echo '== Install: Node.js from NodeSource (Debian and Ubuntu ship older ones), then the package'
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo apt-get install -y "$deb"

echo '== The service runs as voicerecon and starts downloading the speech models'
systemctl is-enabled voicerecon
id voicerecon
stat -c '%U %a %n' /var/lib/voicerecon /var/lib/voicerecon/data /var/lib/voicerecon/models
for i in $(seq 1 30); do
  sudo journalctl -u voicerecon --no-pager | grep -q 'Downloading the speech models' && break
  sleep 1
done
sudo journalctl -u voicerecon --no-pager | tail -5
sudo journalctl -u voicerecon --no-pager | grep -q 'Downloading the speech models'
sudo systemctl stop voicerecon

echo '== The app works on Linux from the package'
sudo -u voicerecon /usr/bin/node -e "require('/usr/lib/voicerecon/node_modules/sherpa-onnx-node'); console.log('sherpa-onnx loads')"
log=$(mktemp)
sudo -u voicerecon env DATA_DIR=/var/lib/voicerecon/data MODELS_DIR=/var/lib/voicerecon/models \
  /usr/bin/node /usr/lib/voicerecon/src/server.js >"$log" 2>&1 &
for i in $(seq 1 30); do
  curl -sf http://127.0.0.1:3000/api/setup >/dev/null && break
  sleep 1
done
curl -sf http://127.0.0.1:3000/api/setup | grep -q '"needed":true'
sudo env VOICERECON_PASSWORD=ci-test-password voicerecon create-user admin --admin
curl -sf http://127.0.0.1:3000/api/setup | grep -q '"needed":false'
sudo voicerecon backup
ls -l /var/lib/voicerecon/backups/*.tar
sudo pkill -f /usr/lib/voicerecon/src/server.js || true
cat "$log"

echo '== Purging keeps the data'
sudo apt-get purge -y voicerecon
if systemctl list-unit-files voicerecon.service | grep -q voicerecon; then
  echo 'The service is still there.' >&2
  exit 1
fi
test ! -e /etc/voicerecon/voicerecon.env
test ! -e /usr/bin/voicerecon
test -f /var/lib/voicerecon/data/voicerecon.db
echo '== The package works.'

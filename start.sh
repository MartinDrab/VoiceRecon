#!/bin/sh
# Starts VoiceRecon: ./start.sh [--no-browser]. On first use it installs what is needed
# (dependencies, about 3 GB of speech models). See README.md, "Setup".
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "VoiceRecon needs Node.js 22.13 or newer. Get it from https://nodejs.org/"
  exit 1
fi
exec node scripts/launch.js "$@"

#!/bin/sh
set -eu
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")"
node configure.mjs
node doctor.mjs
node install-service.mjs

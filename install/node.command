#!/bin/bash
# macOS double-click wrapper for the Node.js installer.
# Finder runs .command files in Terminal; everything lives in node.sh.
cd "$(dirname "$0")/.."
exec ./node.sh "$@"

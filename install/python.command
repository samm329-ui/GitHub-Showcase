#!/bin/bash
# macOS double-click wrapper for the Python installer.
# Finder runs .command files in Terminal; everything lives in python.sh.
cd "$(dirname "$0")/.."
exec ./python.sh "$@"

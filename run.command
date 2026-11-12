#!/bin/bash
# macOS double-click wrapper for the two-channel pipeline runner.
# Finder runs .command files in Terminal; everything lives in run.sh.
cd "$(dirname "$0")"
exec ./run.sh "$@"

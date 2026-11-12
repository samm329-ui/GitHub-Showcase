# Install scripts

One-click setup for each half of the stack, per operating system. Run them in
order from the repository root:

| Step | Windows | Linux | macOS (double-click in Finder, or Terminal) |
| --- | --- | --- | --- |
| 1. Node environment | `install\node.bat` | `./install/node.sh` | `install/node.command` |
| 2. Python environment | `install\python.bat` | `./install/python.sh` | `install/python.command` |

What they do:

- **node** — checks Node.js ≥ 22.5, runs `npm install`, then `npm run check`.
- **python** — finds a working Python ≥ 3.9 (skips the Microsoft Store stub on
  Windows), creates a repo-local virtual environment (`.venv/`), installs
  `requirements.txt`, and downloads the Kokoro v1.0 model files into
  `models/kokoro/` (~115 MB, one time, gitignored — set `SKIP_MODELS=1` to skip).
  The pipeline auto-detects `.venv`; you never need to activate it by hand.

After both:

```bash
# Windows
run.bat        # or: run.bat github  /  run.bat news

# Linux / macOS
./run.sh       # or: ./run.sh github / ./run.sh news
run.command    # same thing (macOS double-click)
```

If anything fails, the scripts stop with the exact install command for your OS.
Nothing is modified outside this repository and your Python environment; models
land in `models/kokoro/` (gitignored).

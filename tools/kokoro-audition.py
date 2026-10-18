"""Local Kokoro voice audition harness.

Generates the same short sample script through several installed voices and
several speeds so the default voice and speed can be chosen by listening rather
than by guessing. Nothing is uploaded; everything is written next to this file.

    python tools/kokoro-audition.py
    npm run voice:audition
"""

import argparse
import json
import sys
from pathlib import Path

import soundfile as sf
from kokoro_onnx import Kokoro

SAMPLE = (
    "This is Next dot J S, a React framework from Vercel. "
    "It handles routing, server rendering and build tooling, so you can ship a web app faster. "
    "About twelve thousand people have starred it on GitHub. "
    "Here is what you get. "
    "You can create a new project with the app creator, then deploy it with one command."
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Audition Kokoro voices locally.")
    parser.add_argument("--model", default="tools/kokoro/kokoro-v1.0.int8.onnx")
    parser.add_argument("--voices", default="tools/kokoro/voices-v1.0.bin")
    parser.add_argument(
        "--voices-list",
        default="af_heart,af_bella,af_nicole,am_adam,am_michael,bm_george",
        help="Comma-separated voice ids to test.",
    )
    parser.add_argument("--speeds", default="0.95,1.0,1.05")
    parser.add_argument("--out", default="tools/audition")
    args = parser.parse_args()

    model = Path(args.model)
    voices = Path(args.voices)
    if not model.exists() or not voices.exists():
        print(
            "Kokoro model or voices file not found. Pass --model and --voices.",
            file=sys.stderr,
        )
        return 1

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    kokoro = Kokoro(str(model), str(voices))
    voices_to_test = [v.strip() for v in args.voices_list.split(",") if v.strip()]
    speeds = [float(s) for s in args.speeds.split(",") if s.strip()]

    manifest = []
    for voice in voices_to_test:
        for speed in speeds:
            try:
                samples, sample_rate = kokoro.create(
                    SAMPLE, voice=voice, speed=speed, lang="en-us"
                )
            except Exception as error:  # noqa: BLE001 - report and continue
                print(f"  {voice} @ {speed}: FAILED ({error})")
                manifest.append(
                    {"voice": voice, "speed": speed, "ok": False, "error": str(error)}
                )
                continue
            file = out / f"{voice}_{speed:.2f}.wav"
            sf.write(str(file), samples, sample_rate)
            duration = round(len(samples) / float(sample_rate), 2)
            print(f"  {voice} @ {speed}: {duration}s -> {file}")
            manifest.append(
                {
                    "voice": voice,
                    "speed": speed,
                    "ok": True,
                    "sampleRate": int(sample_rate),
                    "durationSeconds": duration,
                    "file": str(file),
                }
            )

    (out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"\nWrote {len(manifest)} samples to {out}")
    print(
        "Listen for clarity, warmth, pacing and how the technical words are "
        "pronounced, then set the winner as KOKORO_VOICE / KOKORO_SPEED."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
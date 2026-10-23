"""Local Kokoro voice audition harness.

Generates the same short sample script through several installed voices and
several speeds so the default voice and speed can be chosen by listening rather
than by guessing. Nothing is uploaded; everything is written next to this file.

    python tools/kokoro-audition.py
    npm run voice:audition

Phase 3 audition round: am_liam (candidate), am_puck and am_michael read the
identical script so the comparison is apples to apples. A faster harness
invocation:

    python tools/kokoro-audition.py --script-file audition-script.txt
"""

import argparse
import json
import sys
from pathlib import Path

import soundfile as sf
from kokoro_onnx import Kokoro

SAMPLE = (
    "Ever found a GitHub project that solves a problem you didn't know you had? "
    "This one helps you run multiple promises concurrently, without writing all that extra code yourself. "
    "You can install it locally, explore the source, and start experimenting in minutes. "
    "If you build with JavaScript, this project is worth a closer look."
)


def load_script(args) -> str:
    """Prefer an explicit script file; keep the generic sample as fallback."""
    if args.script_file:
        text = Path(args.script_file).read_text(encoding="utf-8")
        if text.strip():
            return " ".join(text.split())
        raise SystemExit(f"--script-file {args.script_file} is empty.")
    return SAMPLE


def main() -> int:
    parser = argparse.ArgumentParser(description="Audition Kokoro voices locally.")
    parser.add_argument("--model", default="tools/kokoro/kokoro-v1.0.int8.onnx")
    parser.add_argument("--voices", default="tools/kokoro/voices-v1.0.bin")
    parser.add_argument(
        "--voices-list",
        default="am_liam,am_puck,am_michael",
        help="Comma-separated voice ids to test.",
    )
    parser.add_argument("--speeds", default="1.0")
    parser.add_argument("--out", default="tools/audition")
    parser.add_argument(
        "--script-file",
        default=None,
        help="Path to a text file whose content is read by every voice.",
    )
    args = parser.parse_args()

    script = load_script(args)

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
                    script, voice=voice, speed=speed, lang="en-us"
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
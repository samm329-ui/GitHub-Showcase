"""Kokoro TTS wrapper used by the showcase pipeline.

Reads narration text from stdin (one chunk per invocation) and writes a WAV
file. The speed, voice and language are configurable so they can be auditioned
locally instead of being hard-coded.

The installed kokoro-onnx exposes `create_timed`, which would return per-phoneme
timings if the ONNX model published a duration predictor. The bundled
kokoro-v1.0 model only has an `audio` output, so timings come back empty. When
that happens the wrapper reports `timingSource: "unavailable"` instead of
guessing, and the caller falls back to measured chunk durations.
"""

import argparse
import json
import sys

import soundfile as sf
from kokoro_onnx import Kokoro


def main() -> None:
    parser = argparse.ArgumentParser(description="Synthesize one narration chunk.")
    parser.add_argument("--model", required=True)
    parser.add_argument("--voices", required=True)
    parser.add_argument("--voice", default="af_heart")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--lang", default="en-us")
    parser.add_argument("--output", required=True)
    parser.add_argument(
        "--metadata",
        default=None,
        help="Optional path for a JSON description of the generated audio.",
    )
    args = parser.parse_args()

    if not 0.5 <= args.speed <= 2.0:
        raise SystemExit(
            f"--speed must be between 0.5 and 2.0 for this model, got {args.speed}"
        )

    text = sys.stdin.read().strip()
    if not text:
        raise SystemExit("No narration text was provided.")

    kokoro = Kokoro(args.model, args.voices)

    samples, sample_rate, timings = kokoro.create_timed(
        text,
        voice=args.voice,
        speed=args.speed,
        lang=args.lang,
    )

    sf.write(args.output, samples, sample_rate)

    if args.metadata:
        payload = {
            "voice": args.voice,
            "speed": args.speed,
            "lang": args.lang,
            "sampleRate": int(sample_rate),
            "channels": 1,
            "durationMs": round(len(samples) / float(sample_rate) * 1000.0, 2),
            "phonemeTimings": len(timings),
            "timingSource": "phoneme" if timings else "unavailable",
            "characters": len(text),
        }
        with open(args.metadata, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)


if __name__ == "__main__":
    main()
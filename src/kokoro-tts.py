import argparse
import soundfile as sf
import sys
from kokoro_onnx import Kokoro


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--voices", required=True)
    parser.add_argument("--voice", default="af_heart")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    text = sys.stdin.read().strip()
    if not text:
        raise SystemExit("No narration text was provided.")

    kokoro = Kokoro(args.model, args.voices)
    samples, sample_rate = kokoro.create(text, voice=args.voice, speed=args.speed, lang="en-us")
    sf.write(args.output, samples, sample_rate)


if __name__ == "__main__":
    main()

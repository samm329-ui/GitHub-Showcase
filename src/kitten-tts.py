import soundfile as sf
from kittentts import KittenTTS

text = open(0, encoding="utf-8").read().strip()
if not text:
    raise SystemExit("No narration text was provided.")

model = KittenTTS()
audio = model.generate(text, voice="expr-voice-2-m", speed=1.0)
sf.write(__import__("sys").argv[1], audio, 24000)

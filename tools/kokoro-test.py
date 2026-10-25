from kokoro_onnx import Kokoro
import soundfile as sf
k = Kokoro("D:/github-showcase/tools/kokoro/kokoro-v1.0.int8.onnx", "D:/github-showcase/tools/kokoro/voices-v1.0.bin")
samples, sr = k.create("Hello from Kokoro", voice="af_heart", speed=1.0, lang="en-us")
sf.write("D:/github-showcase/tools/kokoro-test.wav", samples, sr)
print("ok", sr, len(samples))

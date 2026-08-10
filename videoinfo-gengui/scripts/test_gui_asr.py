"""End-to-end test: simulate the videoinfo-gengui ASR code path
against the running proxy on localhost:8788.

Mirrors what generate_tab.py + asr_client.py will do:
  1. ffmpeg-extract 30s wav
  2. transcribe_wav_file_direct() — multipart upload to /asr-upload
  3. proxy streaming ASR returns { text, utterances }
  4. we print what user-videos.ts would see
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tabs.asr_client import transcribe_wav_file_direct, convert_media_to_asr_wav, load_asr_config

WAV = Path(r"D:\yt-dlp\Chandler and Monica Find Out If They Got the House ｜ Friends.mp4")
WORK_DIR = Path(r"E:\mycodes\deckmind\NativeOS\videoinfo-gengui\out_test")
WORK_DIR.mkdir(parents=True, exist_ok=True)
wav_out = WORK_DIR / "test_30s.wav"

# Step 1: extract 30s (use the underlying ffmpeg to slice, like the real flow does)
import subprocess
print(f"[step 1] ffmpeg 30s -> {wav_out}")
subprocess.run([
    r"E:\mycodes\deckmind\NativeOS\videoinfo-gengui\vendor\ffmpeg.exe",
    "-y", "-i", str(WAV), "-t", "30",
    "-ac", "1", "-ar", "16000", "-vn", "-acodec", "pcm_s16le",
    str(wav_out),
], check=True)

# Step 2: ASR (this is what the GUI calls)
print(f"[step 2] transcribe_wav_file_direct({wav_out.name})")
cfg = load_asr_config()
print(f"  cfg: {cfg}")
result = transcribe_wav_file_direct(wav_out, cfg, language="en-US")
print(f"\n[result keys] {list(result.keys())}")
print(f"[text] {result.get('text', '')[:200]!r}")
utts = result.get("utterances") or []
print(f"[utterances count] {len(utts)}")
for u in utts[:5]:
    print(f"  {u.get('text','')[:120]!r} ({u.get('start_time')}-{u.get('end_time')})")

# Cleanup
wav_out.unlink()
print(f"\n[cleanup] removed {wav_out}")
print(f"\n✅ If text is non-empty, videoinfo-gengui ASR is fixed.")

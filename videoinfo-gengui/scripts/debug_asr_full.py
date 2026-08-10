"""Direct ASR submit + query debug. Bypasses the complex asr_client flow
and exercises the raw HTTP path so we can see exactly what Volcengine returns
when query returns 45000001.
"""
from __future__ import annotations

import base64
import json
import re
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WAV = Path(r"D:\yt-dlp\Chandler and Monica Find Out If They Got the House ｜ Friends.mp4")

# Reuse the same constants the proxy uses (we already verified these)
SUBMIT_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit"
QUERY_URL  = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query"
RESOURCE   = "volc.bigasr.auc"

# Load creds
cfg_text = (ROOT.parent / "rn-app" / "lib" / "volcengine" / "config.ts").read_text(encoding="utf-8")
def _ex(name: str) -> str:
    m = re.search(rf"export\s+const\s+{re.escape(name)}\s*=\s*['\"]([^'\"]+)['\"]", cfg_text)
    return m.group(1).strip() if m else ''
APP_ID = _ex("VOLC_APP_ID")
ACCESS_TOKEN = _ex("VOLC_ACCESS_TOKEN")
print(f"[creds] app_id={APP_ID[:6]}...{APP_ID[-4:]} token={ACCESS_TOKEN[:6]}...{ACCESS_TOKEN[-4:]}")

# Truncate the WAV to 60s with ffmpeg first (otherwise audio is too large for our test)
import subprocess
wav_short = ROOT / "scripts" / "debug_60s.wav"
if not wav_short.exists() or wav_short.stat().st_size < 100000:
    print("[ffmpeg] trimming 60s clip from mp4...")
    subprocess.run([
        str(ROOT / "vendor" / "ffmpeg.exe"),
        "-y", "-i", str(WAV), "-t", "60",
        "-ac", "1", "-ar", "16000", "-vn", "-acodec", "pcm_s16le",
        str(wav_short),
    ], check=True)
    print(f"[ffmpeg] wav size = {wav_short.stat().st_size / 1024:.1f} KB")

audio_b64 = base64.b64encode(wav_short.read_bytes()).decode("ascii")
print(f"[b64] encoded size = {len(audio_b64)} chars")

req_id = ''.join(f"{int((1+__import__('random').random())*0x10000):04x}" for _ in range(8))[:32]
# Match proxy's 8-segment hex pattern: xxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
import random
seg = lambda: f"{int((1+random.random())*0x10000):04x}"[1:5]  # 4 hex chars per segment
req_id = f"{seg()}{seg()}-{seg()}-{seg()}-{seg()}-{seg()}{seg()}{seg()}"
print(f"[req_id] {req_id}")

# ─── Step 1: submit ────────────────────────────────────────────────────────
submit_payload = {
    "user": {"uid": APP_ID or "nativeos-gui"},
    "audio": {
        "format": "wav",
        "rate": 16000,
        "bits": 16,
        "channel": 1,
        "base64_data": audio_b64,
    },
    "request": {
        "model_name": "bigmodel",
        "enable_punc": True,
        "enable_ddc": True,
        "show_utterances": True,
        "vad_segment": True,
        "end_window_size": 800,
        "enable_speaker_info": True,
        "ssd_version": "200",
        "enable_auto_lang": True,
    },
}
submit_body = json.dumps(submit_payload).encode("utf-8")
submit_headers = {
    "Content-Type": "application/json",
    "X-Api-App-Key": APP_ID,
    "X-Api-Access-Key": ACCESS_TOKEN,
    "X-Api-Resource-Id": RESOURCE,
    "X-Api-Request-Id": req_id,
    "X-Api-Sequence": "-1",
}

print("\n=== SUBMIT ===")
print(f"URL: {SUBMIT_URL}")
print(f"headers: {submit_headers}")
print(f"body (first 200 chars): {submit_body[:200]!r}")

req = urllib.request.Request(SUBMIT_URL, data=submit_body, headers=submit_headers, method="POST")
try:
    with urllib.request.urlopen(req, timeout=180) as resp:
        submit_status = resp.headers.get("x-api-status-code")
        submit_resp_text = resp.read().decode("utf-8", errors="replace")
        print(f"\nSUBMIT OK: status={submit_status}")
        print(f"response body: {submit_resp_text[:500]!r}")
except urllib.error.HTTPError as exc:
    print(f"\nSUBMIT HTTP {exc.code}: {exc.read().decode('utf-8', errors='replace')[:500]!r}")
    raise SystemExit(1)

if submit_status != "20000000":
    print(f"\nsubmit status unexpected: {submit_status}")
    raise SystemExit(1)

# ─── Step 2: query ─────────────────────────────────────────────────────────
print("\n=== QUERY (attempt 1) ===")
query_body = b"{}"
query_headers = {
    "Content-Type": "application/json",
    "X-Api-App-Key": APP_ID,
    "X-Api-Access-Key": ACCESS_TOKEN,
    "X-Api-Resource-Id": RESOURCE,
    "X-Api-Request-Id": req_id,
    "Content-Length": str(len(query_body)),
}
print(f"URL: {QUERY_URL}")
print(f"headers: {query_headers}")
print(f"body: {query_body!r}")

req = urllib.request.Request(QUERY_URL, data=query_body, headers=query_headers, method="POST")
# Try query at multiple time points to see if 45000001 is "not ready yet" or permanent
for delay in [1, 3, 5, 8, 12, 20]:
    time.sleep(delay)
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            query_status = resp.headers.get("x-api-status-code")
            query_resp_text = resp.read().decode("utf-8", errors="replace")
            print(f"\n[after {delay}s] QUERY status={query_status} body={query_resp_text[:300]!r}")
            if query_status == "20000000":
                print("DONE!")
                break
    except urllib.error.HTTPError as exc:
        print(f"\n[after {delay}s] HTTP {exc.code}: {exc.read().decode('utf-8', errors='replace')[:300]!r}")
        break

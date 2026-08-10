"""Debug query body variations. Submit is fixed; only query body/header vary.
We test 5 query variations on the same submitted task.
"""
from __future__ import annotations

import base64
import json
import re
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WAV = Path(r"D:\yt-dlp\Chandler and Monica Find Out If They Got the House ｜ Friends.mp4")

cfg_text = (ROOT.parent / "rn-app" / "lib" / "volcengine" / "config.ts").read_text(encoding="utf-8")
def _ex(name: str) -> str:
    m = re.search(rf"export\s+const\s+{re.escape(name)}\s*=\s*['\"]([^'\"]+)['\"]", cfg_text)
    return m.group(1).strip() if m else ''
APP_ID = _ex("VOLC_APP_ID")
ACCESS_TOKEN = _ex("VOLC_ACCESS_TOKEN")

wav_short = ROOT / "scripts" / "debug_60s.wav"
if not wav_short.exists() or wav_short.stat().st_size < 100000:
    subprocess.run([
        str(ROOT / "vendor" / "ffmpeg.exe"),
        "-y", "-i", str(WAV), "-t", "60",
        "-ac", "1", "-ar", "16000", "-vn", "-acodec", "pcm_s16le",
        str(wav_short),
    ], check=True)

audio_b64 = base64.b64encode(wav_short.read_bytes()).decode("ascii")

# Submit one task, then test multiple query bodies
req_id = str(uuid.uuid4())
payload = {
    "user": {"uid": APP_ID or "nativeos-gui"},
    "audio": {
        "format": "wav", "rate": 16000, "bits": 16, "channel": 1,
        "base64_data": audio_b64,
    },
    "request": {
        "model_name": "bigmodel",
        "enable_punc": True, "enable_ddc": True,
        "show_utterances": True, "vad_segment": True, "end_window_size": 800,
        "enable_speaker_info": True, "ssd_version": "200",
        "enable_auto_lang": True,
    },
}
body = json.dumps(payload).encode("utf-8")
headers = {
    "Content-Type": "application/json",
    "X-Api-App-Key": APP_ID,
    "X-Api-Access-Key": ACCESS_TOKEN,
    "X-Api-Resource-Id": "volc.bigasr.auc",
    "X-Api-Request-Id": req_id,
    "X-Api-Sequence": "-1",
}
print(f"[SUBMIT] req_id={req_id}")
req = urllib.request.Request("https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit",
                              data=body, headers=headers, method="POST")
try:
    with urllib.request.urlopen(req, timeout=180) as resp:
        status = resp.headers.get("x-api-status-code")
        all_h = {k: v for k, v in resp.headers.items()}
        logid = all_h.get("X-Tt-Logid") or all_h.get("x-tt-logid") or ""
        print(f"  status={status} logid={logid!r}")
except urllib.error.HTTPError as exc:
    print(f"  HTTP {exc.code}: {exc.read().decode('utf-8', errors='replace')[:200]!r}")
    raise SystemExit(1)

if status != "20000000":
    print(f"submit failed: {status}")
    raise SystemExit(1)

time.sleep(3)

# Now test 5 query variations
base_h = {
    "X-Api-App-Key": APP_ID,
    "X-Api-Access-Key": ACCESS_TOKEN,
    "X-Api-Resource-Id": "volc.bigasr.auc",
    "X-Api-Request-Id": req_id,
}

variants = [
    # (name, headers, body)
    ("V1: body={}, no Content-Type", {**base_h}, b"{}"),
    ("V2: body={}, with Content-Type application/json", {**base_h, "Content-Type": "application/json"}, b"{}"),
    ("V3: no body at all (GET-style)", {**base_h, "Content-Type": "application/json"}, None),
    ("V4: body with X-Api-Request-Id echoed", {**base_h, "Content-Type": "application/json"}, json.dumps({"X-Api-Request-Id": req_id}).encode("utf-8")),
    ("V5: 1.0/2.0 + logid from submit", {**base_h, "Content-Type": "application/json", "X-Tt-Logid": logid}, b"{}"),
]

for name, hdrs, body_data in variants:
    print(f"\n  [QUERY] {name}")
    print(f"  headers: {hdrs}")
    print(f"  body: {body_data!r}")
    try:
        req = urllib.request.Request("https://openspeech.bytedance.com/api/v3/auc/bigmodel/query",
                                      data=body_data, headers=hdrs, method="POST")
        with urllib.request.urlopen(req, timeout=180) as resp:
            status = resp.headers.get("x-api-status-code")
            body_text = resp.read().decode("utf-8", errors="replace")
            print(f"  status={status}")
            print(f"  body[:300]={body_text[:300]!r}")
            if status == "20000000":
                parsed = json.loads(body_text) if body_text else {}
                text = parsed.get("result", {}).get("text", "")
                utterances = parsed.get("result", {}).get("utterances", [])
                print(f"  ✅ SUCCESS! text={text[:200]!r}")
                print(f"  utterances count: {len(utterances)}")
                break
    except urllib.error.HTTPError as exc:
        print(f"  HTTP {exc.code}: {exc.read().decode('utf-8', errors='replace')[:200]!r}")

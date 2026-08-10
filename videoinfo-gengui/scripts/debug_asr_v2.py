"""Debug ASR v2: test 3 hypotheses for the 45000001 error on query.

H1: We missed the X-Tt-Logid header (echoed from submit response).
    CSDN reference: query MUST include X-Tt-Logid from submit's response.
H2: User opened 豆包录音文件识别 2.0 (volc.seedasr.auc) — try 2.0 resource id.
H3: 2.0 needs X-Api-Key (single key, new console) instead of X-Api-App-Key +
    X-Api-Access-Key (old dual-key format).

We test all three on the same wav so the user can pick the winner.
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

# Load creds
cfg_text = (ROOT.parent / "rn-app" / "lib" / "volcengine" / "config.ts").read_text(encoding="utf-8")
def _ex(name: str) -> str:
    m = re.search(rf"export\s+const\s+{re.escape(name)}\s*=\s*['\"]([^'\"]+)['\"]", cfg_text)
    return m.group(1).strip() if m else ''
APP_ID = _ex("VOLC_APP_ID")
ACCESS_TOKEN = _ex("VOLC_ACCESS_TOKEN")
print(f"[creds] app_id={APP_ID[:6]}...{APP_ID[-4:]} token={ACCESS_TOKEN[:6]}...{ACCESS_TOKEN[-4:]}")

# Trim 60s WAV
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


def submit(resource: str, use_api_key: bool) -> tuple[str, dict[str, str], str]:
    """Submit task. Returns (req_id, all_response_headers, logid)."""
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
    if use_api_key:
        headers = {
            "Content-Type": "application/json",
            "X-Api-Key": ACCESS_TOKEN,
            "X-Api-Resource-Id": resource,
            "X-Api-Request-Id": req_id,
            "X-Api-Sequence": "-1",
        }
    else:
        headers = {
            "Content-Type": "application/json",
            "X-Api-App-Key": APP_ID,
            "X-Api-Access-Key": ACCESS_TOKEN,
            "X-Api-Resource-Id": resource,
            "X-Api-Request-Id": req_id,
            "X-Api-Sequence": "-1",
        }
    print(f"\n  [SUBMIT] resource={resource} use_api_key={use_api_key}")
    print(f"  headers: {headers}")
    req = urllib.request.Request(
        "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit",
        data=body, headers=headers, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            status = resp.headers.get("x-api-status-code")
            body_text = resp.read().decode("utf-8", errors="replace")
            # capture ALL headers (case-insensitive dict via list of tuples)
            all_headers = {k: v for k, v in resp.headers.items()}
            print(f"  submit status={status} body[:200]={body_text[:200]!r}")
            print(f"  ALL submit response headers: {all_headers}")
            logid = all_headers.get("X-Tt-Logid") or all_headers.get("x-tt-logid") or ""
            print(f"  >> X-Tt-Logid from submit: {logid!r}")
            return req_id, all_headers, logid
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode("utf-8", errors="replace")
        all_headers = {k: v for k, v in exc.headers.items()}
        print(f"  submit HTTP {exc.code} body={body_text[:200]!r}")
        print(f"  ALL submit response headers: {all_headers}")
        return req_id, all_headers, ""


def query(req_id: str, resource: str, use_api_key: bool, logid: str = "") -> str:
    """Query task. Returns status code."""
    if use_api_key:
        headers = {
            "Content-Type": "application/json",
            "X-Api-Key": ACCESS_TOKEN,
            "X-Api-Resource-Id": resource,
            "X-Api-Request-Id": req_id,
        }
    else:
        headers = {
            "Content-Type": "application/json",
            "X-Api-App-Key": APP_ID,
            "X-Api-Access-Key": ACCESS_TOKEN,
            "X-Api-Resource-Id": resource,
            "X-Api-Request-Id": req_id,
        }
    if logid:
        headers["X-Tt-Logid"] = logid

    print(f"\n  [QUERY] resource={resource} use_api_key={use_api_key} logid={logid[:20] if logid else 'NONE'!r}")
    print(f"  headers: {headers}")
    req = urllib.request.Request(
        "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query",
        data=b"{}", headers=headers, method="POST",
    )
    # wait 5s for the task to actually be in flight
    time.sleep(5)
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            status = resp.headers.get("x-api-status-code")
            body_text = resp.read().decode("utf-8", errors="replace")
            print(f"  query status={status} body[:300]={body_text[:300]!r}")
            if status == "20000000":
                try:
                    parsed = json.loads(body_text)
                    text = parsed.get("result", {}).get("text", "")
                    utterances = parsed.get("result", {}).get("utterances", [])
                    print(f"  ✅ SUCCESS: text={text!r}")
                    print(f"  utterances count: {len(utterances)}")
                    if utterances:
                        print(f"  first utterance: {utterances[0]}")
                except Exception as e:
                    print(f"  parse error: {e}")
            return status or ""
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode("utf-8", errors="replace")
        print(f"  query HTTP {exc.code} body={body_text[:200]!r}")
        return f"HTTP{exc.code}"


print("=" * 70)
print("Test 1: volc.bigasr.auc (1.0) + dual-key + X-Tt-Logid from submit")
print("=" * 70)
req_id, _, logid = submit("volc.bigasr.auc", use_api_key=False)
status = query(req_id, "volc.bigasr.auc", use_api_key=False, logid=logid)
print(f"  >>> result: {status}")

print("\n" + "=" * 70)
print("Test 2: volc.bigasr.auc (1.0) + dual-key + WITHOUT X-Tt-Logid (control)")
print("=" * 70)
req_id, _, _ = submit("volc.bigasr.auc", use_api_key=False)
status = query(req_id, "volc.bigasr.auc", use_api_key=False, logid="")
print(f"  >>> result: {status}")

print("\n" + "=" * 70)
print("Test 3: volc.seedasr.auc (2.0) + dual-key (old format)")
print("=" * 70)
req_id, _, logid = submit("volc.seedasr.auc", use_api_key=False)
status = query(req_id, "volc.seedasr.auc", use_api_key=False, logid=logid)
print(f"  >>> result: {status}")

print("\n" + "=" * 70)
print("Test 4: volc.seedasr.auc (2.0) + X-Api-Key (new console single key)")
print("=" * 70)
req_id, _, logid = submit("volc.seedasr.auc", use_api_key=True)
status = query(req_id, "volc.seedasr.auc", use_api_key=True, logid=logid)
print(f"  >>> result: {status}")

print("\n[done]")

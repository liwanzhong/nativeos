"""Test the NEW 视频字幕生成 (subtitle generation) API per doc 109885/2606791.
Key differences from old API:
- Auth: X-Api-Key (single key) instead of X-Api-App-Key + X-Api-Access-Key
- Audio: only url field (no base64)
- New: ssd_version "200" (≤5 ppl, short audio) or "300" (voiceprint, long meeting)
- New: ssd_mode "0" (normal, ≤3min) or "1" (clustering, >3min)
"""
from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
cfg_text = (ROOT.parent / "rn-app" / "lib" / "volcengine" / "config.ts").read_text(encoding="utf-8")
def _ex(name: str) -> str:
    m = re.search(rf"export\s+const\s{re.escape(name)}\s*=\s*['\"]([^'\"]+)['\"]", cfg_text)
    return m.group(1).strip() if m else ''
APP_ID = _ex("VOLC_APP_ID")
ACCESS_TOKEN = _ex("VOLC_ACCESS_TOKEN")
print(f"[creds] app_id={APP_ID[:6]}...{APP_ID[-4:]} token={ACCESS_TOKEN[:6]}...{ACCESS_TOKEN[-4:]}")

# Public test URL from Volcengine doc (希沃白板 mp3, ~3-4 seconds, 1 speaker)
TEST_URL = "https://pro-en-ali-pub.en5static.com/easinote5_public/uwixkwvzhhqjjhnohwvyzzwnykhhihhh.mp3"

# 4 test variants: resource × auth method
variants = [
    # (name, resource, use_single_key)
    ("M1: 1.0 auc, OLD dual-key (X-Api-App-Key + X-Api-Access-Key)", "volc.bigasr.auc", False),
    ("M2: 2.0 seedasr, OLD dual-key", "volc.seedasr.auc", False),
    ("M3: 1.0 auc, NEW single X-Api-Key (user's token)", "volc.bigasr.auc", True),
    ("M4: 2.0 seedasr, NEW single X-Api-Key", "volc.seedasr.auc", True),
]

for name, resource, use_single_key in variants:
    print(f"\n{'='*70}\n{name}\n{'='*70}")
    req_id = str(uuid.uuid4())

    # Per doc 2606791: enable_speaker_info + show_utterances + ssd_version required
    # Try ssd_version=200 (simple, ≤5 ppl, ≤3min)
    payload = {
        "user": {"uid": "nativeos-test"},
        "audio": {
            "url": TEST_URL,
            "format": "mp3",
        },
        "request": {
            "model_name": "bigmodel",
            "enable_speaker_info": True,
            "ssd_version": "200",
            "ssd_mode": 0,
            "show_utterances": True,
            "enable_punc": True,
            "enable_ddc": True,
            "enable_auto_lang": True,
        },
    }
    body = json.dumps(payload).encode("utf-8")
    if use_single_key:
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
    print(f"[headers] {headers}")
    print(f"[payload] {json.dumps(payload, ensure_ascii=False)[:200]}")
    print(f"[req_id] {req_id}")

    # Submit
    try:
        req = urllib.request.Request("https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit",
                                      data=body, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=60) as resp:
            submit_status = resp.headers.get("x-api-status-code")
            submit_msg = resp.headers.get("x-api-message")
            submit_body = resp.read().decode("utf-8", errors="replace")
            print(f"  [SUBMIT] status={submit_status} msg={submit_msg!r} body={submit_body!r}")
    except urllib.error.HTTPError as exc:
        print(f"  [SUBMIT] HTTP {exc.code}: {exc.read().decode('utf-8', errors='replace')[:200]!r}")
        continue

    if submit_status != "20000000":
        continue

    # Query (per doc 2606792: same headers but no X-Api-Sequence, body is {})
    if use_single_key:
        q_headers = {
            "Content-Type": "application/json",
            "X-Api-Key": ACCESS_TOKEN,
            "X-Api-Resource-Id": resource,
            "X-Api-Request-Id": req_id,
        }
    else:
        q_headers = {
            "Content-Type": "application/json",
            "X-Api-App-Key": APP_ID,
            "X-Api-Access-Key": ACCESS_TOKEN,
            "X-Api-Resource-Id": resource,
            "X-Api-Request-Id": req_id,
        }
    time.sleep(2)
    try:
        req = urllib.request.Request("https://openspeech.bytedance.com/api/v3/auc/bigmodel/query",
                                      data=b"{}", headers=q_headers, method="POST")
        with urllib.request.urlopen(req, timeout=60) as resp:
            q_status = resp.headers.get("x-api-status-code")
            q_msg = resp.headers.get("x-api-message")
            q_body = resp.read().decode("utf-8", errors="replace")
            print(f"  [QUERY 2s] status={q_status} msg={q_msg!r} body[:400]={q_body[:400]!r}")
            if q_status == "20000000":
                parsed = json.loads(q_body) if q_body else {}
                text = parsed.get("result", {}).get("text", "")
                utterances = parsed.get("result", {}).get("utterances", [])
                print(f"  ✅ text={text!r}")
                print(f"  utterances: {len(utterances)}")
                for u in utterances[:3]:
                    print(f"    {u}")
    except urllib.error.HTTPError as exc:
        print(f"  [QUERY] HTTP {exc.code}: {exc.read().decode('utf-8', errors='replace')[:200]!r}")

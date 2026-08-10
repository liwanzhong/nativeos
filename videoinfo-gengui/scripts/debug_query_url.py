"""Test with public URL audio instead of base64_data.
Hypothesis: base64_data is accepted by submit but task isn't actually persisted,
so query returns 45000001 "请求参数无效" (task not found / unknown req_id).
Switch to audio.url with a public MP3 to confirm.
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
    m = re.search(rf"export\s+const\s+{re.escape(name)}\s*=\s*['\"]([^'\"]+)['\"]", cfg_text)
    return m.group(1).strip() if m else ''
APP_ID = _ex("VOLC_APP_ID")
ACCESS_TOKEN = _ex("VOLC_ACCESS_TOKEN")
print(f"[creds] app_id={APP_ID[:6]}...{APP_ID[-4:]} token={ACCESS_TOKEN[:6]}...{ACCESS_TOKEN[-4:]}")

# Test URL — public sample from Volcengine docs (希沃白板 mp3, 3-4 seconds)
# These URLs are referenced in Volcengine's own blog as ASR test inputs.
TEST_URL = "https://pro-en-ali-pub.en5static.com/easinote5_public/uwixkwvzhhqjjhnohwvyzzwnykhhihhh.mp3"

req_id = str(uuid.uuid4())
print(f"[req_id] {req_id}")

payload = {
    "user": {"uid": APP_ID or "nativeos-gui"},
    "audio": {
        "url": TEST_URL,
        "format": "mp3",
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

for resource in ["volc.bigasr.auc", "volc.seedasr.auc"]:
    print(f"\n{'='*60}")
    print(f"Resource: {resource}")
    print(f"{'='*60}")
    rid = str(uuid.uuid4())
    payload["user"]["uid"] = f"{APP_ID}-{resource}"
    body = json.dumps(payload).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "X-Api-App-Key": APP_ID,
        "X-Api-Access-Key": ACCESS_TOKEN,
        "X-Api-Resource-Id": resource,
        "X-Api-Request-Id": rid,
        "X-Api-Sequence": "-1",
    }
    print(f"[SUBMIT] req_id={rid}")
    try:
        req = urllib.request.Request("https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit",
                                      data=body, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=180) as resp:
            status = resp.headers.get("x-api-status-code")
            all_h = {k: v for k, v in resp.headers.items()}
            logid = all_h.get("X-Tt-Logid") or all_h.get("x-tt-logid") or ""
            print(f"  submit status={status} logid={logid!r}")
    except urllib.error.HTTPError as exc:
        print(f"  submit HTTP {exc.code}: {exc.read().decode('utf-8', errors='replace')[:200]!r}")
        continue

    if status != "20000000":
        continue

    # Query in 2s, 5s, 10s, 20s
    for delay in [2, 5, 10, 20]:
        time.sleep(delay if delay == 2 else (delay - {2:0, 5:2, 10:5, 20:10}[delay]))
        print(f"\n  [QUERY after {delay}s total]")
        try:
            q_headers = {
                "Content-Type": "application/json",
                "X-Api-App-Key": APP_ID,
                "X-Api-Access-Key": ACCESS_TOKEN,
                "X-Api-Resource-Id": resource,
                "X-Api-Request-Id": rid,
            }
            req = urllib.request.Request("https://openspeech.bytedance.com/api/v3/auc/bigmodel/query",
                                          data=b"{}", headers=q_headers, method="POST")
            with urllib.request.urlopen(req, timeout=180) as resp:
                q_status = resp.headers.get("x-api-status-code")
                q_body = resp.read().decode("utf-8", errors="replace")
                print(f"  query status={q_status}")
                print(f"  body[:400]={q_body[:400]!r}")
                if q_status == "20000000":
                    parsed = json.loads(q_body) if q_body else {}
                    text = parsed.get("result", {}).get("text", "")
                    utterances = parsed.get("result", {}).get("utterances", [])
                    print(f"  ✅✅✅ SUCCESS! text={text!r}")
                    print(f"  utterances count: {len(utterances)}")
                    if utterances:
                        print(f"  first utterance: {utterances[0]}")
                    break
        except urllib.error.HTTPError as exc:
            print(f"  query HTTP {exc.code}: {exc.read().decode('utf-8', errors='replace')[:200]!r}")

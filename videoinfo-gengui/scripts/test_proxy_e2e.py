"""E2E test: send wav to proxy /asr-upload via multipart, expect text + utterances."""
import urllib.request, urllib.error, json, time
from pathlib import Path

WAV = Path(__file__).parent / "debug_20s.wav"
print(f"[client] wav={WAV.stat().st_size} bytes, exists={WAV.exists()}")
data = WAV.read_bytes()

boundary = "----NativeOSTestBoundary12345"
crlf = b"\r\n"
body = b"--" + boundary.encode() + crlf
body += b'Content-Disposition: form-data; name="audio"; filename="test.wav"' + crlf
body += b"Content-Type: audio/wav" + crlf + crlf
body += data + crlf
body += b"--" + boundary.encode() + b"--" + crlf

req = urllib.request.Request("http://localhost:8788/asr-upload", data=body, method="POST")
req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
print("[client] sending multipart...")
t0 = time.time()
try:
    with urllib.request.urlopen(req, timeout=60) as resp:
        text = resp.read().decode("utf-8", errors="replace")
        print(f"[client] HTTP {resp.status} in {time.time()-t0:.1f}s")
        print(f"[client] body[:600]={text[:600]!r}")
        try:
            parsed = json.loads(text)
            print(f"[client] text={parsed.get('text', '')[:200]!r}")
            utts = parsed.get("utterances", [])
            print(f"[client] utterances count: {len(utts)}")
            for u in utts[:3]:
                print(f"  {u.get('text', '')[:120]!r} ({u.get('start_time')}-{u.get('end_time')})")
        except Exception as e:
            print(f"[client] parse error: {e}")
except urllib.error.HTTPError as e:
    print(f"[client] HTTP {e.code}: {e.read().decode('utf-8', errors='replace')[:300]!r}")

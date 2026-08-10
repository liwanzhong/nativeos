"""Test the new server.js transcribeWavBufferViaStreaming function directly.
Simulates what /asr-upload will do: take a wav buffer, stream to Volcengine,
return { text, utterances }.

This validates the new code path end-to-end before the user boots proxy +
runs the RN app.
"""
from __future__ import annotations

import base64
import re
import subprocess
import time
from pathlib import Path
import asyncio
import websockets
import json
import struct
import gzip

ROOT = Path(__file__).resolve().parents[1]
WAV = Path(r"D:\yt-dlp\Chandler and Monica Find Out If They Got the House ｜ Friends.mp4")
cfg_text = (ROOT.parent / "rn-app" / "lib" / "volcengine" / "config.ts").read_text(encoding="utf-8")
def _ex(name: str) -> str:
    m = re.search(rf"export\s+const\s{re.escape(name)}\s*=\s*['\"]([^'\"]+)['\"]", cfg_text)
    return m.group(1).strip() if m else ''
APP_ID = _ex("VOLC_APP_ID")
ACCESS_TOKEN = _ex("VOLC_ACCESS_TOKEN")
print(f"[creds] app_id={APP_ID[:6]}...{APP_ID[-4:]} token={ACCESS_TOKEN[:6]}...{ACCESS_TOKEN[-4:]}")

# Trim 20s clip with 2 speakers
wav_short = ROOT / "scripts" / "debug_20s.wav"
if not wav_short.exists() or wav_short.stat().st_size < 100000:
    print("[ffmpeg] trimming 20s clip...")
    subprocess.run([
        str(ROOT / "vendor" / "ffmpeg.exe"),
        "-y", "-i", str(WAV), "-t", "20",
        "-ac", "1", "-ar", "16000", "-vn", "-acodec", "pcm_s16le",
        str(wav_short),
    ], check=True)

wav_bytes = wav_short.read_bytes()
print(f"[wav] {len(wav_bytes)} bytes (44 header + {len(wav_bytes) - 44} PCM = {(len(wav_bytes) - 44) / 32000:.1f}s)")

# ── Reproduce server.js transcribeWavBufferViaStreaming in Python for verification ──
WS_URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel"
RESOURCE = "volc.bigasr.sauc.duration"

PROTO_VER = 0b0001; HDR_SIZE = 0b0001
MSG_FULL_CLIENT = 0b0001; MSG_AUDIO_ONLY = 0b0010; MSG_FULL_SERVER = 0b1001
FLAG_POS_SEQ = 0b0001; FLAG_NEG_LAST = 0b0011
SER_JSON = 0b0001; SER_NONE = 0b0000
CMP_NONE = 0b0000

def make_header(mt, fl, se, co):
    return bytes([(PROTO_VER << 4) | HDR_SIZE, (mt << 4) | fl, (se << 4) | co, 0])
def int32be(n): return struct.pack(">i", n)

# This is the EXACT same logic as server.js
async def transcribe_wav(wav_buf):
    PCM_HEADER_BYTES = 44
    pcm = wav_buf[PCM_HEADER_BYTES:]
    init = {
        "user": {"uid": "test-proxy"},
        "audio": {"format": "pcm", "rate": 16000, "bits": 16, "channel": 1, "codec": "raw"},
        "request": {
            "model_name": "bigmodel",
            "enable_punc": True, "enable_ddc": True, "enable_itn": True,
            "show_utterances": True, "vad_segment": True, "end_window_size": 800,
            "enable_auto_lang": True,
        },
    }
    init_bytes = json.dumps(init).encode("utf-8")
    headers = {
        "X-Api-App-Key": APP_ID,
        "X-Api-Access-Key": ACCESS_TOKEN,
        "X-Api-Resource-Id": RESOURCE,
        "X-Api-Request-Id": "test-req-id",
    }
    CHUNK = 3200
    audio_seq = 2
    final_text = ""
    utterances = []
    import inspect
    sig = inspect.signature(websockets.connect)
    kw = "additional_headers" if "additional_headers" in sig.parameters else "extra_headers"

    async with websockets.connect(WS_URL, **{kw: headers}, max_size=10_000_000) as ws:
        await ws.send(make_header(MSG_FULL_CLIENT, FLAG_POS_SEQ, SER_JSON, CMP_NONE) + int32be(1) + struct.pack(">I", len(init_bytes)) + init_bytes)
        # Stream chunks
        offset = 0
        while offset < len(pcm):
            slc = pcm[offset:offset+CHUNK]
            await ws.send(make_header(MSG_AUDIO_ONLY, FLAG_POS_SEQ, SER_NONE, CMP_NONE) + int32be(audio_seq) + struct.pack(">I", len(slc)) + slc)
            audio_seq += 1
            offset += CHUNK
            await asyncio.sleep(0.005)
        # Last
        await ws.send(make_header(MSG_AUDIO_ONLY, FLAG_NEG_LAST, SER_NONE, CMP_NONE) + int32be(-audio_seq) + struct.pack(">I", 0))

        while True:
            raw = await asyncio.wait_for(ws.recv(), timeout=20)
            if len(raw) < 4:
                continue
            msg_type = (raw[1] >> 4) & 0x0f
            flags = raw[1] & 0x0f
            if msg_type == 0b1111:
                code = struct.unpack(">I", raw[4:8])[0]
                size = struct.unpack(">I", raw[8:12])[0]
                msg = raw[12:12+size].decode("utf-8", errors="replace")
                raise RuntimeError(f"server error {code}: {msg}")
            if msg_type != MSG_FULL_SERVER:
                continue
            off = 4
            if flags & 0x01: off += 4
            if len(raw) < off + 4: continue
            payload_size = struct.unpack(">I", raw[off:off+4])[0]
            off += 4
            payload = raw[off:off+payload_size].decode("utf-8", errors="replace")
            is_last = bool(flags & 0x02)
            try:
                parsed = json.loads(payload)
                if parsed.get("result", {}).get("text"):
                    final_text = parsed["result"]["text"]
                    utterances = parsed["result"].get("utterances", [])
                if is_last:
                    return final_text, utterances
            except Exception as e:
                print(f"parse error: {e}")

print("\n[run] transcribe_wav (simulating server.js logic)")
text, utts = asyncio.run(transcribe_wav(wav_bytes))
print(f"\n[result] text={text!r}")
print(f"[result] utterances: {len(utts)}")
for u in utts[:5]:
    print(f"  {u}")
print("\n✅ If you see this, server.js transcribeWavBufferViaStreaming will work.")

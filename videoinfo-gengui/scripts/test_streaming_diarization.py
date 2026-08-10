"""Test streaming ASR with 100ms chunks + enable_speaker_info + ssd_version=200.
Follows NativeOS lib/volcengine/asr.ts protocol exactly.
"""
from __future__ import annotations

import base64
import gzip
import json
import re
import struct
import subprocess
import time
import uuid
import wave
from pathlib import Path
import asyncio
import websockets

ROOT = Path(__file__).resolve().parents[1]
WAV = Path(r"D:\yt-dlp\Chandler and Monica Find Out If They Got the House ｜ Friends.mp4")

cfg_text = (ROOT.parent / "rn-app" / "lib" / "volcengine" / "config.ts").read_text(encoding="utf-8")
def _ex(name: str) -> str:
    m = re.search(rf"export\s+const\s{re.escape(name)}\s*=\s*['\"]([^'\"]+)['\"]", cfg_text)
    return m.group(1).strip() if m else ''
APP_ID = _ex("VOLC_APP_ID")
ACCESS_TOKEN = _ex("VOLC_ACCESS_TOKEN")

wav_short = ROOT / "scripts" / "debug_30s.wav"
if not wav_short.exists() or wav_short.stat().st_size < 100000:
    subprocess.run([
        str(ROOT / "vendor" / "ffmpeg.exe"),
        "-y", "-i", str(WAV), "-t", "30",
        "-ac", "1", "-ar", "16000", "-vn", "-acodec", "pcm_s16le",
        str(wav_short),
    ], check=True)

with wave.open(str(wav_short), "rb") as w:
    pcm = w.readframes(w.getnframes())
    sr = w.getframerate()
    ch = w.getnchannels()
print(f"[pcm] {len(pcm)} bytes, {sr}Hz, {ch}ch, {len(pcm)/sr:.1f}s")

# 100ms chunks (NativeOS pattern: 3200 bytes @ 16kHz mono s16le)
CHUNK_BYTES = int(0.1 * sr) * 2  # 100ms mono 16-bit = 3200 bytes
chunks = [pcm[i:i+CHUNK_BYTES] for i in range(0, len(pcm), CHUNK_BYTES)]
print(f"[chunks] {len(chunks)} chunks of {CHUNK_BYTES} bytes each")

# Protocol constants
PROTO_VER = 0b0001; HDR_SIZE = 0b0001
MSG_FULL_CLIENT = 0b0001; MSG_AUDIO_ONLY = 0b0010; MSG_FULL_SERVER = 0b1001
FLAG_POS_SEQ = 0b0001; FLAG_NEG_LAST = 0b0011
SER_JSON = 0b0001; SER_NONE = 0b0000
CMP_GZIP = 0b0001; CMP_NONE = 0b0000

def make_header(msg_type, flags, ser, comp):
    return bytes([(PROTO_VER << 4) | HDR_SIZE, (msg_type << 4) | flags, (ser << 4) | comp, 0])
def int32be(n):
    return struct.pack(">i", n)

async def run(enable_speaker: bool, ssd_version: str = "200"):
    print(f"\n{'='*60}\nenable_speaker_info={enable_speaker} ssd_version={ssd_version!r}\n{'='*60}")
    req_id = str(uuid.uuid4())
    print(f"[req_id] {req_id}")

    init = {
        "user": {"uid": "nativeos-test"},
        "audio": {"format": "pcm", "rate": 16000, "bits": 16, "channel": 1, "codec": "raw"},
        "request": {
            "model_name": "bigmodel",
            "enable_punc": True, "enable_ddc": True,
            "show_utterances": True, "vad_segment": True, "end_window_size": 800,
            "enable_auto_lang": True,
        },
    }
    if enable_speaker:
        init["request"]["enable_speaker_info"] = True
        init["request"]["ssd_version"] = ssd_version

    # NativeOS lib/volcengine/asr.ts uses CMP_NONE (no compression) for init
    init_bytes = json.dumps(init).encode("utf-8")
    init_pkt = make_header(MSG_FULL_CLIENT, FLAG_POS_SEQ, SER_JSON, CMP_NONE) + int32be(1) + struct.pack(">I", len(init_bytes)) + init_bytes

    headers = {
        "X-Api-App-Key": APP_ID,
        "X-Api-Access-Key": ACCESS_TOKEN,
        "X-Api-Resource-Id": "volc.bigasr.sauc.duration",
        "X-Api-Request-Id": req_id,
    }

    print(f"[connect]")
    import inspect
    sig = inspect.signature(websockets.connect)
    kw = "additional_headers" if "additional_headers" in sig.parameters else "extra_headers"
    async with websockets.connect("wss://openspeech.bytedance.com/api/v3/sauc/bigmodel", **{kw: headers}, max_size=10_000_000) as ws:
        await ws.send(init_pkt)
        seq = 2
        sent = 0
        for chunk in chunks:
            audio_pkt = make_header(MSG_AUDIO_ONLY, FLAG_POS_SEQ, SER_NONE, CMP_NONE) + int32be(seq) + struct.pack(">I", len(chunk)) + chunk
            await ws.send(audio_pkt)
            seq += 1
            sent += 1
            if sent % 30 == 0:
                print(f"  sent {sent}/{len(chunks)}")
            await asyncio.sleep(0.01)  # 10ms between chunks

        # Last packet
        last_pkt = make_header(MSG_AUDIO_ONLY, FLAG_NEG_LAST, SER_NONE, CMP_NONE) + int32be(-seq) + struct.pack(">I", 0)
        await ws.send(last_pkt)
        print(f"[sent all {sent} chunks + last]")

        final = None
        partial_text = ""
        try:
            while True:
                raw = await asyncio.wait_for(ws.recv(), timeout=30)
                if len(raw) < 12:
                    continue
                msg_type = (raw[1] >> 4) & 0x0F
                flags = raw[1] & 0x0F
                comp = raw[2] & 0x0F
                off = 4
                if flags & 0x01:
                    off += 4
                is_last = bool(flags & 0x02)
                if msg_type != MSG_FULL_SERVER:
                    continue
                payload_size = struct.unpack(">I", raw[off:off+4])[0]
                payload = raw[off+4:off+4+payload_size]
                if comp == CMP_GZIP:
                    payload = gzip.decompress(payload)
                obj = json.loads(payload)
                text = obj.get("result", {}).get("text", "")
                utterances = obj.get("result", {}).get("utterances", [])
                if is_last:
                    final = obj
                    print(f"[FINAL] text={text!r}")
                    print(f"[FINAL] utterances count: {len(utterances)}")
                    for u in utterances[:8]:
                        speaker = u.get("additions", {}).get("speaker", "?")
                        u_text = u.get("text", "")
                        u_start = u.get("start_time", 0)
                        u_end = u.get("end_time", 0)
                        print(f"  [spk={speaker}] {u_start:>5}-{u_end:>5}: {u_text!r}")
                    break
                else:
                    partial_text = text
        except asyncio.TimeoutError:
            print(f"[timeout] partial_text={partial_text!r}")
        except websockets.exceptions.ConnectionClosed:
            print(f"[ws closed] final_text={partial_text!r}")
        return final

asyncio.run(run(enable_speaker=False))
asyncio.run(run(enable_speaker=True, ssd_version="200"))

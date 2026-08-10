"""Restore the imports + constants + helper functions at the top of asr_client.py
that were accidentally removed by apply_asr_fix.py. The new transcribe_wav_file_direct
function (which references VOLC_ASR_*, ASR_*, time, urllib, etc.) is intact;
we just need to put the boilerplate back in front.
"""
from pathlib import Path

TARGET = Path(r'E:\mycodes\deckmind\NativeOS\videoinfo-gengui\tabs\asr_client.py')

HEADER = '''from __future__ import annotations

import base64
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Callable
import urllib.error
import urllib.request
import wave

from tabs.runtime_support import load_json_config, resolve_executable, resolve_ffmpeg_dir, save_json_config

VOLC_ASR_SUBMIT_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit"
VOLC_ASR_QUERY_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query"
VOLC_ASR_RESOURCE = "volc.bigasr.auc"
ASR_SAMPLE_RATE = 16000
ASR_CHANNELS = 1
ASR_SAMPLE_WIDTH_BYTES = 2
ASR_CHUNK_SIZE_MS = 30_000
REQUEST_TIMEOUT_SECONDS = 180
QUERY_POLL_INTERVAL_SECONDS = 1.5
QUERY_MAX_ATTEMPTS = 60  # 60 * 1.5s = 90s upper bound per task


def load_asr_config() -> dict[str, str]:
    data = load_json_config()
    cfg = data.get("asr", {})
    if cfg:
        return cfg
    legacy = _load_rn_volc_config()
    if legacy:
        return legacy
    return {}


def save_asr_config(cfg: dict[str, str]) -> None:
    save_json_config({"asr": cfg})


def _load_rn_volc_config() -> dict[str, str]:
    config_path = Path(__file__).resolve().parents[2] / "rn-app" / "lib" / "volcengine" / "config.ts"
    if not config_path.exists():
        return {}
    try:
        text = config_path.read_text("utf-8")
    except Exception:
        return {}
    app_id = _extract_ts_export_string(text, "VOLC_APP_ID")
    access_token = _extract_ts_export_string(text, "VOLC_ACCESS_TOKEN")
    if not app_id or not access_token:
        return {}
    return {"app_id": app_id, "access_token": access_token}


def _extract_ts_export_string(text: str, name: str) -> str:
    match = re.search(rf"export\\s+const\\s+{re.escape(name)}\\s*=\\s*['\\\"]([^'\\\"]+)['\\\"]", text)
    return match.group(1).strip() if match else ""


def _run_command(cmd: list[str], cwd: Path | None = None, on_progress: Callable[[str], None] | None = None) -> None:
    if on_progress:
        on_progress("[执行] " + " ".join(cmd))
    process = subprocess.Popen(
        cmd,
        cwd=str(cwd) if cwd else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    assert process.stdout is not None
    tail: list[str] = []
    for line in process.stdout:
        clean = line.rstrip()
        if clean:
            tail.append(clean)
            tail = tail[-8:]
            if on_progress:
                on_progress(clean)
    code = process.wait()
    if code != 0:
        detail = "\\n".join(tail[-5:])
        raise RuntimeError(f"命令执行失败（exit {code}）：{detail}")


def _ffmpeg_executable(ffmpeg_dir: str = "") -> str:
    resolved_dir = resolve_ffmpeg_dir(ffmpeg_dir)
    if resolved_dir:
        candidate = Path(resolved_dir) / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
        if candidate.exists():
            return str(candidate)
    executable = resolve_executable("ffmpeg")
    if executable:
        return executable
    raise RuntimeError("未找到 ffmpeg，请先在下载页配置 ffmpeg 目录或加入 PATH。")


def _yt_dlp_executable() -> str:
    executable = resolve_executable("yt-dlp")
    if executable:
        return executable
    raise RuntimeError("未找到 yt-dlp，请先安装或放入 vendor 目录。")


def _safe_stem(stem: str) -> str:
    return re.sub(r'[<>:"/\\\\|?*\\x00-\\x1f]+', '_', stem).strip().strip('.') or 'audio'


def _read_info_source_url(info_path: Path | None) -> str:
    if not info_path or not info_path.exists():
        return ""
    try:
        data = json.loads(info_path.read_text("utf-8"))
    except Exception:
        return ""
    for key in ("webpage_url", "original_url", "url"):
        value = str(data.get(key) or "").strip()
        if value.startswith(("http://", "https://")):
            return value
    return ""


def download_best_audio_with_ytdlp(source_url: str, output_dir: Path, stem: str, on_progress: Callable[[str], None] | None = None) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    before = {p.resolve() for p in output_dir.glob(f'{_safe_stem(stem)}.asr-audio.*')}
    output_template = str(output_dir / f'{_safe_stem(stem)}.asr-audio.%(ext)s')
    cmd = [
        _yt_dlp_executable(),
        "-f", "ba",
        "--no-playlist",
        "-o", output_template,
        source_url,
    ]
    _run_command(cmd, cwd=output_dir, on_progress=on_progress)
    candidates = [p for p in output_dir.glob(f'{_safe_stem(stem)}.asr-audio.*') if p.resolve() not in before]
    if not candidates:
        candidates = list(output_dir.glob(f'{_safe_stem(stem)}.asr-audio.*'))
    candidates = [p for p in candidates if p.is_file() and p.suffix.lower() != ".part"]
    if not candidates:
        raise RuntimeError("yt-dlp 未生成音频文件")
    return max(candidates, key=lambda p: p.stat().st_mtime)


def convert_media_to_asr_wav(input_path: Path, output_path: Path, ffmpeg_dir: str = "", on_progress: Callable[[str], None] | None = None) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        _ffmpeg_executable(ffmpeg_dir),
        "-y",
        "-i", str(input_path),
        "-ac", str(ASR_CHANNELS),
        "-ar", str(ASR_SAMPLE_RATE),
        "-vn",
        "-acodec", "pcm_s16le",
        str(output_path),
    ]
    _run_command(cmd, cwd=output_path.parent, on_progress=on_progress)
    if not output_path.exists() or output_path.stat().st_size <= 44:
        raise RuntimeError("ffmpeg 未生成有效 WAV 文件")
    return output_path


def get_wav_duration_ms(wav_path: Path) -> int:
    with wave.open(str(wav_path), "rb") as wav:
        frames = wav.getnframes()
        rate = wav.getframerate()
    if rate <= 0:
        return 0
    return max(0, round(frames * 1000 / rate))


def extract_wav_chunk(wav_path: Path, output_path: Path, start_ms: int, end_ms: int, ffmpeg_dir: str = "") -> Path:
    duration_ms = max(1, end_ms - start_ms)
    cmd = [
        _ffmpeg_executable(ffmpeg_dir),
        "-y",
        "-ss", f"{start_ms / 1000:.3f}",
        "-i", str(wav_path),
        "-t", f"{duration_ms / 1000:.3f}",
        "-ac", str(ASR_CHANNELS),
        "-ar", str(ASR_SAMPLE_RATE),
        "-vn",
        "-acodec", "pcm_s16le",
        str(output_path),
    ]
    _run_command(cmd, cwd=output_path.parent)
    return output_path


'''


def main() -> int:
    current = TARGET.read_text(encoding="utf-8")
    if current.startswith("from __future__"):
        print("file already has a header — nothing to do")
        return 0
    TARGET.write_text(HEADER + current, encoding="utf-8")
    print(f"prepended {len(HEADER)} chars")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

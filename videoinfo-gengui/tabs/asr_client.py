from __future__ import annotations

import json
import math
import os
import re
import subprocess
import uuid
from pathlib import Path
from typing import Any, Callable
import urllib.parse
import urllib.request
import wave

from tabs.runtime_support import load_json_config, resolve_executable, resolve_ffmpeg_dir, save_json_config

# File ASR (submit + query) — Volcengine 视频字幕生成接口
# 跟 rn-app/lib/volcengine/file-asr.ts::transcribeWavFileDirect 接口和参数完全一致
# Doc: https://www.volcengine.com/docs/6561/80909
#
# 流程:
#   1) POST /api/v1/vc/submit  (audio body, Content-Type: audio/wav)
#      URL params: appid, language, caption_type=speech, use_itn=True, use_punc=True,
#                  max_lines=1, words_per_line=15/55
#      Header:     Authorization: Bearer; <token>
#   2) GET /api/v1/vc/query?appid=&id=&blocking=1&language=
#      Header:     Authorization: Bearer; <token>
#   返回 {id, code, message, duration?, utterances?}
#
# 不接说话人识别 (不传 with_speaker_info),走 caption_type=speech (use_punc 才生效),
# 不调 enable_itn/use_ddc/use_punc 的豆包大模型开关(走接口默认行为)。
VOLC_VC_SUBMIT_URL = "https://openspeech.bytedance.com/api/v1/vc/submit"
VOLC_VC_QUERY_URL = "https://openspeech.bytedance.com/api/v1/vc/query"

ASR_SAMPLE_RATE = 16000
ASR_CHANNELS = 1
ASR_SAMPLE_WIDTH_BYTES = 2
REQUEST_TIMEOUT_SECONDS = 180


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
    match = re.search(rf"export\s+const\s+{re.escape(name)}\s*=\s*['\"]([^'\"]+)['\"]", text)
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
        detail = "\n".join(tail[-5:])
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
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]+', '_', stem).strip().strip('.') or 'audio'


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


def transcribe_wav_file_direct(wav_path: Path, cfg: dict[str, str], language: str = 'en-US') -> dict[str, Any]:
    """Transcribe a local WAV file via Volcengine 视频字幕生成接口 (submit + query blocking).

    接口和参数跟 rn-app/lib/volcengine/file-asr.ts::transcribeWavFileDirect 完全一致:
      - 鉴权: Authorization: Bearer; <token>  (注意 Bearer 后面是分号)
      - submit: POST /api/v1/vc/submit  (audio body, Content-Type: audio/wav)
        URL params: appid, language, caption_type=speech, use_itn=True, use_punc=True,
                    max_lines=1, words_per_line=15/55
      - query:  GET  /api/v1/vc/query?appid=&id=&blocking=1&language=
      - 不传 with_speaker_info (False), 不传 use_ddc (False)
      - 响应 status: 走 body.code (0 = 成功)

    不接说话人识别（user 不要），不需要切 30s 分片（文件接口吃整段音频）。

    Doc: https://www.volcengine.com/docs/6561/80909
    """
    app_id = str(cfg.get("app_id") or "").strip()
    access_token = str(cfg.get("access_token") or "").strip()
    if not app_id or not access_token:
        raise ValueError("ASR 未配置，请填写火山 App ID 和 Access Token。")
    if not wav_path.exists():
        raise FileNotFoundError(f"wav 文件不存在: {wav_path}")
    if wav_path.stat().st_size <= 44:
        raise RuntimeError(f"wav 文件过小: {wav_path} ({wav_path.stat().st_size} bytes)")

    task_id = str(uuid.uuid4())
    duration_seconds = get_wav_duration_ms(wav_path) / 1000.0
    print(f"  [ASR] taskId={task_id} wav={wav_path.name} ({duration_seconds:.1f}s) language={language}")

    auth_header = f'Bearer; {access_token}'  # 注意: Bearer 后面是分号, 跟文档一致

    # ── 1) submit (POST audio body) ────────────────────────────────
    submit_params = {
        'appid': app_id,
        'language': language,                                # 'en-US' / 'zh-CN'
        'caption_type': 'speech',                             # 只识别说话, use_punc 仅此模式生效
        'use_itn': 'True',                                    # 数字归一化
        'use_punc': 'True',                                   # 加标点
        'max_lines': '1',                                     # 不分屏
        'words_per_line': '15' if language == 'zh-CN' else '55',
        # 2026-08-15 加上说话人识别: 卡通/多人对话场景需要按说话人切段,
        # 之前不传导致 (Peppa) / (narrator) 多人混在同一个 utterance.
        # 说话人变化时的后处理切段暂不做,先让 ASR 返回带 speaker 字段的
        # utterances,看真实返回结构再决定切段策略.
        'with_speaker_info': 'True',
        # 不传 use_ddc (默认 False) — 字幕场景不需要口水词/重复词特殊处理
    }
    submit_url = f"{VOLC_VC_SUBMIT_URL}?" + urllib.parse.urlencode(submit_params)
    wav_bytes = wav_path.read_bytes()
    print(f"  [ASR] submit start wav={len(wav_bytes)} bytes url={submit_url[:120]}...")
    # 2026-08-15 调试: 打印完整 submit params, 确认 with_speaker_info 是否生效
    print(f"  [ASR] submit params: {submit_params}")

    submit_req = urllib.request.Request(
        submit_url,
        data=wav_bytes,
        headers={
            'Authorization': auth_header,
            'Content-Type': 'audio/wav',
            'Content-Length': str(len(wav_bytes)),
        },
        method='POST',
    )
    with urllib.request.urlopen(submit_req, timeout=60) as resp:
        submit_raw = resp.read().decode('utf-8', errors='replace')
    try:
        submit_body = json.loads(submit_raw) if submit_raw else {}
    except Exception:
        submit_body = {'_raw': submit_raw}
    submit_code = submit_body.get('code')
    if submit_code != 0:
        raise RuntimeError(f"ASR submit 失败: code={submit_code} message={submit_body.get('message')} body={submit_body}")
    job_id = submit_body.get('id')
    if not job_id:
        raise RuntimeError(f"ASR submit 成功但没返回 id: {submit_body}")
    print(f"  [ASR] submit response code={submit_code} jobId={job_id}")

    # ── 2) query 阻塞 (GET blocking=1, 5min 上限) ────────────────
    query_params = {
        'appid': app_id,
        'id': job_id,
        'blocking': '1',      # 阻塞,服务端处理完一次返回
        'language': language,
    }
    query_url = f"{VOLC_VC_QUERY_URL}?" + urllib.parse.urlencode(query_params)
    print(f"  [ASR] query start (blocking) jobId={job_id} url={query_url[:120]}...")

    query_req = urllib.request.Request(
        query_url,
        headers={'Authorization': auth_header},
        method='GET',
    )
    with urllib.request.urlopen(query_req, timeout=300) as resp:
        query_raw = resp.read().decode('utf-8', errors='replace')
    try:
        query_body = json.loads(query_raw) if query_raw else {}
    except Exception:
        query_body = {'_raw': query_raw}
    query_code = query_body.get('code')
    if query_code != 0:
        raise RuntimeError(f"ASR query 失败: code={query_code} message={query_body.get('message')} body={query_body}")

    utterances = query_body.get('utterances') if isinstance(query_body.get('utterances'), list) else []
    text = ' '.join(
        str(u.get('text') or '').strip() for u in utterances if str(u.get('text') or '').strip()
    ).strip()
    print(f"  [ASR] query response code={query_code} duration={query_body.get('duration')}s utteranceCount={len(utterances)}")
    # 2026-08-15 调试: 打印前几个 utterance 的 keys / speaker / word 数量,
    # 验证 with_speaker_info=True 是否真的让 ASR 返回说话人信息.
    # 关注: speaker 字段在 utterance 上? 还是在每个 word 上? 值是什么类型?
    if utterances:
        print(f"  [ASR] utterance[0] keys: {sorted(utterances[0].keys()) if isinstance(utterances[0], dict) else 'NOT_DICT'}")
        for idx, u in enumerate(utterances[:5]):
            if not isinstance(u, dict):
                continue
            words = u.get('words') if isinstance(u.get('words'), list) else []
            word_keys = sorted(words[0].keys()) if words and isinstance(words[0], dict) else 'NO_WORDS'
            sample_words = [(w.get('text', ''), w.get('speaker', '?')) for w in words[:3] if isinstance(w, dict)]
            print(f"  [ASR] utterance[{idx}]: speaker={u.get('speaker', 'NO_SPEAKER_FIELD')!r} "
                  f"text={str(u.get('text') or '')[:60]!r} wordCount={len(words)} wordKeys={word_keys} sample={sample_words}")
        # 统计: 共多少个不同 speaker
        speaker_set = set()
        for u in utterances:
            if isinstance(u, dict):
                if 'speaker' in u:
                    speaker_set.add(u.get('speaker'))
                words = u.get('words') if isinstance(u.get('words'), list) else []
                for w in words:
                    if isinstance(w, dict) and 'speaker' in w:
                        speaker_set.add(w.get('speaker'))
        print(f"  [ASR] speaker set: {sorted(speaker_set, key=str)}")
    return {
        'text': text,
        'utterances': utterances,
        'raw': {
            'submit_code': submit_code,
            'query_code': query_code,
            'task_id': task_id,
            'job_id': job_id,
            'duration_s': query_body.get('duration') or duration_seconds,
            'language': language,
        },
    }


def _to_finite_number(value: Any) -> float | None:
    try:
        number = float(value)
    except Exception:
        return None
    if not math.isfinite(number):
        return None
    return number


def _normalize_ms(value: Any) -> int | None:
    number = _to_finite_number(value)
    if number is None:
        return None
    if number < 0:
        return None
    if number >= 1000:
        return round(number)
    if not float(number).is_integer():
        return round(number * 1000) if number < 100 else round(number)
    return round(number * 1000) if number <= 60 else round(number)


def _get_start_ms(value: dict[str, Any]) -> int | None:
    for key in ('start_time', 'startTime', 'start_ms', 'startMs'):
        normalized = _normalize_ms(value.get(key))
        if normalized is not None:
            return normalized
    return None


def _get_end_ms(value: dict[str, Any]) -> int | None:
    for key in ('end_time', 'endTime', 'end_ms', 'endMs'):
        normalized = _normalize_ms(value.get(key))
        if normalized is not None:
            return normalized
    return None


def _clamp(value: int, min_value: int, max_value: int) -> int:
    return min(max(value, min_value), max_value)


def _normalize_chunk_timestamp(raw_ms: int | None, time_offset_ms: int, chunk_duration_ms: int | None) -> int | None:
    if raw_ms is None:
        return None
    if chunk_duration_ms is None or chunk_duration_ms <= 0:
        return max(0, raw_ms)
    if 0 <= raw_ms <= chunk_duration_ms + 1500:
        return _clamp(raw_ms, 0, chunk_duration_ms)
    absolute_candidate = raw_ms - time_offset_ms
    if -1500 <= absolute_candidate <= chunk_duration_ms + 1500:
        return _clamp(absolute_candidate, 0, chunk_duration_ms)
    return _clamp(raw_ms, 0, chunk_duration_ms)


def _estimate_duration_ms_from_text(text: str) -> int:
    word_count = len([w for w in text.strip().split() if w])
    return max(1800, word_count * 520)


def _split_text_into_sentences(text: str) -> list[str]:
    return [item.strip() for item in re.findall(r'[^.!?。！？\n]+[.!?。！？]?', text) if item.strip()]


def _normalized_compare_text(text: str) -> str:
    return re.sub(r'\s+', ' ', text).strip().lower()


def _build_fallback_events(text: str, start_ms: int, max_duration_ms: int) -> list[dict[str, Any]]:
    parts = _split_text_into_sentences(text) or ([text.strip()] if text.strip() else [])
    if not parts:
        return []
    total_estimated_ms = sum(_estimate_duration_ms_from_text(part) for part in parts)
    total_duration_ms = max(800 * len(parts), min(max_duration_ms, total_estimated_ms))
    cursor_ms = start_ms
    events: list[dict[str, Any]] = []
    remaining_duration_ms = total_duration_ms
    remaining_weight = sum(max(1, len(part.replace(' ', ''))) for part in parts)
    for index, part in enumerate(parts):
        remaining = len(parts) - index
        if remaining <= 1:
            duration_ms = max(800, remaining_duration_ms)
        else:
            weight = max(1, len(part.replace(' ', '')))
            duration_ms = max(800, round(remaining_duration_ms * weight / max(1, remaining_weight)))
            duration_ms = min(duration_ms, max(800, remaining_duration_ms - (remaining - 1) * 800))
        events.append({'tStartMs': cursor_ms, 'dDurationMs': duration_ms, 'segs': [{'utf8': part, 'tOffsetMs': 0}]})
        cursor_ms += duration_ms
        remaining_duration_ms = max(0, remaining_duration_ms - duration_ms)
        remaining_weight -= max(1, len(part.replace(' ', '')))
    return events


# ---------------------------------------------------------------------------
# 后处理：CJK 过滤 + 超长事件拆段
# ---------------------------------------------------------------------------

# CJK 统一表意文字范围（基本平面）
_CJK_RANGES = ((0x4E00, 0x9FFF), (0x3400, 0x4DBF), (0xF900, 0xFAFF))


def _is_cjk_char(ch: str) -> bool:
    if not ch:
        return False
    cp = ord(ch[0])
    return any(lo <= cp <= hi for lo, hi in _CJK_RANGES)


def _strip_cjk_segs(segs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """丢掉纯 CJK 的 seg（典型：笑声被识别成"哈"）。保留混合的（一般是英文为主）。"""
    out: list[dict[str, Any]] = []
    for seg in segs:
        token = str(seg.get('utf8') or '')
        if not token.strip():
            continue
        # 全 CJK 字符 → 丢
        if all(_is_cjk_char(c) or not c.isalnum() for c in token):
            continue
        out.append(seg)
    return out


def _split_long_event(event: dict[str, Any], max_duration_ms: int = 5000, gap_threshold_ms: int = 1200) -> list[dict[str, Any]]:
    """拆超长事件。

    拆点选 (a) 句末标点 (./!/?) 或 (b) 段间时间空隙 >= gap_threshold_ms。
    每个 sub-event 的 tStartMs/dDurationMs 用 segs 的 tOffsetMs 重算。
    """
    segs = event.get('segs') or []
    if len(segs) < 3:
        return [event]
    duration_ms = int(event.get('dDurationMs') or 0)
    base_start_ms = int(event.get('tStartMs') or 0)
    if duration_ms <= max_duration_ms:
        return [event]

    # 计算每个 seg 的"在事件内的偏移"（用 tOffsetMs，没有就平均分）
    offsets: list[int] = []
    for i, seg in enumerate(segs):
        o = seg.get('tOffsetMs')
        if isinstance(o, (int, float)):
            offsets.append(int(o))
        else:
            offsets.append(duration_ms * i // max(1, len(segs)))
    offsets.append(duration_ms)  # 哨兵：事件末尾

    # 找拆点：在 seg i 之后拆
    split_after: list[int] = []  # 拆点 seg 索引（拆点处的 seg 归前半段）
    for i, seg in enumerate(segs):
        text = str(seg.get('utf8') or '').strip()
        gap_to_next = offsets[i + 1] - offsets[i] if i + 1 < len(offsets) else 0
        ends_sentence = bool(text) and bool(re.search(r'[.!?]["\')\]]*\s*$', text)) and len(text) > 1
        big_gap = gap_to_next >= gap_threshold_ms
        if ends_sentence or big_gap:
            split_after.append(i)

    if not split_after:
        return [event]

    # 构造 sub-events
    sub_events: list[dict[str, Any]] = []
    cursor = 0
    for split_idx in split_after:
        if split_idx < cursor:
            continue
        sub_segs = segs[cursor:split_idx + 1]
        if len(sub_segs) < 1:
            continue
        sub_start_offset = offsets[cursor]
        sub_end_offset = offsets[split_idx + 1]
        sub_duration = max(800, sub_end_offset - sub_start_offset)
        sub_events.append({
            'tStartMs': base_start_ms + sub_start_offset,
            'dDurationMs': sub_duration,
            'segs': sub_segs,
        })
        cursor = split_idx + 1
    if cursor < len(segs):
        sub_segs = segs[cursor:]
        if sub_segs:
            sub_start_offset = offsets[cursor]
            sub_end_offset = offsets[-1]
            sub_duration = max(800, sub_end_offset - sub_start_offset)
            sub_events.append({
                'tStartMs': base_start_ms + sub_start_offset,
                'dDurationMs': sub_duration,
                'segs': sub_segs,
            })
    return sub_events if sub_events else [event]


def build_json3_from_asr_result(result: dict[str, Any], time_offset_ms: int = 0, chunk_duration_ms: int | None = None) -> dict[str, Any]:
    events: list[dict[str, Any]] = []
    untimed_cursor_ms = 0
    # 2026-08-15 调试: 说话人识别 trace — 看 utterance.speaker 字段实际值,
    # 为下一步"speaker 变化时强制切段"提供决策依据.
    speaker_field_present = 0
    speaker_values: list = []
    for utterance in result.get('utterances') or []:
        if not isinstance(utterance, dict):
            continue
        text = str(utterance.get('text') or '').strip()
        raw_start = _get_start_ms(utterance)
        start_in_chunk = _normalize_chunk_timestamp(raw_start, time_offset_ms, chunk_duration_ms)
        if start_in_chunk is None:
            start_in_chunk = untimed_cursor_ms
        raw_end = _get_end_ms(utterance)
        if raw_end is None:
            end_in_chunk = start_in_chunk + _estimate_duration_ms_from_text(text)
        else:
            end_in_chunk = _normalize_chunk_timestamp(raw_end, time_offset_ms, chunk_duration_ms)
        if end_in_chunk is None:
            end_in_chunk = max(start_in_chunk + 800, start_in_chunk + _estimate_duration_ms_from_text(text))
        if chunk_duration_ms is not None:
            end_in_chunk = _clamp(max(start_in_chunk + 800, end_in_chunk), min(start_in_chunk + 800, chunk_duration_ms), chunk_duration_ms)
        untimed_cursor_ms = max(untimed_cursor_ms, end_in_chunk + 120)
        start_ms = time_offset_ms + start_in_chunk
        end_ms = time_offset_ms + end_in_chunk
        duration_ms = max(800, end_ms - start_ms)
        segs: list[dict[str, Any]] = []
        words = utterance.get('words') if isinstance(utterance.get('words'), list) else []
        for word in words:
            if not isinstance(word, dict):
                continue
            token = str(word.get('text') or word.get('word') or '').strip()
            if not token:
                continue
            token_start = _normalize_chunk_timestamp(_get_start_ms(word), time_offset_ms, chunk_duration_ms)
            seg: dict[str, Any] = {'utf8': token}
            if token_start is not None:
                seg['tOffsetMs'] = _clamp(token_start - start_in_chunk, 0, duration_ms)
            segs.append(seg)
        if words and segs and not any('tOffsetMs' in seg for seg in segs):
            step_ms = max(1, duration_ms // max(1, len(segs)))
            for index, seg in enumerate(segs):
                seg['tOffsetMs'] = min(duration_ms, index * step_ms)
        trailing = re.search(r'[.!?。！？]["\']*$', text)
        if trailing and segs and not re.search(r'[.!?。！？]["\']*$', str(segs[-1].get('utf8') or '')):
            segs[-1]['utf8'] = f"{segs[-1]['utf8']}{trailing.group(0)}"
        if not segs and text:
            segs = [{'utf8': text}]
        # 后处理：丢 CJK seg（典型：笑声 "哈"），整个事件空了直接跳过
        if segs:
            segs = _strip_cjk_segs(segs)
        if segs:
            # 2026-08-15 说话人识别: 把 ASR 返回的 speaker 字段保留到 event 上
            # (debug 元数据, 不影响下游 consumer). 后续要按 speaker 切段时,
            # 看这个字段值变化即可.
            speaker = utterance.get('speaker')
            event: dict[str, Any] = {'tStartMs': start_ms, 'dDurationMs': duration_ms, 'segs': segs}
            if speaker is not None:
                event['speaker'] = speaker
                speaker_field_present += 1
                speaker_values.append(speaker)
            events.append(event)
    # 2026-08-15 调试: 打印 ASR 返回的 speaker 字段统计 + 切分前 event 数量
    # 用于验证 with_speaker_info=True 是否真的生效, 以及决定下一步是否
    # 在 speaker 变化时强制切段 (解决"多人在一个 utterance"问题).
    print(f"  [ASR→json3] utterance loop done: events={len(events)} "
          f"speakerFieldCount={speaker_field_present}/{len(result.get('utterances') or [])} "
          f"uniqueSpeakers={sorted(set(speaker_values), key=str)}")
    # 后处理：超长事件拆段（拆点：句末标点 或 段间空隙 >= 1200ms）
    split_events: list[dict[str, Any]] = []
    for ev in events:
        split_events.extend(_split_long_event(ev, max_duration_ms=5000, gap_threshold_ms=1200))
    events = split_events
    full_text = str(result.get('text') or '').strip()
    utterance_text = ' '.join(str(item.get('text') or '').strip() for item in result.get('utterances') or [] if isinstance(item, dict)).strip()
    if full_text and utterance_text:
        normalized_full = _normalized_compare_text(full_text)
        normalized_utterance = _normalized_compare_text(utterance_text)
        if normalized_utterance and not normalized_full.startswith(normalized_utterance) and normalized_utterance in normalized_full:
            prefix_end = normalized_full.find(normalized_utterance)
            missing_prefix = full_text[:prefix_end].strip()
            if missing_prefix:
                first_event_start = min((int(event.get('tStartMs') or time_offset_ms) for event in events), default=time_offset_ms + min(chunk_duration_ms or 3_000, 3_000))
                available_ms = max(800, first_event_start - time_offset_ms)
                events = _build_fallback_events(missing_prefix, time_offset_ms, available_ms) + events
    if not events:
        if full_text:
            events.extend(_build_fallback_events(full_text, time_offset_ms, chunk_duration_ms or _estimate_duration_ms_from_text(full_text)))
    return {'wireMagic': 'pb3', 'events': events}


def merge_json3_files(items: list[dict[str, Any]]) -> dict[str, Any]:
    events: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in items:
        for event in item.get('events') or []:
            key = json.dumps(event, ensure_ascii=False, sort_keys=True)
            if key in seen:
                continue
            seen.add(key)
            events.append(event)
    events.sort(key=lambda event: int(event.get('tStartMs') or 0))
    return {'wireMagic': 'pb3', 'events': events}


def raw_output_path_for_json3(output_path: Path) -> Path:
    return output_path.with_name(f'{output_path.stem}.asr-raw.json')


def generate_asr_json3_from_raw_file(raw_path: Path, output_path: Path) -> dict[str, Any]:
    payload = json.loads(raw_path.read_text('utf-8'))
    chunks = payload.get('chunks') if isinstance(payload, dict) else []
    if not isinstance(chunks, list):
        raise RuntimeError(f'ASR raw 文件格式不正确: {raw_path.name}')
    json3_chunks: list[dict[str, Any]] = []
    for chunk in chunks:
        if not isinstance(chunk, dict):
            continue
        start_ms = int(chunk.get('startMs') or 0)
        end_ms = int(chunk.get('endMs') or start_ms)
        raw = chunk.get('raw') if isinstance(chunk.get('raw'), dict) else {}
        result = raw.get('result') if isinstance(raw.get('result'), dict) else {}
        text = str(result.get('text') or chunk.get('text') or '').strip()
        utterances = result.get('utterances') if isinstance(result.get('utterances'), list) else []
        json3_chunks.append(build_json3_from_asr_result(
            {'text': text, 'utterances': utterances},
            time_offset_ms=start_ms,
            chunk_duration_ms=max(1, end_ms - start_ms),
        ))
    merged = merge_json3_files(json3_chunks)
    if not merged.get('events'):
        raise RuntimeError(f'ASR raw 文件未生成可用字幕: {raw_path.name}')
    output_path.write_text(json.dumps(merged, ensure_ascii=False, indent=2), 'utf-8')
    return merged


def generate_asr_json3_from_wav(wav_path: Path, output_path: Path, cfg: dict[str, str], ffmpeg_dir: str = '', on_progress: Callable[[str], None] | None = None) -> dict[str, Any]:
    """整段 wav 一次性走"新的字幕生成接口"（file ASR submit + query）。

    文件接口吃整段音频，不再做 30s 分片（分片是为流式 WebSocket 设计的）。
    """
    duration_ms = get_wav_duration_ms(wav_path)
    if duration_ms <= 250:
        raise RuntimeError('WAV 文件时长过短或无效')
    if on_progress:
        on_progress(f'上传 + 提交 file ASR（{duration_ms / 1000:.1f}s）…')
    result = transcribe_wav_file_direct(wav_path, cfg)
    text = str(result.get('text') or '').strip()
    utterances = result.get('utterances') if isinstance(result.get('utterances'), list) else []
    if not text and not utterances:
        raise RuntimeError('ASR 未返回可用字幕')
    json3 = build_json3_from_asr_result(
        {'text': text, 'utterances': utterances},
        time_offset_ms=0,
        chunk_duration_ms=duration_ms,
    )
    if not json3.get('events'):
        raise RuntimeError('ASR 未返回可用字幕')
    first_start_ms = int(json3['events'][0].get('tStartMs') or 0)
    if first_start_ms > 3_000 and on_progress:
        on_progress(f'警告：ASR 第一条字幕从 {first_start_ms / 1000:.1f}s 开始，前面可能未识别到有效语音')
    output_path.write_text(json.dumps(json3, ensure_ascii=False, indent=2), 'utf-8')
    # raw 也保留一份，方便后续 debug / 切换 ASR provider
    # 2026-08-15: 把完整 utterances 数组也保存到 raw 文件. 之前只存了 text + metadata,
    # debug 时看不到 ASR 实际返回的 utterance 结构 (比如 speaker 字段在 utterance 上
    # 还是 word 上、说话人是否真的不同). 现在存完整数组, 切换 ASR provider / 改
    # 后处理时不用再调一次 ASR 也能看真实数据.
    raw_output_path_for_json3(output_path).write_text(
        json.dumps({
            'provider': 'volc_vc_submit_query',
            'task_id': (result.get('raw') or {}).get('task_id'),
            'text': text,
            'utteranceCount': len(utterances),
            'utterances': utterances,  # 2026-08-15 新增: 保存完整 utterances
            'raw': result.get('raw'),
        }, ensure_ascii=False, indent=2),
        'utf-8',
    )
    return json3


def generate_asr_subtitle_for_record(
    target_dir: Path,
    stem: str,
    video_path: Path | None,
    info_path: Path | None,
    output_path: Path,
    cfg: dict[str, str],
    ffmpeg_dir: str = '',
    force_regenerate: bool = False,
    on_progress: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    if output_path.exists() and not force_regenerate:
        if on_progress:
            on_progress(f'跳过（已存在）: {output_path.name}')
        return json.loads(output_path.read_text('utf-8'))
    raw_path = raw_output_path_for_json3(output_path)
    if raw_path.exists() and raw_path.stat().st_size > 0:
        if on_progress:
            on_progress(f'复用 ASR raw 结果重建字幕: {raw_path.name}')
        return generate_asr_json3_from_raw_file(raw_path, output_path)
    safe_stem = _safe_stem(stem)
    source_audio_path = video_path
    wav_path = target_dir / f'{safe_stem}.asr.wav'
    if (not wav_path.exists() or wav_path.stat().st_size <= 44) and video_path:
        inline_wav_path = video_path.with_name(f'{video_path.name}.asr.wav')
        if inline_wav_path.exists() and inline_wav_path.stat().st_size > 44:
            wav_path = inline_wav_path
    if wav_path.exists() and wav_path.stat().st_size > 44:
        if on_progress:
            on_progress(f'复用已存在的 ASR WAV 音频: {wav_path.name}')
    elif video_path and video_path.exists():
        if on_progress:
            on_progress('使用本地视频抽取 ASR 音频…')
    else:
        raise RuntimeError('没有可用于 ASR 的来源：缺少本地视频文件')
    if not wav_path.exists() or wav_path.stat().st_size <= 44:
        if on_progress:
            on_progress('转换为 16kHz 单声道 PCM WAV…')
        convert_media_to_asr_wav(source_audio_path, wav_path, ffmpeg_dir, on_progress)
    if on_progress:
        on_progress('开始上传火山 ASR 并生成 json3…')
    return generate_asr_json3_from_wav(wav_path, output_path, cfg, ffmpeg_dir, on_progress)

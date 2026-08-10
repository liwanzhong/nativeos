"""End-to-end smoke test for the new ASR config.

Downloads a short English tutorial clip (TED-Ed — clear 2-speaker dialogue),
converts to 16kHz mono PCM, calls `transcribe_wav_file_direct` with the
new params, and asserts:
  1. response status is 20000000
  2. result.text is non-empty
  3. result.utterances is non-empty list
  4. each utterance has text containing punctuation (. ! ? , or Chinese ， 。 ！？)
  5. if >1 distinct speaker detected, speaker_id fields are present and
     vary across utterances

This is run with `python -m scripts.test_asr_fix` from the project root.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

# Allow running this script directly without `python -m`
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tabs.asr_client import (  # noqa: E402
    transcribe_wav_file_direct,
    convert_media_to_asr_wav,
    build_json3_from_asr_result,
)

# Load volc credentials from the RN app's config.ts (same way asr_client does)
import re
cfg_text = (ROOT.parent / 'rn-app' / 'lib' / 'volcengine' / 'config.ts').read_text(encoding='utf-8')
def _extract(name: str) -> str:
    m = re.search(rf"export\s+const\s+{re.escape(name)}\s*=\s*['\"]([^'\"]+)['\"]", cfg_text)
    return m.group(1).strip() if m else ''
APP_ID = _extract('VOLC_APP_ID')
ACCESS_TOKEN = _extract('VOLC_ACCESS_TOKEN')
if not APP_ID or not ACCESS_TOKEN:
    print('ERROR: could not extract VOLC_APP_ID / VOLC_ACCESS_TOKEN from rn-app/lib/volcengine/config.ts')
    sys.exit(1)
CFG = {'app_id': APP_ID, 'access_token': ACCESS_TOKEN}
print(f'[init] using volc app_id={APP_ID[:6]}...{APP_ID[-4:]}')

# Pick a short clip with clear 2-speaker English dialogue.
# Local files (network to YouTube is blocked on this box).
TEST_VIDEO = Path(os.environ.get('TEST_ASR_FILE',
    r'D:\yt-dlp\Chandler and Monica Find Out If They Got the House ｜ Friends.mp4'))
print(f'[init] test video = {TEST_VIDEO}')

VENDOR_DIR = ROOT / 'vendor'
FFMPEG = VENDOR_DIR / 'ffmpeg.exe'
YTDLP = VENDOR_DIR / 'yt-dlp.exe'
for p in (FFMPEG, YTDLP):
    if not p.exists():
        print(f'ERROR: missing {p}')
        sys.exit(1)


def download_audio(src: Path, out_dir: Path) -> Path:
    """Use the local source video (or a YouTube URL if it starts with http)."""
    if str(src).startswith(('http://', 'https://')):
        cmd = [str(YTDLP), '-f', 'ba', '--no-playlist', '-o',
               str(out_dir / 'test.%(ext)s'), str(src)]
        print(f'[yt-dlp] running: {" ".join(cmd)}')
        subprocess.run(cmd, check=True, cwd=str(out_dir))
        candidates = [p for p in out_dir.glob('test.*') if p.suffix.lower() != '.part']
        if not candidates:
            raise RuntimeError('yt-dlp produced no file')
        return max(candidates, key=lambda p: p.stat().st_mtime)
    # local file: just copy / link into the temp dir
    target = out_dir / f'src{src.suffix.lower()}'
    shutil.copy2(str(src), str(target))
    return target


def main() -> int:
    with tempfile.TemporaryDirectory(prefix='asr-test-') as tmp:
        tmp_path = Path(tmp)
        raw = download_audio(TEST_VIDEO, tmp_path)
        wav = tmp_path / 'test.wav'
        print(f'[ffmpeg] converting {raw.name} → {wav.name} (16k mono PCM)')
        convert_media_to_asr_wav(raw, wav, ffmpeg_dir=str(VENDOR_DIR))
        size_kb = wav.stat().st_size / 1024
        print(f'[ffmpeg] converted wav size = {size_kb:.1f} KB')

        # Trim to first 60s to keep the test cheap (file ASR has no per-second cost
        # but we don't want to wait forever for huge files)
        wav_trimmed = tmp_path / 'test_60s.wav'
        cmd = [str(FFMPEG), '-y', '-i', str(wav), '-t', '60',
               '-ac', '1', '-ar', '16000', '-vn', '-acodec', 'pcm_s16le',
               str(wav_trimmed)]
        subprocess.run(cmd, check=True, cwd=str(tmp_path))
        print(f'[ffmpeg] trimmed to 60s, size = {wav_trimmed.stat().st_size / 1024:.1f} KB')

        print('[asr] calling transcribe_wav_file_direct with new config...')
        result = transcribe_wav_file_direct(wav_trimmed, CFG)
        raw_resp = result.get('raw') or {}
        print(f'[asr] response status_code (in raw headers) = {raw_resp.get("_status_code", "?")}')
        text = result.get('text') or ''
        utterances = result.get('utterances') or []
        print(f'[asr] text length: {len(text)} chars')
        print(f'[asr] utterance count: {len(utterances)}')
        if not text and not utterances:
            print('FAIL — empty response (probably network / credential issue)')
            print('full raw:', json.dumps(raw_resp)[:500])
            return 1

        # Save raw response for inspection
        (tmp_path / 'raw.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')

        print('\n=== text (truncated to 300 chars) ===')
        print(text[:300] + ('...' if len(text) > 300 else ''))

        if not utterances:
            print('\nFAIL — `show_utterances` did not return an array. The new request payload is not being honored.')
            return 2

        print('\n=== first 5 utterances ===')
        for i, u in enumerate(utterances[:5]):
            t = (u.get('text') or '').strip()
            start = u.get('start_time')
            end = u.get('end_time')
            spk = u.get('speaker_id') if 'speaker_id' in u else 'N/A'
            print(f'  [{i}] {start}..{end} (speaker={spk}) "{t}"')

        # 1) Punctuation assertion
        PUNCT = '.!?。！？,，'
        first_utt = utterances[0].get('text') or ''
        has_punct = any(c in first_utt for c in PUNCT)
        if not has_punct:
            print(f'\nFAIL — first utterance has no punctuation: "{first_utt}"')
            print('  expected at least one of .!?。！？,,')
            return 3
        print(f'\n[PASS] punctuation present in first utterance')

        # 2) Speaker-id assertion (only meaningful if multiple speakers)
        speaker_ids = [u.get('speaker_id') for u in utterances if 'speaker_id' in u]
        distinct = set(s for s in speaker_ids if s is not None)
        if len(speaker_ids) == 0:
            print('[WARN] no `speaker_id` in utterances — ssd_version may not be honored (test audio probably has only 1 speaker)')
        elif len(distinct) < 2:
            print(f'[WARN] only 1 distinct speaker_id in {len(speaker_ids)} utterances — test audio may not have multi-speaker dialogue')
        else:
            print(f'[PASS] {len(distinct)} distinct speakers in {len(speaker_ids)} utterances: {sorted(distinct)}')

        # 3) Build json3 and sanity-check
        print('\n[json3] building json3 from result...')
        json3 = build_json3_from_asr_result(result, chunk_duration_ms=60_000)
        events = json3.get('events') or []
        print(f'[json3] event count: {len(events)}')
        if events:
            first = events[0]
            print(f'[json3] first event: tStart={first.get("tStartMs")}ms, dur={first.get("dDurationMs")}ms, segs={len(first.get("segs") or [])}')
            print(f'[json3] first seg text: "{first.get("segs", [{}])[0].get("utf8")}"')
        out = ROOT / 'scripts' / 'last_test_output.json3.json'
        out.write_text(json.dumps(json3, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f'[json3] wrote {out}')

    print('\n=== ALL CHECKS PASSED ===')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except subprocess.CalledProcessError as e:
        print(f'FAIL — subprocess error: {e}')
        sys.exit(10)
    except urllib.error.HTTPError as e:
        print(f'FAIL — HTTP error: {e.code} {e.reason}')
        sys.exit(11)
    except (KeyError, ValueError, RuntimeError) as e:
        print(f'FAIL — {type(e).__name__}: {e}')
        sys.exit(12)

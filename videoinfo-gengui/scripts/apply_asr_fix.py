"""One-off script to apply the asr_client.py refactor in place."""
from pathlib import Path

TARGET = Path(r'E:\mycodes\deckmind\NativeOS\videoinfo-gengui\tabs\asr_client.py')

NEW_FUNCTION = '''def transcribe_wav_file_direct(wav_path: Path, cfg: dict[str, str], language: str = 'en-US') -> dict[str, Any]:
    """Transcribe a local WAV file via Volcengine file ASR (submit + poll query).

    NOTE: we use the async submit/query endpoint with resource `volc.bigasr.auc`
    instead of the synchronous Flash endpoint (`volc.bigasr.auc_turbo`).
    The latter returns 403 ("resource not granted") on this account, so we
    go through the same submit -> poll flow that volc-proxy uses.

    NOTE on request params (per Volcengine file ASR doc 6561/1354868):
      - `language: 'en-US'` (or any non-zh-CN value) DISABLES `enable_speaker_info`
        even if you set it. So to get speaker diarization we drop `language` and
        use `enable_auto_lang: true` so the model can pick zh/en/mixed.
      - `enable_punc` defaults to false in file ASR (unlike streaming), so
        we must set it explicitly.
      - `enable_ddc` ("语义顺滑") is the difference between English coming
        back as "wellcome to our store how can i help you" vs with commas.
      - `show_utterances` + `vad_segment` + `end_window_size` give us the
        per-sentence {text, start_time, end_time, words, speaker_id} array
        that the json3 builder needs.
    """
    app_id = str(cfg.get("app_id") or "").strip()
    access_token = str(cfg.get("access_token") or "").strip()
    if not app_id or not access_token:
        raise ValueError("ASR 未配置，请填写火山 App ID 和 Access Token。")
    req_id = str(uuid.uuid4())
    audio_b64 = base64.b64encode(wav_path.read_bytes()).decode("ascii")

    request_cfg: dict[str, Any] = {
        "model_name": "bigmodel",
        # "language": language,  # dropped: incompatible with enable_speaker_info
        "enable_punc": True,
        "enable_ddc": True,
        "show_utterances": True,
        "vad_segment": True,
        "end_window_size": 800,
        "enable_speaker_info": True,
        "ssd_version": "200",
        "enable_auto_lang": True,
    }
    submit_payload = {
        "user": {"uid": app_id or "nativeos-gui"},
        "audio": {
            "format": "wav",
            "rate": ASR_SAMPLE_RATE,
            "bits": ASR_SAMPLE_WIDTH_BYTES * 8,
            "channel": ASR_CHANNELS,
            "base64_data": audio_b64,
        },
        "request": request_cfg,
    }
    submit_body = json.dumps(submit_payload).encode("utf-8")
    submit_headers = {
        "Content-Type": "application/json",
        "X-Api-App-Key": app_id,
        "X-Api-Access-Key": access_token,
        "X-Api-Resource-Id": VOLC_ASR_RESOURCE,
        "X-Api-Request-Id": req_id,
        "X-Api-Sequence": "-1",
    }
    query_headers = {
        "Content-Type": "application/json",
        "X-Api-App-Key": app_id,
        "X-Api-Access-Key": access_token,
        "X-Api-Resource-Id": VOLC_ASR_RESOURCE,
        "X-Api-Request-Id": req_id,
    }

    # Step 1: submit task
    submit_req = urllib.request.Request(
        VOLC_ASR_SUBMIT_URL, data=submit_body, headers=submit_headers, method="POST",
    )
    try:
        with urllib.request.urlopen(submit_req, timeout=REQUEST_TIMEOUT_SECONDS) as resp:
            submit_status = resp.headers.get("x-api-status-code") or resp.headers.get("X-Api-Status-Code")
            submit_body_text = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        raise RuntimeError(
            f"ASR submit HTTP {exc.code}: {exc.read().decode('utf-8', errors='replace')[:300]}"
        ) from exc

    # 20000000 = accepted; 20000001 = processing; 20000002 = queued
    if submit_status not in ("20000000", "20000001", "20000002"):
        if submit_status == "20000003":
            return {"text": "", "utterances": [], "raw": {"submit_status": submit_status}}
        raise RuntimeError(
            f"ASR submit failed: status={submit_status} body={submit_body_text[:300]}"
        )

    # Step 2: poll for result
    last_status = submit_status
    last_body = submit_body_text
    for attempt in range(1, QUERY_MAX_ATTEMPTS + 1):
        time.sleep(QUERY_POLL_INTERVAL_SECONDS)
        query_req = urllib.request.Request(
            VOLC_ASR_QUERY_URL, data=b"{}", headers=query_headers, method="POST",
        )
        try:
            with urllib.request.urlopen(query_req, timeout=REQUEST_TIMEOUT_SECONDS) as resp:
                last_status = resp.headers.get("x-api-status-code") or resp.headers.get("X-Api-Status-Code")
                last_body = resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            raise RuntimeError(
                f"ASR query HTTP {exc.code}: {exc.read().decode('utf-8', errors='replace')[:300]}"
            ) from exc

        if last_status == "20000000":
            break
        if last_status in ("20000001", "20000002"):
            continue
        if last_status == "20000003":
            return {"text": "", "utterances": [], "raw": {"submit_status": submit_status, "final_status": last_status}}
        raise RuntimeError(
            f"ASR query failed at attempt {attempt}: status={last_status} body={last_body[:300]}"
        )
    else:
        raise RuntimeError(
            f"ASR query timed out after {QUERY_MAX_ATTEMPTS} attempts: last_status={last_status}"
        )

    # Step 3: parse result
    parsed = json.loads(last_body) if last_body else {}
    result = parsed.get("result") if isinstance(parsed, dict) else {}
    text = str(result.get("text") or "").strip() if isinstance(result, dict) else ""
    utterances = result.get("utterances") if isinstance(result, dict) and isinstance(result.get("utterances"), list) else []
    return {
        "text": text,
        "utterances": utterances,
        "raw": {**parsed, "_submit_status": submit_status, "_final_status": last_status},
    }


'''


def main() -> int:
    text = TARGET.read_text(encoding="utf-8")
    start_marker = "def transcribe_wav_file_direct"
    end_marker = "def _to_finite_number"
    start = text.index(start_marker)
    end = text.index(end_marker)
    new_text = NEW_FUNCTION + text[end:]
    TARGET.write_text(new_text, encoding="utf-8")
    print(f"replaced {end - start} chars; new file size {len(new_text)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

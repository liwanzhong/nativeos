"""Patch transcribe_wav_file_direct to add explicit Content-Length to query requests
and verbose debug logging on 45000001 to help diagnose.
"""
from pathlib import Path

TARGET = Path(r'E:\mycodes\deckmind\NativeOS\videoinfo-gengui\tabs\asr_client.py')

OLD = '''    # ─── Step 2: poll for result ─────────────────────────────────────────────
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
        )'''

NEW = '''    # ─── Step 2: poll for result ─────────────────────────────────────────────
    last_status = submit_status
    last_body = submit_body_text
    for attempt in range(1, QUERY_MAX_ATTEMPTS + 1):
        time.sleep(QUERY_POLL_INTERVAL_SECONDS)
        # Volcengine query: doc says body is empty json "{}".  Some server versions
        # reject (45000001) if Content-Length is missing on the empty body, so we
        # set it explicitly. We also surface the request id we're polling so 45000001
        # errors are easy to diagnose.
        query_body = b"{}"
        query_headers_with_len = dict(query_headers)
        query_headers_with_len["Content-Length"] = str(len(query_body))
        query_req = urllib.request.Request(
            VOLC_ASR_QUERY_URL, data=query_body, headers=query_headers_with_len, method="POST",
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
        if last_status == "45000001":
            # Possible cause: req_id never existed (e.g. submit failed server-side
            # but returned 20000000), or a stale req_id from a prior run.
            print(f"[asr] poll #{attempt} got 45000001 for req_id={req_id} — body={last_body[:200]}")
            # give it a few more retries in case the model needs to process longer
            if attempt >= 5:
                raise RuntimeError(
                    f"ASR query 45000001 persists after {attempt} attempts: body={last_body[:300]}"
                )
            continue
        if last_status in ("20000001", "20000002"):
            continue
        if last_status == "20000003":
            return {"text": "", "utterances": [], "raw": {"submit_status": submit_status, "final_status": last_status}}
        raise RuntimeError(
            f"ASR query failed at attempt {attempt}: status={last_status} body={last_body[:300]}"
        )'''


def main() -> int:
    text = TARGET.read_text(encoding="utf-8")
    if OLD not in text:
        print("OLD block not found — aborting")
        return 1
    TARGET.write_text(text.replace(OLD, NEW, 1), encoding="utf-8")
    print("patched query loop with Content-Length + 45000001 handling")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

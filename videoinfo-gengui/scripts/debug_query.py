"""Debug patch: log submit + query request/response details to a file."""
from pathlib import Path

TARGET = Path(r'E:\mycodes\deckmind\NativeOS\videoinfo-gengui\tabs\asr_client.py')
LOG = Path(r'E:\mycodes\deckmind\NativeOS\videoinfo-gengui\scripts\asr-debug.log')

# Open log file in append mode
old_submit_marker = '    # ─── Step 1: submit task ─────────────────────────────────────────────────'
new_submit_marker = '''    # ─── Step 1: submit task ─────────────────────────────────────────────────
    # DEBUG: log request details
    with open(r''' + repr(str(LOG)) + ''', "a", encoding="utf-8") as _log:
        _log.write(f"[submit] url={VOLC_ASR_SUBMIT_URL}\\n")
        _log.write(f"[submit] headers={submit_headers}\\n")
        _log.write(f"[submit] audio_b64 len={len(audio_b64)}\\n")
        _log.write(f"[submit] req_id={req_id}\\n")
        _log.write(f"[submit] request_cfg={request_cfg}\\n")
'''

# Wrap submit response
old_submit_resp = '            submit_body_text = resp.read().decode("utf-8", errors="replace")\n    except urllib.error.HTTPError as exc:'
new_submit_resp = '''            submit_body_text = resp.read().decode("utf-8", errors="replace")
            with open(r''' + repr(str(LOG)) + ''', "a", encoding="utf-8") as _log:
                _log.write(f"[submit resp] status={submit_status} body={submit_body_text[:300]}\\n\\n")
        except urllib.error.HTTPError as exc:'''

# Wrap query response
old_query_resp = '                last_body = resp.read().decode("utf-8", errors="replace")\n        except urllib.error.HTTPError as exc:\n            raise RuntimeError(\n                f"ASR query HTTP {exc.code}: {exc.read().decode(\'utf-8\', errors=\'replace\')[:300]}"\n            ) from exc'
new_query_resp = '''                last_body = resp.read().decode("utf-8", errors="replace")
                with open(r''' + repr(str(LOG)) + ''', "a", encoding="utf-8") as _log:
                    _log.write(f"[query #{attempt} resp] status={last_status} body={last_body[:300]}\\n")
            except urllib.error.HTTPError as exc:
                with open(r''' + repr(str(LOG)) + ''', "a", encoding="utf-8") as _log:
                    _log.write(f"[query #{attempt} HTTP] code={exc.code} body={exc.read().decode(chr(39)+chr(117)+chr(116)+chr(102)+chr(45)+chr(56)+chr(39), errors='replace')[:300]}\\n")
                raise RuntimeError(
                    f"ASR query HTTP {exc.code}: {exc.read().decode('utf-8', errors='replace')[:300]}"
                ) from exc'''


def main() -> int:
    text = TARGET.read_text(encoding="utf-8")
    # clear log
    LOG.write_text("", encoding="utf-8")
    for old, new in [
        (old_submit_marker, new_submit_marker),
        (old_submit_resp, new_submit_resp),
        (old_query_resp, new_query_resp),
    ]:
        if old not in text:
            print(f"marker not found: {old[:60]!r}")
            return 1
        text = text.replace(old, new, 1)
    TARGET.write_text(text, encoding="utf-8")
    print("patched with debug logging")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

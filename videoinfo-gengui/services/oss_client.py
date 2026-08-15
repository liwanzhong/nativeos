"""
OSS client wrapper. Pulled out of upload_tab so it can be reused by the
new series-upload flow without dragging the rest of that 2000-line file
along. Keeps the same config keys (endpoint, bucket, ak, sk, prefix) and
the same auth-from-config pattern as the legacy code.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from tabs.runtime_support import load_json_config


@dataclass
class OSSConfig:
    endpoint: str
    bucket: str
    access_key_id: str
    access_key_secret: str
    prefix: str = 'videos/'

    @classmethod
    def from_runtime_config(cls) -> 'OSSConfig':
        cfg = load_json_config().get('oss', {}) or {}
        return cls(
            endpoint=str(cfg.get('endpoint') or '').strip(),
            bucket=str(cfg.get('bucket') or '').strip(),
            access_key_id=str(cfg.get('access_key_id') or '').strip(),
            access_key_secret=str(cfg.get('access_key_secret') or '').strip(),
            prefix=str(cfg.get('prefix') or 'videos/').strip() or 'videos/',
        )

    @property
    def is_configured(self) -> bool:
        return bool(self.endpoint and self.bucket
                    and self.access_key_id and self.access_key_secret)


def build_bucket(cfg: OSSConfig):
    """Lazy import so this module can be imported without oss2 installed
    (e.g. for unit tests on a workstation that only has the admin client)."""
    try:
        import oss2
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError('未安装 oss2，请执行 pip install oss2') from exc
    auth = oss2.Auth(cfg.access_key_id, cfg.access_key_secret)
    return oss2.Bucket(auth, cfg.endpoint, cfg.bucket)


def upload_files(
    bucket,
    files: Iterable[tuple[Path, str]],
    *,
    on_progress: callable = None,
) -> list[tuple[Path, str, bool, str]]:
    """
    Upload each (local_path, oss_key) pair. Returns a result list
    [(path, key, ok, error_or_etag)]. `on_progress(done, total, current_file)`
    fires after each file.

    Skips files that don't exist on disk (returned as ok=False with
    a clear error). Does NOT raise — caller decides what to do with
    partial failures.
    """
    files = list(files)
    results: list[tuple[Path, str, bool, str]] = []
    for index, (local_path, key) in enumerate(files, start=1):
        if not local_path.exists():
            results.append((local_path, key, False, '本地文件不存在'))
            if on_progress:
                on_progress(index, len(files), local_path)
            continue
        try:
            result = bucket.put_object_from_file(key, str(local_path))
            etag = getattr(result, 'etag', '') or ''
            results.append((local_path, key, True, etag))
        except Exception as exc:
            results.append((local_path, key, False, str(exc) or exc.__class__.__name__))
        if on_progress:
            on_progress(index, len(files), local_path)
    return results

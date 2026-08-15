"""
Per-series manifest.json generation. Wraps the existing
`tabs/build_oss_manifest_from_yt_dir.build_manifest` so the new
series-upload flow can reuse the format the rn-app already parses.

The output schema is whatever build_manifest returns — currently a
dict with an `episodes` array, each item carrying the local-filename
references the rn-app fetches via the manifest's parent URL.

This module is intentionally thin; the heavy lifting (AI classification,
subtitle parsing, level inference) lives in the original script.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from tabs.build_oss_manifest_from_yt_dir import build_manifest


def build_series_manifest(target_dir: Path) -> dict[str, Any]:
    """Build the manifest dict from a directory of yt-dlp downloads.

    The directory should contain the per-episode files (mp4, info.json,
    json3, ai-practice.json, cover image). The manifest references them
    by basename — the rn-app resolves them by joining with the
    manifest's parent URL.
    """
    return build_manifest(target_dir)

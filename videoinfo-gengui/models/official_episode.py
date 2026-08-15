"""
Dataclass wrapping a row of `official_video_episodes`. Mirrors the schema
in `rn-app/supabase/migrations/20260108_official_video_episodes.sql` —
if you add a column there, mirror it here.

Asset fields (`subtitle_json3_file`, `cover_file`, `ai_practice_file`,
`info_file`, `subtitle_zh_file`, `subtitle_en_segmented_file`) are bare
filenames; the rn-app joins them with the series `manifest_url` base
to build full URLs. The desktop admin treats them as opaque strings
and doesn't URL-encode them (matches the existing manifest format).

`video_file` is special: it is a LOGICAL name only, not an OSS path.
The video itself is NOT pushed to OSS — it lives on the user's baidu
pan and is matched to a `cloud_bindings` row on the rn-app side. The
desktop admin still needs the filename on disk to derive episode
ids + titles during parsing, but it is excluded from the upload list.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any


@dataclass
class OfficialEpisode:
    id: str
    series_id: str
    episode_index: int = 0
    title: str = ''
    level: str = 'A1'
    category: str = ''
    type: str = 'vlog'
    source_label: str = ''
    video_file: str = ''
    subtitle_json3_file: str = ''
    info_file: str = ''
    ai_practice_file: str = ''
    subtitle_zh_file: str = ''
    subtitle_en_segmented_file: str = ''
    cover_file: str = ''
    has_roleplay: bool = True
    duration_seconds: float | None = None
    is_published: bool = True

    # ── serialization ────────────────────────────────────────────

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> 'OfficialEpisode':
        return cls(
            id=str(row.get('id') or ''),
            series_id=str(row.get('series_id') or ''),
            episode_index=int(row.get('episode_index') or 0),
            title=str(row.get('title') or ''),
            level=str(row.get('level') or 'A1'),
            category=str(row.get('category') or ''),
            type=str(row.get('type') or 'vlog'),
            source_label=str(row.get('source_label') or ''),
            video_file=str(row.get('video_file') or ''),
            subtitle_json3_file=str(row.get('subtitle_json3_file') or ''),
            info_file=str(row.get('info_file') or ''),
            ai_practice_file=str(row.get('ai_practice_file') or ''),
            subtitle_zh_file=str(row.get('subtitle_zh_file') or ''),
            subtitle_en_segmented_file=str(row.get('subtitle_en_segmented_file') or ''),
            cover_file=str(row.get('cover_file') or ''),
            has_roleplay=bool(row.get('has_roleplay') if row.get('has_roleplay') is not None else True),
            duration_seconds=(float(row['duration_seconds'])
                              if row.get('duration_seconds') is not None
                              else None),
            is_published=bool(row.get('is_published') if row.get('is_published') is not None else True),
        )

    def to_upsert_dict(self) -> dict[str, Any]:
        """For Supabase upsert. Always include series_id (PK part 2)."""
        return {
            'id': self.id,
            'series_id': self.series_id,
            'episode_index': self.episode_index,
            'title': self.title,
            'level': self.level,
            'category': self.category,
            'type': self.type,
            'source_label': self.source_label,
            'video_file': self.video_file,
            'subtitle_json3_file': self.subtitle_json3_file or None,
            'info_file': self.info_file or None,
            'ai_practice_file': self.ai_practice_file or None,
            'subtitle_zh_file': self.subtitle_zh_file or None,
            'subtitle_en_segmented_file': self.subtitle_en_segmented_file or None,
            'cover_file': self.cover_file or None,
            'has_roleplay': self.has_roleplay,
            'duration_seconds': self.duration_seconds,
            'is_published': self.is_published,
        }

    @classmethod
    def from_manifest_episode(cls, ep: dict[str, Any], series_id: str) -> 'OfficialEpisode':
        """Build from the per-series manifest.json's `episodes[]` shape
        (produced by `tabs/build_oss_manifest_from_yt_dir.build_manifest`).

        The manifest nests asset filenames under `assets.X`; this
        method flattens them to the table columns. Episode index
        and id come from the manifest's `episodeIndex` / `id` keys.
        """
        assets = ep.get('assets') if isinstance(ep, dict) and isinstance(ep.get('assets'), dict) else {}
        return cls(
            id=str(ep.get('id') or '').strip(),
            series_id=series_id,
            episode_index=int(ep.get('episodeIndex') or 0),
            title=str(ep.get('title') or ep.get('episodeTitle') or '').strip(),
            level=str(ep.get('level') or 'A1').strip(),
            category=str(ep.get('category') or '').strip(),
            type=str(ep.get('type') or 'vlog').strip(),
            source_label=str(ep.get('sourceLabel') or '').strip(),
            video_file=str(assets.get('video') or '').strip(),
            subtitle_json3_file=str(assets.get('subtitleJson3') or '').strip(),
            info_file=str(assets.get('info') or '').strip(),
            ai_practice_file=str(assets.get('aiPractice') or '').strip(),
            subtitle_zh_file=str(assets.get('subtitleZh') or '').strip(),
            subtitle_en_segmented_file=str(assets.get('subtitleEnSegmented') or '').strip(),
            cover_file=str(ep.get('coverUrl') or '').strip(),
            has_roleplay=bool(ep.get('hasRoleplay')) if ep.get('hasRoleplay') is not None else True,
            duration_seconds=(
                float(ep['durationSeconds'])
                if isinstance(ep, dict) and isinstance(ep.get('durationSeconds'), (int, float))
                else None
            ),
            is_published=bool(ep.get('is_published')) if ep.get('is_published') is not None else True,
        )

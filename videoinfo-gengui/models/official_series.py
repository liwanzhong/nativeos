"""
Dataclass wrapping a row of `official_video_series`. Mirrors the schema
in `rn-app/supabase/migrations/20260106_official_video_series.sql` — if
you add a column there, mirror it here.

Empty strings are tolerated in `cover_url` and `description` because
Supabase TEXT columns round-trip empty strings cleanly; we normalise
to None-equivalents only when building the dataclass from a row dict.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any


LEVELS: tuple[str, ...] = ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')
TYPES: tuple[str, ...] = ('vlog', 'dialogue', 'lecture', 'film', 'interview')


@dataclass
class OfficialSeries:
    id: str
    title: str
    level: str = 'A1'
    category: str = ''
    type: str = 'vlog'
    description: str = ''
    cover_url: str = ''
    tags: list[str] = field(default_factory=list)
    sort_order: int = 0
    manifest_url: str = ''  # required NOT NULL in SQL; empty means "not built yet"
    resource_base_url: str = ''
    is_published: bool = True

    # ── serialization ────────────────────────────────────────────

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> 'OfficialSeries':
        return cls(
            id=str(row.get('id') or ''),
            title=str(row.get('title') or ''),
            level=str(row.get('level') or 'A1'),
            category=str(row.get('category') or ''),
            type=str(row.get('type') or 'vlog'),
            description=str(row.get('description') or ''),
            cover_url=str(row.get('cover_url') or ''),
            tags=list(row.get('tags') or []),
            sort_order=int(row.get('sort_order') or 0),
            manifest_url=str(row.get('manifest_url') or ''),
            resource_base_url=str(row.get('resource_base_url') or ''),
            is_published=bool(row.get('is_published') if row.get('is_published') is not None else True),
        )

    def to_insert_dict(self) -> dict[str, Any]:
        """For Supabase INSERT — tags array must always be present (NOT NULL DEFAULT '{}')."""
        return {
            'id': self.id,
            'title': self.title,
            'level': self.level,
            'category': self.category,
            'type': self.type,
            'description': self.description,
            'cover_url': self.cover_url,
            'tags': self.tags,
            'sort_order': self.sort_order,
            'manifest_url': self.manifest_url,  # NOT NULL — caller must decide
            'resource_base_url': self.resource_base_url or None,
            'is_published': self.is_published,
        }

    def to_update_dict(self) -> dict[str, Any]:
        """For Supabase UPDATE — don't touch id (PK)."""
        d = self.to_insert_dict()
        d.pop('id', None)
        return d

    # ── id helpers ───────────────────────────────────────────────

    @staticmethod
    def new_id() -> str:
        """
        Default id for a new series. Returns 12 hex chars (48 bits of
        entropy) — collision probability is ~1 / 16T, so even after
        millions of series it's effectively unique, and the value is
        short enough to be URL-friendly.

        Why not full UUID: the player doesn't need 128 bits here; the
        id is the OSS path segment for `videos/<id>/series.json` and
        shows up in deep links + logs. 12 hex chars strikes a balance
        between uniqueness and readability.
        """
        import uuid
        return uuid.uuid4().hex[:12]

    @staticmethod
    def slugify_title(title: str) -> str:
        """
        Auto-derive a stable id from the title. Lowercase, replace any
        non-alphanumeric run with `-`, strip leading/trailing dashes.
        Pure ASCII; non-ASCII (CJK) characters are dropped (Supabase
        accepts unicode in PKs but URLs and manifest paths prefer ASCII).

        Kept for legacy compat — existing series like
        `a1-beginner-english` were generated this way. New series
        should use `new_id()` instead.
        """
        import re
        s = title.strip().lower()
        # Transliterate common CJK to pinyin? No — keep it simple: drop
        # any non-ASCII so CJK titles fall back to a generated id.
        s = s.encode('ascii', 'ignore').decode('ascii')
        s = re.sub(r'[^a-z0-9]+', '-', s)
        s = s.strip('-')
        if not s:
            # Pure-CJK title — fall back to timestamp-based id
            import time
            s = f'series-{int(time.time())}'
        return s[:64]

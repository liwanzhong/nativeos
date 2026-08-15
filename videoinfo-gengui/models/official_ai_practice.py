"""
Dataclass wrapping a row of `official_video_ai_practice`. Mirrors the
schema in `rn-app/supabase/migrations/20260108_official_video_ai_practice.sql`
— if you add a column there, mirror it here.

Construction paths:
  - `from_row(row_dict)`           — from a Supabase response row
  - `from_oss_card(card, series, episode, card_index)` — from a single
                                          entry inside an OSS `.ai-practice.json`
                                          (used by the desktop upload pipeline
                                          and the one-shot importer)
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from typing import Any


@dataclass
class OfficialAiPracticeCard:
    id: str
    series_id: str
    episode_id: str
    card_index: int = 0
    icon: str = '💬'
    category: str = ''
    level: str = 'B1'
    title: str = ''
    description: str = ''
    description_zh: str | None = None
    npc_emoji: str | None = None
    npc_name: str | None = None
    npc_status: str | None = None
    npc_system_prompt: str | None = None
    opening_line: str | None = None
    opening_line_zh: str | None = None
    environmental_cue: str | None = None
    environmental_cue_en: str | None = None
    user_initiates: bool = False
    task_contract: dict[str, Any] | None = None
    is_published: bool = True

    # ── serialization ────────────────────────────────────────────

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> 'OfficialAiPracticeCard':
        return cls(
            id=str(row.get('id') or ''),
            series_id=str(row.get('series_id') or ''),
            episode_id=str(row.get('episode_id') or ''),
            card_index=int(row.get('card_index') or 0),
            icon=str(row.get('icon') or '💬'),
            category=str(row.get('category') or ''),
            level=str(row.get('level') or 'B1'),
            title=str(row.get('title') or ''),
            description=str(row.get('description') or ''),
            description_zh=row.get('description_zh'),
            npc_emoji=row.get('npc_emoji'),
            npc_name=row.get('npc_name'),
            npc_status=row.get('npc_status'),
            npc_system_prompt=row.get('npc_system_prompt'),
            opening_line=row.get('opening_line'),
            opening_line_zh=row.get('opening_line_zh'),
            environmental_cue=row.get('environmental_cue'),
            environmental_cue_en=row.get('environmental_cue_en'),
            user_initiates=bool(row.get('user_initiates') or False),
            task_contract=row.get('task_contract'),
            is_published=bool(row.get('is_published') if row.get('is_published') is not None else True),
        )

    def to_upsert_dict(self) -> dict[str, Any]:
        """For Supabase upsert. Always include `series_id` (PK part 1).
        Optional fields normalize to None so the table's nullable
        columns stay clean instead of getting empty-string sentinels."""
        return {
            'id': self.id,
            'series_id': self.series_id,
            'episode_id': self.episode_id,
            'card_index': int(self.card_index),
            'icon': self.icon or '💬',
            'category': self.category,
            'level': self.level or 'B1',
            'title': self.title,
            'description': self.description,
            'description_zh': self.description_zh or None,
            'npc_emoji': self.npc_emoji or None,
            'npc_name': self.npc_name or None,
            'npc_status': self.npc_status or None,
            'npc_system_prompt': self.npc_system_prompt or None,
            'opening_line': self.opening_line or None,
            'opening_line_zh': self.opening_line_zh or None,
            'environmental_cue': self.environmental_cue or None,
            'environmental_cue_en': self.environmental_cue_en or None,
            'user_initiates': bool(self.user_initiates),
            'task_contract': self.task_contract or None,
            'is_published': bool(self.is_published),
        }

    @classmethod
    def from_oss_card(
        cls,
        card: dict[str, Any],
        *,
        series_id: str,
        episode_id: str,
        card_index: int,
    ) -> 'OfficialAiPracticeCard':
        """Build from a single entry inside an OSS `.ai-practice.json`.

        The OSS file shape (built by `tabs/generate_ai_practice_from_yt_dir.py`):
          { items: [ { id, icon, category, level, title, desc, descZh,
                        npcEmoji, npcName, npcStatus, openingLine,
                        openingLineZh, environmentalCue,
                        environmentalCueEn, npcSystemPrompt,
                        userInitiates, taskContract }, ... ] }
        (camelCase, with `desc` instead of `description`)

        We tolerate the same field aliases the rn-app's `loadAiPracticeCards`
        does (cards / items / array), but for v1 the desktop admin and
        the one-shot importer both produce the `{items: [...]}` shape.
        """
        task_contract_raw = card.get('taskContract')
        task_contract: dict[str, Any] | None = None
        if isinstance(task_contract_raw, dict):
            task_contract = task_contract_raw
        elif isinstance(task_contract_raw, str) and task_contract_raw.strip():
            try:
                parsed = json.loads(task_contract_raw)
                if isinstance(parsed, dict):
                    task_contract = parsed
            except json.JSONDecodeError:
                task_contract = None
        return cls(
            id=str(card.get('id') or '').strip(),
            series_id=series_id,
            episode_id=episode_id,
            card_index=int(card_index),
            icon=str(card.get('icon') or '💬').strip() or '💬',
            category=str(card.get('category') or '').strip(),
            level=str(card.get('level') or 'B1').strip() or 'B1',
            title=str(card.get('title') or '').strip(),
            description=str(card.get('desc') or card.get('description') or '').strip(),
            description_zh=(str(card.get('descZh') or card.get('description_zh') or '').strip() or None),
            npc_emoji=(str(card.get('npcEmoji') or '').strip() or None),
            npc_name=(str(card.get('npcName') or '').strip() or None),
            npc_status=(str(card.get('npcStatus') or '').strip() or None),
            npc_system_prompt=(str(card.get('npcSystemPrompt') or '').strip() or None),
            opening_line=(str(card.get('openingLine') or '').strip() or None),
            opening_line_zh=(str(card.get('openingLineZh') or '').strip() or None),
            environmental_cue=(str(card.get('environmentalCue') or '').strip() or None),
            environmental_cue_en=(str(card.get('environmentalCueEn') or '').strip() or None),
            user_initiates=bool(card.get('userInitiates') or False),
            task_contract=task_contract,
            is_published=True,
        )

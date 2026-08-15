"""
Supabase admin client wrapper.

Uses the service_role key to bypass RLS. **Only** run this code on a machine
you trust (your own admin machine). The service_role key can read/write
every row in every table — leaking it = full DB compromise.

What lives here:
  - SupabaseAdmin: thin wrapper around `supabase.create_client(...)`.
  - health_check: cheapest possible authenticated call — fetches 1 row of
    `official_video_series` and returns count + latency. If this works,
    the URL + key pair is good.
  - CRUD stubs for `official_video_series` (filled out in step 2).

The client is created lazily on first call. If the URL/key pair is invalid
or the network is down, the `create_client` call itself doesn't fail
(Supabase is lazy too) — failures surface on the first real request.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Iterable

from supabase import Client, create_client


@dataclass
class HealthCheckResult:
    ok: bool
    latency_ms: int | None
    error: str | None
    sample_row: dict[str, Any] | None = None


class SupabaseAdmin:
    """Service-role Supabase client. Use sparingly, never log the key."""

    def __init__(self, url: str, service_key: str) -> None:
        if not url or not service_key:
            raise ValueError('Supabase URL 和 service_key 都必须提供')
        self._url = url
        self._key = service_key
        self._client: Client | None = None

    @property
    def client(self) -> Client:
        if self._client is None:
            self._client = create_client(self._url, self._key)
        return self._client

    # ── connection / health ───────────────────────────────────────

    def health_check(self) -> HealthCheckResult:
        """
        Cheapest possible authenticated call: fetch 1 row from
        `official_video_series`. If the URL+key are valid AND the table
        exists AND we can read it, this returns ok=True.
        """
        started = time.perf_counter()
        try:
            resp = (
                self.client.table('official_video_series')
                .select('id, title, is_published')
                .limit(1)
                .execute()
            )
            latency_ms = int((time.perf_counter() - started) * 1000)
            sample = resp.data[0] if resp.data else None
            return HealthCheckResult(
                ok=True,
                latency_ms=latency_ms,
                error=None,
                sample_row=sample,
            )
        except Exception as exc:  # broad: supabase raises a variety of types
            latency_ms = int((time.perf_counter() - started) * 1000)
            return HealthCheckResult(
                ok=False,
                latency_ms=latency_ms,
                error=str(exc) or exc.__class__.__name__,
            )

    # ── official_video_series CRUD ────────────────────────────────

    def list_series(
        self,
        *,
        level: str | None = None,
        is_published: bool | None = None,
        search: str | None = None,
    ) -> list[dict[str, Any]]:
        """
        List series rows, ordered published-first then by sort_order.
        Optional filters: level (exact), is_published (bool), search
        (case-insensitive substring against title or id).
        """
        query = self.client.table('official_video_series').select('*')
        if level:
            query = query.eq('level', level)
        if is_published is not None:
            query = query.eq('is_published', is_published)
        if search:
            term = f'%{search}%'
            # supabase-py: or_ filter syntax. Falls back to title-only on
            # older versions; the `,id.ilike.` form uses ilike on each.
            query = query.or_(f'title.ilike.{term},id.ilike.{term}')
        resp = (
            query
            .order('is_published', desc=True)
            .order('sort_order')
            .order('created_at')
            .execute()
        )
        return list(resp.data or [])

    def get_series(self, series_id: str) -> dict[str, Any] | None:
        resp = (
            self.client.table('official_video_series')
            .select('*')
            .eq('id', series_id)
            .limit(1)
            .execute()
        )
        if not resp.data:
            return None
        return resp.data[0]

    def create_series(self, data: dict[str, Any]) -> dict[str, Any]:
        resp = self.client.table('official_video_series').insert(data).execute()
        if not resp.data:
            raise RuntimeError('Supabase 未返回新建行（可能 RLS 拒绝或字段缺失）')
        return resp.data[0]

    def update_series(self, series_id: str, data: dict[str, Any]) -> dict[str, Any]:
        resp = (
            self.client.table('official_video_series')
            .update(data)
            .eq('id', series_id)
            .execute()
        )
        if not resp.data:
            raise RuntimeError(f'未找到 id={series_id} 的合集，更新失败')
        return resp.data[0]

    def delete_series(self, series_id: str) -> None:
        self.client.table('official_video_series').delete().eq('id', series_id).execute()

    def set_published(self, series_id: str, is_published: bool) -> None:
        self.update_series(series_id, {'is_published': is_published})

    def set_manifest_url(self, series_id: str, manifest_url: str) -> None:
        self.update_series(series_id, {'manifest_url': manifest_url})

    # ── official_video_episodes CRUD ──────────────────────────────

    def list_episodes(self, series_id: str) -> list[dict[str, Any]]:
        """List all episodes for a series, ordered by episode_index."""
        resp = (
            self.client.table('official_video_episodes')
            .select('*')
            .eq('series_id', series_id)
            .order('episode_index')
            .execute()
        )
        return list(resp.data or [])

    def upsert_episodes(
        self,
        series_id: str,
        episodes: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Bulk upsert episodes for one series. Each dict must include
        `id` and `series_id`; other fields are optional (defaults apply
        via the table). Returns the rows the server echoed back."""
        if not episodes:
            return []
        # Make sure series_id is set on every row (caller may forget)
        rows = []
        for ep in episodes:
            row = dict(ep)
            row.setdefault('series_id', series_id)
            rows.append(row)
        # PostgREST has a URL length cap; batch to stay safe
        BATCH = 100
        all_returned: list[dict[str, Any]] = []
        for i in range(0, len(rows), BATCH):
            batch = rows[i:i + BATCH]
            resp = (
                self.client.table('official_video_episodes')
                .upsert(batch, on_conflict='series_id,id')
                .execute()
            )
            all_returned.extend(resp.data or [])
        return all_returned

    def delete_episode(self, series_id: str, episode_id: str) -> None:
        self.client.table('official_video_episodes') \
            .delete() \
            .eq('series_id', series_id) \
            .eq('id', episode_id) \
            .execute()

    # ── official_video_ai_practice CRUD ──────────────────────────

    def list_ai_practice_cards(
        self,
        series_id: str,
        episode_id: str,
    ) -> list[dict[str, Any]]:
        """List all AI practice cards for one episode, ordered by
        `card_index`. Empty list if the episode has no cards.

        The rn-app's `loadAiPracticeCards` calls this when the scene
        is from the Supabase path; for scenes still on the legacy
        OSS path it falls back to fetching the .ai-practice.json.
        """
        resp = (
            self.client.table('official_video_ai_practice')
            .select('*')
            .eq('series_id', series_id)
            .eq('episode_id', episode_id)
            .order('card_index')
            .execute()
        )
        return list(resp.data or [])

    def upsert_ai_practice_cards(
        self,
        series_id: str,
        episode_id: str,
        cards: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Bulk upsert practice cards for one episode. Each dict must
        include `id`, `series_id`, `episode_id`; the rest default.
        Batched in groups of 100 (PostgREST URL cap)."""
        if not cards:
            return []
        rows = []
        for c in cards:
            row = dict(c)
            row.setdefault('series_id', series_id)
            row.setdefault('episode_id', episode_id)
            rows.append(row)
        BATCH = 100
        all_returned: list[dict[str, Any]] = []
        for i in range(0, len(rows), BATCH):
            batch = rows[i:i + BATCH]
            resp = (
                self.client.table('official_video_ai_practice')
                .upsert(batch, on_conflict='series_id,id')
                .execute()
            )
            all_returned.extend(resp.data or [])
        return all_returned

    def delete_ai_practice_cards_for_episode(
        self,
        series_id: str,
        episode_id: str,
    ) -> None:
        """Drop all cards for an episode. Used by the desktop upload
        pipeline before re-upserting (so a removed card in the
        local file is also removed in Supabase), and by the episode
        edit dialog's "delete episode" path (cascades from
        `official_video_episodes`, but kept here for explicit calls
        when we want to clear cards without deleting the episode)."""
        self.client.table('official_video_ai_practice') \
            .delete() \
            .eq('series_id', series_id) \
            .eq('episode_id', episode_id) \
            .execute()

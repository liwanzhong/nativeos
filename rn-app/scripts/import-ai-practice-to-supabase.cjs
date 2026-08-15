#!/usr/bin/env node
/**
 * One-shot import: per-series `.ai-practice.json` (on OSS) → `official_video_ai_practice` table.
 *
 * Usage (one-off, run by hand once):
 *   SUPABASE_URL=... \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   node scripts/import-ai-practice-to-supabase.cjs
 *
 * What it does:
 *   1. List all series from `official_video_series`
 *   2. For each series, GET the manifest_url
 *   3. For each episode with `assets.aiPractice` set, GET the .ai-practice.json
 *   4. Parse the cards (top-level array OR `{items: [...]}` OR `{cards: [...]}`)
 *   5. Map each card to the new table shape
 *   6. UPSERT into `official_video_ai_practice` (PK = (series_id, id))
 *
 * What it does NOT do:
 *   - Does not delete cards that disappeared from the .ai-practice.json
 *     (the desktop admin's re-run is the right place for that; a one-shot
 *     importer shouldn't silently drop data)
 *   - Does not touch the OSS files
 *   - Does not touch any other table
 *
 * Mapping (.ai-practice.json card → table):
 *   id                ← id
 *   episode_id        ← the parent episode id (from the manifest)
 *   card_index        ← position in the cards array
 *   icon              ← icon
 *   category          ← category
 *   level             ← level
 *   title             ← title
 *   description       ← desc
 *   description_zh    ← descZh
 *   npc_emoji         ← npcEmoji
 *   npc_name          ← npcName
 *   npc_status        ← npcStatus
 *   npc_system_prompt ← npcSystemPrompt
 *   opening_line      ← openingLine
 *   opening_line_zh   ← openingLineZh
 *   environmental_cue     ← environmentalCue
 *   environmental_cue_en  ← environmentalCueEn
 *   user_initiates    ← userInitiates
 *   task_contract     ← taskContract (as JSONB)
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing env vars. Run with:');
  console.error('  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/import-ai-practice-to-supabase.cjs');
  process.exit(2);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function stripBucketPrefix(url, bucket) {
  // The desktop upload tab produces URLs like
  //   https://<bucket>.<host>/<key>
  // but the .ai-practice.json lives inside `videos/<series_id>/<basename>`,
  // and the series `manifest_url` points at `series.json` in the same dir.
  // We don't need bucket stripping for OSS — we just resolve the asset
  // path the same way the rn-app does: take everything after the host.
  return url;
}

function resolveAssetUrl(manifestUrl, assetPath) {
  if (!manifestUrl || !assetPath) return null;
  // manifestUrl is like https://bucket.host/videos/<id>/series.json
  // Drop the basename (series.json) and join the asset path.
  const withoutQuery = manifestUrl.split('?')[0] || manifestUrl;
  const trimmed = withoutQuery.endsWith('/') ? withoutQuery.slice(0, -1) : withoutQuery;
  const lastSlash = trimmed.lastIndexOf('/');
  const base = lastSlash >= 0 ? trimmed.slice(0, lastSlash) : trimmed;
  const normalized = String(assetPath).replace(/^\/+/, '');
  const encoded = normalized
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `${base}/${encoded}`;
}

function mapCard(card, seriesId, episodeId, cardIndex) {
  return {
    id: String(card.id || '').trim(),
    series_id: seriesId,
    episode_id: episodeId,
    card_index: cardIndex,
    icon: String(card.icon || '💬'),
    category: String(card.category || ''),
    level: String(card.level || 'B1'),
    title: String(card.title || '').trim(),
    description: String(card.desc || card.description || ''),
    description_zh: card.descZh || card.description_zh || null,
    npc_emoji: card.npcEmoji || null,
    npc_name: card.npcName || null,
    npc_status: card.npcStatus || null,
    npc_system_prompt: card.npcSystemPrompt || null,
    opening_line: card.openingLine || null,
    opening_line_zh: card.openingLineZh || null,
    environmental_cue: card.environmentalCue || null,
    environmental_cue_en: card.environmentalCueEn || null,
    user_initiates: card.userInitiates === true,
    task_contract: card.taskContract && typeof card.taskContract === 'object'
      ? card.taskContract
      : null,
    is_published: true,
  };
}

async function fetchJson(url) {
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) {
    throw new Error(`GET ${url} failed: ${resp.status} ${resp.statusText}`);
  }
  return resp.json();
}

async function main() {
  console.log('[import-ai-practice] fetching series list...');
  const { data: seriesRows, error: seriesError } = await supabase
    .from('official_video_series')
    .select('id, title, manifest_url, is_published')
    .order('id');
  if (seriesError) {
    console.error('[import-ai-practice] failed to list series:', seriesError.message);
    process.exit(1);
  }
  console.log(`[import-ai-practice] found ${seriesRows.length} series`);

  let totalInserted = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  let totalEpisodesWithoutAi = 0;

  for (const series of seriesRows) {
    if (!series.manifest_url) {
      console.warn(`[import-ai-practice] [${series.id}] no manifest_url, skipping`);
      totalSkipped += 1;
      continue;
    }
    let manifest;
    try {
      console.log(`[import-ai-practice] [${series.id}] GET ${series.manifest_url}`);
      manifest = await fetchJson(series.manifest_url);
    } catch (err) {
      console.error(`[import-ai-practice] [${series.id}] fetch failed: ${err.message}`);
      totalFailed += 1;
      continue;
    }
    const episodes = Array.isArray(manifest.episodes) ? manifest.episodes : [];
    if (episodes.length === 0) {
      console.warn(`[import-ai-practice] [${series.id}] manifest has no episodes, skipping`);
      totalSkipped += 1;
      continue;
    }

    let seriesInserted = 0;
    for (const ep of episodes) {
      const epId = String(ep.id || '').trim();
      if (!epId) continue;
      const aiKey = ep.assets && ep.assets.aiPractice;
      if (!aiKey) {
        totalEpisodesWithoutAi += 1;
        continue;
      }
      const aiUrl = resolveAssetUrl(series.manifest_url, aiKey);
      if (!aiUrl) {
        console.warn(`[import-ai-practice] [${series.id}/${epId}] no ai_url, skipping`);
        continue;
      }
      let payload;
      try {
        payload = await fetchJson(aiUrl);
      } catch (err) {
        console.warn(`[import-ai-practice] [${series.id}/${epId}] ai fetch failed: ${err.message}`);
        totalFailed += 1;
        continue;
      }
      const rawCards = Array.isArray(payload)
        ? payload
        : Array.isArray(payload.items) ? payload.items
        : Array.isArray(payload.cards) ? payload.cards
        : [];
      if (rawCards.length === 0) {
        console.warn(`[import-ai-practice] [${series.id}/${epId}] no cards in ${aiKey}`);
        continue;
      }
      const rows = rawCards
        .filter((c) => c && typeof c === 'object')
        .map((c, i) => mapCard(c, series.id, epId, i))
        .filter((r) => r.id);
      if (rows.length === 0) {
        console.warn(`[import-ai-practice] [${series.id}/${epId}] all cards missing id, skipping`);
        continue;
      }
      const BATCH = 100;
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const { error } = await supabase
          .from('official_video_ai_practice')
          .upsert(batch, { onConflict: 'series_id,id', ignoreDuplicates: false });
        if (error) {
          console.error(`[import-ai-practice] [${series.id}/${epId}] upsert failed: ${error.message}`);
          totalFailed += batch.length;
        } else {
          totalInserted += batch.length;
          seriesInserted += batch.length;
        }
      }
    }
    if (seriesInserted > 0) {
      console.log(`[import-ai-practice] [${series.id}] upserted ${seriesInserted} cards`);
    }
  }

  console.log('');
  console.log('[import-ai-practice] done.');
  console.log(`  cards inserted/updated: ${totalInserted}`);
  console.log(`  failed:                 ${totalFailed}`);
  console.log(`  series skipped:          ${totalSkipped}`);
  console.log(`  episodes without ai:     ${totalEpisodesWithoutAi}`);
}

main().catch((err) => {
  console.error('[import-ai-practice] FAILED:', err);
  process.exit(1);
});

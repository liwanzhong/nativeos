#!/usr/bin/env node
/**
 * One-shot import: per-series `manifest.json` (on OSS) → `official_video_episodes` table.
 *
 * Usage (one-off, run by hand once):
 *   SUPABASE_URL=... \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   node scripts/import-oss-manifests-to-supabase.cjs
 *
 * What it does:
 *   1. List all series from `official_video_series`
 *   2. For each series, GET the manifest_url (an OSS JSON file)
 *   3. Parse the `episodes[]` array
 *   4. Map each episode to the new table shape
 *   5. UPSERT into `official_video_episodes` (PK = (series_id, id))
 *
 * What it does NOT do:
 *   - Does not delete episodes that disappeared from the manifest (set
 *     is_published=false in the admin tool, or run a separate "prune"
 *     step). Safer default: never silently drop data on a one-shot import.
 *   - Does not touch the OSS manifest.json files (left in place as a
 *     read-only legacy cache; the rn-app will stop reading them after
 *     the switch to Supabase-driven loading).
 *   - Does not touch any other table.
 *
 * Mapping (manifest → table):
 *   id                  ← id
 *   episode_index       ← episodeIndex
 *   title               ← title (fallback episodeTitle)
 *   level               ← level
 *   category            ← category
 *   type                ← type
 *   source_label        ← sourceLabel
 *   video_file          ← assets.video
 *   subtitle_json3_file ← assets.subtitleJson3
 *   info_file           ← assets.info
 *   ai_practice_file    ← assets.aiPractice
 *   subtitle_zh_file    ← assets.subtitleZh
 *   subtitle_en_segmented_file ← assets.subtitleEnSegmented
 *   cover_file          ← coverUrl
 *   has_roleplay        ← hasRoleplay
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing env vars. Run with:');
  console.error('  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/import-oss-manifests-to-supabase.cjs');
  process.exit(2);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function mapEpisode(ep) {
  const assets = (ep && typeof ep.assets === 'object' && ep.assets) || {};
  return {
    id: String(ep.id || '').trim(),
    series_id: '', // filled in by caller
    episode_index: Number.isFinite(ep.episodeIndex) ? ep.episodeIndex : 0,
    title: String(ep.title || ep.episodeTitle || '').trim(),
    level: String(ep.level || 'A1').trim(),
    category: String(ep.category || '').trim(),
    type: String(ep.type || 'vlog').trim(),
    source_label: String(ep.sourceLabel || '').trim(),
    video_file: String(assets.video || '').trim(),
    subtitle_json3_file: String(assets.subtitleJson3 || '').trim() || null,
    info_file: String(assets.info || '').trim() || null,
    ai_practice_file: String(assets.aiPractice || '').trim() || null,
    subtitle_zh_file: String(assets.subtitleZh || '').trim() || null,
    subtitle_en_segmented_file: String(assets.subtitleEnSegmented || '').trim() || null,
    cover_file: String(ep.coverUrl || '').trim() || null,
    has_roleplay: ep.hasRoleplay !== false,
    duration_seconds: Number.isFinite(ep.durationSeconds) ? ep.durationSeconds : null,
    is_published: ep.is_published !== false,
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
  console.log('[import-episodes] fetching series list...');
  const { data: seriesRows, error: seriesError } = await supabase
    .from('official_video_series')
    .select('id, title, manifest_url, is_published')
    .order('id');
  if (seriesError) {
    console.error('[import-episodes] failed to list series:', seriesError.message);
    process.exit(1);
  }
  console.log(`[import-episodes] found ${seriesRows.length} series`);

  let totalInserted = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  for (const series of seriesRows) {
    if (!series.manifest_url) {
      console.warn(`[import-episodes] [${series.id}] no manifest_url, skipping`);
      totalSkipped += 1;
      continue;
    }
    let manifest;
    try {
      console.log(`[import-episodes] [${series.id}] GET ${series.manifest_url}`);
      manifest = await fetchJson(series.manifest_url);
    } catch (err) {
      console.error(`[import-episodes] [${series.id}] fetch failed: ${err.message}`);
      totalFailed += 1;
      continue;
    }
    const episodes = Array.isArray(manifest.episodes) ? manifest.episodes : [];
    if (episodes.length === 0) {
      console.warn(`[import-episodes] [${series.id}] manifest has no episodes, skipping`);
      totalSkipped += 1;
      continue;
    }
    const rows = episodes.map((ep) => ({ ...mapEpisode(ep), series_id: series.id }));
    // Drop rows missing required fields
    const validRows = rows.filter((r) => r.id && r.title && r.video_file);
    if (validRows.length === 0) {
      console.warn(`[import-episodes] [${series.id}] no valid episodes (missing id/title/video_file)`);
      totalSkipped += 1;
      continue;
    }
    const skippedInBatch = rows.length - validRows.length;
    if (skippedInBatch > 0) {
      console.warn(`[import-episodes] [${series.id}] skipped ${skippedInBatch} episodes missing required fields`);
    }

    // Upsert in batches (PostgREST has a row-count cap)
    const BATCH = 100;
    for (let i = 0; i < validRows.length; i += BATCH) {
      const batch = validRows.slice(i, i + BATCH);
      const { error } = await supabase
        .from('official_video_episodes')
        .upsert(batch, { onConflict: 'series_id,id', ignoreDuplicates: false });
      if (error) {
        console.error(`[import-episodes] [${series.id}] upsert failed: ${error.message}`);
        totalFailed += batch.length;
      } else {
        totalInserted += batch.length;
        console.log(`[import-episodes] [${series.id}] upserted ${batch.length} episodes`);
      }
    }
  }

  console.log('');
  console.log('[import-episodes] done.');
  console.log(`  inserted/updated: ${totalInserted}`);
  console.log(`  failed:            ${totalFailed}`);
  console.log(`  series skipped:    ${totalSkipped}`);
}

main().catch((err) => {
  console.error('[import-episodes] FAILED:', err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * One-shot import: OSS official-video-catalog.json → Supabase official_video_series
 *
 * Usage (one-off, run by hand when content changes):
 *   SUPABASE_URL=... \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   node scripts/import-official-series-from-oss.cjs
 *
 * What it does:
 *   1. GET https://nativeos.oss-cn-beijing.aliyuncs.com/videos/official-video-catalog.json
 *   2. Parse the `series[]` array
 *   3. For each entry, upsert into `official_video_series` (matching on PK `id`)
 *   4. Print a summary (inserted / updated / unchanged / failed)
 *
 * Why a service_role key:
 *   The `official_video_series` table only grants SELECT to anon + authed
 *   (RLS: is_published = true). The actual write needs to bypass RLS, so
 *   the import script uses the service_role key from your Supabase dashboard.
 *   Never ship the service_role key to client code or commit it to git.
 *
 * What it does NOT do:
 *   - Does not touch `user_picked_video_series` (that's user-owned, RLS)
 *   - Does not touch OSS bucket (we only read the catalog JSON; videos stay where they are)
 *   - Does not delete rows that disappeared from OSS (set is_published=false in the
 *     dashboard for soft-deletion; a separate "prune" step is out of scope here).
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OSS_CATALOG_URL = 'https://nativeos.oss-cn-beijing.aliyuncs.com/videos/official-video-catalog.json';

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing env vars. Run with:');
  console.error('  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/import-official-series-from-oss.cjs');
  console.error('Both come from Supabase dashboard → Settings → API.');
  process.exit(2);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/**
 * Map a catalog.series entry → official_video_series row.
 * Mirrors the field names in lib/content/video-scenes.ts::OfficialVideoCatalogSeriesEntry.
 *
 * Resolves the relative `manifestUrl` to a full URL using the catalog's
 * `resourceBaseUrl` (or falls back to the catalog URL's directory).
 */
function resolveManifestUrl(manifestUrl, catalogBaseUrl) {
  const trimmed = (manifestUrl || '').trim();
  if (!trimmed) return null;
  // Already absolute — use as-is.
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (!catalogBaseUrl) return null;
  // Build "<base>/<path>" with each path segment URI-encoded.
  const base = catalogBaseUrl.replace(/\/+$/, '');
  const path = trimmed.replace(/^\/+/, '');
  return `${base}/${path.split('/').map((part) => encodeURIComponent(part)).join('/')}`;
}

function mapSeries(entry, catalogBaseUrl) {
  const manifestUrl = resolveManifestUrl(entry.manifestUrl, catalogBaseUrl);
  if (!manifestUrl) {
    return null; // skip — cannot build a series without its manifest
  }
  if (!entry.id || !entry.title) {
    return null; // skip — id and title are required
  }
  return {
    id: entry.id.trim(),
    title: entry.title.trim(),
    level: (entry.level || 'B1').trim(),
    category: (entry.category || '综合').trim(),
    type: (entry.type || 'vlog').trim(),
    description: entry.description?.trim() || null,
    cover_url: entry.coverUrl?.trim() || null,
    tags: Array.isArray(entry.tags)
      ? entry.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim())
      : [],
    sort_order: Number.isFinite(entry.sortOrder) ? entry.sortOrder : 0,
    manifest_url: manifestUrl,
    resource_base_url: catalogBaseUrl || null,
    is_published: true,
  };
}

async function fetchCatalog() {
  console.log(`[import] fetching ${OSS_CATALOG_URL} ...`);
  const resp = await fetch(OSS_CATALOG_URL, { cache: 'no-store' });
  if (!resp.ok) {
    throw new Error(`OSS GET failed: ${resp.status} ${resp.statusText}`);
  }
  const json = await resp.json();
  const series = Array.isArray(json.series) ? json.series : [];
  console.log(`[import] catalog has ${series.length} series entries, version=${json.version ?? '?'}`);
  return { json, series };
}

async function upsertBatch(rows) {
  if (rows.length === 0) return { inserted: 0, updated: 0 };
  // Supabase JS upsert returns rows back when using .select(); we don't need them
  // but we want to know the count. Use the `count: 'exact'` option and `ignoreDuplicates: false`
  // so the count reflects "touched" rows.
  const { error, count } = await supabase
    .from('official_video_series')
    .upsert(rows, { onConflict: 'id', ignoreDuplicates: false, count: 'exact' })
    .select('id', { count: 'exact', head: true });
  if (error) {
    throw new Error(`Supabase upsert failed: ${error.message}`);
  }
  return { count: count ?? rows.length };
}

async function main() {
  const { json, series } = await fetchCatalog();

  const catalogBaseUrl = typeof json.resourceBaseUrl === 'string' && json.resourceBaseUrl.trim()
    ? json.resourceBaseUrl.trim().replace(/\/$/, '')
    : OSS_CATALOG_URL.split('/').slice(0, -1).join('/');

  const rows = series
    .map((s) => mapSeries(s, catalogBaseUrl))
    .filter((r) => r !== null);

  const skipped = series.length - rows.length;
  console.log(`[import] ${rows.length} rows to upsert, ${skipped} skipped (missing id/title/manifestUrl)`);

  if (rows.length === 0) {
    console.log('[import] nothing to do, exiting');
    return;
  }

  // Print a sample so the operator can eyeball the mapping before commit
  console.log('[import] sample row:', JSON.stringify(rows[0], null, 2));

  // Upsert in batches of 100 to stay under PostgREST row-count limits
  const BATCH_SIZE = 100;
  let total = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { count } = await upsertBatch(batch);
    total += count;
    console.log(`[import] batch ${Math.floor(i / BATCH_SIZE) + 1}: upserted ${count} rows`);
  }

  console.log(`[import] done. ${total} rows touched in official_video_series.`);
}

main().catch((err) => {
  console.error('[import] FAILED:', err.message);
  process.exit(1);
});

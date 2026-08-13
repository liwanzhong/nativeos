import * as DocumentPicker from 'expo-document-picker';
import {
  copyAsync,
  deleteAsync,
  documentDirectory,
  getInfoAsync,
  makeDirectoryAsync,
  moveAsync,
  readAsStringAsync,
  writeAsStringAsync,
} from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { z } from 'zod';
import { getOrCreateDefaultCollection, encodeUserCollectionId } from './user-collections';

const IMPORT_ROOT_DIR = `${documentDirectory ?? ''}imported-video-packs`;
const IMPORT_INDEX_PATH = `${IMPORT_ROOT_DIR}/index.json`;
const IMPORT_STAGING_DIR = `${IMPORT_ROOT_DIR}/staging`;

const importedVideoPackManifestSchema = z.object({
  schemaVersion: z.number().int().positive(),
  id: z.string().min(1),
  title: z.string().min(1),
  level: z.string().min(1).default('B1'),
  category: z.string().min(1).default('生活'),
  type: z.string().min(1).default('vlog'),
  sourceLabel: z.string().optional(),
  hasRoleplay: z.boolean().optional(),
  videoFile: z.string().min(1),
  subtitleJson3File: z.string().min(1),
  subtitleEnSegmentedFile: z.string().optional(),
  subtitleZhFile: z.string().optional(),
  infoFile: z.string().optional(),
  coverFile: z.string().optional(),
  aiPracticeFile: z.string().optional(),
  durationSeconds: z.number().nonnegative().optional(),
  createdAt: z.string().optional(),
  tool: z.string().optional(),
});

const importedVideoPackIndexEntrySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  level: z.string().min(1),
  category: z.string().min(1),
  type: z.string().min(1),
  sourceLabel: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  importedAt: z.string().min(1),
  packageDir: z.string().min(1),
  manifestUri: z.string().min(1),
  videoUri: z.string().min(1),
  subtitleJson3Uri: z.string().min(1),
  subtitleEnSegmentedUri: z.string().optional(),
  subtitleZhUri: z.string().optional(),
  infoUri: z.string().optional(),
  coverUri: z.string().optional(),
  aiPracticeUri: z.string().optional(),
  durationSeconds: z.number().nonnegative().optional(),
  hasRoleplay: z.boolean().optional(),
  videoFileName: z.string().min(1),
  subtitleJson3FileName: z.string().min(1),
  subtitleEnSegmentedFileName: z.string().optional(),
  subtitleZhFileName: z.string().optional(),
  infoFileName: z.string().optional(),
  coverFileName: z.string().optional(),
  aiPracticeFileName: z.string().optional(),
  /**
   * Owning collection id. Encoded as `"user:<bigserial>"` for
   * user-built collections; absent / null means "uncategorised —
   * surface it under the default collection at read time".
   *
   * Set on import (assigned by the import flow) and editable from
   * the video detail page. Empty string is treated the same as
   * absent.
   */
  collectionId: z.string().optional(),
});

const importedVideoPackIndexSchema = z.object({
  version: z.literal(1),
  items: z.array(importedVideoPackIndexEntrySchema),
});

export type ImportedVideoPackManifest = z.infer<typeof importedVideoPackManifestSchema>;
export type ImportedVideoPackIndexEntry = z.infer<typeof importedVideoPackIndexEntrySchema>;

interface ImportVideoPackSourceOptions {
  sourceName?: string | null;
  mimeType?: string | null;
  /**
   * Owning collection wire id. See `ImportLocalVideoOptions` in
   * user-videos.ts for the same semantics.
   */
  collectionId?: string;
}

let pendingImportedVideoPackUri: string | null = null;

function loadUnzip() {
  if (Platform.OS === 'web') {
    throw new Error('Web 端暂不支持本地视频包导入');
  }
  const zipArchiveModule = require('react-native-zip-archive') as { unzip?: (source: string, target: string, charset?: string) => Promise<string> };
  if (!zipArchiveModule?.unzip) {
    throw new Error('未找到 zip 解压模块 react-native-zip-archive');
  }
  return zipArchiveModule.unzip;
}

function ensureImportRootAvailable() {
  if (!documentDirectory) {
    throw new Error('当前设备不支持本地视频包导入');
  }
}

function toLocalFsPath(uri: string) {
  return uri.startsWith('file://') ? uri.replace('file://', '') : uri;
}

function joinPath(base: string, name: string) {
  return `${base.replace(/\/+$/, '')}/${name}`;
}

function sanitizePackageId(id: string) {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_') || `video_pack_${Date.now()}`;
}

function getFileNameFromUri(uri: string) {
  const normalized = uri.split('?')[0] || uri;
  const segments = normalized.split('/').filter(Boolean);
  return segments.length ? segments[segments.length - 1] : '';
}

function isDeckpackMimeType(value?: string | null) {
  const mimeType = value?.trim().toLowerCase();
  return mimeType === 'application/octet-stream'
    || mimeType === 'application/zip'
    || mimeType === 'application/x-zip-compressed';
}

function assertDeckpackCandidate(sourceUri: string, options: ImportVideoPackSourceOptions = {}) {
  const sourceName = (options.sourceName || getFileNameFromUri(sourceUri)).trim();
  if (sourceName) {
    if (!sourceName.toLowerCase().endsWith('.deckpack')) {
      throw new Error('请选择 .deckpack 视频包文件');
    }
    return;
  }

  if (sourceUri.startsWith('file://')) {
    const normalized = sourceUri.toLowerCase().split('?')[0];
    if (!normalized.endsWith('.deckpack')) {
      throw new Error('请选择 .deckpack 视频包文件');
    }
    return;
  }

  if (options.mimeType && !isDeckpackMimeType(options.mimeType)) {
    throw new Error('当前分享的不是 .deckpack 视频包文件');
  }
}

async function ensureDirectory(uri: string) {
  const info = await getInfoAsync(uri);
  if (!info.exists) {
    await makeDirectoryAsync(uri, { intermediates: true });
  }
}

async function readJsonFile<T>(uri: string): Promise<T> {
  const raw = await readAsStringAsync(uri);
  return JSON.parse(raw) as T;
}

async function writeJsonFile(uri: string, value: unknown) {
  await writeAsStringAsync(uri, JSON.stringify(value, null, 2));
}

async function fileExists(uri?: string | null) {
  if (!uri) return false;
  const info = await getInfoAsync(uri);
  return info.exists;
}

async function readImportIndex() {
  ensureImportRootAvailable();
  await ensureDirectory(IMPORT_ROOT_DIR);
  const exists = await fileExists(IMPORT_INDEX_PATH);
  if (!exists) {
    return { version: 1 as const, items: [] as ImportedVideoPackIndexEntry[] };
  }
  const parsed = importedVideoPackIndexSchema.parse(await readJsonFile(IMPORT_INDEX_PATH));
  return parsed;
}

async function writeImportIndex(items: ImportedVideoPackIndexEntry[]) {
  ensureImportRootAvailable();
  await ensureDirectory(IMPORT_ROOT_DIR);
  await writeJsonFile(IMPORT_INDEX_PATH, {
    version: 1,
    items,
  });
}

function buildImportedIndexEntry(manifest: ImportedVideoPackManifest, packageDir: string, collectionId?: string): ImportedVideoPackIndexEntry {
  const manifestUri = joinPath(packageDir, 'manifest.json');
  return {
    id: manifest.id,
    title: manifest.title,
    level: manifest.level,
    category: manifest.category,
    type: manifest.type,
    sourceLabel: manifest.sourceLabel || '本地导入',
    schemaVersion: manifest.schemaVersion,
    importedAt: new Date().toISOString(),
    packageDir,
    manifestUri,
    videoUri: joinPath(packageDir, manifest.videoFile),
    subtitleJson3Uri: joinPath(packageDir, manifest.subtitleJson3File),
    subtitleEnSegmentedUri: manifest.subtitleEnSegmentedFile ? joinPath(packageDir, manifest.subtitleEnSegmentedFile) : undefined,
    subtitleZhUri: manifest.subtitleZhFile ? joinPath(packageDir, manifest.subtitleZhFile) : undefined,
    infoUri: manifest.infoFile ? joinPath(packageDir, manifest.infoFile) : undefined,
    coverUri: manifest.coverFile ? joinPath(packageDir, manifest.coverFile) : undefined,
    aiPracticeUri: manifest.aiPracticeFile ? joinPath(packageDir, manifest.aiPracticeFile) : undefined,
    durationSeconds: manifest.durationSeconds,
    hasRoleplay: manifest.hasRoleplay,
    videoFileName: manifest.videoFile,
    subtitleJson3FileName: manifest.subtitleJson3File,
    subtitleEnSegmentedFileName: manifest.subtitleEnSegmentedFile,
    subtitleZhFileName: manifest.subtitleZhFile,
    infoFileName: manifest.infoFile,
    coverFileName: manifest.coverFile,
    aiPracticeFileName: manifest.aiPracticeFile,
    collectionId,
  };
}

async function validateImportedPackageFiles(extractDir: string, manifest: ImportedVideoPackManifest) {
  const requiredFiles = [
    joinPath(extractDir, 'manifest.json'),
    joinPath(extractDir, manifest.videoFile),
    joinPath(extractDir, manifest.subtitleJson3File),
  ];
  if (manifest.subtitleEnSegmentedFile) {
    requiredFiles.push(joinPath(extractDir, manifest.subtitleEnSegmentedFile));
  }
  if (manifest.subtitleZhFile) {
    requiredFiles.push(joinPath(extractDir, manifest.subtitleZhFile));
  }
  if (manifest.infoFile) {
    requiredFiles.push(joinPath(extractDir, manifest.infoFile));
  }
  if (manifest.coverFile) {
    requiredFiles.push(joinPath(extractDir, manifest.coverFile));
  }
  if (manifest.aiPracticeFile) {
    requiredFiles.push(joinPath(extractDir, manifest.aiPracticeFile));
  }
  for (const uri of requiredFiles) {
    if (!(await fileExists(uri))) {
      throw new Error(`导入包缺少文件：${uri.split('/').pop() || uri}`);
    }
  }
}

async function cleanupPath(uri: string) {
  const exists = await fileExists(uri);
  if (exists) {
    await deleteAsync(uri, { idempotent: true });
  }
}

export function setPendingImportedVideoPackUri(uri: string | null) {
  pendingImportedVideoPackUri = uri;
}

export function consumePendingImportedVideoPackUri() {
  const current = pendingImportedVideoPackUri;
  pendingImportedVideoPackUri = null;
  return current;
}

export function getImportableVideoPackUriFromUrl(url: string | null | undefined) {
  if (!url) return null;
  const normalized = decodeURIComponent(url);
  if (normalized.startsWith('file://') || normalized.startsWith('content://')) {
    return normalized;
  }
  try {
    const parsed = new URL(url);
    const candidate = parsed.searchParams.get('uri') || parsed.searchParams.get('file') || parsed.searchParams.get('url');
    if (candidate && (candidate.startsWith('file://') || candidate.startsWith('content://'))) {
      return decodeURIComponent(candidate);
    }
  } catch {
  }
  return null;
}

export async function listImportedVideoPacks(): Promise<ImportedVideoPackIndexEntry[]> {
  const index = await readImportIndex();
  return [...index.items].sort((a, b) => b.importedAt.localeCompare(a.importedAt));
}

export async function getImportedVideoPackEntryById(id: string): Promise<ImportedVideoPackIndexEntry | null> {
  const index = await readImportIndex();
  return index.items.find((item) => item.id === id) || null;
}

export async function readImportedVideoPackManifest(entry: ImportedVideoPackIndexEntry): Promise<ImportedVideoPackManifest> {
  const manifest = importedVideoPackManifestSchema.parse(await readJsonFile(entry.manifestUri));
  return manifest;
}

export async function readImportedVideoPackJson<T>(uri?: string): Promise<T | null> {
  if (!uri) return null;
  if (!(await fileExists(uri))) return null;
  return readJsonFile<T>(uri);
}

export async function importVideoPackFromUri(sourceUri: string, options: ImportVideoPackSourceOptions = {}) {
  ensureImportRootAvailable();
  const unzip = loadUnzip();
  assertDeckpackCandidate(sourceUri, options);
  await ensureDirectory(IMPORT_ROOT_DIR);
  await ensureDirectory(IMPORT_STAGING_DIR);

  const stageId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const stageRoot = joinPath(IMPORT_STAGING_DIR, stageId);
  const stagedPackageUri = joinPath(stageRoot, 'package.deckpack');
  const extractDir = joinPath(stageRoot, 'unzipped');

  await ensureDirectory(stageRoot);

  try {
    await copyAsync({ from: sourceUri, to: stagedPackageUri });
    await unzip(toLocalFsPath(stagedPackageUri), toLocalFsPath(extractDir));

    const manifestUri = joinPath(extractDir, 'manifest.json');
    if (!(await fileExists(manifestUri))) {
      throw new Error('导入包缺少 manifest.json');
    }

    const manifest = importedVideoPackManifestSchema.parse(await readJsonFile(manifestUri));
    await validateImportedPackageFiles(extractDir, manifest);

    const packageDir = joinPath(IMPORT_ROOT_DIR, sanitizePackageId(manifest.id));
    await cleanupPath(packageDir);
    await moveAsync({ from: extractDir, to: packageDir });

    // Resolve owning collection. Picker can pass a non-default
    // wire id; otherwise lazy-create default. Same rationale as
    // user-videos imports.
    const targetCollectionId = options.collectionId
      ?? encodeUserCollectionId((await getOrCreateDefaultCollection()).id);

    const entry = buildImportedIndexEntry(manifest, packageDir, targetCollectionId);
    const index = await readImportIndex();
    const nextItems = index.items.filter((item) => item.id !== entry.id);
    nextItems.unshift(entry);
    await writeImportIndex(nextItems);
    await cleanupPath(stageRoot);
    return entry;
  } catch (error) {
    await cleanupPath(stageRoot);
    throw error;
  }
}

export async function pickAndImportVideoPack() {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['application/octet-stream', 'application/zip', 'application/x-zip-compressed', '*/*'],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled || !result.assets?.[0]?.uri) {
    return null;
  }
  return importVideoPackFromUri(result.assets[0].uri, {
    sourceName: result.assets[0].name,
    mimeType: result.assets[0].mimeType,
  });
}

/**
 * Move a pack entry to a different collection, or clear its
 * `collectionId` (passing `undefined`) so the pack falls back to
 * the default collection. The pack's actual files on disk are
 * NOT touched — only the index row is updated. Use this for
 * non-destructive "remove from this custom collection". For real
 * delete, call `deleteImportedVideoPack`.
 */
export async function setImportedVideoPackCollection(
  id: string,
  collectionId: string | undefined,
): Promise<ImportedVideoPackIndexEntry | null> {
  const index = await readImportIndex();
  const target = index.items.find((item) => item.id === id);
  if (!target) {
    console.warn('[ImportedVideoPackCollection] entry not found', { id });
    return null;
  }
  const nextItems = index.items.map((item) =>
    item.id === id ? { ...item, collectionId } : item,
  );
  await writeImportIndex(nextItems);
  return nextItems.find((item) => item.id === id) ?? null;
}

/**
 * Hard-delete an imported pack: remove the index row AND delete
 * the pack's directory (video, subtitles, cover, etc.). Used
 * when the user removes a pack from the default collection —
 * the catch-all sink — so there's nowhere else for it to land.
 */
export async function deleteImportedVideoPack(id: string): Promise<ImportedVideoPackIndexEntry | null> {
  const index = await readImportIndex();
  const target = index.items.find((item) => item.id === id);
  if (!target) {
    return null;
  }
  // Best-effort cleanup of the pack directory. We don't fail the
  // delete if cleanup throws (e.g. file already gone) — the index
  // row removal is the source of truth.
  try {
    await cleanupPath(target.packageDir);
  } catch (err) {
    console.warn('[ImportedVideoPackDelete] cleanupPath failed (continuing)', {
      id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await writeImportIndex(index.items.filter((item) => item.id !== id));
  return target;
}

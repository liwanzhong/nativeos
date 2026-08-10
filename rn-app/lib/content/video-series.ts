import { getFeaturedVideoScenes, type VideoSceneDetail } from './video-scenes';
import { listVideoUserMeta, type VideoUserMetaRecord } from './video-user-meta';

export interface OfficialVideoSeriesSummary {
  id: string;
  title: string;
  level: string;
  description?: string;
  coverImageUri?: string;
  tags: string[];
  category: string;
  episodeCount: number;
  completedEpisodeCount: number;
  lastPracticedAt?: number;
  resumeSceneId?: string;
  resumeEpisodeIndex?: number;
  firstSceneId?: string;
  firstEpisodeIndex?: number;
  sortOrder: number;
}

export interface OfficialVideoSeriesDetail extends OfficialVideoSeriesSummary {
  episodes: VideoSceneDetail[];
}

export interface OfficialVideoSeriesNeighbors {
  groupId: string;
  groupTitle: string;
  currentSceneId: string;
  currentEpisodeIndex?: number;
  totalEpisodes: number;
  previousSceneId?: string;
  nextSceneId?: string;
}

interface SeriesGroupingMeta {
  groupId: string;
  title: string;
  level: string;
  description?: string;
  sortOrder: number;
  coverImageUri?: string;
}

function isOfficialScene(scene: VideoSceneDetail) {
  return scene.contentOrigin === 'official';
}

function normalizeLevel(level?: string) {
  return typeof level === 'string' && level.trim().length > 0 ? level.trim() : '未分级';
}

function buildFallbackGroupMeta(scene: VideoSceneDetail): SeriesGroupingMeta {
  const level = normalizeLevel(scene.groupLevel || scene.card.level);
  return {
    groupId: `level::${level}`,
    title: `${level} 官方推荐合集`,
    level,
    description: `围绕 ${level} 学习阶段整理的官方推荐视频合集。`,
    sortOrder: Number.MAX_SAFE_INTEGER,
    coverImageUri: scene.groupCoverImageUri || scene.coverImageUri,
  };
}

function getGroupingMeta(scene: VideoSceneDetail): SeriesGroupingMeta {
  if (typeof scene.groupId === 'string' && scene.groupId.trim().length > 0) {
    return {
      groupId: scene.groupId,
      title: scene.groupTitle || scene.card.title,
      level: normalizeLevel(scene.groupLevel || scene.card.level),
      description: scene.groupDescription,
      sortOrder: typeof scene.groupSortOrder === 'number' && Number.isFinite(scene.groupSortOrder)
        ? scene.groupSortOrder
        : Number.MAX_SAFE_INTEGER - 1,
      coverImageUri: scene.groupCoverImageUri || scene.coverImageUri,
    };
  }
  return buildFallbackGroupMeta(scene);
}

function sortEpisodes(a: VideoSceneDetail, b: VideoSceneDetail) {
  const aIndex = typeof a.episodeIndex === 'number' ? a.episodeIndex : Number.MAX_SAFE_INTEGER;
  const bIndex = typeof b.episodeIndex === 'number' ? b.episodeIndex : Number.MAX_SAFE_INTEGER;
  if (aIndex !== bIndex) {
    return aIndex - bIndex;
  }
  return a.card.title.localeCompare(b.card.title, 'zh-Hans-CN');
}

function getCategoryLabel(episodes: VideoSceneDetail[]) {
  const categoryCount = new Map<string, number>();
  episodes.forEach((episode) => {
    const category = episode.card.category || '综合';
    categoryCount.set(category, (categoryCount.get(category) || 0) + 1);
  });
  return Array.from(categoryCount.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || '综合';
}

function buildTags(episodes: VideoSceneDetail[]) {
  const tags = new Set<string>();
  episodes.forEach((episode) => {
    (episode.groupTags || []).forEach((tag) => {
      if (tag && tag.trim()) {
        tags.add(tag.trim());
      }
    });
    if (episode.card.category) {
      tags.add(episode.card.category);
    }
  });
  return Array.from(tags).slice(0, 4);
}

function buildSeriesSummary(groupMeta: SeriesGroupingMeta, episodes: VideoSceneDetail[], metaMap: Record<string, VideoUserMetaRecord>): OfficialVideoSeriesDetail {
  const sortedEpisodes = [...episodes].sort(sortEpisodes).map((episode, _index, source) => ({
    ...episode,
    totalEpisodesInGroup: source.length,
  }));
  const firstEpisode = sortedEpisodes[0];
  const practicedEpisodes = sortedEpisodes.filter((episode) => typeof metaMap[episode.id]?.lastPracticedAt === 'number');
  const lastPracticedEpisode = [...practicedEpisodes].sort((a, b) => (metaMap[b.id]?.lastPracticedAt || 0) - (metaMap[a.id]?.lastPracticedAt || 0))[0] ?? null;
  const resumeEpisode = lastPracticedEpisode ?? firstEpisode;

  return {
    id: groupMeta.groupId,
    title: groupMeta.title,
    level: groupMeta.level,
    description: groupMeta.description,
    coverImageUri: groupMeta.coverImageUri || firstEpisode.groupCoverImageUri || firstEpisode.coverImageUri,
    tags: buildTags(sortedEpisodes),
    category: getCategoryLabel(sortedEpisodes),
    episodeCount: sortedEpisodes.length,
    completedEpisodeCount: practicedEpisodes.length,
    lastPracticedAt: lastPracticedEpisode ? metaMap[lastPracticedEpisode.id]?.lastPracticedAt : undefined,
    resumeSceneId: resumeEpisode?.id,
    resumeEpisodeIndex: resumeEpisode?.episodeIndex,
    firstSceneId: firstEpisode.id,
    firstEpisodeIndex: firstEpisode.episodeIndex,
    sortOrder: groupMeta.sortOrder,
    episodes: sortedEpisodes,
  };
}

async function getOfficialVideoSeriesDetails(forceRefresh: boolean = false): Promise<OfficialVideoSeriesDetail[]> {
  const [scenes, metaList] = await Promise.all([
    getFeaturedVideoScenes(forceRefresh),
    listVideoUserMeta().catch(() => [] as VideoUserMetaRecord[]),
  ]);
  const officialScenes = scenes.filter(isOfficialScene);
  const metaMap = Object.fromEntries(metaList.map((item) => [item.sceneId, item]));
  const grouped = new Map<string, { meta: SeriesGroupingMeta; episodes: VideoSceneDetail[] }>();

  officialScenes.forEach((scene) => {
    const groupingMeta = getGroupingMeta(scene);
    const current = grouped.get(groupingMeta.groupId);
    if (current) {
      current.episodes.push(scene);
      return;
    }
    grouped.set(groupingMeta.groupId, {
      meta: groupingMeta,
      episodes: [scene],
    });
  });

  return Array.from(grouped.values())
    .map(({ meta, episodes }) => buildSeriesSummary(meta, episodes, metaMap))
    .sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) {
        return a.sortOrder - b.sortOrder;
      }
      if ((b.lastPracticedAt || 0) !== (a.lastPracticedAt || 0)) {
        return (b.lastPracticedAt || 0) - (a.lastPracticedAt || 0);
      }
      return a.level.localeCompare(b.level, 'zh-Hans-CN') || a.title.localeCompare(b.title, 'zh-Hans-CN');
    });
}

export async function getOfficialVideoSeriesList(forceRefresh: boolean = false): Promise<OfficialVideoSeriesSummary[]> {
  const details = await getOfficialVideoSeriesDetails(forceRefresh);
  return details.map(({ episodes, ...summary }) => summary);
}

export async function getOfficialVideoSeriesById(groupId: string, forceRefresh: boolean = false): Promise<OfficialVideoSeriesDetail | null> {
  const details = await getOfficialVideoSeriesDetails(forceRefresh);
  return details.find((series) => series.id === groupId) ?? null;
}

export async function getOfficialVideoSeriesNeighbors(sceneId: string, forceRefresh: boolean = false): Promise<OfficialVideoSeriesNeighbors | null> {
  const details = await getOfficialVideoSeriesDetails(forceRefresh);
  for (const series of details) {
    const currentIndex = series.episodes.findIndex((episode) => episode.id === sceneId);
    if (currentIndex < 0) {
      continue;
    }
    return {
      groupId: series.id,
      groupTitle: series.title,
      currentSceneId: sceneId,
      currentEpisodeIndex: series.episodes[currentIndex]?.episodeIndex,
      totalEpisodes: series.episodes.length,
      previousSceneId: currentIndex > 0 ? series.episodes[currentIndex - 1]?.id : undefined,
      nextSceneId: currentIndex < series.episodes.length - 1 ? series.episodes[currentIndex + 1]?.id : undefined,
    };
  }
  return null;
}

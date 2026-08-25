"use strict";
/**
 * Stats 本地存储层 · AsyncStorage 封装
 *
 * 设计要点:
 *   1. 内存缓冲 + 5 秒节流 flush — timeUpdate 触发频率约 10Hz,
 *      每次都写 AsyncStorage 会卡 UI,所以攒 5 秒或 AppState=background
 *      时强制刷盘。
 *   2. Key 命名:`stats:video:{videoId}` 和 `stats:daily:{YYYY-MM-DD}`
 *      — 用冒号分段,后续如果要批量扫所有 stats key 也好过滤。
 *   3. 失败容忍 — 写盘失败只在 console.warn,不影响主流程。
 *   4. 全局索引 — `stats:video-index` 存所有有数据的 videoId 列表,
 *      否则"按视频列表"无法知道有哪些视频。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.incrementVideoStats = incrementVideoStats;
exports.incrementVideoShadowing = incrementVideoShadowing;
exports.incrementDailyStats = incrementDailyStats;
exports.incrementDailyShadowing = incrementDailyShadowing;
exports.readVideoStatsSync = readVideoStatsSync;
exports.bufferVideoStats = bufferVideoStats;
exports.readVideoStats = readVideoStats;
exports.readAllVideoStats = readAllVideoStats;
exports.bufferDailyStats = bufferDailyStats;
exports.readDailyStats = readDailyStats;
exports.flush = flush;
exports.todayLocalDate = todayLocalDate;
const async_storage_1 = __importDefault(require("@react-native-async-storage/async-storage"));
const VIDEO_KEY_PREFIX = 'stats:video:';
const DAILY_KEY_PREFIX = 'stats:daily:';
const VIDEO_INDEX_KEY = 'stats:video-index';
const FLUSH_INTERVAL_MS = 5000;
// ── 内存缓冲层 ────────────────────────────────────────────
// Map<key, value> 形式缓存待写盘的数据
const videoBuffer = new Map();
const dailyBuffer = new Map();
let flushTimer = null;
let flushInFlight = null;
// 同步内存副本:用于"先读后写"的原子累加,避免 read-then-write 竞态
const inMemoryVideo = new Map();
const inMemoryDaily = new Map();
// 标记"已从 storage 加载过" — 未加载过的话累加时 lazy load
const videoLoaded = new Set();
const dailyLoaded = new Set();
function todayLocalDate() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}
// 异步把 storage 数据 lazy load 到 inMemory(只 load 一次)
async function ensureVideoLoaded(videoId) {
    if (videoLoaded.has(videoId))
        return;
    videoLoaded.add(videoId);
    try {
        const raw = await async_storage_1.default.getItem(`${VIDEO_KEY_PREFIX}${videoId}`);
        if (raw) {
            const stats = JSON.parse(raw);
            inMemoryVideo.set(videoId, stats);
        }
    }
    catch (e) {
        console.warn('[stats/storage] ensureVideoLoaded failed:', videoId, e);
    }
}
async function ensureDailyLoaded(date) {
    if (dailyLoaded.has(date))
        return;
    dailyLoaded.add(date);
    try {
        const raw = await async_storage_1.default.getItem(`${DAILY_KEY_PREFIX}${date}`);
        if (raw) {
            const stats = JSON.parse(raw);
            inMemoryDaily.set(date, stats);
        }
    }
    catch (e) {
        console.warn('[stats/storage] ensureDailyLoaded failed:', date, e);
    }
}
/**
 * 同步累加 video stats(原子操作,无竞态)
 * 第一次调用会触发 lazy load,但本次返回的累加是基于当前 inMemory 值,
 * 即便 storage 还没加载完成,也至少不会跟其他 recordPlayback 冲突。
 * 返回累加后的最新值。
 */
function incrementVideoStats(videoId, deltaMs, isActive) {
    const now = Date.now();
    const existing = inMemoryVideo.get(videoId) ?? {
        videoId,
        foregroundMs: 0,
        backgroundMs: 0,
        shadowingCount: 0,
        updatedAt: now,
    };
    const next = {
        ...existing,
        foregroundMs: existing.foregroundMs + (isActive ? deltaMs : 0),
        backgroundMs: existing.backgroundMs + (isActive ? 0 : deltaMs),
        updatedAt: now,
    };
    inMemoryVideo.set(videoId, next);
    videoBuffer.set(videoId, next);
    scheduleFlush();
    // 触发 lazy load(后台,不影响本次累加正确性)
    ensureVideoLoaded(videoId);
    return next;
}
function incrementVideoShadowing(videoId) {
    const now = Date.now();
    const existing = inMemoryVideo.get(videoId) ?? {
        videoId,
        foregroundMs: 0,
        backgroundMs: 0,
        shadowingCount: 0,
        updatedAt: now,
    };
    const next = {
        ...existing,
        shadowingCount: existing.shadowingCount + 1,
        updatedAt: now,
    };
    inMemoryVideo.set(videoId, next);
    videoBuffer.set(videoId, next);
    scheduleFlush();
    ensureVideoLoaded(videoId);
    return next;
}
function incrementDailyStats(date, deltaMs, isActive) {
    const existing = inMemoryDaily.get(date) ?? {
        date,
        foregroundMs: 0,
        backgroundMs: 0,
        shadowingCount: 0,
    };
    const next = {
        ...existing,
        foregroundMs: existing.foregroundMs + (isActive ? deltaMs : 0),
        backgroundMs: existing.backgroundMs + (isActive ? 0 : deltaMs),
    };
    inMemoryDaily.set(date, next);
    dailyBuffer.set(date, next);
    scheduleFlush();
    ensureDailyLoaded(date);
    return next;
}
function incrementDailyShadowing(date) {
    const existing = inMemoryDaily.get(date) ?? {
        date,
        foregroundMs: 0,
        backgroundMs: 0,
        shadowingCount: 0,
    };
    const next = {
        ...existing,
        shadowingCount: existing.shadowingCount + 1,
    };
    inMemoryDaily.set(date, next);
    dailyBuffer.set(date, next);
    scheduleFlush();
    ensureDailyLoaded(date);
    return next;
}
/** 读取单视频(优先 inMemory) */
function readVideoStatsSync(videoId) {
    return inMemoryVideo.get(videoId) ?? null;
}
// ── Video stats ──────────────────────────────────────────
function bufferVideoStats(stats) {
    videoBuffer.set(stats.videoId, stats);
    scheduleFlush();
}
async function readVideoStats(videoId) {
    // 优先读 inMemory(累加器维护的最新值,可能比 storage 更准)
    const inMem = inMemoryVideo.get(videoId);
    if (inMem)
        return inMem;
    try {
        const raw = await async_storage_1.default.getItem(`${VIDEO_KEY_PREFIX}${videoId}`);
        if (!raw)
            return null;
        const stats = JSON.parse(raw);
        inMemoryVideo.set(videoId, stats);
        videoLoaded.add(videoId);
        return stats;
    }
    catch (e) {
        console.warn('[stats/storage] readVideoStats failed:', videoId, e);
        return null;
    }
}
async function readAllVideoStats() {
    await flushIfPending();
    try {
        const indexRaw = await async_storage_1.default.getItem(VIDEO_INDEX_KEY);
        const ids = indexRaw ? JSON.parse(indexRaw) : [];
        if (ids.length === 0)
            return [];
        const keys = ids.map((id) => `${VIDEO_KEY_PREFIX}${id}`);
        const pairs = await async_storage_1.default.multiGet(keys);
        const result = [];
        for (const [, value] of pairs) {
            if (!value)
                continue;
            try {
                result.push(JSON.parse(value));
            }
            catch {
                // skip corrupted entry
            }
        }
        return result;
    }
    catch (e) {
        console.warn('[stats/storage] readAllVideoStats failed:', e);
        return [];
    }
}
// ── Daily stats ──────────────────────────────────────────
function bufferDailyStats(stats) {
    dailyBuffer.set(stats.date, stats);
    scheduleFlush();
}
async function readDailyStats(startDate, endDate) {
    await flushIfPending();
    // 生成日期序列
    const dates = [];
    const start = new Date(startDate + 'T00:00:00');
    const end = new Date(endDate + 'T00:00:00');
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        dates.push(`${y}-${m}-${day}`);
    }
    const keys = dates.map((d) => `${DAILY_KEY_PREFIX}${d}`);
    try {
        const pairs = await async_storage_1.default.multiGet(keys);
        const result = [];
        for (let i = 0; i < pairs.length; i++) {
            const [, value] = pairs[i];
            const date = dates[i];
            if (value) {
                try {
                    result.push(JSON.parse(value));
                }
                catch {
                    result.push({ date, foregroundMs: 0, backgroundMs: 0, shadowingCount: 0 });
                }
            }
            else {
                // 没数据的日期也要占位(柱状图 30 天不能有空洞)
                result.push({ date, foregroundMs: 0, backgroundMs: 0, shadowingCount: 0 });
            }
        }
        return result;
    }
    catch (e) {
        console.warn('[stats/storage] readDailyStats failed:', e);
        return dates.map((date) => ({ date, foregroundMs: 0, backgroundMs: 0, shadowingCount: 0 }));
    }
}
// ── Flush 机制 ───────────────────────────────────────────
function scheduleFlush() {
    if (flushTimer)
        return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flush().catch((e) => console.warn('[stats/storage] flush failed:', e));
    }, FLUSH_INTERVAL_MS);
}
async function flush() {
    // 防止并发 flush
    if (flushInFlight) {
        return flushInFlight;
    }
    flushInFlight = doFlush().finally(() => {
        flushInFlight = null;
    });
    return flushInFlight;
}
async function flushIfPending() {
    if (videoBuffer.size > 0 || dailyBuffer.size > 0 || flushTimer) {
        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }
        await flush();
    }
}
async function doFlush() {
    const videosToWrite = Array.from(videoBuffer.entries());
    const dailiesToWrite = Array.from(dailyBuffer.entries());
    if (videosToWrite.length === 0 && dailiesToWrite.length === 0)
        return;
    videoBuffer.clear();
    dailyBuffer.clear();
    try {
        // 1. 写 video stats
        if (videosToWrite.length > 0) {
            const videoPairs = videosToWrite.map(([id, stats]) => [
                `${VIDEO_KEY_PREFIX}${id}`,
                JSON.stringify(stats),
            ]);
            await async_storage_1.default.multiSet(videoPairs);
            // 2. 更新 video 索引
            const existingRaw = await async_storage_1.default.getItem(VIDEO_INDEX_KEY);
            const existing = existingRaw ? JSON.parse(existingRaw) : [];
            const newIds = videosToWrite.map(([id]) => id).filter((id) => !existing.includes(id));
            if (newIds.length > 0) {
                await async_storage_1.default.setItem(VIDEO_INDEX_KEY, JSON.stringify([...existing, ...newIds]));
            }
        }
        // 3. 写 daily stats
        if (dailiesToWrite.length > 0) {
            const dailyPairs = dailiesToWrite.map(([date, stats]) => [
                `${DAILY_KEY_PREFIX}${date}`,
                JSON.stringify(stats),
            ]);
            await async_storage_1.default.multiSet(dailyPairs);
        }
    }
    catch (e) {
        console.warn('[stats/storage] doFlush failed:', e);
        // 失败时把数据放回 buffer,下次再试
        for (const [id, stats] of videosToWrite) {
            const existing = videoBuffer.get(id);
            if (!existing || existing.updatedAt < stats.updatedAt) {
                videoBuffer.set(id, stats);
            }
        }
        for (const [date, stats] of dailiesToWrite) {
            const existing = dailyBuffer.get(date);
            if (!existing) {
                dailyBuffer.set(date, stats);
            }
        }
    }
}

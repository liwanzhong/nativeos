"use strict";
/**
 * Stats 核心入口
 *
 * 对外暴露 5 个函数 + 1 个强制 flush:
 *   - recordPlayback(videoId, deltaMs, isActive)   累加播放时长(同步)
 *   - recordShadowing(videoId)                     累加跟读次数(同步)
 *   - getVideoStats(videoId)                       查询单视频
 *   - getDailyStats(startDate, endDate)            查询日期段
 *   - getAllVideoStats()                           查询所有视频
 *   - forceFlush()                                 强制 flush(切后台/退出前调)
 *   - installAppStateFlushListener()               全局监听 AppState,bg 时自动 flush
 *
 * 实现策略:
 *   - 写:inMemory 累加(同步、原子、无竞态)+ 5s 节流 flush 到 AsyncStorage
 *   - 读:inMemory 优先 → 缺则 AsyncStorage(lazy load 到 inMemory)
 *   - 同步:P1 阶段再加 Supabase 双向同步
 *
 * 边界处理:
 *   - delta <= 0 或 > 2000ms:判定为 seek/异常,不计入
 *   - AppState 在 tick 之间变化:以该 tick 内的 isActive 为准
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.todayLocalDate = void 0;
exports.recordPlayback = recordPlayback;
exports.recordShadowing = recordShadowing;
exports.getVideoStats = getVideoStats;
exports.getDailyStats = getDailyStats;
exports.getAllVideoStats = getAllVideoStats;
exports.forceFlush = forceFlush;
exports.installAppStateFlushListener = installAppStateFlushListener;
const react_native_1 = require("react-native");
const storage_1 = require("./storage");
Object.defineProperty(exports, "todayLocalDate", { enumerable: true, get: function () { return storage_1.todayLocalDate; } });
const SEEK_THRESHOLD_MS = 2000;
// ── 累加器(同步,无竞态) ─────────────────────────────
function recordPlayback(videoId, deltaMs, isActive) {
    if (!videoId)
        return;
    if (deltaMs <= 0 || deltaMs > SEEK_THRESHOLD_MS)
        return;
    // 1. 累加 video stats
    (0, storage_1.incrementVideoStats)(videoId, deltaMs, isActive);
    // 2. 累加当天 daily stats
    (0, storage_1.incrementDailyStats)((0, storage_1.todayLocalDate)(), deltaMs, isActive);
}
function recordShadowing(videoId) {
    if (!videoId)
        return;
    (0, storage_1.incrementVideoShadowing)(videoId);
    (0, storage_1.incrementDailyShadowing)((0, storage_1.todayLocalDate)());
}
// ── 查询 ────────────────────────────────────────────
async function getVideoStats(videoId) {
    return (0, storage_1.readVideoStats)(videoId);
}
async function getDailyStats(startDate, endDate) {
    return (0, storage_1.readDailyStats)(startDate, endDate);
}
async function getAllVideoStats() {
    return (0, storage_1.readAllVideoStats)();
}
// ── 强制 flush ─────────────────────────────────────
async function forceFlush() {
    return (0, storage_1.flush)();
}
/**
 * 监听 AppState 变化,在切到 background 时强制 flush。
 * 在 App 入口(root)处调一次,全局生效。返回 unsub 函数。
 */
function installAppStateFlushListener() {
    const sub = react_native_1.AppState.addEventListener('change', (next) => {
        if (next !== 'active') {
            forceFlush().catch((e) => console.warn('[stats] background flush failed:', e));
        }
    });
    return () => sub.remove();
}

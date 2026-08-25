
import {
  recordPlayback,
  recordShadowing,
  getVideoStats,
  getAllVideoStats,
  getDailyStats,
  forceFlush,
} from './index';

async function main() {
  // 1. 累加播放 3 次(active)
  recordPlayback('video1', 5000, true);
  recordPlayback('video1', 3000, true);
  recordPlayback('video1', 2000, false); // background
  recordShadowing('video1');
  recordShadowing('video1');

  // 2. 累加另一个视频
  recordPlayback('video2', 10000, true);

  // 3. 强制 flush
  await forceFlush();

  // 4. 读回
  const v1 = await getVideoStats('video1');
  const v2 = await getVideoStats('video2');
  const all = await getAllVideoStats();
  const today = await getDailyStats(
    new Date().toISOString().slice(0, 10),
    new Date().toISOString().slice(0, 10)
  );

  console.log('video1:', JSON.stringify(v1, null, 2));
  console.log('video2:', JSON.stringify(v2, null, 2));
  console.log('all count:', all.length);
  console.log('today:', JSON.stringify(today, null, 2));

  // 断言
  const assert = (cond, msg) => {
    if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  };
  assert(v1.foregroundMs === 8000, 'video1.foregroundMs expected 8000, got ' + v1.foregroundMs);
  assert(v1.backgroundMs === 2000, 'video1.backgroundMs expected 2000, got ' + v1.backgroundMs);
  assert(v1.shadowingCount === 2, 'video1.shadowingCount expected 2, got ' + v1.shadowingCount);
  assert(v2.foregroundMs === 10000, 'video2.foregroundMs expected 10000, got ' + v2.foregroundMs);
  assert(all.length === 2, 'expected 2 videos, got ' + all.length);
  assert(today[0].foregroundMs === 18000, 'today.foregroundMs expected 18000, got ' + today[0].foregroundMs);
  assert(today[0].shadowingCount === 2, 'today.shadowingCount expected 2, got ' + today[0].shadowingCount);

  // 5. 测试 seek 边界(delta > 2000ms 应被忽略)
  const v1Before = v1.foregroundMs;
  recordPlayback('video1', 5000, true); // 5s > 2s 阈值,应被忽略
  const v1After = await getVideoStats('video1');
  assert(v1After.foregroundMs === v1Before, 'seek delta 应被忽略');

  // 6. 测试负 delta
  recordPlayback('video1', -1000, true);
  const v1Neg = await getVideoStats('video1');
  assert(v1Neg.foregroundMs === v1Before, '负 delta 应被忽略');

  // 7. 测试空 videoId
  recordPlayback('', 1000, true); // 应被忽略,不抛错

  console.log('\n✅ All assertions passed');
}

main().catch((e) => { console.error(e); process.exit(1); });

# NativeOS 持久化迁移规划

> 状态: 待用户确认 · 作者: Mavis · 日期: 2026-08-05
> 范围: 把 P0/P1 的 AsyncStorage JSON store 迁到 SQLite, 解决写放大 + 并发覆盖 + 查询能力差
> 出 scope: 留 AsyncStorage 的小 key (badge/计数/版本号/临时态), 留 expo-file-system 的大文件 (视频/缩略图/音频/APK)

---

## 1. 现状盘点 (P0 + P1)

| AsyncStorage key | 文件 | 单 key 规模 | 写放大 | 并发风险 | 优先级 |
|---|---|---|---|---|---|
| `@cloud_drive_bindings_v1` | `cloud-drive-bindings.ts` | 中-大 (5 个子集) | **严重** (每条 scene 下载都全量 read+write) | **是** (OAuth + 下载元数据混一个 key) | **P0.1** |
| `chat_sessions` | `sessions.ts` | 中-大 (transcript 数组) | **严重** (每条 turn 都全量 read+write) | 否 (单用户) | **P0.2** |
| `generated_video_ai_practice_v1` | `video-ai-practice.ts` | 中 (per-scene 3-8 张卡) | 中 | 否 | **P0.3** |
| `generated_video_ai_practice_generation_state_v1` | 同上 | 小 | 中 (按 scene 频写) | 否 | **P1.1** |
| `video_user_meta_v1` | `video-user-meta.ts` | 小-中 (per-scene) | 低 (per-scene 全量写) | 否 | **P1.2** |
| `ai_practice_user_meta_v1` | `ai-practice-user-meta.ts` | 小-中 (per-topic) | 低 | 否 | **P1.3** |
| `web_cards` | `evaluator.ts` | ? | — | — | **删** (FSRS 已接管) |
| 其余 8 个 key (staged_*, fsrs_inject_cache, library_badge_count, android_update_*, evaluated_sessions, user_*) | 多 | 极小 | 极低 | 否 | **留** |

**结论**: 5 个 store 迁, 1 个删, 8 个留。

---

## 2. 关键决策 (帮用户拍板, 可改)

| 决策点 | 选择 | 理由 |
|---|---|---|
| web 端 | **native-only, web 走 mock** | `lib/database/index.ts` 注释 "Native-only — no web fallback." cards/fsrs 已 native-only, 一致 |
| API 兼容 | **函数签名 0 改动**, 只换内部实现 | 调用方 `cloud-video-playback.ts` / `evaluator.ts` / `app/(tabs)/review.tsx` 不用动 |
| 迁移时机 | **`migrateToV3` 一次性搬**, 搬完 `removeItem` 旧 key | 跟 `migrateToV2` 风格一致, 不打扰用户 |
| 失败策略 | **迁移失败不抛错**, 留 AsyncStorage 兜底 | 用户数据不丢, 出错能在 logcat 看到 |
| 平台分支 | 不加, 全用 SQLite (web 走 noop mock) | 跟 schema.web.ts 一致, AsyncStorage 在 web 也不再是 fallback |
| 拆表粒度 | **按数据形态拆**, 不为了拆而拆 | 5 个 store → 10 张表 (见 §4) |

---

## 3. 目标架构

```
lib/database/
├── schema.ts              ← 现有, 加 migrateToV3 + 新 CREATE TABLE
├── schema.web.ts          ← 现有 (noop)
├── expo-sqlite-mock.ts    ← 现有
├── index.ts               ← 现有, 补新 export
├── cards.ts               ← 现有
├── fsrs.ts                ← 现有
├── cloud-bindings.ts      ← 新: 5 张表的全部 CRUD (替换 @cloud_drive_bindings_v1 store)
├── chat-sessions.ts       ← 新: chat_sessions + chat_turns 2 张表的全部 CRUD
└── video-ai-practice.ts   ← 新: video_ai_practice_cards + 生成状态表的全部 CRUD
```

外部调用方**完全不变**:
- `cloud-video-playback.ts` 调 `getDownloadedSceneSource(...)` / `upsertDownloadedSceneSource(...)` → 内部走 SQLite
- `evaluator.ts` 调 `markEvaluated(...)` / `wasAlreadyEvaluated(...)` → 继续 AsyncStorage (极小, 不迁)
- `app/(tabs)/review.tsx` 不动

---

## 4. 表设计

### 4.1 cloud-drive-bindings 5 表

```sql
-- 1. 整个 app 的 key-value 配置 (单行 / 多行)
CREATE TABLE app_config (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,    -- JSON 序列化的小对象, 如 baiduPanBinding, baiduPanAppConfig, defaultProvider
  updated_at INTEGER NOT NULL
);

-- 2. 每个 scene 用户选的网盘 provider
CREATE TABLE scene_provider_selection (
  scene_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,      -- 'baidu_pan' (留扩展)
  updated_at INTEGER NOT NULL
);

-- 3. 每个 scene + provider 的下载元数据 (替代 downloadedSceneSources)
CREATE TABLE downloaded_scene_source (
  scene_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  local_video_uri TEXT,
  target_file_uri TEXT,
  remote_path TEXT,
  remote_url TEXT,
  remote_url_resolved_at TEXT,
  resume_data TEXT,
  total_bytes_written INTEGER,
  total_bytes_expected_to_write INTEGER,
  speed_bytes_per_second REAL,
  status TEXT NOT NULL,        -- 'idle'|'resolving'|'downloading'|'paused'|'completed'|'error'
  progress REAL NOT NULL DEFAULT 0,
  error_message TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scene_id, provider)
);
CREATE INDEX idx_dss_status ON downloaded_scene_source(status);

-- 4. 每个 scene + provider 的官方内容网盘同步记录
CREATE TABLE official_scene_sync_record (
  scene_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  official_video_key TEXT NOT NULL,
  synced_official_video_key TEXT,
  remote_path TEXT,
  remote_file_id INTEGER,
  binding_type TEXT,           -- 'scanned'|'manual'
  status TEXT NOT NULL,        -- 'not_synced'|'available'|'stale'|'error'
  error_message TEXT,
  last_checked_at TEXT NOT NULL,
  PRIMARY KEY (scene_id, provider)
);
CREATE INDEX idx_ossr_status ON official_scene_sync_record(status);
```

**为什么不用 `app_config` 存 downloadedSceneSources**: 下载元数据每条 scene 状态变更频繁, 放 KV 表会反复全 JSON 序列化。拆成行表是单 row update, 性能差距 10-100x。

**`app_config` 存什么**:
- `baiduPanBinding` (OAuth token) — 1 行
- `baiduPanAppConfig` — 1 行
- `defaultProvider` — 1 行

### 4.2 chat-sessions 2 表

```sql
CREATE TABLE chat_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  scenario_title TEXT NOT NULL,
  status TEXT NOT NULL,        -- 'active'|'completed'
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX idx_cs_status_completed ON chat_sessions(status, completed_at DESC);

CREATE TABLE chat_turns (
  session_id TEXT NOT NULL,
  turn_seq INTEGER NOT NULL,   -- 在 session 内递增, 0-based
  role TEXT NOT NULL,          -- 'npc'|'user'
  text TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (session_id, turn_seq),
  FOREIGN KEY (session_id) REFERENCES chat_sessions(session_id) ON DELETE CASCADE
);
CREATE INDEX idx_turns_session ON chat_turns(session_id, turn_seq);
```

**关键变化**: `appendTurn` 从 "read 全部 sessions → 改 → write 全部" 变成 "单行 INSERT", 复杂度从 O(N) 降到 O(1)。

### 4.3 video-ai-practice 2 表

```sql
CREATE TABLE video_ai_practice_card (
  scene_id TEXT NOT NULL,
  position INTEGER NOT NULL,   -- 0-based
  card_json TEXT NOT NULL,     -- 整个 ScenarioCard JSON
  created_at INTEGER NOT NULL,
  PRIMARY KEY (scene_id, position)
);
CREATE INDEX idx_vapc_scene ON video_ai_practice_card(scene_id);

-- 1 个 scene 1 行, 替代 generation state JSON store
CREATE TABLE video_ai_practice_state (
  scene_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,        -- 'idle'|'generating'|'completed'|'failed'
  progress_text TEXT NOT NULL,
  parsed_count INTEGER NOT NULL DEFAULT 0,
  target_count INTEGER NOT NULL DEFAULT 0,
  cards_json TEXT NOT NULL,    -- 累积的 ScenarioCard[] (生成中实时变)
  error_message TEXT,
  updated_at INTEGER NOT NULL
);
```

**`generation state` 状态并入 SQLite**: 之前是单独 key (`generated_video_ai_practice_generation_state_v1`), 跟 cards 分开维护, 容易不一致。合到 `video_ai_practice_state` 一行, 一次事务搞定。

---

## 5. 迁移步骤 (按依赖排序)

### 阶段 A: schema + 新数据层骨架 (不动现有调用)

1. `lib/database/schema.ts` 加 `migrateToV3(db)`:
   - CREATE 上面 9 张新表 (不含已删的 web_cards)
   - 从 AsyncStorage 读 5 个旧 store → INSERT 到新表
   - INSERT 成功 → `AsyncStorage.removeItem` 旧 key
   - 失败 → log error, 保留 AsyncStorage (下一次 migrate 再试)
2. 新建 `lib/database/cloud-bindings.ts` / `chat-sessions.ts` / `video-ai-practice.ts`:
   - 函数签名 1:1 复刻原 store 接口
   - 内部走 `await getDatabase()` + prepared statement
3. 暂**不删**旧 store, 双写期 (async + sqlite) 各跑 1 周

### 阶段 B: 切换调用方 (无感)

4. `lib/content/cloud-drive-bindings.ts`: 5 个 `readStore/writeStore` 函数 → 改 import 指向 `lib/database/cloud-bindings.ts`
5. `lib/session/sessions.ts`: `readAll/writeAll` → 改 import 指向 `lib/database/chat-sessions.ts`
6. `lib/content/video-ai-practice.ts`: 2 个 store 的 `readXxxStore/writeXxxStore` → 改 import

7. 跑全量 tsc + 跑 e2e (创建/下载/同步/取消/重启/删卡/重下)

### 阶段 C: 删旧 key

8. 用户下一次打开 app 7 天后 (或 schema 升级一个版本), 删:
   - `@cloud_drive_bindings_v1`
   - `chat_sessions`
   - `generated_video_ai_practice_v1`
   - `generated_video_ai_practice_generation_state_v1`
   - `video_user_meta_v1` (如果 P1.2 也迁了)
   - `ai_practice_user_meta_v1` (如果 P1.3 也迁了)
   - `web_cards` (evaluator.ts 里那个)
9. 删 `lib/content/cloud-drive-bindings.ts` 里所有 `readStore` / `writeStore` / AsyncStorage import

### 阶段 D (可选): P1 三个小 store

10. `video_user_meta` → 单表 (主键 `scene_id`)
11. `ai_practice_user_meta` → 单表 (主键 `topic_id`)
12. 跟 P0 一样流程: schema + 新文件 + 切换 import + 删旧 key

---

## 6. 关键文件清单 (10 个)

**新建 (3)**:
- `lib/database/cloud-bindings.ts` — 5 张表 CRUD
- `lib/database/chat-sessions.ts` — 2 张表 CRUD
- `lib/database/video-ai-practice.ts` — 2 张表 CRUD

**修改 (4)**:
- `lib/database/schema.ts` — 加 9 张 CREATE TABLE + `migrateToV3`
- `lib/database/index.ts` — 加 3 个新模块的 export
- `lib/content/cloud-drive-bindings.ts` — 替换内部 store 实现 (函数签名不变)
- `lib/content/video-ai-practice.ts` — 替换 2 个 store 实现 (函数签名不变)
- `lib/session/sessions.ts` — 替换 readAll/writeAll (函数签名不变)

**可选新建/修改 (P1)**:
- `lib/database/video-user-meta.ts` (新) / `lib/content/video-user-meta.ts` (改)
- `lib/database/ai-practice-user-meta.ts` (新) / `lib/ai/ai-practice-user-meta.ts` (改)

**删除 (阶段 C 后)**:
- `lib/session/evaluator.ts` 里的 `WEB_CARDS_KEY` / `web_cards` 引用

---

## 7. 验收标准

- [ ] `migrateToV3` 在干净环境 (无 AsyncStorage 数据) 不报错
- [ ] `migrateToV3` 在有旧数据环境: 5 个 store 全部正确搬到新表, AsyncStorage key 全部 remove
- [ ] 现有 e2e 全过: 百度授权 → 选 scene → 下载 → 同步状态 → 取消 → 重新下载
- [ ] 聊 5+ 个 sandbox session, 每次 appendTurn 延迟 < 5ms (之前 50ms+)
- [ ] 同时下 2 个 video, downloaded_scene_source 不互相覆盖
- [ ] review tab 翻卡走 video_ai_practice_state 时无延迟
- [ ] tsc --noEmit 0 错
- [ ] web 端 (mock 模式) 不崩, 所有调用走 noop

---

## 8. 风险 + 缓解

| 风险 | 缓解 |
|---|---|
| 迁移丢数据 | migrateToV3 失败时保留 AsyncStorage 兜底; 在控制台 log 旧 store 行数 vs 新表行数, 不匹配告警 |
| 旧 store JSON 解析失败 | 已被 sanitize 函数 cover; 解析失败返回空对象, 不阻塞迁移 |
| 双写期 (阶段 A) 数据不一致 | **不双写**, 直接切; AsyncStorage 仅在迁移完成前作 fallback |
| SQLite 写锁竞争 | 单库单连接, 应用场景下不构成瓶颈; 后续可加 WAL group commit (expo-sqlite 默认 WAL) |
| web 端用户丢 OAuth | web 端本就不是产品目标 (cards/fsrs 已经 native-only); 如果要兜, 在 `getDatabase` 处加 `if (Platform.OS === 'web')` 走 AsyncStorage, 但成本不值 |
| 改 schema 影响 fsrs 卡 | 不影响, `migrateToV3` 不动 `learning_cards` / `fsrs_reviews` |

---

## 9. 不在本次范围

- `evaluator.ts` 的 `EVALUATED_KEY` / `INJECTED_WORDS_KEY` / `BADGE_KEY` (单值/小数组, 留)
- `scenario-generator.ts` 的 `STAGED_KEY` / `STAGED_REF_KEY` (临时态, 留)
- `app-update.ts` 的 `ANDROID_UPDATE_SKIP_KEY` (单 number, 留)
- `user-profile.ts` 4 个 `user_*` key (仅 web fallback, native 已在 SQLite)
- `audio-storage.ts` / `video-cache.ts` / `clip-thumbnail.ts` (expo-file-system 大文件, 本来就是文件系统)
- 任何 native 模块改动 (不需要 prebuild)

---

## 10. 实施顺序 (单 PR 多 commit)

1. commit 1: `feat(db): schema v3 + 9 new tables + migrateToV3`
2. commit 2: `feat(db): cloud-bindings module (SQLite-backed)`
3. commit 3: `refactor: switch cloud-drive-bindings to db module (signature 0 change)`
4. commit 4: `feat(db): chat-sessions module`
5. commit 5: `refactor: switch sessions.ts to db module`
6. commit 6: `feat(db): video-ai-practice module + state table`
7. commit 7: `refactor: switch video-ai-practice.ts to db module`
8. commit 8: `chore: remove legacy AsyncStorage keys in schema v4`
9. (可选) commit 9-11: P1 三个 store 同样套路
10. (可选) commit 12: `chore: drop web_cards in evaluator.ts`

每个 commit 单独跑 tsc + e2e 关键路径。

---

## 11. 总工期估算

- 阶段 A (schema + 新模块) — 0.5 天
- 阶段 B (切换调用) — 0.5 天
- 阶段 C (删旧 key) — 0.1 天 (加一个 version guard)
- 阶段 D (P1 可选) — 0.5 天/个 × 3 = 1.5 天

P0 全部: **~1.1 天**. 含 P1 全部: **~2.5 天**.

---

## 12. 待用户确认

1. **范围**: 只做 P0, 还是 P0 + P1 全做?  → 我建议先 P0, 跑 1 周稳定再做 P1
2. **web 端**: 直接 native-only (cards/fsrs 同款), 还是给 web 加 AsyncStorage fallback?  → 我建议 native-only
3. **回退方案**: 要不要在 `migrateToV3` 里加 version 字段, 失败可回退?  → 我建议加 (`PRAGMA user_version`)
4. **顺序**: 先 `cloud-drive-bindings` (用户感知最强) 还是 `chat_sessions` (作者 TODO 标注)?  → 我建议先 `cloud-drive-bindings` (写放大最严重)

确认后我开始动阶段 A。

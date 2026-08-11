# NativeOS - 语言学习应用

**口号**：停止翻译，开始思考 (Stop Translating. Start Thinking.)

一款通过端侧 FTS 检索与 AI 认知矩阵彻底消除母语依赖的革命性语言学习应用。

## 🎯 核心理念

基于以下语言学理论：
- **Krashen i+1 理论**：精准个人语境数据库 + FTS5 检索
- **Saussure 结构主义**：易混淆词汇的二元对立分析
- **Vygotsky 内部语言**：每日内心独白推送通知

## 🏗️ 技术架构

### 数据库层（SQLite + FTS5）
- **不使用向量数据库**：严格使用 SQLite + FTS5 进行精确文本匹配
- **个人语境库**：存储用户已知语境，附带 FSRS 健康度追踪
- **全文检索**：Porter 词干提取 + Unicode 分词
- **自动同步**：触发器保持 FTS 索引实时更新

### FSRS 算法
- **依赖库**：ts-fsrs v5.2.3
- **评分系统**：4 档评分（Again / Hard / Good / Easy）
- **健康度指标**：稳定性 / 难度比 × 20
- **待复习队列**：根据复习表现自动调度

### AI 集成
- **服务商**：通义千问（Qwen）
- **11 种认知矩阵**：针对不同学习场景的卡片类型
- **意图路由器**：自动分类 5 种输入类型
- **JSON 模式**：结构化输出，保证解析可靠性

## 📦 快速上手（新开发者必读）

### 环境前置要求

| 工具 | 版本要求 | 说明 |
|------|---------|------|
| Node.js | 18+ | |
| JDK | **Temurin 17**（不能用 JDK 21） | 下载：https://adoptium.net |
| Android SDK | Platform-Tools | 包含 adb |
| MuMu 模拟器 | 任意 | 或其他支持 ADB 的模拟器/真机 |

> ⚠️ **必须使用 JDK 17**：JDK 21 在 Gradle 9.0 下存在 `JvmVendorSpec.IBM_SEMERU` 兼容性 bug，会导致编译失败。

---

### 第一步：准备 JDK 路径

安装 Temurin 17 后，有两种方式让脚本找到它：

```powershell
# 方式 A：设置系统环境变量（推荐，一次设置永久生效）
[System.Environment]::SetEnvironmentVariable("NATIVEOS_JDK", "D:\Java\jdk-17.0.17+10", "User")

# 方式 B：脚本参数临时指定
.\setup.ps1 -JavaHome "C:\Program Files\Eclipse Adoptium\jdk-17.0.x.x-hotspot"
```

默认路径为 `D:\Java\jdk-17.0.17+10`，如果你的安装路径与此一致则无需任何设置。

---

### 第二步：一键初始化（首次，只跑一次）

```powershell
# 在项目根目录执行
cd NativeOS
.\setup.ps1
```

脚本自动完成以下所有步骤：

```
[1/6] 检查 JDK 17
[2/6] 检查 ADB
[3/6] 检查本地依赖包 react-native-live2d
[4/6] 生成 .env.local 模板（如不存在）
[5/6] npm install（含自动修复 babel-preset-expo）
[6/6] 编译 Debug APK 并安装到 MuMu
```

**可选参数：**

```powershell
# 指定不同的 MuMu ADB 地址（默认 127.0.0.1:7555）
.\setup.ps1 -MuMuDevice "127.0.0.1:16384"

# 跳过编译（只装依赖，适合先填写配置再编译的情况）
.\setup.ps1 -SkipBuild

# 同时指定 JDK 路径和设备
.\setup.ps1 -JavaHome "D:\Java\jdk-17" -MuMuDevice "127.0.0.1:16384"
```

---

### 第三步：填写 API Key

`setup.ps1` 会在 `rn-app/.env.local` 生成模板，用编辑器打开填入真实值：

```bash
EXPO_PUBLIC_QWEN_API_KEY=sk-xxxxxxxx       # 通义千问，必填
ALIBABA_API_KEY=sk-xxxxxxxx                # 同上
EXPO_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

> 从团队共享文档获取这些值。`.env.local` 已在 `.gitignore` 中，不会提交到仓库。

---

### 第四步：日常开发启动

```powershell
.\dev-start.ps1
```

自动连接 MuMu → 检测/安装 APK → 启动 Metro bundler，之后在设备上按 `R` 热重载。

---

### 何时需要重新编译原生

以下情况需重新编译，运行 `.\rebuild-dev-android.ps1`：

- 新增/更新了含原生模块的 npm 包（如 `react-native-live2d`、`react-native-reanimated`）
- 修改了 `android/` 目录下的任何文件
- 拉取他人代码后 `package.json` 的原生依赖有变更

```powershell
# 重新编译并安装
.\rebuild-dev-android.ps1

# 全量清理重建（遇到诡异编译错误时）
.\rebuild-dev-android.ps1 -Clean
```

---

### 脚本一览

| 脚本 | 用途 | 运行时机 |
|------|------|---------|
| `setup.ps1` | 首次初始化 | clone 后只跑一次 |
| `dev-start.ps1` | 日常启动开发环境 | 每次开发 |
| `rebuild-dev-android.ps1` | 重新编译原生 APK | 原生依赖变更后 |

## 📁 项目结构

```
rn-app/
├── app/                          # Expo Router 页面
│   ├── (onboarding)/            # 引导流程
│   │   ├── welcome.tsx
│   │   └── level-test.tsx       # 仿 Tinder 滑动测试
│   ├── (tabs)/                  # 主界面标签页
│   │   ├── feed.tsx             # 动态场景探索流
│   │   ├── review.tsx           # 词库与聚类
│   │   └── profile.tsx
│   ├── dojo/[id].tsx            # 渐进式复习界面
│   └── _layout.tsx              # 根布局（含数据库初始化）
├── components/
│   ├── LearningCard.tsx
│   ├── OmniCaptureSheet.tsx     # 输入捕获（含终端动画）
│   └── ScenarioTile.tsx
├── lib/
│   ├── database/                # SQLite + FTS5 数据层
│   │   ├── schema.ts            # 数据库结构与初始化
│   │   ├── contexts.ts          # 语境 CRUD + FTS 检索
│   │   ├── cards.ts             # 卡片管理
│   │   ├── fsrs.ts              # FSRS 调度
│   │   ├── clusters.ts          # 聚类管理
│   │   ├── seed.ts              # 初始数据
│   │   └── index.ts
│   ├── ai/
│   │   ├── intent-router.ts     # 输入分类（5 种类型）
│   │   └── prompts/             # 认知矩阵提示词
│   │       ├── scene01-etymology.ts
│   │       ├── scene02-context-fill.ts
│   │       ├── scene03-collocation.ts
│   │       ├── scene04-contrast.ts
│   │       └── scene05-visual.ts
│   ├── hooks/
│   │   └── useScenarios.ts
│   ├── ai.ts                    # AI API 客户端
│   ├── fsrs.ts                  # FSRS 封装
│   └── tts.ts                   # TTS 引擎
├── stores/
│   └── userStore.ts             # Zustand 状态管理
├── types/
│   └── index.ts                 # TypeScript 类型定义
└── constants/
    └── theme.ts                 # 设计 token
```

## 🎨 UI 界面（6 个核心界面）

### 1. 引导滑动（破冰测试流）
- 仿 Tinder 卡片滑动交互
- 右滑 = 已知 → 存入个人语境库
- 左滑 = 未知 → 跳过
- 1 分钟内完成个人语境库初始化

### 2. 动态场景流（动态场景探索流）
- 仿 Apple News 瀑布流布局
- 基于 FTS 推演的个性化场景
- 按等级筛选（A1-C2）
- 分类图标：💻☕📰🎮📧✈️

### 3. 复习道场（极简母语道场）
- 渐进式提示系统（3 级）：
  1. 英文同义词 + TTS
  2. 触觉反馈警告 + 中文（最后手段）
  3. 直接显示答案
- FSRS 评分按钮
- 全屏沉浸式体验

### 4. 词库与聚类（认知图谱）
- 主题分组
- FSRS 健康度指示（🟢 92%）
- 待复习卡片数量
- 搜索功能

### 5. 随手捕获（随身捕获器）
- 浮动 + 按钮
- 终端风格处理动画
- 意图路由可视化
- 即时生成卡片

### 6. 点火模式（零基础点火）
- 适合词汇量 < 500 的学习者
- SVG 动画 + TTS 循环
- 积木式短语拼装
- 全程禁止中文

## 🧠 11 种认知矩阵

1. **深度理解**（词根词缀拆解）：词源拆解
2. **语境填空**（语境填空）：原句完形填空
3. **词块搭配**（词块搭配）：多词组合练习
4. **二元对立**（二元对立）：易混淆词对比
5. **视觉 SVG**（具象视觉）：具体名词可视化
6. **俚语隐喻**（俚语隐喻）：文化语境解读
7. **语法骨架**（语法骨架）：句型结构练习
8. **跨学科折叠**（跨学科折叠）：熟词生义
9. **语音重音**（语音重音）：重音模式练习
10. **语体转换**（语体转换）：正式 vs 非正式
11. **母语逆向**（母语逆向）：中文 → 英文

## 🔍 意图路由器（5 种输入类型）

| 类型 | 示例 | 触发场景 |
|------|------|---------|
| 孤立单词 | `obsolete` | 场景 1、3、5 |
| 语境片段 | `ReferenceError: throttle is not defined` | 场景 2 |
| 对比查询 | `amend vs modify` | 场景 4 |
| 母语逆向 | `怎么说"画大饼"` | 场景 11、6 |
| 批量请求 | `给我10个商务词汇` | 场景 8、10 |

## 📊 数据库结构

```sql
-- 个人语境库（含 FTS5）
CREATE TABLE user_contexts (
  id INTEGER PRIMARY KEY,
  sentence TEXT NOT NULL,
  source TEXT NOT NULL,
  level TEXT,
  created_at INTEGER,
  fsrs_health REAL DEFAULT 100.0
);

CREATE VIRTUAL TABLE user_contexts_fts USING fts5(
  sentence,
  content='user_contexts',
  tokenize='porter unicode61'
);


-- 学习卡片（11 种类型）
CREATE TABLE learning_cards (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  target_word TEXT,
  context TEXT,
  explanation TEXT,
  visual_svg TEXT,
  audio_url TEXT,
  created_at INTEGER,
  cluster_id INTEGER
);

-- FSRS scheduling
-- FSRS 复习调度
CREATE TABLE fsrs_reviews (
  card_id TEXT PRIMARY KEY,
  difficulty REAL DEFAULT 5.0,
  stability REAL DEFAULT 1.0,
  elapsed_days INTEGER,
  scheduled_days INTEGER,
  reps INTEGER,
  lapses INTEGER,
  state INTEGER,
  last_review INTEGER,
  due INTEGER
);
```

## 🎯 Key Features

### ✅ Implemented
- SQLite + FTS5 database with automatic indexing
- Complete FSRS algorithm integration
- Intent router for 5 input types
- AI card generation (5 cognitive matrices)
- Onboarding level test with context saving
- Omni capture with terminal animation
- Database seeding with 6 default clusters

### 🚧 In Progress
- Remaining 6 cognitive matrix prompts
- TTS API integration with emotion control
- Feed screen with real database
- Dojo progressive review interface

### 📋 Planned
- 3D cognitive star map
- Push notifications for inner monologue
- Cloud sync with Supabase
- Offline-first architecture
- Export/import functionality

## 🧪 Testing

```bash
# Run tests (when implemented)
npm test

# Type checking
npx tsc --noEmit

# Linting
npx eslint .
```

## 📖 API Usage

### Create a Card

```typescript
import { createCard, initializeCardReview } from './lib/database';

const cardId = `card_${Date.now()}`;
await createCard({
  id: cardId,
  type: 'context-fill',
  targetWord: 'throttle',
  context: 'ReferenceError: ________ is not defined',
});

await initializeCardReview(cardId);
```

### Search Contexts (FTS5)

```typescript
import { searchContextsFTS } from './lib/database';

const contexts = await searchContextsFTS(
  'error function',  // FTS query
  80,                // min health
  50                 // limit
);
```

### Schedule Review

```typescript
import { scheduleReview } from './lib/database';
import { Rating } from 'ts-fsrs';

await scheduleReview(cardId, Rating.Good);
```

### Generate AI Card

```typescript
import { generateCard } from './lib/ai';

const card = await generateCard({
  targetWord: 'obsolete',
  context: 'This API is obsolete.',
  cardType: 'deep-understanding',
  userLevel: 'B1',
});
```

## 🎨 Design Principles

1. **No Empty Canvas**: Always show personalized content
2. **Chinese as Last Resort**: Hidden behind 2 clicks + haptic warning
3. **Precise Memory**: FTS5 exact matching, no fuzzy vectors
4. **i+1 Theory**: Always one step beyond current level
5. **Native Feel**: Dark mode, smooth animations, haptic feedback

## 📱 Platform Support

- ✅ iOS (React Native)
- ✅ Android (React Native)
- ✅ Web (React Native Web)

## 🤝 Contributing

This is a private project. For questions, contact the development team.

## 📄 License

Proprietary - All rights reserved

## 🔗 Related Documents

- [Product Requirements (PRD)](../docs/NativeOS_产品需求文档_PRD.md)
- [Development Plan](../plans/nativeos-development-plan-acf1f2.md)
- [Implementation Progress](./IMPLEMENTATION_PROGRESS.md)

## 🎓 Linguistic Theory References

- Krashen, S. (1982). *Principles and Practice in Second Language Acquisition*
- Saussure, F. (1916). *Course in General Linguistics*
- Vygotsky, L. (1934). *Thought and Language*
- Laufer, B. & Hulstijn, J. (2001). *Incidental Vocabulary Acquisition*

---

**Version**: 1.0.0-alpha  
**Last Updated**: 2026-03-12  
**Status**: Week 1 Implementation Complete (~60%)

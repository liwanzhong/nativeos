# NativeOS — 功能与特性文档

> 基于源代码深度分析编写，仅描述代码中实际存在的功能。
> 最后更新：2026-03-26

---

## 目录

1. [应用概述](#1-应用概述)
2. [技术栈](#2-技术栈)
3. [用户引导 Onboarding](#3-用户引导-onboarding)
4. [探索页 Feed](#4-探索页-feed)
5. [对话沙箱 Standard Mode](#5-对话沙箱-standard-mode)
6. [沉浸式沙箱 Immersive Mode](#6-沉浸式沙箱-immersive-mode)
7. [词卡库 Library](#7-词卡库-library)
8. [Dojo 复习系统](#8-dojo-复习系统)
9. [OmniCapture 万能捕获](#9-omnicapture-万能捕获)
10. [个人档案 Profile](#10-个人档案-profile)
11. [AI 核心模块](#11-ai-核心模块)
12. [语音技术](#12-语音技术)
13. [FSRS 间隔重复系统](#13-fsrs-间隔重复系统)
14. [推送通知](#14-推送通知)
15. [数据存储](#15-数据存储)

---

## 1. 应用概述

NativeOS 是一款面向中文母语者的沉浸式英语口语练习应用。核心路径：

```
选择场景 → 与 AI NPC 对话 → 口语评分自动生成词卡 → FSRS 定期复习词卡
```

---

## 2. 技术栈

| 层级 | 技术 |
|------|------|
| 框架 | React Native 0.83 + Expo 55 + Expo Router |
| 语言 | TypeScript 5.9 |
| 本地数据库 | expo-sqlite（Native）/ AsyncStorage（Web） |
| AI 对话 | 阿里云 Qwen qwen-plus |
| TTS | 火山引擎 (ByteDance) TTS REST API |
| ASR | 火山引擎 Streaming ASR WebSocket V3 协议 |
| FSRS 算法 | ts-fsrs 库 |
| Live2D 角色 | react-native-live2d（Android / Web 双实现） |
| 手势 | react-native-gesture-handler（Swipeable 滑动删除） |
| 状态管理 | React useState + useRef + Zustand |

---

## 3. 用户引导 Onboarding

### 3.1 欢迎页 `app/(onboarding)/welcome.tsx`

用户首次进入时选择英语等级：

- 展示 6 个 CEFR 等级（A1 / A2 / B1 / B2 / C1 / C2）
- 每个等级显示：等级名称、词汇量估算、现实锚点（如"高考及格 / 雅思 4.0-5.0"）、一句自我诊断描述
- 选择后写入 `AsyncStorage('user_level')`，跳转到兴趣选择页

### 3.2 兴趣选择页 `app/(onboarding)/level-test.tsx`

- 按已选 CEFR 等级展示对应话题域（`DOMAINS_BY_LEVEL`）
- 每个等级 12–18 个话题域，A1 示例：打招呼、问路、点餐、乘车、酒店入住、药店购药等；B1 示例：职场沟通、会议讨论、机场问题、就医问诊、投诉维权等
- 最多可选 3 个兴趣
- 选择结果以标签数组写入 `AsyncStorage('user_interests')`

---

## 4. 探索页 Feed

**文件**: `app/(tabs)/feed.tsx`

### 4.1 每日场景列表

- 进入 Feed 页时检测等级和兴趣是否变化，变化则触发 AI 重新生成
- 调用 `generateDailyScenariosStream` 流式生成 **8 张场景卡片**，逐卡渲染
- 场景卡片字段：等级徽章（带颜色）、分类、标题、英文任务描述、NPC 图标
- 结果以 `daily_scenarios__<level>__<interestsHash>` 为键缓存于 AsyncStorage
- 缓存命中时直接展示，不调用 AI；读取缓存时自动修复字段一致性

### 4.2 换一批按钮

- 右上角洗牌按钮，触发内联确认提示栏
- 确认后清除缓存，排除已显示标题，重新流式生成 8 张新卡
- 生成中按钮位置替换为 ActivityIndicator

### 4.3 定制场景弹窗

- 右上角 Sparkles 按钮打开底部弹窗（固定高度防抖动）
- 输入框供用户用中文描述具体情境
- 生成流程（流式，逐卡追加）：
  - 顶部持续显示加载条，文字随进度动态变化
  - 0 张时："AI 正在为「xxx」定制场景..."
  - N 张后："已生成 N 个，继续生成中..."
  - 全部完成后加载条消失
- 输入长度超过 10 字时触发专用 prompt（`buildCustomQueryPrompt`），所有生成场景均围绕该具体情境
- 生成的卡片右侧可点 `+` 保存到"我的场景"
- 提供"重新输入"按钮返回输入态

### 4.4 场景排序

主列表自动排序规则（优先级从高到低）：
1. 有对话记录的场景，按最近对话时间降序排在最前
2. 自定义保存的场景（标记 `✨ 我的`）
3. 当日 AI 生成的每日场景

### 4.5 手势与交互

- 场景卡片左滑出现红色"删除"按钮（Swipeable）
- 有对话记录的场景删除前弹出 Alert 确认
- 已有对话记录的场景卡片显示 `💬 有记录` 徽章
- 下拉刷新：重新加载自定义场景 + 对话历史 + 已屏蔽 ID

---

## 5. 对话沙箱 Standard Mode

**文件**: `app/scenario/[id].tsx`

### 5.1 开场模式（两轨）

由 AI 生成场景时决定，客户端按 `userInitiates` 字段渲染：
- **NPC 先开口**（`userInitiates=false`）：展示 NPC 英文开场白（`openingLine`）气泡
- **用户先开口**（`userInitiates=true`）：展示环境旁白（`environmentalCueEn` 或 `environmentalCue`）system 气泡，等待用户发言

### 5.2 语音输入

**平台差异（重要）**：
- **Web 端**：使用火山引擎 Streaming ASR（WebSocket V3）；点击麦克风开始，再次点击停止；实时显示 `liveTranscript`
- **Native 端**：`recognizeSpeech()` 当前为 stub（返回 `null`，原因：`native_stt_pending`），自动降级为键盘输入；ASR SDK 尚未集成

降级后：
- 显示"网络信号弱，已切换为键盘输入"提示
- 弹出文字输入框，用户手动打字发送

### 5.3 NPC 对话回复

- 调用 Qwen API，一次 API 请求同时返回：英文回复 + 中文翻译
- NPC 消息气泡点击可展开中文翻译
- 每条 NPC 回复自动触发 TTS 朗读（火山引擎）
- NPC 挑战难度三档（对话内切换）：
  - B1 宽容模式：配合用户，减少障碍
  - B2 标准模式（默认）：场景合理摩擦，推进练习
  - C1 地狱模式：频繁追问，只有清晰表达才推进

### 5.4 单词点击查询

- 点击消息中任意单词弹出查询面板
- 显示：词义、中文翻译
- 面板内 `+` 按钮将该词保存为 FSRS 词卡（调用 `word-card-generator`）

### 5.5 口语评分（异步，不阻断交互）

评分在用户发言后后台进行，完成后附加到对应消息气泡：
- **粗粒度**：该句话在当前场景是否合适（场景适配性检查）
  - 不合适 → 直接生成 FSRS 卡片（原话 vs 母语者建议说法）
- **细粒度**（粗粒度通过时）：grammar / vocabulary / register / collocation 四类问题逐条列出，有问题则生成 FSRS 卡片
- 评分结果展示在消息气泡内：红色删除线（原话）+ 绿色高亮（建议说法）+ 解释文字

### 5.6 提示系统

- 灯泡按钮调用 `generateHints`，AI 返回 3 条针对当前场景上下文的提示
- 提示以底部面板形式展示

### 5.7 会话记录

- 进入时调用 `enterSandbox` 创建会话记录
- 每轮对话调用 `recordTurn` 保存
- 退出时调用 `exitSandbox`，触发后台 session evaluator（异步）
- 对话历史保存于 `npc_messages__<scenarioId>`（800ms防抖自动保存），重进场景可恢复
- 最后对话时间保存于 `npc_chat_time__<scenarioId>`（Feed 页用于排序和显示"有记录"徽章）

---

## 6. 沉浸式沙箱 Immersive Mode

**文件**: `app/scenario/immersive/[id].tsx`

在标准沙箱所有功能的基础上增加：

### 6.1 Live2D 动画角色

- 画面上半部分渲染 Live2D 角色（默认 Senko 角色）
- 特定场景可指定专属角色模型（`modelUrl` 字段）
- TTS 播放期间实时口型同步：从 TTS 音频数据提取 RMS 帧级音量包络（60fps，16ms/帧），驱动角色嘴部动画

### 6.2 平台实现

- Android：`Live2DAvatar.android.tsx`，使用 `react-native-live2d` 原生组件
- Web：`Live2DAvatar.web.tsx`，通过 WebView 渲染
- 默认（iOS）：`Live2DAvatar.tsx`，fallback 展示静态 Emoji

### 6.3 NPC 信息栏

顶部固定展示：
- NPC 姓名 + 所属场景分类（如 `DAVID (交通)`）
- 英文任务描述 + 中/英切换按钮
- 语言切换控制对话中中文翻译的显示语言

### 6.4 NPC 难度设置

右上角 Settings 按钮打开侧边面板，选择 B1 / B2 / C1 难度后立即生效（影响下一条 NPC 回复）

### 6.5 消息保存词卡

消息气泡右侧 `+` 按钮触发选词流程，确认后调用 `word-card-generator` 生成 4 模板词卡

---

## 7. 词卡库 Library

**文件**: `app/(tabs)/review.tsx`

### 7.0 词卡模板体系说明

FSRS 词卡共 **6 种来源模板**，分两类生成：

**A. 手动点词生成（4种）** — 沙箱对话中点击生词，AI 自动选择最合适的模板：

| 模板 | 适用词汇类型 | 正面形式 |
|------|------------|---------|
| **选择题** | 易混淆近义词（如 amend vs modify） | 含空白的句子 + 2个选项 |
| **填空题** | 固定搭配/词块（如 sheer volume） | 含 `________` 的句子，附提示 |
| **解释题** | 具象名词/常见动词（如 stethoscope） | 纯英文定义描述（无中文） |
| **翻译题** | 俚语/职场黑话（如 pass the buck） | 中文场景描述 |

卡片背面：✅ 正确答案 + 💬 沙箱原句重现（高亮目标词）+ 解析说明

**B. 口语评分自动生成（2种）** — 每次用户发言后 AI 异步评分，有问题时自动入库：

| 模板 | 触发条件 | 正面形式 |
|------|---------|---------|
| **语体转换卡** | 说错场景/语体不当 | Low EQ 原话 vs High EQ 建议（红绿分屏） |
| **语境纠错卡** | 语法/词汇错误 | 场景 + 原话 + "哪里有问题？" |

### 7.1 统计栏

页面顶部三项：
- 🔥 今日到期复习数（FSRS due cards）
- 📖 今日新增词卡数
- 📊 词卡总数

### 7.2 场景卡组 Deck 视图

- 词卡按来源场景自动分组（`source_scene` 字段）
- 每个卡组显示：图标、场景标题、总卡数、到期数
- 卡组按到期数降序排序
- 点击卡组进入该场景 Dojo 复习队列

### 7.3 词卡列表

- 卡片按 FSRS 到期时间升序排列（最近到期排前）
- 新卡（无复习记录）排在已复习卡后面
- 每张卡显示：目标词、来源场景、下次复习时间（今天 / 明天 / MM/DD）
- 点击展开：显示认知矩阵类型标签（带颜色编码）、完整卡片内容
- 展开状态下可：TTS 朗读、单独进入 Dojo、删除

### 7.4 认知矩阵与 UI 模板（review.tsx 内嵌 Dojo）

**重要说明**：11种认知矩阵 UI 模板在 `review.tsx` 的内嵌 Dojo Modal（`renderChallengeFront`）中**已全部实现**，但在独立的 `dojo/[id].tsx` 页面中**未使用**（那里只用4种生成模板）。两套 Dojo 是并列存在的独立实现。

`review.tsx` 内嵌 Dojo 通过 `resolveUiTemplate(card)` 决定渲染分支：

| UI 模板 | 触发矩阵 | 渲染形式 |
|---------|---------|---------|
| `reverse_translation` | M11 逆向 | 中文触发词 + 3秒倒计时进度条 |
| `register_shift` | M10 语体 | Low EQ 原话（红色）vs High EQ 建议（绿色）分屏 |
| `phonetic_audio` | M9 发音 | 音频播放按钮 + 选项列表，无直接文字 |
| `binary_choice` | M4 辨析 | 警告框 + 两个互斥选项按钮 |
| `syntax_ordering` | M7 语法 | 填空句 + 乱序词块 pill 列表 |
| `domain_cloze` | M8 跨域 | 领域标签徽章 + 填空句 |
| `visual_flash` | M5 视觉 | Emoji 大图 + TTS 按钮 + 填空句 |
| `slang_metaphor` | M6 俚语 | iMessage 气泡样式填空 |
| `chunk_cloze` | M3 词块 | 标准填空（蓝色下划线） |
| `concept_breakdown` | M1 词根 | "底层拼装线索"标签 + 填空句 |
| `cloze`（默认） | M2/其他 | 灰色下划线标准填空 |

---

## 8. Dojo 复习系统

**文件**: `app/dojo/[id].tsx`

### 8.1 复习流程（每张卡）

| 步骤 | 内容 |
|------|------|
| Step 0 | 展示问题，自动 TTS 朗读目标词 |
| Step 1 | 可选展开 hint（填空提示） |
| Step 2 | 可选查看中文翻译（背景变红 + 震动警告，FSRS 扣分标记） |
| Step 3 | 展示完整答案 + FSRS 四档评分按钮 |

### 8.2 FSRS 评分按钮

- **Again** / **Hard** / **Good** / **Easy**
- 若 Step 2 已查看中文，则 Easy 按钮被禁用/降级

### 8.3 dojo/[id].tsx 渲染的卡片模板

`app/dojo/[id].tsx`（从词卡库卡组进入的独立页面）只处理4种模板 + legacy fallback：

| 模板 | `type` 值 | 渲染逻辑 |
|------|----------|----------|
| **选择题** | `选择题` | 句子 + 选项按钮；选对绿色闪，选错红色闪后可再选 |
| **填空题** | `填空题` | 句子含 `________`，可显示 hint；揭示时高亮目标词 |
| **解释题** | `解释题` | 纯英文定义描述（无中文），点击揭示目标词 |
| **翻译题** | `翻译题` | 中文语境描述，点击揭示最地道英文说法 |
| **Legacy Cloze** | 其他/默认 | 旧格式填空，兼容旧版口语评分卡 |

> 11种认知矩阵 UI 模板（`reverse_translation`、`register_shift` 等）由 `review.tsx` 内嵌 Dojo Modal 处理（见第7.4节），`dojo/[id].tsx` 不使用这些模板。

### 8.4 发音类卡片语音跟读

- M9 发音卡：按住麦克风跟读目标词
- ASR 识别后与目标词比对，给出评分反馈

### 8.5 队列管理

- 支持全局队列（所有到期卡）和场景过滤队列
- 完成全部卡片后展示当日完成统计

---

## 9. OmniCapture 万能捕获

**文件**: `components/OmniCaptureSheet.tsx`

一个底部弹窗组件，用于快速将任意词汇/短语/句子转化为 FSRS 词卡：

### 流程

1. 用户输入任意文本（英文词、短语、句子，或含中文的逆向映射需求）
2. 终端风格日志动画展示处理过程（"> 拦截原始语料... > 语义分析中... > AI 智能矩阵选择中..."）
3. 单次 AI 调用（`generateSmartCards`）：Qwen 自动判断输入类型，选择最合适的 1–3 个认知矩阵，同时生成对应卡片
4. 预览生成的卡片（可能是 1–3 张互补卡片）
5. 确认后批量保存到词卡库

---

## 10. 个人档案 Profile

**文件**: `app/(tabs)/profile.tsx`

### 10.1 用户信息卡

显示内容：
- CEFR 等级徽章 + 等级名称（如"中级 · 中阶瓶颈期"）
- 当前词汇量范围参考
- 当前兴趣标签列表
- 词卡库总卡数

### 10.2 等级 + 兴趣联动修改

单一入口"英语水平 + 我的兴趣"，打开两步弹窗：
- **Step 1**：在 6 个 CEFR 等级中选择新等级
- **Step 2**：展示该等级对应话题域，选择新兴趣（最多 3 个，`MAX_INTERESTS = 3`）
- 确认后更新 AsyncStorage，下次打开 Feed 时自动重新生成场景

### 10.3 TTS 语音设置弹窗

- **音色选择**（共 6 个）：
  - Sarah · 活力女声（默认，美式）
  - Anna · 亲切女声（美式）
  - Adam · 磁性男声（美式）
  - Tim · 情感男声（ASMR）
  - Dacey · 情感女声（ASMR）
  - Stokie · 温柔女声（ASMR）
- **试听**：点击播放示例句，验证音色效果

---

## 11. AI 核心模块

### 11.1 场景生成器 `lib/ai/scenario-generator.ts`

**两种 prompt 模式**（运行时自动选择）：

**a. 普通话题场景** `buildScenarioPrompt`：
- 根据用户等级 + 兴趣标签生成场景列表
- 双轨发起引擎：按等级比例分配 npc_first（openingLine）和 user_first（environmentalCue）场景
- A1/A2 用户：35% user_first；B1/B2：65%；C1/C2：80%

**b. 自定义查询场景** `buildCustomQueryPrompt`（输入 > 10 字时触发）：
- 所有生成的场景必须围绕用户描述的具体情境，从不同角度/NPC/阶段切入
- 不允许生成与描述无关的场景

**字段一致性保障**（`mapRawToCard`）：
- Track A 场景（`userInitiates=false`）强制清空 environmentalCue
- Track B 场景（`userInitiates=true`）强制清空 openingLine
- Emoji 安全过滤（`safeEmoji`）：检测 ZWJ 序列和肤色修饰符，降级为基础码点或从 80 个安全 emoji 池随机取一个

### 11.2 NPC 对话 `lib/ai/npc-chat.ts`

- 使用 Qwen qwen-plus 自由文本 chat completions（非 JSON 模式）
- System prompt 包含：NPC 角色设定、场景背景、难度阻力层、FSRS 不可见注入词汇
- 同一 API 请求同时返回英文回复 + 中文翻译（通过 prompt 指令实现）
- 支持 `generateHints`：生成 3 条场景上下文提示
- 支持 `lookupWord`：单词词义查询
- 支持 `translateText`：文本翻译

### 11.3 口语评分 `lib/ai/speech-evaluator.ts`

- 评分分两个粒度（先粗后细）：
  - 粗粒度：场景适配性（这句话在此场景合理吗？）
  - 细粒度：grammar / vocabulary / register / collocation 四类问题
- 粗粒度不通过时跳过细粒度，直接生成 register-shift / reverse-mapping 类 FSRS 卡片
- 评分结果通过 `saveEvaluationCard` 写入词卡库

### 11.4 智能矩阵 `lib/ai/smart-matrix.ts`

- 单次 AI 调用判断输入属于 11 种矩阵中的哪 1–3 种，并立即生成对应卡片
- 输出字段：`matrixType`（矩阵名）、`targetWord`（核心词）、`front`（卡正面）、`back`（卡背面）、`explanation`（解析）

### 11.5 词卡生成器 `lib/ai/word-card-generator.ts`

从沙箱对话中点词保存时调用，遵循 SuperMemo 最小信息原则：

4 种模板（AI 根据词的语言学特征自动选择）：
- **选择题**：易混淆近义词（amend vs modify）
- **填空题**：固定搭配/词块（sheer volume）
- **解释题**：具象名词/常见动词（stethoscope）
- **翻译题**：俚语/职场黑话/中文文化映射（pass the buck）

### 11.6 FSRS 不可见注入 `lib/fsrs/invisible-injector.ts`

将用户当日到期词汇无感注入到 NPC system prompt，让用户在对话中自然接触到应复习的词：

- 每日一次拉取到期词卡（最多 8 个）
- 按场景主题过滤（AI 判断哪些词在当前场景语义匹配），每场景最多注入 3 词
- 注入格式：`【强制指令】在本次对话中，请自然地将以下词汇融入对话...`
- 不匹配的词保留在 Dojo 队列
- 结果缓存（按日期 + 场景标题 key），避免重复 AI 调用

### 11.7 Intent Router `lib/ai/intent-router.ts`

AI 路由模块，用于场景内意图判断（如 FSRS 词汇场景匹配过滤）

---

## 12. 语音技术

### 12.1 火山引擎 TTS `lib/volcengine/tts.ts`

- **Native 路径**：直接调用 `https://openspeech.bytedance.com/api/v1/tts` REST API
- **Web 路径**：通过本地代理 `volc-proxy/server.js` 转发（代理加签名头）
- 返回 base64 MP3，Native 端写入 expo-file-system 缓存目录后播放
- Web 端通过 Web Audio API 解码，构建 RMS 帧级音量包络（60fps），驱动 Live2D 口型
- 支持全局停止（`stopCurrentTTS`）
- 音色通过 Profile 配置持久化

### 12.2 火山引擎 ASR `lib/volcengine/asr.ts`

- **协议**：WebSocket V3 Binary，URL `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel`
- **音频格式**：raw PCM，16kHz，16-bit，单声道，分块流式发送
- **Native 录音**：expo-av 录制，读取为 base64，直接发送到火山引擎（无代理）
- **Web 录音**：通过本地代理转发
- 支持实时中间结果（`liveTranscript`）和最终结果回调
- Android 需要 RECORD_AUDIO 权限

### 12.3 TTS 情绪选择器 `lib/tts-emotion-selector.ts`

根据文本内容和场景自动选择情绪类型（neutral / excited / professional / casual / urgent）和语体（formal / casual / technical）

---

## 13. FSRS 间隔重复系统

**数据库模块**: `lib/database/`，算法库: `ts-fsrs`

### 13.1 词卡数据结构 `lib/database/schema.ts`

每张词卡包含：
- 核心内容：`targetWord`、`context`（填空句）、`front`、`back`、`correct`
- 4 模板专属字段：`options`（选择题）、`hint`（填空题）、`back_front`（预生成答案面）
- 元信息：`source_scene`（来源场景）、`matrixType`（认知矩阵）、`savedAt`（保存时间）
- FSRS 状态字段（由 `ts-fsrs` 管理）：stability、difficulty、due 等

### 13.2 评分规则

- 查看过中文翻译：评分自动降级（扣分）
- Again：卡片重置，当天再次出现
- Hard/Good/Easy：按 FSRS 算法计算下次间隔

### 13.3 Native vs Web 差异

- **Native**：使用 expo-sqlite 存储（`lib/database/cards.ts`、`clusters.ts`、`contexts.ts`）
- **Web**：使用 AsyncStorage，卡片存 `web_cards`，FSRS 状态存 `web_fsrs_reviews`

---

## 14. 推送通知

**文件**: `lib/notifications.ts`

- 使用 expo-notifications
- Android 专属通知频道：`inner-monologue`（高优先级 + 震动模式）
- 仅在物理设备上生效（模拟器不支持）
- 当前用于 Inner Monologue 系统的练习提醒

### Inner Monologue `app/inner-monologue.tsx`

- 接收一个英文提示 prompt + 预期字数（通过路由参数传入）
- 用户用英文作答，实时统计单词数
- 检测中文字符输入，触发震动警告
- 最少 10 个词才允许提交

---

## 15. 数据存储

### 15.1 AsyncStorage 键列表

| 键 | 内容 |
|----|------|
| `user_level` | CEFR 等级字符串（A1-C2） |
| `user_interests` | 兴趣标签 JSON 数组 |
| `onboarding_completed` | `'true'` 字符串，标记引导流程已完成 |
| `tts_config` | TTS 音色和语速配置 JSON |
| `practice_mode` | 固定写入 `immersive`（废弃分支，profile.tsx 启动时设置） |
| `daily_scenarios__<level>__<hash>` | 当日 AI 生成场景卡片 JSON 数组 |
| `user_custom_scenarios` | 用户保存的自定义场景 JSON 数组 |
| `npc_messages__<scenarioId>` | 场景对话历史消息 JSON 数组（800ms 防抖自动保存） |
| `npc_chat_time__<scenarioId>` | 该场景最后对话时间戳（Feed 排序 + 有记录徽章用） |
| `dismissed_scenarios` | 已屏蔽场景 ID 集合 JSON |
| `fsrs_inject_cache` | 当日 FSRS 注入词缓存（含日期） |
| `fsrs_scene_match_cache` | 场景级词汇匹配缓存（按日期+场景 key） |
| `web_cards` | Web 端词卡 JSON 数组（Native 端也读这个表） |
| `web_fsrs_reviews` | Web/Native 端 FSRS 复习状态 JSON 对象 |

### 15.2 SQLite 表（Native）

- `cards`：词卡主表
- `clusters`：场景卡组聚合
- `contexts`：对话上下文存储

### 15.3 Supabase（可选）

`lib/supabase.ts` 中配置了 Supabase 客户端，用于云端用户档案同步（`lib/user-profile.ts`）。本地运行无需配置，所有核心功能走本地存储。

---

*文档结束*

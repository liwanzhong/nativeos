# NativeOS - Language Learning App

**Slogan**: 停止翻译，开始思考 (Stop Translating. Start Thinking.)

A revolutionary language learning app that eliminates mother tongue dependency through端侧 FTS retrieval and AI-powered cognitive matrices.

## 🎯 Core Philosophy

Based on linguistic theories from:
- **Krashen's i+1 Theory**: Precise personal context database with FTS5 search
- **Saussure's Structuralism**: Binary opposition analysis for confusable words
- **Vygotsky's Inner Speech**: Daily inner monologue push notifications

## 🏗️ Architecture

### Database Layer (SQLite + FTS5)
- **No Vector Database**: Strictly using SQLite with FTS5 for precise text matching
- **Personal Context DB**: User's known contexts with FSRS health tracking
- **Full-Text Search**: Porter stemming + Unicode tokenization
- **Automatic Sync**: Triggers keep FTS index updated

### FSRS Algorithm
- **Library**: ts-fsrs v5.2.3
- **Scheduling**: 4 ratings (Again/Hard/Good/Easy)
- **Health Metric**: stability/difficulty ratio × 20
- **Due Queue**: Automatic scheduling based on review performance

### AI Integration
- **Provider**: OpenAI GPT-4o-mini
- **11 Cognitive Matrices**: Different card types for different learning scenarios
- **Intent Router**: Automatic classification of 5 input types
- **JSON Mode**: Structured outputs for reliable parsing

## 📦 Installation

```bash
cd rn-app
npm install
```

## 🔑 Configuration

Create `.env` file:

```bash
# AI API (Required for card generation)
EXPO_PUBLIC_AI_API_KEY=sk-...

# TTS API (Optional)
EXPO_PUBLIC_TTS_API_KEY=...

# Supabase (Optional - for cloud sync)
EXPO_PUBLIC_SUPABASE_URL=...
EXPO_PUBLIC_SUPABASE_ANON_KEY=...
```

## 🚀 Running

```bash
# Start development server
npm start

# Run on specific platform
npm run ios
npm run android
npm run web
```

## 📁 Project Structure

```
rn-app/
├── app/                          # Expo Router pages
│   ├── (onboarding)/            # Onboarding flow
│   │   ├── welcome.tsx
│   │   └── level-test.tsx       # Tinder-style swipe test
│   ├── (tabs)/                  # Main app tabs
│   │   ├── feed.tsx             # Dynamic scenario feed
│   │   ├── review.tsx           # Library & clusters
│   │   └── profile.tsx
│   ├── dojo/[id].tsx            # Progressive review interface
│   └── _layout.tsx              # Root layout with DB init
├── components/
│   ├── LearningCard.tsx
│   ├── OmniCaptureSheet.tsx     # Capture input with terminal animation
│   └── ScenarioTile.tsx
├── lib/
│   ├── database/                # SQLite + FTS5 layer
│   │   ├── schema.ts            # Database schema & initialization
│   │   ├── contexts.ts          # Context CRUD + FTS search
│   │   ├── cards.ts             # Card management
│   │   ├── fsrs.ts              # FSRS scheduling
│   │   ├── clusters.ts          # Cluster management
│   │   ├── seed.ts              # Initial data
│   │   └── index.ts
│   ├── ai/
│   │   ├── intent-router.ts     # Input classification (5 types)
│   │   └── prompts/             # Cognitive matrix prompts
│   │       ├── scene01-etymology.ts
│   │       ├── scene02-context-fill.ts
│   │       ├── scene03-collocation.ts
│   │       ├── scene04-contrast.ts
│   │       └── scene05-visual.ts
│   ├── hooks/
│   │   └── useScenarios.ts
│   ├── ai.ts                    # AI API client
│   ├── fsrs.ts                  # FSRS wrapper
│   └── tts.ts                   # TTS engine
├── stores/
│   └── userStore.ts             # Zustand state management
├── types/
│   └── index.ts                 # TypeScript definitions
└── constants/
    └── theme.ts                 # Design tokens
```

## 🎨 UI Components (6 Core Interfaces)

### 1. Onboarding Swipe (破冰测试流)
- Tinder-style card swipe
- Right swipe = known → saves to Context DB
- Left swipe = unknown → skip
- Initializes Personal Context DB in 1 minute

### 2. Dynamic Feed (动态场景探索流)
- Apple News-style tile layout
- Personalized scenarios based on FTS推演
- Level-based filtering (A1-C2)
- Category icons: 💻☕📰🎮📧✈️

### 3. Review Dojo (极简母语道场)
- Progressive hint system (3 levels):
  1. English synonym + TTS
  2. Haptic warning + Chinese (last resort)
  3. Answer reveal
- FSRS rating buttons
- Full-screen immersive experience

### 4. Library & Clusters (认知图谱)
- Thematic groupings
- FSRS health indicators (🟢 92%)
- Due card counts
- Search functionality

### 5. Omni Capture (随身捕获器)
- Floating + button
- Terminal-style processing animation
- Intent routing visualization
- Instant card generation

### 6. Ignition Mode (零基础点火)
- For <500 word learners
- SVG animations + TTS loop
- Lego-style phrase assembly
- No Chinese allowed

## 🧠 11 Cognitive Matrices

1. **Deep Understanding** (词根词缀拆解): Etymology breakdown
2. **Context Fill** (语境填空): Original sentence cloze
3. **Collocation** (词块搭配): Multi-word chunk practice
4. **Contrast** (二元对立): Confusable word pairs
5. **Visual SVG** (具象视觉): Concrete noun visualization
6. **Slang** (俚语隐喻): Cultural context explanation
7. **Grammar Skeleton** (语法骨架): Structure practice
8. **Cross-Domain** (跨学科折叠): 熟词生义
9. **Pronunciation** (语音重音): Stress pattern practice
10. **Register Shift** (语体转换): Formal vs casual
11. **Reverse Mapping** (母语逆向): Chinese → English

## 🔍 Intent Router (5 Input Types)

| Type | Example | Triggers |
|------|---------|----------|
| Isolated Word | `obsolete` | Scene 1, 3, 5 |
| Context Fragment | `ReferenceError: throttle is not defined` | Scene 2 |
| Contrast Query | `amend vs modify` | Scene 4 |
| Reverse Mapping | `怎么说"画大饼"` | Scene 11, 6 |
| Batch Request | `给我10个商务词汇` | Scene 8, 10 |

## 📊 Database Schema

```sql
-- Personal Context DB with FTS5
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

-- Learning cards (11 types)
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

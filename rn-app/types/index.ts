// User level based on CEFR
export type CEFRLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';

// Card types based on PRD's 11 cognitive matrices
export type CardType = 
  | 'deep-understanding'    // 场景1: 词根词缀拆解
  | 'context-fill'          // 场景2: 语境填空
  | 'collocation'           // 场景3: 词块搭配
  | 'contrast'              // 场景4: 二元对立辨析
  | 'visual'                // 场景5: 具象视觉
  | 'slang-idioms'          // 场景6: 俚语与隐喻
  | 'grammar-skeleton'      // 场景7: 语法骨架
  | 'cross-domain'          // 场景8: 跨学科折叠
  | 'pronunciation'         // 场景9: 语音重音
  | 'register-shift'        // 场景10: 语体转换
  | 'reverse-mapping';      // 场景11: 母语逆向映射

// Scenario tile for the feed
export interface ScenarioTile {
  id: string;
  title: string;
  subtitle: string;
  level: CEFRLevel;
  category: 'survival' | 'workplace' | 'social' | 'news' | 'culture';
  iconName: string;
  color: string;
}

// Learning card
export interface LearningCard {
  id: string;
  type: CardType;
  targetWord: string;
  context: string;
  explanation?: string;
  audioUrl?: string;
  visualSvg?: string;
  createdAt: Date;
  nextReviewAt?: Date;
}

// User profile with Personal RAG
export interface UserProfile {
  id: string;
  level: CEFRLevel;
  knownWords: string[];
  learningHistory: LearningCard[];
  ragEmbeddings: number[][];
}

// FSRS review data
export interface ReviewData {
  cardId: string;
  difficulty: number;
  stability: number;
  lastReview: Date;
  nextReview: Date;
  reviewCount: number;
}

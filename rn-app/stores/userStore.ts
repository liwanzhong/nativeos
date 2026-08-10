import { create } from 'zustand';
import { CEFRLevel } from '../types';

interface UserState {
  level: CEFRLevel | null;
  hasCompletedOnboarding: boolean;
  knownWords: Set<string>;
  setLevel: (level: CEFRLevel) => void;
  completeOnboarding: () => void;
  addKnownWord: (word: string) => void;
}

export const useUserStore = create<UserState>((set) => ({
  level: null,
  hasCompletedOnboarding: false,
  knownWords: new Set(),
  
  setLevel: (level) => set({ level }),
  
  completeOnboarding: () => set({ hasCompletedOnboarding: true }),
  
  addKnownWord: (word) => set((state) => ({
    knownWords: new Set([...state.knownWords, word]),
  })),
}));

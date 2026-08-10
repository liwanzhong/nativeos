/**
 * Push Notification Service for Inner Monologue System
 * Implements Vygotsky's theory of inner speech development
 */

import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

// Configure notification handler
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

/**
 * Request notification permissions
 */
export async function requestNotificationPermissions(): Promise<boolean> {
  if (!Device.isDevice) {
    console.warn('Notifications only work on physical devices');
    return false;
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    console.warn('Notification permission denied');
    return false;
  }

  // Configure notification channel for Android
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('inner-monologue', {
      name: 'Inner Monologue Challenges',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#FF6B6B',
    });
  }

  return true;
}

/**
 * Schedule daily inner monologue notifications
 */
export async function scheduleInnerMonologueNotifications(): Promise<void> {
  // Cancel existing notifications first
  await Notifications.cancelAllScheduledNotificationsAsync();

  const scenarios = getInnerMonologueScenarios();

  // Schedule 3 notifications per day
  const times = [
    { hour: 8, minute: 0 },   // Morning
    { hour: 12, minute: 30 }, // Lunch
    { hour: 20, minute: 0 },  // Evening
  ];

  for (let i = 0; i < times.length; i++) {
    const scenario = scenarios[i % scenarios.length];
    
    await Notifications.scheduleNotificationAsync({
      content: {
        title: '💭 Inner Monologue Challenge',
        body: scenario.prompt,
        data: {
          type: 'inner_monologue',
          scenarioId: scenario.id,
          expectedLength: scenario.expectedLength,
        },
        sound: true,
        priority: Notifications.AndroidNotificationPriority.HIGH,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.CALENDAR,
        hour: times[i].hour,
        minute: times[i].minute,
        repeats: true,
      },
    });
  }

  console.log('✅ Scheduled 3 daily inner monologue notifications');
}

/**
 * Send immediate test notification
 */
export async function sendTestNotification(): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: '💭 Test: Inner Monologue',
      body: 'Think in English: What are you doing right now?',
      data: { type: 'test' },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: 2,
    },
  });
}

/**
 * Get all scheduled notifications
 */
export async function getScheduledNotifications() {
  return await Notifications.getAllScheduledNotificationsAsync();
}

/**
 * Cancel all notifications
 */
export async function cancelAllNotifications(): Promise<void> {
  await Notifications.cancelAllScheduledNotificationsAsync();
  console.log('✅ All notifications cancelled');
}

/**
 * Inner monologue scenario library
 */
interface InnerMonologueScenario {
  id: string;
  trigger: string;
  prompt: string;
  expectedLength: number; // words
  difficulty: 'easy' | 'medium' | 'hard';
}

function getInnerMonologueScenarios(): InnerMonologueScenario[] {
  return [
    // Morning scenarios
    {
      id: 'morning_routine',
      trigger: '08:00',
      prompt: 'Think in English: What are you planning to do today? (No Chinese!)',
      expectedLength: 30,
      difficulty: 'easy',
    },
    {
      id: 'morning_feeling',
      trigger: '08:00',
      prompt: 'Describe how you feel this morning in English. Use vivid adjectives!',
      expectedLength: 25,
      difficulty: 'medium',
    },
    {
      id: 'morning_goals',
      trigger: '08:00',
      prompt: 'What do you want to accomplish today? Think it through in English.',
      expectedLength: 35,
      difficulty: 'medium',
    },

    // Lunch scenarios
    {
      id: 'lunch_reflection',
      trigger: '12:30',
      prompt: 'Describe your morning in English. What did you do?',
      expectedLength: 30,
      difficulty: 'easy',
    },
    {
      id: 'lunch_food',
      trigger: '12:30',
      prompt: 'What are you eating? Describe it in English without translating!',
      expectedLength: 20,
      difficulty: 'easy',
    },
    {
      id: 'lunch_conversation',
      trigger: '12:30',
      prompt: 'If you talked to someone, replay the conversation in English.',
      expectedLength: 40,
      difficulty: 'hard',
    },

    // Evening scenarios
    {
      id: 'evening_review',
      trigger: '20:00',
      prompt: 'What did you learn today? Express it in English.',
      expectedLength: 35,
      difficulty: 'medium',
    },
    {
      id: 'evening_challenge',
      trigger: '20:00',
      prompt: 'What was challenging today? Describe the problem in English.',
      expectedLength: 30,
      difficulty: 'medium',
    },
    {
      id: 'evening_gratitude',
      trigger: '20:00',
      prompt: 'What are you grateful for today? Think in English only.',
      expectedLength: 25,
      difficulty: 'easy',
    },
    {
      id: 'evening_tomorrow',
      trigger: '20:00',
      prompt: 'What will you do differently tomorrow? Plan it in English.',
      expectedLength: 30,
      difficulty: 'medium',
    },

    // Random scenarios (can be used anytime)
    {
      id: 'current_activity',
      trigger: 'random',
      prompt: 'Stop! What are you doing RIGHT NOW? Describe it in English.',
      expectedLength: 20,
      difficulty: 'easy',
    },
    {
      id: 'surroundings',
      trigger: 'random',
      prompt: 'Look around. Describe what you see in English. Be specific!',
      expectedLength: 30,
      difficulty: 'easy',
    },
    {
      id: 'emotion_check',
      trigger: 'random',
      prompt: 'How do you feel? Dig deeper than "good" or "bad". Use English!',
      expectedLength: 25,
      difficulty: 'medium',
    },
    {
      id: 'problem_solving',
      trigger: 'random',
      prompt: 'Think of a problem you have. Analyze it step-by-step in English.',
      expectedLength: 50,
      difficulty: 'hard',
    },
    {
      id: 'creative_thinking',
      trigger: 'random',
      prompt: 'If you could do anything right now, what would it be? Dream in English!',
      expectedLength: 35,
      difficulty: 'medium',
    },
  ];
}

/**
 * Get random scenario for immediate notification
 */
export function getRandomScenario(): InnerMonologueScenario {
  const scenarios = getInnerMonologueScenarios();
  const randomIndex = Math.floor(Math.random() * scenarios.length);
  return scenarios[randomIndex];
}

/**
 * Initialize notification system
 */
export async function initializeNotifications(): Promise<boolean> {
  const hasPermission = await requestNotificationPermissions();
  
  if (hasPermission) {
    await scheduleInnerMonologueNotifications();
    return true;
  }
  
  return false;
}

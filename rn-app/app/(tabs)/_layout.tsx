import { Tabs } from 'expo-router';
import { Film, Layers, MessageCircle, User } from 'lucide-react-native';
import { useState, useCallback, useEffect } from 'react';
import { colors } from '../../constants/theme';

function useDueCardBadge() {
  const [dueCount, setDueCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const { getDueCardCount } = await import('../../lib/database');
      setDueCount(await getDueCardCount());
    } catch {
      setDueCount(0);
    }
  }, []);

  return { dueCount, refresh };
}

export default function TabsLayout() {
  const { dueCount, refresh } = useDueCardBadge();

  useEffect(() => { refresh(); }, []);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border.light,
          borderTopWidth: 1,
          height: 100,
          paddingBottom: 40,
          paddingTop: 8,
        },
        tabBarActiveTintColor: colors.text.primary,
        tabBarInactiveTintColor: colors.text.tertiary,
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '500',
          marginTop: 4,
          marginBottom: 0,
        },
      }}
    >
      <Tabs.Screen
        name="videos"
        options={{
          title: '视频跟练',
          tabBarIcon: ({ color, size }) => <Film color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="feed"
        options={{
          title: 'AI陪练',
          tabBarIcon: ({ color, size }) => <MessageCircle color={color} size={size} />,
        }}
        listeners={{ focus: () => refresh() }}
      />
      <Tabs.Screen
        name="review"
        options={{
          title: '知识库',
          tabBarIcon: ({ color, size }) => <Layers color={color} size={size} />,
          tabBarBadge: dueCount > 0 ? dueCount : undefined,
        }}
        listeners={{ focus: () => refresh() }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: '我的',
          tabBarIcon: ({ color, size }) => <User color={color} size={size} />,
        }}
      />
    </Tabs>
  );
}

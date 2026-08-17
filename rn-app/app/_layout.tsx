import { Stack, router } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCallback, useEffect, useState, useRef } from 'react';
import { Platform, ActivityIndicator, View, Linking } from 'react-native';
import { ensureDatabaseInitialized } from '../lib/database';
import { initializeNotifications } from '../lib/notifications';
import * as Notifications from 'expo-notifications';
import { AndroidAppUpdateModal } from '../components/android-app-update-modal';
import { getImportableVideoPackUriFromUrl, setPendingImportedVideoPackUri } from '../lib/content/imported-video-packs';
import {
  checkForAndroidAppUpdate,
  downloadAndroidUpdateApk,
  installAndroidUpdateApk,
  markAndroidUpdateSkipped,
  type AndroidUpdateInfo,
} from '../lib/app-update';
import { prewarmDictionaryDb } from '../lib/dictionary/db';
import { AuthProvider } from '../lib/auth';
import { QuotaBlockedDialog } from '../components/quota/QuotaBlockedDialog';
import { installQuotaBackgroundSync } from '../lib/quota';
import { installLogStore } from '../lib/diagnostics/logStore';

// Install the in-memory console ring buffer as early as possible so
// even init-phase errors (DB migration, notifications, app update
// check) end up in the feedback bundle. Idempotent.
installLogStore();

const queryClient = new QueryClient();

export default function RootLayout() {
  const [dbReady, setDbReady] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState<AndroidUpdateInfo | null>(null);
  const [isUpdateVisible, setIsUpdateVisible] = useState(false);
  const [isDownloadingUpdate, setIsDownloadingUpdate] = useState(false);
  const [updateDownloadProgress, setUpdateDownloadProgress] = useState(0);
  const [updateErrorMessage, setUpdateErrorMessage] = useState<string | null>(null);
  const notificationListener = useRef<any>(null);
  const responseListener = useRef<any>(null);
  const updateCheckStartedRef = useRef(false);

  useEffect(() => {
    async function initializeApp() {
      try {
        await ensureDatabaseInitialized();
        
        // Initialize push notifications (Phase 3)
        if (Platform.OS !== 'web') {
          try {
            const notificationsEnabled = await initializeNotifications();
            if (notificationsEnabled) {
              console.log('✅ Inner monologue notifications enabled');
            }
          } catch (notifError) {
            console.warn('Notifications init failed (non-fatal):', notifError);
          }

          // Listen for notification responses
          responseListener.current = Notifications.addNotificationResponseReceivedListener(response => {
            const data = response.notification.request.content.data as Record<string, any> | undefined;
            if (data?.type === 'inner_monologue') {
              // Navigate to inner monologue screen
              const router = require('expo-router').router;
              // expo-router v5: pass path + params as separate args.
              // The object form `{ pathname, params }` is deprecated.
              router.push('/inner-monologue', {
                prompt: response.notification.request.content.body,
                expectedLength: data.expectedLength || 30,
              });
            }
          });
        }
        
        setDbReady(true);
      } catch (error) {
        console.error('Failed to initialize app:', error);
        setDbReady(true);
      }
    }
    
    initializeApp();
    installQuotaBackgroundSync();

    // Cleanup
    return () => {
      if (responseListener.current) {
        responseListener.current.remove();
      }
    };
  }, []);

  // Inject web-specific styles + Live2D Cubism core runtime
  useEffect(() => {
    if (Platform.OS === 'web') {
      const style = document.createElement('style');
      style.textContent = `
        /* Fix tab bar height and padding */
        [role="tablist"] {
          min-height: 120px !important;
          padding-bottom: 50px !important;
          padding-top: 10px !important;
        }
      `;
      document.head.appendChild(style);

      // Inject Live2D Cubism 4 core runtime (served locally from web/ directory)
      const CUBISM_SRC = '/live2dcubismcore.min.js';
      if (!document.querySelector(`script[src="${CUBISM_SRC}"]`)) {
        const script = document.createElement('script');
        script.src = CUBISM_SRC;
        script.async = false;
        document.head.appendChild(script);
      }
    }
  }, []);

  useEffect(() => {
    if (!dbReady || updateCheckStartedRef.current) {
      return;
    }

    prewarmDictionaryDb();
    updateCheckStartedRef.current = true;

    (async () => {
      try {
        const result = await checkForAndroidAppUpdate();
        if (result.status === 'available') {
          setPendingUpdate(result.update);
          setIsUpdateVisible(true);
        }
      } catch (error) {
        console.warn('App update check failed:', error);
      }
    })();
  }, [dbReady]);

  useEffect(() => {
    if (Platform.OS === 'web') {
      return;
    }

    const handleIncomingUrl = (url: string | null | undefined) => {
      const importableUri = getImportableVideoPackUriFromUrl(url);
      if (!importableUri) {
        return;
      }
      setPendingImportedVideoPackUri(importableUri);
      router.push('/(tabs)/videos');
    };

    Linking.getInitialURL()
      .then((url) => {
        handleIncomingUrl(url);
      })
      .catch(() => {
      });

    const subscription = Linking.addEventListener('url', ({ url }) => {
      handleIncomingUrl(url);
    });

    return () => {
      subscription.remove();
    };
  }, []);

  const handleUpdateNow = useCallback(async () => {
    if (!pendingUpdate || isDownloadingUpdate) {
      return;
    }

    setUpdateErrorMessage(null);
    setIsDownloadingUpdate(true);
    setUpdateDownloadProgress(0);

    try {
      const fileUri = await downloadAndroidUpdateApk(pendingUpdate, setUpdateDownloadProgress);
      await installAndroidUpdateApk(fileUri);
    } catch (error) {
      setUpdateErrorMessage(error instanceof Error ? error.message : '更新失败，请稍后重试');
    } finally {
      setIsDownloadingUpdate(false);
    }
  }, [isDownloadingUpdate, pendingUpdate]);

  const handleUpdateLater = useCallback(async () => {
    if (!pendingUpdate || pendingUpdate.isMandatory || isDownloadingUpdate) {
      return;
    }

    await markAndroidUpdateSkipped(pendingUpdate.versionCode);
    setIsUpdateVisible(false);
    setPendingUpdate(null);
    setUpdateErrorMessage(null);
    setUpdateDownloadProgress(0);
  }, [isDownloadingUpdate, pendingUpdate]);

  if (!dbReady) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <>
              <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen name="(onboarding)" />
                <Stack.Screen name="(tabs)" />
                <Stack.Screen name="login" options={{ presentation: 'modal' }} />
                <Stack.Screen name="profile-edit" options={{ presentation: 'modal' }} />
                <Stack.Screen name="settings" options={{ presentation: 'modal' }} />
                <Stack.Screen name="settings/feedback" options={{ presentation: 'modal' }} />
                <Stack.Screen name="membership" options={{ presentation: 'modal' }} />
                <Stack.Screen name="redeem" options={{ presentation: 'modal' }} />
                <Stack.Screen name="byok" options={{ presentation: 'modal' }} />
              </Stack>
              <AndroidAppUpdateModal
                visible={isUpdateVisible}
                update={pendingUpdate}
                isDownloading={isDownloadingUpdate}
                progress={updateDownloadProgress}
                errorMessage={updateErrorMessage}
                onUpdateNow={handleUpdateNow}
                onLater={handleUpdateLater}
              />
              <QuotaBlockedDialog />
            </>
          </AuthProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

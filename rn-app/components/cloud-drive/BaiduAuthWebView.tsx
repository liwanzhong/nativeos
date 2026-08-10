import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import WebView, { type WebViewNavigation } from 'react-native-webview';
import {
  buildBaiduOAuthUrl,
  exchangeBaiduCodeForToken,
  getBaiduPanAppConfig,
  isBaiduOAuthCallbackCandidate,
  parseBaiduImplicitTokenFromUrl,
  saveBaiduPanBinding,
  saveBaiduPanImplicitTokenFromUrl,
  type BaiduPanAuthMode,
  type BaiduPanToken,
} from '../../lib/content/cloud-drive-bindings';

const INJECTED_JS = `
(function () {
  function postPayload() {
    if (!window.ReactNativeWebView) return;
    window.ReactNativeWebView.postMessage(JSON.stringify({
      href: window.location.href,
      text: document.body ? document.body.innerText : ''
    }));
  }
  window.addEventListener('load', postPayload);
  window.addEventListener('hashchange', postPayload);
  setTimeout(postPayload, 300);
  setTimeout(postPayload, 1000);
  true;
})();
`;

type Props = {
  visible: boolean;
  authMode?: BaiduPanAuthMode;
  onSuccess: (token: BaiduPanToken) => void;
  onError?: (message: string) => void;
  onClose: () => void;
};

export function BaiduAuthWebView({
  visible,
  authMode = 'token',
  onSuccess,
  onError,
  onClose,
}: Props) {
  const insets = useSafeAreaInsets();
  const processingRef = useRef(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [redirectUri, setRedirectUri] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [webViewNonce, setWebViewNonce] = useState(0);

  const handleModalShow = useCallback(async () => {
    processingRef.current = false;
    setIsLoading(true);
    setErrorMsg(null);
    setAuthUrl(null);
    setWebViewNonce((prev) => prev + 1);
    try {
      const config = await getBaiduPanAppConfig();
      setRedirectUri(config.redirectUri);
      const url = await buildBaiduOAuthUrl(authMode);
      setAuthUrl(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '构建授权地址失败';
      setErrorMsg(msg);
      onError?.(msg);
    }
  }, [authMode, onError]);

  const finishAuthorized = useCallback(
    async (token: BaiduPanToken) => {
      await saveBaiduPanImplicitTokenFromUrl('access_token=' + token.accessToken);
      onSuccess(token);
    },
    [onSuccess],
  );

  const handleNavigationChange = useCallback(
    async (navState: WebViewNavigation) => {
      const { url } = navState;
      if (!url || !isBaiduOAuthCallbackCandidate(url, redirectUri) || processingRef.current) {
        return;
      }
      processingRef.current = true;
      try {
        if (authMode === 'token') {
          const parsed = parseBaiduImplicitTokenFromUrl(url);
          if (!parsed) {
            throw new Error('未从授权结果中解析到 access_token');
          }
          await finishAuthorized(parsed);
          return;
        }
        const codeMatch = url.match(/[?&]code=([^&#]+)/);
        if (codeMatch) {
          const token = await exchangeBaiduCodeForToken(codeMatch[1]);
          const store = await import('../../lib/content/cloud-drive-bindings');
          const binding = await store.getBaiduPanBinding();
          await saveBaiduPanBinding({ rootPath: binding?.rootPath || '/', token });
          onSuccess(token);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : '授权失败';
        setErrorMsg(msg);
        onError?.(msg);
        processingRef.current = false;
      }
    },
    [authMode, redirectUri, finishAuthorized, onSuccess, onError],
  );

  const handleWebMessage = useCallback(
    async (event: any) => {
      if (processingRef.current) return;
      let payload: { href?: string; text?: string } | null = null;
      try {
        payload = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }
      if (!payload) return;
      const href = payload.href || '';
      if (!isBaiduOAuthCallbackCandidate(href, redirectUri)) return;
      processingRef.current = true;
      try {
        if (authMode === 'token') {
          const parsed = parseBaiduImplicitTokenFromUrl(href);
          if (!parsed) return;
          await finishAuthorized(parsed);
          return;
        }
        const codeMatch = href.match(/[?&]code=([^&#]+)/);
        if (codeMatch) {
          const token = await exchangeBaiduCodeForToken(codeMatch[1]);
          const store = await import('../../lib/content/cloud-drive-bindings');
          const binding = await store.getBaiduPanBinding();
          await saveBaiduPanBinding({ rootPath: binding?.rootPath || '/', token });
          onSuccess(token);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : '授权失败';
        setErrorMsg(msg);
        onError?.(msg);
        processingRef.current = false;
      }
    },
    [authMode, redirectUri, finishAuthorized, onSuccess, onError],
  );

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      onShow={handleModalShow}
    >
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>百度网盘授权</Text>
          <Pressable onPress={onClose} style={styles.closeBtn}>
            <Text style={styles.closeBtnText}>关闭</Text>
          </Pressable>
        </View>

        {errorMsg ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{errorMsg}</Text>
            <Pressable onPress={onClose} style={styles.errorCloseBtn}>
              <Text style={styles.errorCloseBtnText}>关闭</Text>
            </Pressable>
          </View>
        ) : authUrl ? (
          <WebView
            key={`baidu-auth-${webViewNonce}`}
            source={{ uri: authUrl }}
            onNavigationStateChange={handleNavigationChange}
            onMessage={handleWebMessage}
            injectedJavaScript={INJECTED_JS}
            startInLoadingState
            incognito
            cacheEnabled={false}
            sharedCookiesEnabled={false}
            thirdPartyCookiesEnabled={false}
            onLoadStart={() => setIsLoading(true)}
            onLoadEnd={() => setIsLoading(false)}
            renderLoading={() => (
              <View style={styles.loadingBox}>
                <ActivityIndicator size="large" color="#2563EB" />
                <Text style={styles.loadingText}>正在加载授权页面...</Text>
              </View>
            )}
            style={styles.webView}
          />
        ) : (
          <View style={styles.loadingBox}>
            <ActivityIndicator size="large" color="#2563EB" />
            <Text style={styles.loadingText}>正在准备授权地址...</Text>
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F172A',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#1E293B',
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  headerTitle: {
    color: '#F8FAFC',
    fontSize: 16,
    fontWeight: '700',
  },
  closeBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: '#334155',
    borderRadius: 8,
  },
  closeBtnText: {
    color: '#E2E8F0',
    fontSize: 14,
  },
  webView: {
    flex: 1,
  },
  loadingBox: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#0F172A',
  },
  loadingText: {
    color: '#94A3B8',
    fontSize: 14,
  },
  errorBox: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
    padding: 24,
  },
  errorText: {
    color: '#FCA5A5',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 22,
  },
  errorCloseBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: '#334155',
    borderRadius: 8,
  },
  errorCloseBtnText: {
    color: '#E2E8F0',
    fontSize: 14,
  },
});

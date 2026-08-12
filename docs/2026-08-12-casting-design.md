# NativeOS 视频投屏功能 - 详细设计

> 状态: 设计稿 v1
> 日期: 2026-08-12
> 作者: Mavis (设计) + 用户 (审阅)
> 关联: `docs/FEATURES.md`、`rn-app/lib/video-cache.ts`、`rn-app/lib/content/cloud-video-playback.ts`

## 1. 需求与边界

### 1.1 范围 (In Scope)

- 视频源: 官方视频 (OS) + 用户上传视频 (OS) + 百度网盘视频 (缓存到本地后)
- 协议: DLNA / UPnP AVTransport
- 平台: Android (项目当前只构建 Android 端, iOS 端代码按平台隔离但不写 iOS 实现)
- 用户态: 局域网内, 手机与电视 / 盒子同 WiFi
- 投屏内容: 手机本地缓存的视频文件, 通过 mini HTTP server 让电视拉流
- 状态: 投屏 (casting) 与本地播放**独立**, 不做进度同步

### 1.2 范围外 (Out of Scope)

- AirPlay (RN 无成熟方案, Apple 生态闭源)
- Google Cast (需要 Google 备案)
- 手机镜像 / 实时编码投屏
- 投屏进度回传到手机 (i.e. 电视 seek 后手机跟着)
- 离线 / 跨网段投屏 (需要 NAT 穿透, 不在 MVP)
- 字幕 / 倍速同步

## 2. 现状与可复用资产

### 2.1 视频缓存 (`rn-app/lib/video-cache.ts`)

**已实现, 全部可复用**:
- `getCachedVideoUri(sceneId, remoteUrl)` — 查询缓存命中
- `cacheVideoLocally(sceneId, remoteUrl)` — 主动下载到 `Paths.cache/video-cache/`
- `clearVideoCache()` / `getVideoCacheStats()` — 缓存管理

**协议 (extracted from `video-cache.ts:22-27`)**:
- 缓存目录: `Paths.cache/video-cache/`
- 文件命名: `${sceneId}_${remoteUrlHash}.${ext}` (ext 从 URL 提取, 默认 mp4)
- 命中条件: `file.exists && file.size > 0`

**这意味着**: 投屏流程不需要新写"下载到本地"逻辑, **直接复用** 现有 `cacheVideoLocally`。

### 2.2 视频源解析 (`rn-app/lib/content/cloud-video-playback.ts:440-480`)

**官方视频 / 用户上传视频** (`resolveOfficialSceneVideoSource`):
- 优先返回 `playbackMode: 'local'`, 本地缓存命中就拿本地
- 没有本地缓存? 当前直接返回远端 URL (意味着从 OSS 拉流)
- **MVP 调整**: 投屏场景下需要确保本地缓存存在, 缺失时调 `cacheVideoLocally` 主动下载

**百度网盘视频** (`resolveCloudReferencedVideoSource`):
- 必须先通过 `downloadOfficialSceneVideo` / `downloadImportedCloudVideo` 缓存到本地
- 走的是 `expo-file-system` resumable download, 已有下载进度回调
- 投屏场景: 复用现有下载流程, 完事后直接投

### 2.3 已选定的依赖方案

| 组件 | 候选 | 选型 | 理由 |
|---|---|---|---|
| DLNA SSDP | `react-native-upnp` / `react-native-dlna` / 自写 Android 原生 | **自写 Android 原生模块** | 社区库都年久失修, RN 0.83 + Hermes 兼容性未验证; 原生模块可控可调 |
| DLNA SOAP | 纯 JS | **纯 JS** | 标准 UPnP AVTransport spec, SOAP 客户端简单, 无需原生层 |
| 本地 HTTP server | `react-native-static-server` | **`react-native-static-server`** | 成熟, iOS 用 GCDWebServer / Android 用 NanoHttpd, 自带 Range header 支持 |
| 网络信息 | `react-native-network-info` | **`react-native-network-info`** | 拿手机内网 IP, DLNA 推送 URL 必须用手机 IP, 不能用 localhost |
| 状态管理 | `zustand` (项目已用) | **新建 `useCastStore`** | 与项目其他状态管理风格一致 |

## 3. 架构总览

```
┌────────────────────────────────────────────────────────────┐
│  UI Layer                                                   │
│  ┌──────────────┐  ┌──────────────────┐  ┌──────────────┐  │
│  │ CastButton   │  │ DevicePickerSheet │  │ CastStatusBar │  │
│  │ (视频页头)   │  │ (设备列表)        │  │ (投屏中)     │  │
│  └──────┬───────┘  └─────────┬────────┘  └──────┬───────┘  │
│         │                    │                   │          │
│         └────────────────────┼───────────────────┘          │
│                              ▼                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  useCastStore (zustand)                              │  │
│  │  - state: { phase, device, error, videoMeta }        │  │
│  │  - actions: { startDiscovery, cast, stop, pause }    │  │
│  └──────────────────────────┬───────────────────────────┘  │
└─────────────────────────────┼──────────────────────────────┘
                              ▼
┌────────────────────────────────────────────────────────────┐
│  Cast Manager (lib/cast/manager.ts)                        │
│  - 编排: discovery → cache-check → http-server → SOAP     │
│  - 错误处理 + 状态机                                       │
└────────┬────────────────────┬─────────────────┬────────────┘
         ▼                    ▼                 ▼
┌──────────────┐    ┌────────────────┐  ┌─────────────────┐
│ Discovery    │    │ HttpServer     │  │ DlnaClient      │
│ (SSDP)       │    │ (本地服务)     │  │ (SOAP 控制)     │
│              │    │                │  │                 │
│ Android      │    │ react-native-  │  │ 纯 JS           │
│ 原生模块     │    │ static-server  │  │ XMLHttpRequest  │
└──────────────┘    └────────────────┘  └─────────────────┘
         │                                       │
         └───────────────┬───────────────────────┘
                         ▼
              ┌─────────────────────┐
              │ 电视 / 盒子         │
              │ (DLNA 接收端)       │
              └─────────────────────┘
```

## 4. 模块设计

### 4.1 文件结构

```
rn-app/
├── lib/
│   └── cast/                          # 新增
│       ├── index.ts                   # 公共 API 导出
│       ├── manager.ts                 # 顶层 Cast Manager
│       ├── discovery.ts               # 设备发现 (调原生)
│       ├── dlna-client.ts             # SOAP 控制点
│       ├── http-server.ts             # 本地 mini HTTP server
│       ├── device.ts                  # DLNA 设备模型
│       ├── xml-parser.ts              # 设备描述 / SOAP 响应解析
│       ├── errors.ts                  # CastError 错误码
│       └── types.ts                   # 内部类型定义
│       └── native/
│           ├── SsdpDiscoveryModule.kt # Android 原生 SSDP 模块
│           └── SsdpDiscoveryModule.java # (如果走 Java 路线)
├── components/
│   └── cast/                          # 新增
│       ├── CastButton.tsx
│       ├── DevicePickerSheet.tsx
│       └── CastStatusBar.tsx
├── stores/
│   └── cast-store.ts                  # 新增 (zustand)
└── android/                           # 修改: 注册原生模块
    └── app/src/main/java/.../package/
        ├── MainApplication.kt         # 注册 SsdpDiscoveryModule
        └── SsdpDiscoveryModule.kt     # 实现 SSDP
```

### 4.2 原生模块: `SsdpDiscoveryModule` (Android)

**为什么必须原生**:
- RN JS 层无 UDP multicast API
- DLNA SSDP 协议依赖 UDP multicast (239.255.255.250:1900)
- 自写 JS 替代方案需要写 Node.js dgram, RN 0.83 不支持

**接口设计 (Promise 风格)**:

```kotlin
class SsdpDiscoveryModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    @ReactMethod
    fun searchDevices(searchType: String, timeoutMs: Int, promise: Promise) {
        // searchType: "ssdp:all" 或 "urn:schemas-upnp-org:device:MediaServer:1"
        // 异步发送 M-SEARCH, 收集响应, 解析 LOCATION header
        // 超时后把设备列表 resolve 给 JS
    }

    @ReactMethod
    fun stopSearch(promise: Promise) {
        // 取消进行中的搜索
    }

    override fun getName() = "SsdpDiscovery"
}
```

**M-SEARCH 请求模板**:
```
M-SEARCH * HTTP/1.1
HOST: 239.255.255.250:1900
MAN: "ssdp:discover"
MX: 3
ST: ssdp:all
```

**响应解析 (Java side)**:
- 提取 `LOCATION` header (设备描述 URL, e.g. `http://192.168.1.100:49152/rootDesc.xml`)
- 提取 `ST` (服务类型) 和 `USN` (唯一服务名)
- 拉取 LOCATION URL 的 XML, 提取 `<friendlyName>` (给用户看的设备名) 和 `<UDN>` (UUID)

### 4.3 DLNA SOAP 控制点 (`lib/cast/dlna-client.ts`)

**核心方法 (UPnP AVTransport spec)**:

| 方法 | SOAPAction | 用途 |
|---|---|---|
| `SetAVTransportURI` | `urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI` | 告诉电视要播什么 |
| `Play` | `...#Play` | 开始 / 恢复播放 |
| `Pause` | `...#Pause` | 暂停 |
| `Stop` | `...#Stop` | 停止 (释放资源) |
| `Seek` | `...#Seek` | seek 到指定位置 |

**SetAVTransportURI SOAP body 模板**:
```xml
<?xml version="1.0" encoding="utf-8"?>
<s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"
            xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
      <CurrentURI>http://192.168.1.50:8088/videos/scene_abc.mp4</CurrentURI>
      <CurrentURIMetadata>
        <dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">视频标题</dc:title>
      </CurrentURIMetadata>
    </u:SetAVTransportURI>
  </s:Body>
</s:Envelope>
```

**实现**: 用 RN 的 `XMLHttpRequest` (不走 fetch, 因为 SOAP 兼容性 fetch 不稳; RN 0.83 的 fetch 已经在 OSS 上踩过坑)。

**控制 URL 提取** (`xml-parser.ts`):
- 拉取 `http://<device>/rootDesc.xml`
- 解析 XML, 找到 `<serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>`
- 拿同 `<service>` 下的 `<controlURL>` (相对路径, 要拼到 base URL)
- 拿 `<eventSubURL>` 备用 (订阅状态变更)

### 4.4 本地 HTTP server (`lib/cast/http-server.ts`)

**封装 `react-native-static-server`**:
```ts
import StaticServer from 'react-native-static-server';

let server: StaticServer | null = null;

export async function startCastServer(): Promise<{ url: string; port: number }> {
  if (server) return getServerInfo();
  server = new StaticServer(0, getVideoCacheDir().path, {
    localOnly: false,           // 允许局域网访问
    keepAlive: true,            // 投屏期间不退出
  });
  const url = await server.start();
  const port = extractPort(url);
  return { url, port };
}

export async function stopCastServer() {
  if (server) {
    await server.stop();
    server = null;
  }
}
```

**目录**: `Paths.cache/video-cache/`

**重要**: 投屏期间不主动 `stop`, 用户离开视频页时调 `stop` 释放。

### 4.5 状态管理 (`stores/cast-store.ts`)

**State 状态机**:
```ts
type CastPhase =
  | 'idle'              // 没投屏
  | 'discovering'       // 搜设备
  | 'device-selected'   // 选了设备
  | 'caching'           // 视频下载到本地
  | 'starting-server'   // 起 HTTP server
  | 'casting'           // 投屏中
  | 'paused'            // 投屏中暂停
  | 'error';            // 错误
```

```ts
type CastState = {
  phase: CastPhase;
  device: CastDevice | null;     // 选中的电视
  devices: CastDevice[];          // 发现的设备列表
  error: CastError | null;
  videoMeta: {                    // 当前投屏的视频
    sceneId: string;
    title: string;
    remoteUrl: string;
    cachedUri?: string;
  } | null;
};

type CastActions = {
  discover(): Promise<void>;
  castTo(device: CastDevice, video: VideoMeta): Promise<void>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  reset(): void;
};
```

### 4.6 UI 组件

**CastButton** (`components/cast/CastButton.tsx`):
- 视频页头部 (顶栏右上角)
- 显示: 投屏图标 (lucide-react-native 已有 `Cast` 图标)
- 行为: 点击 → 触发 `discover()` → 弹 `DevicePickerSheet`
- 状态: `casting` / `paused` 时按钮高亮

**DevicePickerSheet** (`components/cast/DevicePickerSheet.tsx`):
- 用 `Modal` 包装, 底部弹出 (类似项目里 `VideoSourcePickerContent` 风格)
- 列表显示发现的电视: 图标 + `friendlyName` (e.g. "客厅小米电视")
- 列表为空时: 提示"未找到设备, 请确认电视和手机在同一 WiFi"
- 顶部 loading state: `发现中...`
- 选设备 → 调 `castTo(device, videoMeta)`

**CastStatusBar** (`components/cast/CastStatusBar.tsx`):
- 视频页底部固定条
- 显示: "投屏中 → 客厅小米电视" + 停止按钮
- `pause` 时显示 "已暂停"

## 5. 投屏流程 (Sequence)

```
用户                UI                  CastStore           CastManager
 │                  │                      │                     │
 │ 1. 点击投屏按钮  │                      │                     │
 ├─────────────────▶│                      │                     │
 │                  │ 2. discover()        │                     │
 │                  ├─────────────────────▶│                     │
 │                  │                      │ 3. SSDP search      │
 │                  │                      ├────────────────────▶│
 │                  │                      │                     │── M-SEARCH ─▶│ TV
 │                  │                      │                     │◀─ LOCATION ──┤
 │                  │                      │ 4. devices[]        │
 │                  │                      │◀────────────────────│
 │                  │ 5. 弹设备列表         │                     │
 │                  │◀─────────────────────┤                     │
 │ 6. 选电视        │                      │                     │
 ├─────────────────▶│                      │                     │
 │                  │ 7. castTo()          │                     │
 │                  ├─────────────────────▶│                     │
 │                  │                      │ 8. castTo(device)   │
 │                  │                      ├────────────────────▶│
 │                  │                      │                     │
 │                  │                      │ 9. cacheVideoLocally│
 │                  │                      │  (或复用现有)       │
 │                  │                      │                     │
 │                  │                      │ 10. startCastServer │
 │                  │                      │  (本地 HTTP)        │
 │                  │                      │                     │
 │                  │                      │ 11. SetAVTransportURI
 │                  │                      │  + Play             │
 │                  │                      │                     │── SOAP ──────▶│ TV
 │                  │                      │                     │◀─ 200 ────────┤
 │                  │                      │ 12. phase='casting' │
 │                  │ 13. 显示 CastStatusBar │                    │
 │                  │◀─────────────────────┤                     │
```

## 6. 关键代码片段 (示意, 实际写时细化)

### 6.1 设备发现调用 (lib/cast/discovery.ts)

```ts
import { NativeModules } from 'react-native';

const { SsdpDiscovery } = NativeModules;

export type RawDevice = {
  friendlyName: string;
  udn: string;          // 唯一设备名
  location: string;     // 设备描述 URL
  st: string;           // 服务类型
  address: string;      // IP
  port: number;
};

export async function discoverDevices(timeoutMs = 5000): Promise<RawDevice[]> {
  return SsdpDiscovery.searchDevices('ssdp:all', timeoutMs);
}
```

### 6.2 SOAP 推送 (lib/cast/dlna-client.ts)

```ts
async function sendSoap(
  controlUrl: string,
  soapAction: string,
  body: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', controlUrl, true);
    xhr.setRequestHeader('Content-Type', 'text/xml; charset="utf-8"');
    xhr.setRequestHeader('SOAPAction', `"${soapAction}"`);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300
      ? resolve(xhr.responseText)
      : reject(new Error(`SOAP ${xhr.status}: ${xhr.responseText}`)));
    xhr.onerror = () => reject(new Error('SOAP network error'));
    xhr.send(body);
  });
}

export async function setAVTransportURI(
  controlUrl: string,
  uri: string,
  title: string,
): Promise<void> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
    <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
                s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
      <s:Body>
        <u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
          <InstanceID>0</InstanceID>
          <CurrentURI>${escapeXml(uri)}</CurrentURI>
          <CurrentURIMetadata>
            <dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">${escapeXml(title)}</dc:title>
          </CurrentURIMetadata>
        </u:SetAVTransportURI>
      </s:Body>
    </s:Envelope>`;
  await sendSoap(controlUrl, 'urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI', body);
}
```

### 6.3 编排 (lib/cast/manager.ts 关键路径)

```ts
async function castTo(device: CastDevice, video: VideoMeta) {
  // 1. 缓存
  setPhase('caching');
  const cachedUri = video.cachedUri
    ?? await cacheVideoLocally(video.sceneId, video.remoteUrl);

  // 2. 起 server
  setPhase('starting-server');
  const { url, port } = await startCastServer();

  // 3. 拿手机 IP
  const localIp = await getLocalIp();
  const videoUrl = `http://${localIp}:${port}/${path.basename(cachedUri)}`;

  // 4. SOAP 推送
  await setAVTransportURI(device.controlUrl, videoUrl, video.title);
  await play(device.controlUrl);

  setPhase('casting');
}
```

## 7. 关键风险点

### 7.1 RN 0.83 + Hermes 兼容性

| 风险 | 缓解 |
|---|---|
| `react-native-static-server` 维护度 | 用的人多, 主流方案, RN 0.83 大概率兼容; **PoC 必跑, 不行换 Kotlin `ServerSocket` 自写** (决策 4) |
| `react-native-network-info` 维护度 | 同样, PoC 必跑; 拿 IP 只需 `ACCESS_WIFI_STATE` 静态权限, 不需要动态申请 |
| Android 原生模块注册 | 项目已用过 `expo-router`, prebuild 模式; 注册新模块要确认 `MainApplication.kt` 注入 |
| XMLHttpRequest SOAP | 已在 OSS 上踩过坑, 这次用 XHR + 短超时 + AbortController |
| **SSDP `MulticastLock` 时序** | 必须在 `MulticastSocket.joinGroup()` **之前** `acquire()`, finally 块 `release()`, 不然 Android 永远收不到 multicast 报文 (2026-08-12 自检发现) |
| **`InetAddress.getLocalHost()` 返回 127.0.0.1** | 不能用这个 joinGroup, 必须 `NetworkInterface.getByName("wlan0").getInetAddresses()` 拿真实网卡 (2026-08-12 自检发现) |
| **emulator 不支持 IGMP/multicast** | MuMu / 雷电 / 网易 / 官方 AVD 全部不支持, emulator 上永远搜不到设备, 联调必须真机 (2026-08-12 自检发现) |

### 7.2 设备差异

- **小米 / 天猫 / 海信电视**: DLNA 实现都符合 UPnP 1.0 spec, 但 Samsung / LG 偶有私有扩展
- **魔百和 / IPTV 盒子**: 部分老款实现省略 Range header, 我们的 HTTP server 一定要返回 `Accept-Ranges: bytes`
- **乐播投屏电视端**: 标准 DLNA 接收端, 应该 OK
- **VLC for Android**: 用作开发期调试用, 装在手机或电脑模拟 DLNA 接收

### 7.3 跨进程权限

- Android 10+ scoped storage, `Paths.cache` 内部访问, 没问题
- HTTP server 端口 < 1024 需要 root, 选 8088 等高端口
- WiFi 状态权限: `ACCESS_WIFI_STATE` + `ACCESS_NETWORK_STATE`, 在 `AndroidManifest.xml` 加

### 7.4 已知未做

- **电视 seek 回传**: 不在 MVP 范围, 留扩展点 (`pause/resume/seek` 接口预留)
- **断线重连**: TV 主动断开时 (用户关机), 手机端不感知, 状态会卡在 `casting`; 加 eventing 订阅 (SOAP SUBSCRIBE) 后期再做
- **多设备投屏**: MVP 只支持单设备, 切设备要 stop 后再 cast
- **HTTPS 推流**: 电视拉 HTTP 没问题, 不上 HTTPS

## 8. 工作量估算

| 模块 | 工作量 | 说明 |
|---|---|---|
| SSDP Android 原生模块 | 1.5 天 | Java/Kotlin + 注册到 MainApplication |
| DLNA 设备描述 XML 解析 | 0.5 天 | 纯 JS, 用浏览器 DOMParser 或 quick-xml |
| SOAP 客户端 | 1 天 | 4 个方法 (Set/Pause/Play/Stop) + 错误处理 |
| 本地 HTTP server 集成 | 0.5 天 | react-native-static-server 封装 |
| 投屏 Manager 编排 + 错误状态机 | 1 天 | 核心串接逻辑 |
| 视频缓存集成 + 自动下载 | 0.5 天 | 官方/用户上传视频场景 |
| 百度网盘投屏集成 | 0.5 天 | 复用现有 download 流程 |
| 投屏 UI 组件 (3 个) | 0.5 天 | CastButton / DevicePickerSheet / CastStatusBar |
| CastStore + 状态机 | 0.5 天 | zustand store |
| 集成到视频页 (app/scenario/video/[id].tsx) | 0.5 天 | 头部按钮 + 状态条 |
| 联调: VLC 模拟接收端 | 1 天 | 本地闭环 |
| 联调: 真电视 / 盒子 (2-3 款) | 2 天 | 兼容性 |
| Manifest 权限 + Android 配置 | 0.5 天 | |
| 单元测试 + 文档 | 0.5 天 | |
| **总计** | **~10 个工作日** | 2 周 |

## 9. 联调清单 (Dev 期, 真机联调)

> **注**: 2026-08-12 联网自检验证 — Android emulator (含 MuMu / 雷电 / 网易) 历史上**不支持 IGMP/multicast**, 模拟器上 SSDP 永远收不到响应, **联调必须用真机**, emulator 联调路径**作废**。

- [ ] VLC for Android (作为 DLNA Renderer / Receiver) — **开发期主用**
- [ ] macast (xfangfang 开源) 跑在 Mac 上 — **开发期备用**
- [ ] 小米电视 / 小米盒子 (如有)
- [ ] 天猫魔盒 (如有)
- [ ] 乐播投屏电视端 (如有)
- [ ] 至少一款 Samsung / LG 海外电视 (如有)

## 10. MVP vs 完整版分阶段

### MVP (本设计, 2 周)
- DLNA 发现 + SOAP 控制
- 本地 HTTP server
- 3 种视频源投屏
- 基础 UI (按钮 + 设备列表 + 状态条)

### V2 (1 周)
- 投屏进度回传 (SOAP Subscribe + GetTransportInfo)
- 断线重连
- 多设备管理 (记住上次的电视, 自动连)

### V3 (1 周)
- 字幕 / 倍速同步
- 投屏历史记录
- 设备分组 / 收藏

## 11. 验收标准 (MVP)

- [ ] 视频页能搜到至少一款电视 / 盒子
- [ ] 选电视后, 3 秒内电视开始播视频
- [ ] 官方 / 用户上传 / 百度网盘 3 种视频源都能投
- [ ] 投屏期间, 手机端可以退出页面, 不影响电视播放
- [ ] 投屏期间, 停止按钮能正常让电视停
- [ ] 投屏失败时, 错误信息清晰 (没连 WiFi / 找不到设备 / 服务异常)
- [ ] 退出视频页自动停投屏 + 关 HTTP server
- [ ] 重新进入视频页, 状态正确重置

## 12. 决策记录 (历史拍板)

1. ✅ DLNA 协议 (已选)
2. ✅ 3 种视频源一次到位 (已选, 走本地缓存)
3. ✅ 不做进度同步 (已选)
4. ✅ **`react-native-static-server` 接受度** (2026-08-12 拍板) — 选 C: 备选 + 选型不变, PoC 优先验证; 不行就用 Kotlin `ServerSocket` 自写 mini HTTP server (Range header 走 `RandomAccessFile.seek()` 手动实现, +0.5 天)
5. ✅ **Android 原生模块自写 SSDP** (2026-08-12 拍板) — 接受, 走标准 `ReactPackage` 注册到 `MainApplication.kt`
6. ✅ **联调用真机, 不走 emulator** (2026-08-12 拍板) — Android emulator 不支持 IGMP/multicast, 设备用户自备
7. ✅ **PoC 必跑 3 步验收** (2026-08-12 拍板) — ① 互相能搜到 ② 推 50MB MP4 3 秒内开播 ③ VLC 拖进度条到 80% 能正常 seek

### 12.1 2026-08-12 联网自检关键发现 (8 环节)

| # | 环节 | 结论 | 设计影响 |
|---|---|---|---|
| 1 | Expo SDK 55 + Kotlin 原生模块 | ✅ 100% | 0 |
| 2 | `react-native-static-server` RN 0.83 | ⚠️ 需 PoC | 决策 4 |
| 3 | `react-native-network-info` | ✅ 95% | 加 `ACCESS_WIFI_STATE` 权限 |
| 4 | SSDP M-SEARCH + MulticastLock | ✅ 95% | 原生模块 try-finally 包锁; `InetAddress.getLocalHost()` 不可用, 必须走 `NetworkInterface.getByName("wlan0")` |
| 5 | SetAVTransportURI SOAP | ✅ 100% | `CurrentURIMetadata` 只写 `<dc:title>`, 不加花里胡哨 DIDL-Lite |
| 6 | Range header | ✅ 100% | NanoHTTPD 默认支持, PoC 必验 seek |
| 7 | VLC for Android DMR | ✅ 100% | 用真机装 VLC, 跟 §8 绑定 |
| 8 | MuMu emulator SSDP | ❌ 0% | **emulator 联调路径作废**, 决策 6 |

## 13. 计划提交

设计定稿后, 按以下顺序开干:

### Phase 0: PoC 必跑 3 步 (1.5 天, 不写产品代码)
1. 起一个 RN debug build 装到真机
2. 写最小 `SsdpDiscoveryModule.kt` (只搜 `ssdp:all` + 解析 LOCATION 头, 不解析 XML)
3. **PoC 验收 ①**: 开发真机 + 装 VLC 的真机 同 WiFi 互搜, 能在 logcat 看到对方 `LOCATION` 头
4. 加 `react-native-static-server` 依赖, 跑 `new StaticServer(0, videoCacheDir, {localOnly: false})` 起来
5. **PoC 验收 ②**: VLC 装上, 从 NativeOS 推一个 50MB MP4 给 VLC, 3 秒内开播
6. **PoC 验收 ③**: VLC 拖进度条到 80% 能正常 seek (验 Range header)
7. 任意一步不过 → 决策 4 的备选方案顶上 (Kotlin `ServerSocket` 自写), 过了再继续

### Phase 1: 骨架 (4 天)
1. 写完整 SSDP 原生模块 (含 XML 解析 + MulticastLock 正确时序)
2. 写 DLNA 设备描述解析 (`xml-parser.ts`)
3. 写 SOAP 客户端 (Set / Play / Pause / Stop + Seek 占位)
4. 写本地 HTTP server 封装 (`http-server.ts`)
5. 写 `useCastStore` (zustand) + 状态机
6. 写 `castManager` 编排
7. 跑通"搜设备 → 选设备 → 投屏 → 停"完整链路 (用 VLC 收)

### Phase 2: 集成 (1.5 天)
1. 集成到 `app/scenario/video/[id].tsx` (CastButton + CastStatusBar)
2. 接入 3 种视频源 (官方 / 用户上传 / 百度网盘)
3. `AndroidManifest.xml` 加权限 (见 §7.3)
4. 退出视频页自动 stop + 关 HTTP server

### Phase 3: 联调 (3 天, 真机 + 真电视)
1. 用户的真电视 / 盒子 兼容性测试
2. 国产电视 (小米 / 天猫 / 海信) 重点
3. Samsung / LG 海外电视 (如有)
4. 各品牌 seek 行为测试

### Phase 4: 打磨 (1 天)
1. 错误状态 (没连 WiFi / 找不到设备 / 服务异常)
2. UI 细节
3. 单元测试 + 文档

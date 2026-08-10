import { getBaiduPanAppConfig, getBaiduPanBinding } from './cloud-drive-bindings';

const BAIDU_TRANSCODE_SUBMIT_BASES = ['https://apaas.baidu.com', 'https://pan.baidu.com'];
const BAIDU_TRANSCODE_QUERY_BASES = ['https://pan.baidu.com', 'https://apaas.baidu.com'];
const BAIDU_TRANSCODE_QUERY_TOKEN_KEYS = ['access_token', 'spacetoken'] as const;
const BAIDU_TRANSCODE_POLL_INTERVAL_MS = 2000;
const BAIDU_TRANSCODE_MAX_POLL_ATTEMPTS = 90;
const BAIDU_TRANSCODE_DEFAULT_VIDEO_PARAM = {
  container: { format: 'mp4' },
  video: {
    codec: 'H264',
    bitrate: '300',
    crf: 28,
    width: 640,
    height: 360,
    frame_rate: 15,
  },
  audio: {
    codec: 'aac',
    bitrate: 64,
    samplerate: 16000,
    channels: 1,
  },
  segment: {
    duration: 10,
  },
};

type BaiduPanTranscodeSubmitResponse = {
  errno?: number;
  err_msg?: string;
  errmsg?: string;
  show_msg?: string;
  result?: {
    taskid?: string;
    task_id?: string;
  };
};

type BaiduPanTranscodeQueryItem = {
  task_id?: string;
  taskid?: string;
  dlink?: string;
  errno?: number;
  err_msg?: string;
  errmsg?: string;
  process?: number | string;
  extra?: string;
};

type BaiduPanTranscodeQueryResponse = {
  errno?: number;
  err_msg?: string;
  errmsg?: string;
  show_msg?: string;
  result?: BaiduPanTranscodeQueryItem[];
};

export type BaiduPanOfficialTranscodedSource = {
  taskId: string;
  dlink: string;
  process: number;
};

function getErrorMessage(value: { err_msg?: string; errmsg?: string; show_msg?: string; errno?: number }) {
  return value.err_msg || value.errmsg || value.show_msg || (typeof value.errno === 'number' ? `errno ${value.errno}` : '请求失败');
}

function normalizeProcess(value: number | string | undefined) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildTaskIdsCandidates(taskId: string) {
  return [
    JSON.stringify([taskId]),
    `[${taskId}]`,
    taskId,
  ];
}

function summarizeValue(value: string, maxLength: number = 240) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...<truncated>`;
}

function headersToObject(headers: Headers) {
  return Object.fromEntries(Array.from(headers.entries()));
}

async function waitMs(durationMs: number) {
  await new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function readJsonResponse<T>(response: Response, fallbackLabel: string): Promise<T> {
  const raw = await response.text();
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${fallbackLabel}返回了无法解析的响应: ${raw.slice(0, 300)}`);
  }
}

async function submitTranscodeTask(params: {
  accessToken: string;
  appId: string;
  path: string;
}): Promise<string> {
  let lastError: unknown = null;
  const videoParam = JSON.stringify(BAIDU_TRANSCODE_DEFAULT_VIDEO_PARAM);

  console.log('[BaiduPanOfficialTranscode] submit start', {
    appId: params.appId,
    path: params.path,
    baseCandidates: BAIDU_TRANSCODE_SUBMIT_BASES,
  });

  for (const baseUrl of BAIDU_TRANSCODE_SUBMIT_BASES) {
    try {
      const query = new URLSearchParams({
        appid: params.appId,
        access_token: params.accessToken,
      });
      const submitUrl = `${baseUrl}/apaas/1.0/bas/streaming/trans?${query.toString()}`;
      const requestHeaders = {
        'User-Agent': 'pan.baidu.com',
      };
      const formData = new FormData();
      formData.append('video_param', videoParam);
      formData.append('path', params.path);
      console.log('[BaiduPanOfficialTranscode] submit attempt', {
        baseUrl,
        path: params.path,
      });
      console.log('[BaiduPanOfficialTranscode] submit request detail', {
        url: submitUrl,
        method: 'POST',
        headers: requestHeaders,
        form: {
          video_param: videoParam,
          path: params.path,
        },
      });
      const response = await fetch(submitUrl, {
        method: 'POST',
        headers: requestHeaders,
        body: formData,
      });
      const rawResponse = await response.text();
      console.log('[BaiduPanOfficialTranscode] submit response detail', {
        url: submitUrl,
        status: response.status,
        statusText: response.statusText,
        headers: headersToObject(response.headers),
        body: rawResponse,
      });
      let json: BaiduPanTranscodeSubmitResponse;
      try {
        json = JSON.parse(rawResponse) as BaiduPanTranscodeSubmitResponse;
      } catch {
        throw new Error(`百度网盘转码任务发布接口返回了无法解析的响应: ${rawResponse}`);
      }
      if (json.errno !== 0) {
        throw new Error(getErrorMessage(json));
      }
      const taskId = json.result?.taskid || json.result?.task_id;
      if (!taskId) {
        throw new Error('百度网盘转码任务发布成功但未返回 taskid');
      }
      console.log('[BaiduPanOfficialTranscode] submit success', {
        baseUrl,
        taskId,
      });
      return taskId;
    } catch (error) {
      lastError = error;
      console.warn('[BaiduPanOfficialTranscode] submit attempt failed', {
        baseUrl,
        path: params.path,
        error: error instanceof Error ? error.message : String(error || ''),
      });
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError || '百度网盘转码任务发布失败'));
}

async function queryTranscodeTask(params: {
  accessToken: string;
  appId: string;
  taskId: string;
}): Promise<BaiduPanOfficialTranscodedSource> {
  let lastError: unknown = null;
  for (const baseUrl of BAIDU_TRANSCODE_QUERY_BASES) {
    for (const tokenKey of BAIDU_TRANSCODE_QUERY_TOKEN_KEYS) {
      for (const taskIds of buildTaskIdsCandidates(params.taskId)) {
        try {
          console.log('[BaiduPanOfficialTranscode] query attempt', {
            baseUrl,
            tokenKey,
            taskIds: summarizeValue(taskIds),
            taskId: params.taskId,
          });
          const query = new URLSearchParams({
            appid: params.appId,
            task_ids: taskIds,
          });
          query.set(tokenKey, params.accessToken);
          const response = await fetch(`${baseUrl}/apaas/1.0/file/streaming/query?${query.toString()}`, {
            method: 'GET',
            headers: {
              'User-Agent': 'pan.baidu.com',
            },
          });
          const json = await readJsonResponse<BaiduPanTranscodeQueryResponse>(response, '百度网盘转码任务查询接口');
          if (json.errno !== 0) {
            throw new Error(getErrorMessage(json));
          }
          const item = Array.isArray(json.result) ? json.result[0] : null;
          if (!item) {
            throw new Error('百度网盘转码任务查询成功但未返回任务详情');
          }
          if (typeof item.errno === 'number' && item.errno !== 0) {
            throw new Error(getErrorMessage(item));
          }
          console.log('[BaiduPanOfficialTranscode] query success', {
            baseUrl,
            tokenKey,
            taskIds: summarizeValue(taskIds),
            taskId: item.task_id || item.taskid || params.taskId,
            process: normalizeProcess(item.process),
            hasDlink: Boolean(item.dlink),
          });
          return {
            taskId: item.task_id || item.taskid || params.taskId,
            dlink: item.dlink || '',
            process: normalizeProcess(item.process),
          };
        } catch (error) {
          lastError = error;
          console.warn('[BaiduPanOfficialTranscode] query attempt failed', {
            baseUrl,
            tokenKey,
            taskIds: summarizeValue(taskIds),
            taskId: params.taskId,
            error: error instanceof Error ? error.message : String(error || ''),
          });
        }
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError || '百度网盘转码任务查询失败'));
}

export async function requestBaiduPanOfficialTranscodedSource(params: {
  remotePath: string;
}): Promise<BaiduPanOfficialTranscodedSource> {
  const [binding, appConfig] = await Promise.all([
    getBaiduPanBinding(),
    getBaiduPanAppConfig(),
  ]);
  const accessToken = binding?.token?.accessToken;
  const appId = appConfig.appNumericId?.trim();
  if (!accessToken) {
    throw new Error('百度网盘尚未授权');
  }
  if (!appId) {
    throw new Error('百度网盘 appid 未配置');
  }

  const taskId = await submitTranscodeTask({
    accessToken,
    appId,
    path: params.remotePath,
  });

  for (let attempt = 0; attempt < BAIDU_TRANSCODE_MAX_POLL_ATTEMPTS; attempt += 1) {
    console.log('[BaiduPanOfficialTranscode] poll tick', {
      taskId,
      attempt: attempt + 1,
      maxAttempts: BAIDU_TRANSCODE_MAX_POLL_ATTEMPTS,
      remotePath: params.remotePath,
    });
    const status = await queryTranscodeTask({
      accessToken,
      appId,
      taskId,
    });
    if (status.process >= 100 && status.dlink) {
      console.log('[BaiduPanOfficialTranscode] poll complete', {
        taskId,
        process: status.process,
        dlinkPreview: summarizeValue(status.dlink),
      });
      return status;
    }
    console.log('[BaiduPanOfficialTranscode] poll pending', {
      taskId,
      process: status.process,
      hasDlink: Boolean(status.dlink),
    });
    await waitMs(BAIDU_TRANSCODE_POLL_INTERVAL_MS);
  }

  throw new Error('百度网盘转码任务超时，未在预期时间内完成');
}

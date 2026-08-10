const BAIDU_PCS_BASE = 'https://pan.baidu.com/rest/2.0/xpan';

export type BaiduPanFsItem = {
  fsId: number;
  path: string;
  name: string;
  isDirectory: boolean;
  size: number;
};

export type BaiduPanVideoItem = {
  fsId: number;
  path: string;
  name: string;
  size: number;
  thumbnailUrl?: string;
};

export async function listBaiduPanDirectory(
  accessToken: string,
  dir: string,
): Promise<BaiduPanFsItem[]> {
  const params = new URLSearchParams({
    method: 'list',
    dir,
    access_token: accessToken,
    num: '100',
    page: '1',
    order: 'name',
    desc: '0',
  });
  const resp = await fetch(`${BAIDU_PCS_BASE}/file?${params.toString()}`, {
    headers: { 'User-Agent': 'pan.baidu.com' },
  });
  const json = await resp.json() as { errno: number; list?: unknown[] };
  if (json.errno !== 0) {
    throw new Error(`百度网盘列表失败 (errno ${json.errno})`);
  }
  const list = Array.isArray(json.list) ? json.list : [];
  return (list as Array<{
    fs_id: number;
    path: string;
    server_filename: string;
    isdir: number;
    size: number;
  }>)
    .map((item) => ({
      fsId: item.fs_id,
      path: item.path,
      name: item.server_filename,
      isDirectory: item.isdir === 1,
      size: item.size || 0,
    }))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
}

export async function listBaiduPanVideos(
  accessToken: string,
  parentPath: string,
): Promise<BaiduPanVideoItem[]> {
  const params = new URLSearchParams({
    method: 'videolist',
    parent_path: parentPath,
    access_token: accessToken,
    web: '1',
    recursion: '1',
  });
  const resp = await fetch(`${BAIDU_PCS_BASE}/file?${params.toString()}`, {
    headers: { 'User-Agent': 'pan.baidu.com' },
  });
  const json = await resp.json() as { errno: number; info?: unknown[] };
  if (json.errno !== 0) {
    throw new Error(`百度网盘视频列表失败 (errno ${json.errno})`);
  }
  const info = Array.isArray(json.info) ? json.info : [];
  return (info as Array<{
    fs_id: number;
    path: string;
    server_filename: string;
    size: number;
    thumbs?: {
      url3?: string;
      url2?: string;
      url1?: string;
      icon?: string;
    };
  }>)
    .map((item) => ({
      fsId: item.fs_id,
      path: item.path,
      name: item.server_filename,
      size: item.size || 0,
      thumbnailUrl: item.thumbs?.url2 || item.thumbs?.url1 || item.thumbs?.url3 || item.thumbs?.icon,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

export async function getBaiduPanDownloadLink(
  accessToken: string,
  fsId: number,
): Promise<string> {
  const params = new URLSearchParams({
    method: 'filemetas',
    fsids: JSON.stringify([fsId]),
    dlink: '1',
    access_token: accessToken,
  });
  const resp = await fetch(`${BAIDU_PCS_BASE}/multimedia?${params.toString()}`, {
    headers: { 'User-Agent': 'pan.baidu.com' },
  });
  const json = await resp.json() as { errno: number; info?: Array<{ dlink?: string }> };
  if (json.errno !== 0) {
    throw new Error(`百度网盘获取下载链接失败 (errno ${json.errno})`);
  }
  const dlink = json.info?.[0]?.dlink;
  if (!dlink) {
    throw new Error('百度网盘未返回下载链接');
  }
  return dlink;
}

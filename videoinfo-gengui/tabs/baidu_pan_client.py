from __future__ import annotations

import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

DEFAULT_REDIRECT_URI = 'oob'
DEFAULT_SCOPE = 'basic,netdisk'
DEFAULT_DISPLAY = 'popup'
DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024
AUTHORIZE_URL = 'https://openapi.baidu.com/oauth/2.0/authorize'
TOKEN_URL = 'https://openapi.baidu.com/oauth/2.0/token'
PRECREATE_URL = 'https://pan.baidu.com/rest/2.0/xpan/file'
CREATE_URL = 'https://pan.baidu.com/rest/2.0/xpan/file'
LOCATE_UPLOAD_URL = 'https://d.pcs.baidu.com/rest/2.0/pcs/file'


class BaiduPanApiError(RuntimeError):
    pass


@dataclass
class FileChunk:
    index: int
    offset: int
    size: int
    md5: str


@dataclass
class FileUploadPlan:
    local_path: Path
    size: int
    content_md5: str
    slice_md5: str
    block_list: list[str]
    chunks: list[FileChunk]


@dataclass
class BaiduPanFsItem:
    fs_id: int
    path: str
    name: str
    is_directory: bool
    size: int


class BaiduPanClient:
    def __init__(self, app_id: str, access_token: str) -> None:
        self.app_id = str(app_id or '').strip()
        self.access_token = str(access_token or '').strip()
        if not self.access_token:
            raise ValueError('百度网盘 Access Token 不能为空。')

    @staticmethod
    def build_implicit_authorize_url(
        client_id: str,
        redirect_uri: str = DEFAULT_REDIRECT_URI,
        scope: str = DEFAULT_SCOPE,
        display: str = DEFAULT_DISPLAY,
        state: str = '',
    ) -> str:
        app_key = str(client_id or '').strip()
        if not app_key:
            raise ValueError('百度网盘 App Key 不能为空。')
        query = {
            'response_type': 'token',
            'client_id': app_key,
            'redirect_uri': redirect_uri or DEFAULT_REDIRECT_URI,
            'scope': scope or DEFAULT_SCOPE,
        }
        if display:
            query['display'] = display
        if state:
            query['state'] = state
        return f'{AUTHORIZE_URL}?{urllib.parse.urlencode(query)}'

    @staticmethod
    def build_authorize_code_url(
        client_id: str,
        redirect_uri: str = DEFAULT_REDIRECT_URI,
        scope: str = DEFAULT_SCOPE,
        display: str = DEFAULT_DISPLAY,
        state: str = '',
    ) -> str:
        app_key = str(client_id or '').strip()
        if not app_key:
            raise ValueError('百度网盘 App Key 不能为空。')
        query = {
            'response_type': 'code',
            'client_id': app_key,
            'redirect_uri': redirect_uri or DEFAULT_REDIRECT_URI,
            'scope': scope or DEFAULT_SCOPE,
        }
        if display:
            query['display'] = display
        if state:
            query['state'] = state
        return f'{AUTHORIZE_URL}?{urllib.parse.urlencode(query)}'

    @staticmethod
    def parse_implicit_redirect_payload(raw_value: str) -> dict[str, str]:
        text = str(raw_value or '').strip()
        if not text:
            raise ValueError('请粘贴浏览器最终跳转后的完整 URL 或 # 后面的片段。')
        token = BaiduPanClient._extract_oauth_param(text, 'access_token')
        if not token:
            raise ValueError('未能从回跳内容中解析到 access_token。')
        result = {
            'access_token': token,
            'expires_in': BaiduPanClient._extract_oauth_param(text, 'expires_in') or '',
            'session_secret': BaiduPanClient._extract_oauth_param(text, 'session_secret') or '',
            'session_key': BaiduPanClient._extract_oauth_param(text, 'session_key') or '',
            'scope': (BaiduPanClient._extract_oauth_param(text, 'scope') or '').replace('+', ' '),
            'obtained_at': str(int(time.time())),
        }
        expires_in = result['expires_in']
        if expires_in.isdigit():
            result['expires_at'] = str(int(result['obtained_at']) + int(expires_in))
        else:
            result['expires_at'] = ''
        return result

    @staticmethod
    def parse_authorize_code_redirect(raw_value: str) -> dict[str, str]:
        text = str(raw_value or '').strip()
        if not text:
            raise ValueError('授权回跳内容不能为空。')
        error = BaiduPanClient._extract_oauth_param(text, 'error') or ''
        if error:
            description = BaiduPanClient._extract_oauth_param(text, 'error_description') or ''
            raise ValueError(description or error)
        code = BaiduPanClient._extract_oauth_param(text, 'code') or ''
        if not code:
            match = re.search(r'(?:授权码|code)\s*[:：]\s*([A-Za-z0-9._-]+)', text, flags=re.IGNORECASE)
            code = urllib.parse.unquote(match.group(1)).strip() if match else ''
        if not code:
            raise ValueError('未能从授权回跳内容中解析到 code。')
        return {
            'code': code,
            'state': BaiduPanClient._extract_oauth_param(text, 'state') or '',
        }

    @staticmethod
    def is_oauth_callback_candidate(url: str, redirect_uri: str = '') -> bool:
        text = str(url or '').strip()
        if not text:
            return False
        if 'access_token=' in text or re.search(r'(?:\?|&)code=', text) or text.startswith('oob'):
            return True
        redirect = str(redirect_uri or '').strip()
        if not redirect or redirect == 'oob':
            return False
        return text.startswith(redirect)

    @staticmethod
    def _extract_oauth_param(raw: str, key: str) -> str | None:
        text = str(raw or '')
        if not text:
            return None
        escaped_key = re.escape(key)
        match = re.search(rf'(?:^|[?#&\s]){escaped_key}=([^&#\s]+)', text)
        if not match:
            return None
        return urllib.parse.unquote(match.group(1)).strip()

    @staticmethod
    def _request_oauth_token(query: dict[str, str]) -> dict[str, str]:
        url = f'{TOKEN_URL}?{urllib.parse.urlencode(query)}'
        request = urllib.request.Request(url, headers={'User-Agent': 'pan.baidu.com'})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = json.loads(response.read().decode('utf-8', errors='replace'))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode('utf-8', errors='replace')
            raise BaiduPanApiError(f'获取百度授权 token 失败（HTTP {exc.code}）: {body}') from exc
        except urllib.error.URLError as exc:
            raise BaiduPanApiError(f'获取百度授权 token 失败: {exc}') from exc
        if not isinstance(payload, dict):
            raise BaiduPanApiError(f'百度授权 token 返回格式异常: {payload}')
        if payload.get('error'):
            raise BaiduPanApiError(str(payload.get('error_description') or payload.get('error')))
        result = {str(key): str(value) for key, value in payload.items() if value is not None}
        result['obtained_at'] = str(int(time.time()))
        expires_in = result.get('expires_in', '')
        if expires_in.isdigit():
            result['expires_at'] = str(int(result['obtained_at']) + int(expires_in))
        else:
            result['expires_at'] = ''
        return result

    @staticmethod
    def exchange_authorization_code(client_id: str, client_secret: str, code: str, redirect_uri: str) -> dict[str, str]:
        app_key = str(client_id or '').strip()
        secret_key = str(client_secret or '').strip()
        auth_code = str(code or '').strip()
        if not app_key:
            raise ValueError('百度网盘 App Key 不能为空。')
        if not secret_key:
            raise ValueError('百度网盘 App Secret 不能为空。')
        if not auth_code:
            raise ValueError('授权 code 不能为空。')
        return BaiduPanClient._request_oauth_token(
            {
                'grant_type': 'authorization_code',
                'code': auth_code,
                'client_id': app_key,
                'client_secret': secret_key,
                'redirect_uri': redirect_uri or DEFAULT_REDIRECT_URI,
            }
        )

    @staticmethod
    def refresh_access_token(client_id: str, client_secret: str, refresh_token: str) -> dict[str, str]:
        app_key = str(client_id or '').strip()
        secret_key = str(client_secret or '').strip()
        refresh = str(refresh_token or '').strip()
        if not app_key:
            raise ValueError('百度网盘 App Key 不能为空。')
        if not secret_key:
            raise ValueError('百度网盘 App Secret 不能为空。')
        if not refresh:
            raise ValueError('百度网盘 Refresh Token 不能为空。')
        return BaiduPanClient._request_oauth_token(
            {
                'grant_type': 'refresh_token',
                'refresh_token': refresh,
                'client_id': app_key,
                'client_secret': secret_key,
            }
        )

    @staticmethod
    def normalize_remote_root(remote_root: str) -> str:
        value = str(remote_root or '').strip()
        if not value:
            raise ValueError('百度网盘上传目录不能为空。')
        if not value.startswith('/'):
            value = '/' + value
        return value.rstrip('/')

    @staticmethod
    def build_remote_file_path(remote_root: str, relative_suffix: str) -> str:
        root = BaiduPanClient.normalize_remote_root(remote_root)
        suffix = str(relative_suffix or '').replace('\\', '/').strip('/ ')
        if not suffix:
            raise ValueError('远端文件相对路径不能为空。')
        return f'{root}/{suffix}'

    def list_directory(self, dir_path: str) -> list[BaiduPanFsItem]:
        normalized_dir = self.normalize_remote_root(dir_path or '/') if str(dir_path or '').strip() not in {'', '/'} else '/'
        query = urllib.parse.urlencode(
            {
                'method': 'list',
                'dir': normalized_dir,
                'access_token': self.access_token,
                'num': '100',
                'page': '1',
                'order': 'name',
                'desc': '0',
            }
        )
        payload = self._request_json(f'{PRECREATE_URL}?{query}', headers={'User-Agent': 'pan.baidu.com'})
        entries = payload.get('list')
        if not isinstance(entries, list):
            return []
        result = [
            BaiduPanFsItem(
                fs_id=int(item.get('fs_id') or 0),
                path=str(item.get('path') or ''),
                name=str(item.get('server_filename') or ''),
                is_directory=int(item.get('isdir') or 0) == 1,
                size=int(item.get('size') or 0),
            )
            for item in entries
            if isinstance(item, dict)
        ]
        result.sort(key=lambda item: (0 if item.is_directory else 1, item.name.lower()))
        return result

    @staticmethod
    def analyze_file(local_path: Path, chunk_size: int = DEFAULT_CHUNK_SIZE) -> FileUploadPlan:
        path = Path(local_path)
        size = path.stat().st_size
        content_md5 = hashlib.md5()
        block_list: list[str] = []
        chunks: list[FileChunk] = []
        offset = 0
        index = 0
        with path.open('rb') as fh:
            while True:
                chunk = fh.read(chunk_size)
                if not chunk:
                    break
                content_md5.update(chunk)
                block_md5 = hashlib.md5(chunk).hexdigest()
                block_list.append(block_md5)
                chunks.append(FileChunk(index=index, offset=offset, size=len(chunk), md5=block_md5))
                offset += len(chunk)
                index += 1
        if not chunks:
            empty_md5 = hashlib.md5(b'').hexdigest()
            chunks = [FileChunk(index=0, offset=0, size=0, md5=empty_md5)]
            block_list = [empty_md5]
        if len(chunks) > 1024:
            raise ValueError('百度网盘普通上传分片数量不得超过 1024。')
        return FileUploadPlan(
            local_path=path,
            size=size,
            content_md5=content_md5.hexdigest(),
            slice_md5=block_list[0],
            block_list=block_list,
            chunks=chunks,
        )

    def precreate_file(self, remote_path: str, plan: FileUploadPlan, rtype: int = 3) -> dict[str, Any]:
        payload = {
            'path': remote_path,
            'size': str(plan.size),
            'isdir': '0',
            'autoinit': '1',
            'rtype': str(rtype),
            'block_list': json.dumps(plan.block_list, ensure_ascii=False),
            'content-md5': plan.content_md5,
            'slice-md5': plan.slice_md5,
        }
        return self._request_json(
            f'{PRECREATE_URL}?method=precreate&access_token={urllib.parse.quote(self.access_token, safe="")}',
            method='POST',
            data=urllib.parse.urlencode(payload).encode('utf-8'),
            headers={'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'pan.baidu.com'},
        )

    def locate_upload_host(self, remote_path: str, uploadid: str) -> str:
        if not self.app_id:
            raise ValueError('百度网盘 App ID 不能为空。')
        query = urllib.parse.urlencode({
            'method': 'locateupload',
            'appid': self.app_id,
            'access_token': self.access_token,
            'path': remote_path,
            'uploadid': uploadid,
            'upload_version': '2.0',
        })
        data = self._request_json(f'{LOCATE_UPLOAD_URL}?{query}', headers={'User-Agent': 'pan.baidu.com'})
        server_lists = []
        for key in ('servers', 'quic_servers', 'bak_servers'):
            value = data.get(key)
            if isinstance(value, list):
                server_lists.extend(value)
        for item in server_lists:
            server = str((item or {}).get('server') or '').strip()
            if server.startswith('https://'):
                return server.rstrip('/')
        host = str(data.get('host') or '').strip()
        if host:
            return f'https://{host}'
        raise BaiduPanApiError(f'获取上传域名失败: {json.dumps(data, ensure_ascii=False)}')

    def upload_tmpfile(self, upload_host: str, remote_path: str, uploadid: str, partseq: int, chunk_bytes: bytes) -> dict[str, Any]:
        query = urllib.parse.urlencode({
            'method': 'upload',
            'access_token': self.access_token,
            'type': 'tmpfile',
            'path': remote_path,
            'uploadid': uploadid,
            'partseq': str(partseq),
        })
        url = f'{upload_host.rstrip("/")}/rest/2.0/pcs/superfile2?{query}'
        boundary = f'----DeckMind{uuid.uuid4().hex}'
        body = b''.join([
            f'--{boundary}\r\n'.encode('utf-8'),
            b'Content-Disposition: form-data; name="file"; filename="blob"\r\n',
            b'Content-Type: application/octet-stream\r\n\r\n',
            chunk_bytes,
            b'\r\n',
            f'--{boundary}--\r\n'.encode('utf-8'),
        ])
        return self._request_json(
            url,
            method='POST',
            data=body,
            headers={
                'Content-Type': f'multipart/form-data; boundary={boundary}',
                'User-Agent': 'pan.baidu.com',
            },
            timeout=300,
        )

    def create_file(self, remote_path: str, plan: FileUploadPlan, uploadid: str, rtype: int = 3) -> dict[str, Any]:
        payload = {
            'path': remote_path,
            'size': str(plan.size),
            'isdir': '0',
            'rtype': str(rtype),
            'uploadid': uploadid,
            'block_list': json.dumps(plan.block_list, ensure_ascii=False),
        }
        return self._request_json(
            f'{CREATE_URL}?method=create&access_token={urllib.parse.quote(self.access_token, safe="")}',
            method='POST',
            data=urllib.parse.urlencode(payload).encode('utf-8'),
            headers={'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'pan.baidu.com'},
        )

    def _request_json(
        self,
        url: str,
        *,
        method: str = 'GET',
        data: bytes | None = None,
        headers: dict[str, str] | None = None,
        timeout: int = 120,
    ) -> dict[str, Any]:
        request = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read().decode('utf-8', errors='replace')
        except urllib.error.HTTPError as exc:
            body = exc.read().decode('utf-8', errors='replace')
            raise BaiduPanApiError(f'HTTP {exc.code}: {body}') from exc
        except urllib.error.URLError as exc:
            raise BaiduPanApiError(f'网络请求失败: {exc}') from exc
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise BaiduPanApiError(f'接口返回了非 JSON 内容: {raw[:300]}') from exc
        errno = payload.get('errno')
        error_code = payload.get('error_code')
        if (isinstance(errno, int) and errno != 0) or (isinstance(error_code, int) and error_code != 0):
            raise BaiduPanApiError(json.dumps(payload, ensure_ascii=False))
        return payload

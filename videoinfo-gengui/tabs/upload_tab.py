from __future__ import annotations

import base64
import http.server
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from PySide6.QtCore import QThread, Signal, Qt, QUrl
from PySide6.QtWidgets import (
    QAbstractItemView,
    QDialog,
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QInputDialog,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QPlainTextEdit,
    QProgressBar,
    QPushButton,
    QTabWidget,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

try:
    from PySide6.QtWebEngineWidgets import QWebEngineView
except ImportError:
    QWebEngineView = None

from tabs.baidu_pan_client import BaiduPanApiError, BaiduPanClient, DEFAULT_REDIRECT_URI
from tabs.runtime_support import load_json_config, save_json_config

DRIVE_VIDEO_SUFFIXES = ('.mp4',)
LEGACY_BAIDU_LOCAL_REDIRECT = 'http://127.0.0.1:53682/baidu_oauth_callback'

def load_oss_config() -> dict[str, str]:
    data = load_json_config()
    return data.get('oss', {})


def save_oss_config(cfg: dict[str, str]) -> None:
    save_json_config({'oss': cfg})


def load_baidu_pan_config() -> dict[str, str]:
    data = load_json_config()
    return data.get('baidu_pan', {})


def save_baidu_pan_config(cfg: dict[str, str]) -> None:
    save_json_config({'baidu_pan': cfg})


def load_pan123_config() -> dict[str, str]:
    data = load_json_config()
    return data.get('pan123', {})


def save_pan123_config(cfg: dict[str, str]) -> None:
    save_json_config({'pan123': cfg})


# ---------------------------------------------------------------------------
# 上传线程
# ---------------------------------------------------------------------------

class UploadWorker(QThread):
    log_line = Signal(str)
    progress = Signal(int, int)  # current_index, total
    finished_signal = Signal()

    def __init__(self, bucket, files: list[tuple[Path, str]]) -> None:
        super().__init__()
        self.bucket = bucket
        self.files = files  # [(local_path, oss_key), ...]
        self._paused = False
        self._stopped = False

    def run(self) -> None:
        try:
            total = len(self.files)
            self.log_line.emit(f'上传线程已启动，共 {total} 个文件')
            for i, (local_path, oss_key) in enumerate(self.files):
                if self._stopped:
                    self.log_line.emit('[停止] 上传已终止')
                    break
                while self._paused:
                    self.msleep(200)
                    if self._stopped:
                        break
                self.log_line.emit(f'[{i + 1}/{total}] 上传 {local_path.name} → {oss_key}')
                try:
                    self.bucket.put_object_from_file(oss_key, str(local_path))
                    self.log_line.emit(f'  [完成] {local_path.name}')
                except Exception as exc:
                    self.log_line.emit(f'  [失败] {exc}')
                self.progress.emit(i + 1, total)
        except Exception as exc:
            self.log_line.emit(f'[错误] 上传线程异常: {exc}')
        finally:
            self.finished_signal.emit()

    def pause(self) -> None:
        self._paused = True
        self.log_line.emit('[暂停] 上传已暂停')

    def resume(self) -> None:
        self._paused = False
        self.log_line.emit('[继续] 上传已恢复')

    def stop(self) -> None:
        self._stopped = True

    @property
    def is_paused(self) -> bool:
        return self._paused


class BaiduPanUploadWorker(QThread):
    log_line = Signal(str)
    progress = Signal(int, int)
    finished_signal = Signal()

    def __init__(self, client: BaiduPanClient, remote_root: str, files: list[tuple[Path, str]]) -> None:
        super().__init__()
        self.client = client
        self.remote_root = remote_root
        self.files = files
        self._paused = False
        self._stopped = False

    def run(self) -> None:
        try:
            total = len(self.files)
            self.log_line.emit(f'百度网盘上传线程已启动，共 {total} 个文件')
            for index, (local_path, relative_suffix) in enumerate(self.files, start=1):
                if self._stopped:
                    self.log_line.emit('[停止] 百度网盘上传已终止')
                    break
                self._wait_if_paused()
                remote_path = BaiduPanClient.build_remote_file_path(self.remote_root, relative_suffix)
                self.log_line.emit(f'[{index}/{total}] 准备上传 {local_path.name} → {remote_path}')
                try:
                    plan = BaiduPanClient.analyze_file(local_path)
                    precreate = self.client.precreate_file(remote_path, plan)
                    uploadid = str(precreate.get('uploadid') or '').strip()
                    if not uploadid:
                        raise BaiduPanApiError(f'precreate 未返回 uploadid: {json.dumps(precreate, ensure_ascii=False)}')
                    upload_host = self.client.locate_upload_host(remote_path, uploadid)
                    self.log_line.emit(f'  [预上传成功] uploadid={uploadid[:24]}...')
                    self.log_line.emit(f'  [上传域名] {upload_host}')
                    with local_path.open('rb') as fh:
                        for chunk in plan.chunks:
                            if self._stopped:
                                break
                            self._wait_if_paused()
                            chunk_bytes = fh.read(chunk.size)
                            result = self.client.upload_tmpfile(upload_host, remote_path, uploadid, chunk.index, chunk_bytes)
                            server_md5 = str(result.get('md5') or '').strip().lower()
                            if server_md5 and server_md5 != chunk.md5.lower():
                                raise BaiduPanApiError(f'分片 {chunk.index} MD5 不匹配，本地 {chunk.md5}，服务端 {server_md5}')
                            self.log_line.emit(f'  [分片完成] {chunk.index + 1}/{len(plan.chunks)}')
                    if self._stopped:
                        self.log_line.emit('[停止] 百度网盘上传已终止')
                        break
                    created = self.client.create_file(remote_path, plan, uploadid)
                    self.log_line.emit(f'  [完成] {created.get("path") or remote_path}')
                except Exception as exc:
                    self.log_line.emit(f'  [失败] {exc}')
                self.progress.emit(index, total)
        except Exception as exc:
            self.log_line.emit(f'[错误] 百度网盘上传线程异常: {exc}')
        finally:
            self.finished_signal.emit()

    def _wait_if_paused(self) -> None:
        while self._paused and not self._stopped:
            self.msleep(200)

    def pause(self) -> None:
        self._paused = True
        self.log_line.emit('[暂停] 百度网盘上传已暂停')

    def resume(self) -> None:
        self._paused = False
        self.log_line.emit('[继续] 百度网盘上传已恢复')

    def stop(self) -> None:
        self._stopped = True

    @property
    def is_paused(self) -> bool:
        return self._paused


class WebDavUploadWorker(QThread):
    log_line = Signal(str)
    progress = Signal(int, int)
    finished_signal = Signal()

    def __init__(self, base_url: str, username: str, password: str, remote_root: str, files: list[tuple[Path, str]]) -> None:
        super().__init__()
        self.base_url = base_url.rstrip('/')
        self.username = username
        self.password = password
        self.remote_root = remote_root
        self.files = files
        self._paused = False
        self._stopped = False

    def _auth_header(self) -> str:
        token = base64.b64encode(f'{self.username}:{self.password}'.encode('utf-8')).decode('ascii')
        return f'Basic {token}'

    def _normalize_remote_path(self, relative_suffix: str) -> str:
        normalized_root = '/' + self.remote_root.strip().strip('/').replace('\\', '/') if self.remote_root.strip() != '/' else '/'
        suffix = relative_suffix.strip().lstrip('/').replace('\\', '/')
        if normalized_root == '/':
            return f'/{suffix}'.replace('//', '/')
        return f'{normalized_root}/{suffix}'.replace('//', '/')

    def _build_remote_url(self, remote_path: str) -> str:
        quoted_path = urllib.parse.quote(remote_path, safe='/')
        return f'{self.base_url}{quoted_path}'

    def _request(self, method: str, remote_path: str, data: bytes | None = None, headers: dict[str, str] | None = None) -> None:
        request_headers = {'Authorization': self._auth_header()}
        if headers:
            request_headers.update(headers)
        req = urllib.request.Request(self._build_remote_url(remote_path), data=data, headers=request_headers, method=method)
        with urllib.request.urlopen(req, timeout=180):
            return

    def _ensure_remote_dir(self, remote_dir: str) -> None:
        parts = [part for part in remote_dir.strip('/').split('/') if part]
        current = ''
        for part in parts:
            current = f'{current}/{part}'
            try:
                self._request('MKCOL', current)
            except urllib.error.HTTPError as exc:
                if exc.code in (200, 201, 301, 302, 405):
                    continue
                raise

    def _wait_if_paused(self) -> None:
        while self._paused and not self._stopped:
            self.msleep(200)

    def run(self) -> None:
        try:
            total = len(self.files)
            self.log_line.emit(f'123 网盘上传线程已启动，共 {total} 个文件')
            for index, (local_path, relative_suffix) in enumerate(self.files, start=1):
                if self._stopped:
                    self.log_line.emit('[停止] 123 网盘上传已终止')
                    break
                self._wait_if_paused()
                remote_path = self._normalize_remote_path(relative_suffix)
                remote_parent = str(Path(remote_path).parent).replace('\\', '/')
                if remote_parent and remote_parent != '.':
                    self._ensure_remote_dir(remote_parent)
                self.log_line.emit(f'[{index}/{total}] 上传 {local_path.name} → {remote_path}')
                try:
                    data = local_path.read_bytes()
                    self._request('PUT', remote_path, data=data, headers={'Content-Type': 'application/octet-stream'})
                    self.log_line.emit(f'  [完成] {remote_path}')
                except Exception as exc:
                    self.log_line.emit(f'  [失败] {exc}')
                self.progress.emit(index, total)
        except Exception as exc:
            self.log_line.emit(f'[错误] 123 网盘上传线程异常: {exc}')
        finally:
            self.finished_signal.emit()

    def pause(self) -> None:
        self._paused = True
        self.log_line.emit('[暂停] 123 网盘上传已暂停')

    def resume(self) -> None:
        self._paused = False
        self.log_line.emit('[继续] 123 网盘上传已继续')

    def stop(self) -> None:
        self._stopped = True
        self.log_line.emit('[停止] 正在停止 123 网盘上传…')


def normalize_webdav_path(path: str) -> str:
    text = str(path or '').strip().replace('\\', '/')
    if not text or text == '/':
        return '/'
    return '/' + text.strip('/')


class WebDavDirectoryClient:
    def __init__(self, base_url: str, username: str, password: str) -> None:
        self.base_url = base_url.rstrip('/')
        self.username = username
        self.password = password

    def _auth_header(self) -> str:
        token = base64.b64encode(f'{self.username}:{self.password}'.encode('utf-8')).decode('ascii')
        return f'Basic {token}'

    def _build_remote_url(self, remote_path: str) -> str:
        return f'{self.base_url}{urllib.parse.quote(normalize_webdav_path(remote_path), safe="/")}'

    def list_directories(self, remote_path: str) -> list[tuple[str, str]]:
        body = b'''<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:displayname/>
    <D:resourcetype/>
  </D:prop>
</D:propfind>'''
        req = urllib.request.Request(
            self._build_remote_url(remote_path),
            data=body,
            headers={
                'Authorization': self._auth_header(),
                'Depth': '1',
                'Content-Type': 'application/xml; charset=utf-8',
            },
            method='PROPFIND',
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = resp.read()
        root = ET.fromstring(payload)
        current_path = normalize_webdav_path(remote_path)
        items: list[tuple[str, str]] = []
        for response in root.findall('{DAV:}response'):
            href_node = response.find('{DAV:}href')
            if href_node is None or not href_node.text:
                continue
            propstat = response.find('{DAV:}propstat')
            prop = propstat.find('{DAV:}prop') if propstat is not None else None
            resource_type = prop.find('{DAV:}resourcetype') if prop is not None else None
            if resource_type is None or resource_type.find('{DAV:}collection') is None:
                continue
            href_path = urllib.parse.unquote(urllib.parse.urlparse(href_node.text).path)
            item_path = normalize_webdav_path(href_path)
            if item_path == current_path:
                continue
            name = item_path.rstrip('/').split('/')[-1] or item_path
            items.append((name, item_path))
        return sorted(items, key=lambda item: item[0].lower())


class WebDavDirectoryPickerDialog(QDialog):
    def __init__(self, client: WebDavDirectoryClient, initial_path: str, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.client = client
        self.selected_path = '/'
        self.current_path = normalize_webdav_path(initial_path)
        self.setWindowTitle('选择 123 网盘目录')
        self.resize(520, 420)
        layout = QVBoxLayout(self)
        self.path_label = QLabel()
        layout.addWidget(self.path_label)
        self.dir_list = QListWidget()
        self.dir_list.itemDoubleClicked.connect(self._open_selected_item)
        layout.addWidget(self.dir_list, 1)
        btn_row = QHBoxLayout()
        self.up_btn = QPushButton('上一级')
        self.up_btn.clicked.connect(self._go_parent)
        self.open_btn = QPushButton('进入所选目录')
        self.open_btn.clicked.connect(self._open_selected_item)
        self.select_btn = QPushButton('选择当前目录')
        self.select_btn.clicked.connect(self._select_current_path)
        cancel_btn = QPushButton('取消')
        cancel_btn.clicked.connect(self.reject)
        btn_row.addWidget(self.up_btn)
        btn_row.addWidget(self.open_btn)
        btn_row.addStretch(1)
        btn_row.addWidget(self.select_btn)
        btn_row.addWidget(cancel_btn)
        layout.addLayout(btn_row)
        self._load_directory(self.current_path)

    def _load_directory(self, path: str) -> None:
        self.current_path = normalize_webdav_path(path)
        self.path_label.setText(f'当前目录：{self.current_path}')
        self.dir_list.clear()
        try:
            items = self.client.list_directories(self.current_path)
        except Exception as exc:
            QMessageBox.warning(self, '加载 123 网盘目录失败', str(exc))
            return
        for name, item_path in items:
            row = QListWidgetItem(name)
            row.setData(Qt.ItemDataRole.UserRole, item_path)
            self.dir_list.addItem(row)
        self.up_btn.setEnabled(self.current_path != '/')
        self.open_btn.setEnabled(self.dir_list.count() > 0)

    def _go_parent(self) -> None:
        if self.current_path == '/':
            return
        parent = str(Path(self.current_path).parent).replace('\\', '/')
        self._load_directory(parent if parent and parent != '.' else '/')

    def _open_selected_item(self, _item: QListWidgetItem | None = None) -> None:
        item = self.dir_list.currentItem()
        if not item:
            return
        target_path = str(item.data(Qt.ItemDataRole.UserRole) or '').strip()
        if target_path:
            self._load_directory(target_path)

    def _select_current_path(self) -> None:
        self.selected_path = self.current_path
        self.accept()


class BaiduOAuthCallbackWorker(QThread):
    log_line = Signal(str)
    auth_code_received = Signal(str, str)
    error_signal = Signal(str)

    def __init__(self, redirect_uri: str, expected_state: str, timeout_seconds: int = 300) -> None:
        super().__init__()
        self.redirect_uri = redirect_uri
        self.expected_state = expected_state
        self.timeout_seconds = timeout_seconds
        self._stopped = False
        self._result: tuple[str, str] | None = None
        self._error_message = ''
        self._server: http.server.HTTPServer | None = None

    def stop(self) -> None:
        self._stopped = True
        if self._server:
            self._server.server_close()

    def run(self) -> None:
        parsed = urllib.parse.urlparse(self.redirect_uri)
        host = parsed.hostname or ''
        port = parsed.port
        callback_path = parsed.path or '/'
        if parsed.scheme != 'http' or not host or not port:
            self.error_signal.emit('百度授权回调地址必须是本地 http 地址，并且包含端口。')
            return
        outer = self

        class CallbackHandler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                request_url = urllib.parse.urlparse(self.path)
                if request_url.path != callback_path:
                    self.send_response(404)
                    self.end_headers()
                    return
                query = urllib.parse.parse_qs(request_url.query, keep_blank_values=True)
                error = str((query.get('error') or [''])[0]).strip()
                if error:
                    description = str((query.get('error_description') or [''])[0]).strip()
                    outer._error_message = description or error
                    self._write_html('百度授权失败，你可以关闭这个窗口并返回 GUI 查看原因。')
                    return
                code = str((query.get('code') or [''])[0]).strip()
                state = str((query.get('state') or [''])[0]).strip()
                if not code:
                    outer._error_message = '百度授权回调中未包含 code。'
                    self._write_html('百度授权失败，回调里没有 code。你可以关闭这个窗口并返回 GUI。')
                    return
                if outer.expected_state and state != outer.expected_state:
                    outer._error_message = '百度授权 state 不匹配，已拒绝本次回调。'
                    self._write_html('百度授权失败，state 校验未通过。你可以关闭这个窗口并返回 GUI。')
                    return
                outer._result = (code, state)
                self._write_html('百度授权成功，GUI 正在自动获取 Access Token。你可以关闭这个窗口。')

            def _write_html(self, message: str) -> None:
                content = f'<html><body><h3>{message}</h3></body></html>'.encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(content)))
                self.end_headers()
                self.wfile.write(content)

            def log_message(self, format: str, *args) -> None:
                return

        try:
            self._server = http.server.ThreadingHTTPServer((host, port), CallbackHandler)
            self._server.timeout = 0.5
        except OSError as exc:
            self.error_signal.emit(f'启动百度授权本地回调监听失败: {exc}')
            return
        self.log_line.emit(f'百度授权本地回调监听已启动: {self.redirect_uri}')
        deadline = time.time() + max(self.timeout_seconds, 1)
        try:
            while not self._stopped and time.time() < deadline and not self._result and not self._error_message:
                self._server.handle_request()
        finally:
            self._server.server_close()
        if self._result:
            self.auth_code_received.emit(self._result[0], self._result[1])
            return
        if self._error_message:
            self.error_signal.emit(self._error_message)
            return
        if not self._stopped:
            self.error_signal.emit('等待百度授权回调超时。')


class BaiduAuthBrowserDialog(QDialog):
    def __init__(self, auth_url: str, redirect_uri: str, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.auth_url = auth_url
        self.redirect_uri = redirect_uri
        self.captured_payload = ''
        self.setWindowTitle('百度网盘授权登录')
        self.resize(980, 760)
        layout = QVBoxLayout(self)
        if QWebEngineView is None:
            message = QLabel('当前环境未提供 Qt WebEngine，无法在应用内打开百度授权页。')
            message.setWordWrap(True)
            layout.addWidget(message)
            close_btn = QPushButton('关闭')
            close_btn.clicked.connect(self.reject)
            layout.addWidget(close_btn, 0, Qt.AlignmentFlag.AlignRight)
            return
        self.web_view = QWebEngineView(self)
        self.web_view.urlChanged.connect(self._on_url_changed)
        self.web_view.loadFinished.connect(self._on_load_finished)
        layout.addWidget(self.web_view, 1)
        close_btn = QPushButton('取消')
        close_btn.clicked.connect(self.reject)
        layout.addWidget(close_btn, 0, Qt.AlignmentFlag.AlignRight)
        self.web_view.setUrl(QUrl(self.auth_url))

    def _on_url_changed(self, url: QUrl) -> None:
        url_text = url.toString()
        if not url_text:
            return
        self._try_accept_payload(url_text)

    def _on_load_finished(self, _ok: bool) -> None:
        if QWebEngineView is None or self.captured_payload:
            return
        page = self.web_view.page()
        page.runJavaScript('window.location.href', self._on_js_value)
        page.runJavaScript('document.body ? document.body.innerText : ""', self._on_js_value)

    def _on_js_value(self, value: Any) -> None:
        if value is None:
            return
        self._try_accept_payload(str(value))

    def _try_accept_payload(self, payload: str) -> None:
        text = str(payload or '').strip()
        if not text:
            return
        if BaiduPanClient.is_oauth_callback_candidate(text, self.redirect_uri):
            self.captured_payload = text
            self.accept()

    def _is_redirect_match(self, url_text: str) -> bool:
        return BaiduPanClient.is_oauth_callback_candidate(url_text, self.redirect_uri)


class BaiduDirectoryPickerDialog(QDialog):
    def __init__(self, client: BaiduPanClient, initial_path: str, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.client = client
        self.selected_path = '/'
        self.current_path = self._normalize_path(initial_path)
        self.setWindowTitle('选择百度网盘目录')
        self.resize(520, 420)
        layout = QVBoxLayout(self)
        self.path_label = QLabel()
        layout.addWidget(self.path_label)
        self.dir_list = QListWidget()
        self.dir_list.itemDoubleClicked.connect(self._open_selected_item)
        layout.addWidget(self.dir_list, 1)
        btn_row = QHBoxLayout()
        self.up_btn = QPushButton('上一级')
        self.up_btn.clicked.connect(self._go_parent)
        self.open_btn = QPushButton('进入所选目录')
        self.open_btn.clicked.connect(self._open_selected_item)
        self.select_btn = QPushButton('选择当前目录')
        self.select_btn.clicked.connect(self._select_current_path)
        cancel_btn = QPushButton('取消')
        cancel_btn.clicked.connect(self.reject)
        btn_row.addWidget(self.up_btn)
        btn_row.addWidget(self.open_btn)
        btn_row.addStretch(1)
        btn_row.addWidget(self.select_btn)
        btn_row.addWidget(cancel_btn)
        layout.addLayout(btn_row)
        self._load_directory(self.current_path)

    def _normalize_path(self, path: str) -> str:
        text = str(path or '').strip()
        if not text or text == '/':
            return '/'
        return BaiduPanClient.normalize_remote_root(text)

    def _load_directory(self, path: str) -> None:
        self.current_path = self._normalize_path(path)
        self.path_label.setText(f'当前目录：{self.current_path}')
        self.dir_list.clear()
        try:
            items = self.client.list_directory(self.current_path)
        except Exception as exc:
            QMessageBox.warning(self, '加载百度目录失败', str(exc))
            return
        for item in items:
            if not item.is_directory:
                continue
            row = QListWidgetItem(item.name or item.path)
            row.setData(Qt.ItemDataRole.UserRole, item.path)
            self.dir_list.addItem(row)
        self.up_btn.setEnabled(self.current_path != '/')
        self.open_btn.setEnabled(self.dir_list.count() > 0)

    def _go_parent(self) -> None:
        if self.current_path == '/':
            return
        parent = str(Path(self.current_path).parent).replace('\\', '/')
        self._load_directory(parent if parent and parent != '.' else '/')

    def _open_selected_item(self, _item: QListWidgetItem | None = None) -> None:
        item = self.dir_list.currentItem()
        if not item:
            return
        target_path = str(item.data(Qt.ItemDataRole.UserRole) or '').strip()
        if not target_path:
            return
        self._load_directory(target_path)

    def _select_current_path(self) -> None:
        self.selected_path = self.current_path
        self.accept()


from tabs.fixed_upload_tab import FixedUploadTab


# ---------------------------------------------------------------------------
# 标签页 UI
# ---------------------------------------------------------------------------

class UploadTab(QWidget):
    def __init__(self) -> None:
        super().__init__()
        self.selected_files: list[Path] = []
        self.selected_root_dir: Path | None = None
        self.worker: UploadWorker | BaiduPanUploadWorker | WebDavUploadWorker | None = None
        self._baidu_refresh_token = ''
        self._baidu_auth_state = ''
        self.baidu_auth_worker: BaiduOAuthCallbackWorker | None = None
        self._build_ui()
        self._load_saved_config()

    def _build_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(12)

        self.provider_tabs = QTabWidget()
        self.provider_tabs.addTab(self._build_oss_page(), 'OSS 上传')
        self.provider_tabs.addTab(FixedUploadTab(), '固定上传')
        self.provider_tabs.addTab(self._build_drive_page(), '网盘上传')
        layout.addWidget(self.provider_tabs, 2)

        self.common_upload_widget = QWidget()
        common_layout = QVBoxLayout(self.common_upload_widget)
        common_layout.setContentsMargins(0, 0, 0, 0)
        common_layout.setSpacing(12)

        file_group = QGroupBox('选择要上传的文件')
        file_layout = QVBoxLayout(file_group)
        file_btn_row = QHBoxLayout()
        self.choose_files_btn = QPushButton('选择文件')
        self.choose_dir_btn = QPushButton('选择整个目录')
        self.choose_files_btn.clicked.connect(self._choose_files)
        self.choose_dir_btn.clicked.connect(self._choose_dir)
        file_btn_row.addWidget(self.choose_files_btn)
        file_btn_row.addWidget(self.choose_dir_btn)
        file_btn_row.addStretch(1)
        file_layout.addLayout(file_btn_row)

        self.file_table = QTableWidget(0, 3)
        self.file_table.setHorizontalHeaderLabels(['文件名', '大小', '目标路径'])
        self.file_table.verticalHeader().setVisible(False)
        self.file_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.file_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        fh = self.file_table.horizontalHeader()
        fh.setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        fh.setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)
        fh.setSectionResizeMode(2, QHeaderView.ResizeMode.Stretch)
        file_layout.addWidget(self.file_table)
        self.provider_tabs.currentChanged.connect(self._render_file_table)
        self.drive_tabs.currentChanged.connect(self._render_file_table)
        self._render_file_table()
        common_layout.addWidget(file_group, 1)

        upload_row = QHBoxLayout()
        self.pause_btn = QPushButton('暂停')
        self.stop_btn = QPushButton('停止')
        self.pause_btn.clicked.connect(self._toggle_pause)
        self.stop_btn.clicked.connect(self._stop_upload)
        self.pause_btn.setEnabled(False)
        self.stop_btn.setEnabled(False)
        upload_row.addWidget(QLabel('当前上传控制'))
        upload_row.addWidget(self.pause_btn)
        upload_row.addWidget(self.stop_btn)
        self.progress_bar = QProgressBar()
        self.progress_bar.setValue(0)
        upload_row.addWidget(self.progress_bar, 1)
        common_layout.addLayout(upload_row)

        log_group = QGroupBox('上传日志')
        log_layout = QVBoxLayout(log_group)
        self.log_box = QPlainTextEdit()
        self.log_box.setReadOnly(True)
        self.log_box.setMaximumHeight(110)
        self.log_box.setPlaceholderText('上传日志…')
        log_layout.addWidget(self.log_box)
        common_layout.addWidget(log_group)
        layout.addWidget(self.common_upload_widget, 3)
        self.provider_tabs.currentChanged.connect(self._on_provider_tab_changed)
        self._on_provider_tab_changed(self.provider_tabs.currentIndex())

    def _build_oss_page(self) -> QWidget:
        page = QWidget()
        page_layout = QVBoxLayout(page)
        page_layout.setContentsMargins(0, 0, 0, 0)
        page_layout.setSpacing(12)
        config_group = QGroupBox('OSS 配置（配置一次后自动保存复用）')
        config_form = QFormLayout(config_group)
        self.endpoint_input = QLineEdit()
        self.endpoint_input.setPlaceholderText('例: https://oss-cn-beijing.aliyuncs.com')
        self.bucket_input = QLineEdit()
        self.bucket_input.setPlaceholderText('仅填 Bucket 名称，例: nativeos（不要填完整域名）')
        self.access_key_input = QLineEdit()
        self.access_key_input.setPlaceholderText('AccessKey ID')
        self.access_secret_input = QLineEdit()
        self.access_secret_input.setPlaceholderText('AccessKey Secret')
        self.access_secret_input.setEchoMode(QLineEdit.EchoMode.Password)
        self.oss_prefix_input = QLineEdit()
        self.oss_prefix_input.setPlaceholderText('上传到 OSS 的目录前缀，例: videos/')
        self.oss_prefix_input.setText('videos/')
        self.oss_prefix_input.textChanged.connect(self._render_file_table)
        config_form.addRow('Endpoint', self.endpoint_input)
        config_form.addRow('Bucket', self.bucket_input)
        config_form.addRow('AccessKey ID', self.access_key_input)
        config_form.addRow('AccessKey Secret', self.access_secret_input)
        config_form.addRow('OSS 目录前缀', self.oss_prefix_input)
        action_row = QHBoxLayout()
        self.save_config_btn = QPushButton('保存配置')
        self.save_config_btn.clicked.connect(self._save_config)
        self.upload_btn = QPushButton('开始上传到 OSS')
        self.upload_btn.clicked.connect(self._start_upload)
        action_row.addWidget(self.save_config_btn)
        action_row.addWidget(self.upload_btn)
        action_row.addStretch(1)
        action_widget = QWidget()
        action_widget.setLayout(action_row)
        config_form.addRow('', action_widget)
        page_layout.addWidget(config_group)
        return page

    def _build_drive_page(self) -> QWidget:
        page = QWidget()
        page_layout = QVBoxLayout(page)
        page_layout.setContentsMargins(0, 0, 0, 0)
        page_layout.setSpacing(12)
        self.drive_tabs = QTabWidget()
        self.drive_tabs.addTab(self._build_baidu_pan_page(), '百度网盘')
        self.drive_tabs.addTab(self._build_pan123_page(), '123 网盘')
        page_layout.addWidget(self.drive_tabs)
        return page

    def _on_provider_tab_changed(self, index: int) -> None:
        is_fixed_upload_tab = index == 1
        self.common_upload_widget.setVisible(not is_fixed_upload_tab)
        if hasattr(self, 'choose_files_btn'):
            is_drive_tab = index == 2
            self.choose_files_btn.setEnabled(True)
            self.choose_dir_btn.setEnabled(True)
            if is_drive_tab:
                self.choose_files_btn.setToolTip('网盘上传仅选择并上传 mp4 文件。')
                self.choose_dir_btn.setToolTip('网盘上传从目录中递归选择 mp4 文件。')
            else:
                self.choose_files_btn.setToolTip('')
                self.choose_dir_btn.setToolTip('')

    def _build_baidu_pan_page(self) -> QWidget:
        page = QWidget()
        page_layout = QVBoxLayout(page)
        page_layout.setContentsMargins(0, 0, 0, 0)
        page_layout.setSpacing(12)
        baidu_group = QGroupBox('百度网盘配置')
        baidu_form = QFormLayout(baidu_group)
        self.baidu_app_id_input = QLineEdit()
        self.baidu_app_id_input.setPlaceholderText('控制台中的 AppID，例: 250528')
        self.baidu_app_key_input = QLineEdit()
        self.baidu_app_key_input.setPlaceholderText('控制台中的 AppKey，用于打开授权页')
        self.baidu_app_secret_input = QLineEdit()
        self.baidu_app_secret_input.setPlaceholderText('控制台中的 Secret Key，用于 code 换 token')
        self.baidu_app_secret_input.setEchoMode(QLineEdit.EchoMode.Password)
        self.baidu_redirect_input = QLineEdit()
        self.baidu_redirect_input.setText(DEFAULT_REDIRECT_URI)
        self.baidu_remote_root_input = QLineEdit()
        self.baidu_remote_root_input.setPlaceholderText('/apps/你的应用名/videos')
        self.baidu_remote_root_input.textChanged.connect(self._render_file_table)
        self.choose_baidu_root_btn = QPushButton('选择百度目录')
        self.choose_baidu_root_btn.clicked.connect(self._choose_baidu_remote_dir)
        self.baidu_access_token_input = QLineEdit()
        self.baidu_access_token_input.setPlaceholderText('授权完成后自动填入 access_token')
        self.baidu_access_token_input.setEchoMode(QLineEdit.EchoMode.Password)
        self.baidu_expires_at_label = QLabel('未授权')
        self.save_baidu_btn = QPushButton('保存百度配置')
        self.save_baidu_btn.clicked.connect(self._save_baidu_config)
        self.open_baidu_auth_btn = QPushButton('打开百度授权页')
        self.open_baidu_auth_btn.clicked.connect(self._open_baidu_auth_page)
        self.import_baidu_token_btn = QPushButton('导入授权回跳内容')
        self.import_baidu_token_btn.clicked.connect(self._import_baidu_token)
        self.baidu_upload_btn = QPushButton('开始上传到百度网盘')
        self.baidu_upload_btn.clicked.connect(self._start_baidu_upload)
        baidu_btn_row = QHBoxLayout()
        baidu_btn_row.addWidget(self.save_baidu_btn)
        baidu_btn_row.addWidget(self.open_baidu_auth_btn)
        baidu_btn_row.addWidget(self.import_baidu_token_btn)
        baidu_btn_row.addWidget(self.baidu_upload_btn)
        baidu_btn_row.addStretch(1)
        baidu_btn_widget = QWidget()
        baidu_btn_widget.setLayout(baidu_btn_row)
        baidu_form.addRow('App ID', self.baidu_app_id_input)
        baidu_form.addRow('App Key', self.baidu_app_key_input)
        baidu_form.addRow('App Secret', self.baidu_app_secret_input)
        baidu_form.addRow('Redirect URI', self.baidu_redirect_input)
        baidu_root_row = QWidget()
        baidu_root_layout = QHBoxLayout(baidu_root_row)
        baidu_root_layout.setContentsMargins(0, 0, 0, 0)
        baidu_root_layout.addWidget(self.baidu_remote_root_input, 1)
        baidu_root_layout.addWidget(self.choose_baidu_root_btn)
        baidu_form.addRow('网盘目录', baidu_root_row)
        baidu_form.addRow('Access Token', self.baidu_access_token_input)
        baidu_form.addRow('过期时间', self.baidu_expires_at_label)
        baidu_form.addRow('', baidu_btn_widget)
        page_layout.addWidget(baidu_group)
        return page

    def _build_pan123_page(self) -> QWidget:
        page = QWidget()
        page_layout = QVBoxLayout(page)
        page_layout.setContentsMargins(0, 0, 0, 0)
        page_layout.setSpacing(12)
        config_group = QGroupBox('123 网盘 WebDAV 配置')
        config_form = QFormLayout(config_group)
        self.pan123_base_url_input = QLineEdit()
        self.pan123_base_url_input.setPlaceholderText('WebDAV 地址')
        self.pan123_username_input = QLineEdit()
        self.pan123_username_input.setPlaceholderText('用户名')
        self.pan123_password_input = QLineEdit()
        self.pan123_password_input.setPlaceholderText('应用密码')
        self.pan123_password_input.setEchoMode(QLineEdit.EchoMode.Password)
        self.pan123_root_input = QLineEdit()
        self.pan123_root_input.setPlaceholderText('/videos')
        self.pan123_root_input.textChanged.connect(self._render_file_table)
        self.choose_pan123_root_btn = QPushButton('选择目录')
        self.choose_pan123_root_btn.clicked.connect(self._choose_pan123_remote_dir)
        self.save_pan123_btn = QPushButton('保存 123 配置')
        self.save_pan123_btn.clicked.connect(self._save_pan123_config)
        self.pan123_upload_btn = QPushButton('开始上传到 123 网盘')
        self.pan123_upload_btn.clicked.connect(self._start_pan123_upload)
        pan123_root_row = QWidget()
        pan123_root_layout = QHBoxLayout(pan123_root_row)
        pan123_root_layout.setContentsMargins(0, 0, 0, 0)
        pan123_root_layout.addWidget(self.pan123_root_input, 1)
        pan123_root_layout.addWidget(self.choose_pan123_root_btn)
        action_row = QHBoxLayout()
        action_row.addWidget(self.save_pan123_btn)
        action_row.addWidget(self.pan123_upload_btn)
        action_row.addStretch(1)
        action_widget = QWidget()
        action_widget.setLayout(action_row)
        config_form.addRow('WebDAV 地址', self.pan123_base_url_input)
        config_form.addRow('用户名', self.pan123_username_input)
        config_form.addRow('应用密码', self.pan123_password_input)
        config_form.addRow('网盘目录', pan123_root_row)
        config_form.addRow('', action_widget)
        page_layout.addWidget(config_group)
        return page

    # --- OSS 配置 ---

    def _load_saved_config(self) -> None:
        cfg = load_oss_config()
        if cfg:
            self.endpoint_input.setText(cfg.get('endpoint', ''))
            self.bucket_input.setText(cfg.get('bucket', ''))
            self.access_key_input.setText(cfg.get('access_key_id', ''))
            self.access_secret_input.setText(cfg.get('access_key_secret', ''))
            self.oss_prefix_input.setText(cfg.get('prefix', 'videos/'))
        baidu_cfg = load_baidu_pan_config()
        if baidu_cfg:
            self.baidu_app_id_input.setText(baidu_cfg.get('app_id', ''))
            self.baidu_app_key_input.setText(baidu_cfg.get('app_key', ''))
            self.baidu_app_secret_input.setText(baidu_cfg.get('app_secret', ''))
            saved_redirect = baidu_cfg.get('redirect_uri', DEFAULT_REDIRECT_URI) or DEFAULT_REDIRECT_URI
            if saved_redirect == LEGACY_BAIDU_LOCAL_REDIRECT:
                saved_redirect = DEFAULT_REDIRECT_URI
            if saved_redirect == 'oob':
                saved_redirect = DEFAULT_REDIRECT_URI
            self.baidu_redirect_input.setText(saved_redirect)
            self.baidu_remote_root_input.setText(baidu_cfg.get('remote_root', ''))
            self.baidu_access_token_input.setText(baidu_cfg.get('access_token', ''))
            expires_at = baidu_cfg.get('expires_at', '')
            self.baidu_expires_at_label.setText(expires_at or '未授权')
            self._baidu_refresh_token = baidu_cfg.get('refresh_token', '')
        pan123_cfg = load_pan123_config()
        if pan123_cfg:
            self.pan123_base_url_input.setText(pan123_cfg.get('base_url', ''))
            self.pan123_username_input.setText(pan123_cfg.get('username', ''))
            self.pan123_password_input.setText(pan123_cfg.get('password', ''))
            self.pan123_root_input.setText(pan123_cfg.get('root_path', ''))

    def _save_config(self) -> None:
        cfg = {
            'endpoint': self.endpoint_input.text().strip(),
            'bucket': self.bucket_input.text().strip(),
            'access_key_id': self.access_key_input.text().strip(),
            'access_key_secret': self.access_secret_input.text().strip(),
            'prefix': self.oss_prefix_input.text().strip(),
        }
        save_oss_config(cfg)
        self.log_box.appendPlainText('OSS 配置已保存。')

    def _save_baidu_config(self) -> None:
        cfg = {
            'app_id': self.baidu_app_id_input.text().strip(),
            'app_key': self.baidu_app_key_input.text().strip(),
            'app_secret': self.baidu_app_secret_input.text().strip(),
            'redirect_uri': self.baidu_redirect_input.text().strip() or DEFAULT_REDIRECT_URI,
            'remote_root': self.baidu_remote_root_input.text().strip(),
            'access_token': self.baidu_access_token_input.text().strip(),
            'expires_at': self.baidu_expires_at_label.text().strip() if self.baidu_expires_at_label.text().strip() != '未授权' else '',
            'refresh_token': self._baidu_refresh_token,
        }
        save_baidu_pan_config(cfg)
        self.log_box.appendPlainText('百度网盘配置已保存。')

    def _save_pan123_config(self) -> None:
        cfg = {
            'base_url': self.pan123_base_url_input.text().strip(),
            'username': self.pan123_username_input.text().strip(),
            'password': self.pan123_password_input.text(),
            'root_path': self.pan123_root_input.text().strip(),
        }
        save_pan123_config(cfg)
        self.log_box.appendPlainText('123 网盘配置已保存。')

    def _open_baidu_auth_page(self) -> None:
        app_key = self.baidu_app_key_input.text().strip()
        redirect_uri = self.baidu_redirect_input.text().strip() or DEFAULT_REDIRECT_URI
        if redirect_uri == LEGACY_BAIDU_LOCAL_REDIRECT:
            redirect_uri = DEFAULT_REDIRECT_URI
            self.baidu_redirect_input.setText(redirect_uri)
        if not app_key:
            self.log_box.appendPlainText('[提示] 请先填写百度网盘 App Key。')
            return
        try:
            self._stop_baidu_auth_listener()
            auth_url = BaiduPanClient.build_implicit_authorize_url(app_key, redirect_uri=redirect_uri)
            if QWebEngineView is not None:
                dialog = BaiduAuthBrowserDialog(auth_url, redirect_uri, self)
                if dialog.exec() == QDialog.DialogCode.Accepted and dialog.captured_payload:
                    self.log_box.appendPlainText('已在应用内捕获百度授权结果，正在解析 token。')
                    self._consume_baidu_auth_payload(dialog.captured_payload)
                else:
                    self.log_box.appendPlainText('百度授权窗口已关闭，未捕获到授权回跳。')
                return
            webbrowser.open(auth_url)
            self.log_box.appendPlainText('已打开百度授权页。当前按 app 的简化模式授权运行，完成登录后请将最终 URL 或页面中的 access_token 内容粘贴回来。')
        except Exception as exc:
            self.log_box.appendPlainText(f'[错误] 打开百度授权页失败: {exc}')
            self._stop_baidu_auth_listener()

    def _import_baidu_token(self) -> None:
        text, accepted = QInputDialog.getMultiLineText(
            self,
            '导入百度授权回跳内容',
            '请粘贴浏览器最终跳转的完整 URL，或页面中的 access_token / code 内容：',
        )
        if not accepted or not text.strip():
            return
        try:
            self._consume_baidu_auth_payload(text)
        except Exception as exc:
            self.log_box.appendPlainText(f'[错误] 导入百度网盘 Access Token 失败: {exc}')

    def _choose_baidu_remote_dir(self) -> None:
        if not self._ensure_baidu_access_token():
            self.log_box.appendPlainText('[提示] 请先完成百度网盘授权。')
            return
        access_token = self.baidu_access_token_input.text().strip()
        initial_path = self.baidu_remote_root_input.text().strip() or '/'
        try:
            client = BaiduPanClient('', access_token)
            dialog = BaiduDirectoryPickerDialog(client, initial_path, self)
            if dialog.exec() == QDialog.DialogCode.Accepted and dialog.selected_path:
                self.baidu_remote_root_input.setText(dialog.selected_path)
                self.log_box.appendPlainText(f'已选择百度网盘目录：{dialog.selected_path}')
        except Exception as exc:
            self.log_box.appendPlainText(f'[错误] 打开百度网盘目录选择器失败: {exc}')

    def _choose_pan123_remote_dir(self) -> None:
        base_url = self.pan123_base_url_input.text().strip()
        username = self.pan123_username_input.text().strip()
        password = self.pan123_password_input.text()
        if not base_url or not username or not password:
            self.log_box.appendPlainText('[提示] 请先填写 123 网盘 WebDAV 地址、用户名和应用密码。')
            return
        initial_path = self.pan123_root_input.text().strip() or '/'
        try:
            client = WebDavDirectoryClient(base_url, username, password)
            dialog = WebDavDirectoryPickerDialog(client, initial_path, self)
            if dialog.exec() == QDialog.DialogCode.Accepted and dialog.selected_path:
                self.pan123_root_input.setText(dialog.selected_path)
                self.log_box.appendPlainText(f'已选择 123 网盘目录：{dialog.selected_path}')
        except Exception as exc:
            self.log_box.appendPlainText(f'[错误] 打开 123 网盘目录选择器失败: {exc}')

    def _stop_baidu_auth_listener(self) -> None:
        if self.baidu_auth_worker:
            self.baidu_auth_worker.stop()
            self.baidu_auth_worker.wait(1000)
            self.baidu_auth_worker = None

    def _handle_baidu_auth_code(self, code: str, state: str) -> None:
        self._stop_baidu_auth_listener()
        self._exchange_baidu_authorization_code(code, state)

    def _handle_baidu_auth_error(self, message: str) -> None:
        self._stop_baidu_auth_listener()
        if message:
            self.log_box.appendPlainText(f'[错误] 百度授权失败: {message}')

    def _consume_baidu_auth_payload(self, payload: str) -> None:
        text = str(payload or '').strip()
        if not text:
            raise ValueError('百度授权结果为空。')
        if 'access_token=' in text:
            parsed = BaiduPanClient.parse_implicit_redirect_payload(text)
            self._apply_baidu_token_payload(parsed)
            self.log_box.appendPlainText('百度网盘 Access Token 已自动获取。')
            return
        if 'code=' in text or text.startswith('oob') or '授权码' in text:
            parsed = BaiduPanClient.parse_authorize_code_redirect(text)
            self._exchange_baidu_authorization_code(parsed.get('code', ''), parsed.get('state', ''))
            return
        raise ValueError('未从百度授权结果中识别到 access_token 或 code。')

    def _exchange_baidu_authorization_code(self, code: str, state: str = '') -> None:
        expected_state = self._baidu_auth_state
        if expected_state and state and state != expected_state:
            self.log_box.appendPlainText('[错误] 百度授权 state 校验失败，已拒绝本次授权结果。')
            return
        app_key = self.baidu_app_key_input.text().strip()
        app_secret = self.baidu_app_secret_input.text().strip()
        redirect_uri = self.baidu_redirect_input.text().strip() or DEFAULT_REDIRECT_URI
        token_payload = BaiduPanClient.exchange_authorization_code(app_key, app_secret, code, redirect_uri)
        self._apply_baidu_token_payload(token_payload)
        self.log_box.appendPlainText('百度网盘授权成功，Access Token 已自动获取。')
        self._baidu_auth_state = ''

    def _apply_baidu_token_payload(self, token_payload: dict[str, str]) -> None:
        self.baidu_access_token_input.setText(token_payload.get('access_token', ''))
        self.baidu_expires_at_label.setText(token_payload.get('expires_at') or '未授权')
        refresh_token = token_payload.get('refresh_token', '')
        if refresh_token:
            self._baidu_refresh_token = refresh_token
        self._save_baidu_config()

    def _ensure_baidu_access_token(self) -> bool:
        access_token = self.baidu_access_token_input.text().strip()
        expires_at_text = self.baidu_expires_at_label.text().strip()
        if access_token and expires_at_text.isdigit() and int(expires_at_text) > int(time.time()) + 60:
            return True
        if access_token and not expires_at_text:
            return True
        if not self._baidu_refresh_token:
            if not access_token:
                return False
            if expires_at_text.isdigit() and int(expires_at_text) <= int(time.time()) + 60:
                self.log_box.appendPlainText('[提示] 百度网盘 Access Token 已过期，请重新授权。')
                return False
            return True
        app_key = self.baidu_app_key_input.text().strip()
        app_secret = self.baidu_app_secret_input.text().strip()
        try:
            token_payload = BaiduPanClient.refresh_access_token(app_key, app_secret, self._baidu_refresh_token)
            self._apply_baidu_token_payload(token_payload)
            self.log_box.appendPlainText('百度网盘 Access Token 已自动刷新。')
            return True
        except Exception as exc:
            self.log_box.appendPlainText(f'[错误] 自动刷新百度网盘 Access Token 失败: {exc}')
            return bool(self.baidu_access_token_input.text().strip())

    def _get_bucket(self):
        try:
            import oss2
        except ImportError:
            self.log_box.appendPlainText('[错误] 未安装 oss2，请执行 pip install oss2')
            return None
        endpoint = self.endpoint_input.text().strip()
        bucket_name = self.bucket_input.text().strip()
        ak = self.access_key_input.text().strip()
        sk = self.access_secret_input.text().strip()
        if not all([endpoint, bucket_name, ak, sk]):
            self.log_box.appendPlainText('[提示] 请先填写完整的 OSS 配置。')
            return None
        try:
            auth = oss2.Auth(ak, sk)
            bucket = oss2.Bucket(auth, endpoint, bucket_name)
            return bucket
        except Exception as exc:
            self.log_box.appendPlainText(f'[错误] 创建 OSS Bucket 连接失败: {exc}')
            return None

    # --- 文件选择 ---

    def _choose_files(self) -> None:
        if self.provider_tabs.currentIndex() == 2:
            files, _ = QFileDialog.getOpenFileNames(self, '选择要上传的 MP4 文件', str(Path.home()), 'MP4 Video Files (*.mp4)')
        else:
            files, _ = QFileDialog.getOpenFileNames(self, '选择要上传的文件')
        if files:
            selected = [Path(f) for f in files]
            if self.provider_tabs.currentIndex() == 2:
                selected = [path for path in selected if path.suffix.lower() in DRIVE_VIDEO_SUFFIXES]
                self.log_box.appendPlainText(f'选择了 {len(selected)} 个 MP4 文件（网盘上传模式）')
            self.selected_files = selected
            self.selected_root_dir = None
            self._render_file_table()

    def _choose_dir(self) -> None:
        chosen = QFileDialog.getExistingDirectory(self, '选择要上传的目录')
        if chosen:
            dir_path = Path(chosen)
            self.selected_root_dir = dir_path
            if self.provider_tabs.currentIndex() == 2:
                self.selected_files = sorted(
                    p for p in dir_path.rglob('*') if p.is_file()
                    and not p.name.startswith('.')
                    and p.suffix.lower() in DRIVE_VIDEO_SUFFIXES
                )
                self.log_box.appendPlainText(f'从目录中选择了 {len(self.selected_files)} 个视频文件（网盘上传模式）')
            else:
                self.selected_files = sorted(
                    p for p in dir_path.rglob('*') if p.is_file()
                    and not p.name.startswith('.')
                    and p.suffix.lower() in (
                        '.mp4', '.webm', '.mkv',
                        '.json3', '.json',
                        '.jpg', '.jpeg', '.png', '.webp',
                    )
                )
                self.log_box.appendPlainText(f'从目录中选择了 {len(self.selected_files)} 个文件')
            self._render_file_table()

    def _relative_oss_suffix(self, path: Path) -> str:
        if self.selected_root_dir:
            try:
                return path.relative_to(self.selected_root_dir).as_posix()
            except Exception:
                return path.name
        return path.name

    def _relative_upload_suffix(self, path: Path) -> str:
        if self.selected_root_dir:
            try:
                relative = path.relative_to(self.selected_root_dir).as_posix()
            except Exception:
                relative = path.name
            if self.provider_tabs.currentIndex() == 2:
                return f'{self.selected_root_dir.name}/{relative}'.replace('//', '/')
            return relative
        return path.name

    def _active_upload_target(self) -> str:
        if self.provider_tabs.currentIndex() == 0:
            return 'oss'
        if self.provider_tabs.currentIndex() == 1:
            return 'fixed_oss'
        if self.drive_tabs.currentIndex() == 0:
            return 'baidu_pan'
        return 'pan123'

    def _build_active_target_path(self, relative_suffix: str) -> str:
        target = self._active_upload_target()
        if target == 'oss':
            prefix = self.oss_prefix_input.text().strip()
            return f'{prefix}{relative_suffix}'
        if target == 'fixed_oss':
            return relative_suffix
        if target == 'baidu_pan':
            remote_root = self.baidu_remote_root_input.text().strip()
            if not remote_root:
                return relative_suffix
            try:
                return BaiduPanClient.build_remote_file_path(remote_root, relative_suffix)
            except Exception:
                return relative_suffix
        remote_root = self.pan123_root_input.text().strip()
        if not remote_root:
            return relative_suffix
        normalized_root = '/' + remote_root.strip().strip('/').replace('\\', '/') if remote_root.strip() != '/' else '/'
        if normalized_root == '/':
            return f'/{relative_suffix}'.replace('//', '/')
        return f'{normalized_root}/{relative_suffix}'.replace('//', '/')

    def _render_file_table(self, *_args) -> None:
        if not hasattr(self, 'file_table'):
            return
        self.file_table.setRowCount(len(self.selected_files))
        for row, fp in enumerate(self.selected_files):
            size_kb = fp.stat().st_size / 1024
            if size_kb > 1024:
                size_str = f'{size_kb / 1024:.1f} MB'
            else:
                size_str = f'{size_kb:.0f} KB'
            relative_suffix = self._relative_upload_suffix(fp)
            target_path = self._build_active_target_path(relative_suffix)
            self.file_table.setItem(row, 0, QTableWidgetItem(relative_suffix))
            self.file_table.setItem(row, 1, QTableWidgetItem(size_str))
            self.file_table.setItem(row, 2, QTableWidgetItem(target_path))

    def _set_start_buttons_enabled(self, enabled: bool) -> None:
        self.upload_btn.setEnabled(enabled)
        self.baidu_upload_btn.setEnabled(enabled)
        self.pan123_upload_btn.setEnabled(enabled)

    # --- 上传 ---

    def _start_upload(self) -> None:
        if not self.selected_files:
            self.log_box.appendPlainText('[提示] 请先选择要上传的文件。')
            return

        self.log_box.appendPlainText('正在连接 OSS…')
        bucket = self._get_bucket()
        if not bucket:
            return

        prefix = self.oss_prefix_input.text().strip()
        file_pairs = [(fp, f'{prefix}{self._relative_upload_suffix(fp)}') for fp in self.selected_files]

        self.log_box.appendPlainText(f'准备上传 {len(file_pairs)} 个文件，前缀: {prefix}')
        self._set_start_buttons_enabled(False)
        self.pause_btn.setEnabled(True)
        self.stop_btn.setEnabled(True)
        self.progress_bar.setValue(0)
        self.progress_bar.setMaximum(len(file_pairs))

        try:
            self.worker = UploadWorker(bucket, file_pairs)
            self.worker.log_line.connect(self.log_box.appendPlainText)
            self.worker.progress.connect(self._on_progress)
            self.worker.finished_signal.connect(self._on_upload_done)
            self.worker.start()
        except Exception as exc:
            self.log_box.appendPlainText(f'[错误] 启动上传线程失败: {exc}')
            self._on_upload_done()

    def _start_baidu_upload(self) -> None:
        drive_files = [fp for fp in self.selected_files if fp.suffix.lower() in DRIVE_VIDEO_SUFFIXES]
        if not drive_files:
            self.log_box.appendPlainText('[提示] 请先选择要上传的文件。')
            return
        app_id = self.baidu_app_id_input.text().strip()
        if not self._ensure_baidu_access_token():
            self.log_box.appendPlainText('[提示] 请先完成百度网盘授权。')
            return
        access_token = self.baidu_access_token_input.text().strip()
        remote_root = self.baidu_remote_root_input.text().strip()
        if not app_id:
            self.log_box.appendPlainText('[提示] 请先填写百度网盘 App ID。')
            return
        if not access_token:
            self.log_box.appendPlainText('[提示] 请先完成百度网盘授权并导入 Access Token。')
            return
        if not remote_root:
            self.log_box.appendPlainText('[提示] 请先填写百度网盘目录，例如 /apps/你的应用名/videos。')
            return
        try:
            client = BaiduPanClient(app_id, access_token)
            file_pairs = [(fp, self._relative_upload_suffix(fp)) for fp in drive_files]
        except Exception as exc:
            self.log_box.appendPlainText(f'[错误] 初始化百度网盘上传失败: {exc}')
            return
        remote_dir_name = self.selected_root_dir.name if self.selected_root_dir else ''
        target_desc = f'{remote_root.rstrip("/")}/{remote_dir_name}'.replace('//', '/') if remote_dir_name else remote_root
        self.log_box.appendPlainText(f'准备上传 {len(file_pairs)} 个视频文件到百度网盘目录: {target_desc}')
        self._set_start_buttons_enabled(False)
        self.pause_btn.setEnabled(True)
        self.stop_btn.setEnabled(True)
        self.progress_bar.setValue(0)
        self.progress_bar.setMaximum(len(file_pairs))
        try:
            self.worker = BaiduPanUploadWorker(client, remote_root, file_pairs)
            self.worker.log_line.connect(self.log_box.appendPlainText)
            self.worker.progress.connect(self._on_progress)
            self.worker.finished_signal.connect(self._on_upload_done)
            self.worker.start()
        except Exception as exc:
            self.log_box.appendPlainText(f'[错误] 启动百度网盘上传线程失败: {exc}')
            self._on_upload_done()

    def _start_pan123_upload(self) -> None:
        drive_files = [fp for fp in self.selected_files if fp.suffix.lower() in DRIVE_VIDEO_SUFFIXES]
        if not drive_files:
            self.log_box.appendPlainText('[提示] 请先选择要上传的视频文件或目录。')
            return
        base_url = self.pan123_base_url_input.text().strip()
        username = self.pan123_username_input.text().strip()
        password = self.pan123_password_input.text()
        remote_root = self.pan123_root_input.text().strip()
        if not base_url or not username or not password:
            self.log_box.appendPlainText('[提示] 请先填写完整的 123 网盘 WebDAV 配置。')
            return
        if not remote_root:
            self.log_box.appendPlainText('[提示] 请先填写 123 网盘目录，例如 /videos。')
            return
        file_pairs = [(fp, self._relative_upload_suffix(fp)) for fp in drive_files]
        remote_dir_name = self.selected_root_dir.name if self.selected_root_dir else ''
        target_desc = f'{remote_root.rstrip("/")}/{remote_dir_name}'.replace('//', '/') if remote_dir_name else remote_root
        self.log_box.appendPlainText(f'准备上传 {len(file_pairs)} 个视频文件到 123 网盘目录: {target_desc}')
        self._set_start_buttons_enabled(False)
        self.pause_btn.setEnabled(True)
        self.stop_btn.setEnabled(True)
        self.progress_bar.setValue(0)
        self.progress_bar.setMaximum(len(file_pairs))
        try:
            self.worker = WebDavUploadWorker(base_url, username, password, remote_root, file_pairs)
            self.worker.log_line.connect(self.log_box.appendPlainText)
            self.worker.progress.connect(self._on_progress)
            self.worker.finished_signal.connect(self._on_upload_done)
            self.worker.start()
        except Exception as exc:
            self.log_box.appendPlainText(f'[错误] 启动 123 网盘上传线程失败: {exc}')
            self._on_upload_done()

    def _toggle_pause(self) -> None:
        if not self.worker:
            return
        if self.worker.is_paused:
            self.worker.resume()
            self.pause_btn.setText('暂停')
        else:
            self.worker.pause()
            self.pause_btn.setText('继续')

    def _stop_upload(self) -> None:
        if self.worker:
            self.worker.stop()

    def _on_progress(self, current: int, total: int) -> None:
        self.progress_bar.setValue(current)

    def _on_upload_done(self) -> None:
        self._set_start_buttons_enabled(True)
        self.pause_btn.setEnabled(False)
        self.pause_btn.setText('暂停')
        self.stop_btn.setEnabled(False)
        self.log_box.appendPlainText('--- 上传完成 ---')
        self.worker = None

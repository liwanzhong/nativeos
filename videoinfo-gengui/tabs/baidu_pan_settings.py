"""百度网盘 配置 + 授权 子 tab（放在系统设置里）。

包含内容（从 upload_tab.py 搬过来）：
  - 7 个配置字段（App ID / App Key / App Secret / Redirect URI / 网盘目录 / Access Token / 过期时间）
  - 4 个按钮（保存百度配置 / 打开百度授权页 / 导入授权回跳内容 / 选择百度目录）
  - BaiduOAuthCallbackWorker (本地 HTTP 回调监听)
  - BaiduAuthBrowserDialog (Qt WebEngine 内嵌授权页)
  - BaiduDirectoryPickerDialog (远程目录选择)

**不**包含（保留在 upload_tab 自由上传 → 网盘上传 → 百度网盘）：
  - BaiduPanUploadWorker + "开始上传到百度网盘" 按钮 + 文件选择区 + log_box

settings_tab 是配置 single source of truth；upload_tab 通过 load_baidu_pan_config() 读配置。
"""
from __future__ import annotations

import http.server
import time
import urllib.parse
from pathlib import Path

from PySide6.QtCore import QThread, Qt, QUrl, Signal
from PySide6.QtWidgets import (
    QDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

try:
    from PySide6.QtWebEngineWidgets import QWebEngineView
except ImportError:
    QWebEngineView = None  # type: ignore[assignment]

from tabs.baidu_pan_client import BaiduPanClient, DEFAULT_REDIRECT_URI
from tabs.runtime_support import load_json_config, save_json_config


LEGACY_BAIDU_LOCAL_REDIRECT = 'http://127.0.0.1:53682/baidu_oauth_callback'


def load_baidu_pan_config() -> dict[str, str]:
    data = load_json_config()
    return data.get('baidu_pan', {})


def save_baidu_pan_config(cfg: dict[str, str]) -> None:
    save_json_config({'baidu_pan': cfg})


# ── upload_tab 用的模块级访问器 ────────────────────────────────────────


def get_baidu_remote_root() -> str:
    """读当前百度网盘远程目录（settings_tab 是 single source of truth）。"""
    return load_baidu_pan_config().get('remote_root', '').strip()


def get_baidu_app_id() -> str:
    return load_baidu_pan_config().get('app_id', '').strip()


def ensure_baidu_access_token() -> str:
    """检查/自动刷新百度 access_token，返回有效 token。

    失败抛 ValueError（upload_tab 捕获后 log 错误信息）。
    """
    cfg = load_baidu_pan_config()
    access_token = cfg.get('access_token', '').strip()
    expires_at = cfg.get('expires_at', '').strip()
    refresh_token = cfg.get('refresh_token', '').strip()
    now = int(time.time())
    if access_token and expires_at.isdigit() and int(expires_at) > now + 60:
        return access_token
    if access_token and not expires_at:
        return access_token
    if not refresh_token:
        raise ValueError('请先到 系统设置 → 百度网盘 完成授权。')
    if expires_at.isdigit() and int(expires_at) <= now + 60:
        pass  # 已过期, 走 refresh
    app_key = cfg.get('app_key', '').strip()
    app_secret = cfg.get('app_secret', '').strip()
    new_token = BaiduPanClient.refresh_access_token(app_key, app_secret, refresh_token)
    cfg['access_token'] = new_token.get('access_token', access_token)
    cfg['expires_at'] = new_token.get('expires_at', expires_at)
    if new_token.get('refresh_token'):
        cfg['refresh_token'] = new_token['refresh_token']
    save_baidu_pan_config(cfg)
    return cfg['access_token']


def upload_files_to_baidu(
    remote_root: str,
    file_pairs: list[tuple[Path, str]],
    on_progress=None,
    on_chunk_progress=None,
    on_step=None,
) -> tuple[int, list[tuple[Path, str]]]:
    """同步上传多个文件到百度网盘（在 worker 线程里调，不卡主 UI）。

    Args:
        remote_root: 远端根目录，例: '/apps/myapp/videos'
        file_pairs: [(local_path, relative_suffix), ...]
                   final remote_path = remote_root + '/' + relative_suffix
        on_progress: optional callback(file_done, total_files, current_local_path)
                     在每个文件开始/结束时调用。
        on_chunk_progress: optional callback(file_idx, total_files, current_local_path,
                                            chunk_done, total_chunks,
                                            bytes_done, bytes_total,
                                            file_bytes_done, file_bytes_total)
                          在每个分片上传完成后调用。
                          bytes_done / bytes_total = 跨文件累计（全集进度条用）
                          file_bytes_done / file_bytes_total = 当前文件级（日志 % 用）
        on_step: optional callback(step, file_idx, total_files, current_local_path, **kwargs)
                 在每个**阶段前**调用（analyze / precreate / locate_host / create / chunk_start）。
                 用于让 UI 立刻看到"在干啥"——避免大文件 + 慢 API 看起来像死锁。

    Returns:
        (ok_count, failed: [(local_path, error_msg), ...])

    Raises:
        ValueError: 没有有效 access_token / App ID 没填
    """
    def _emit_step(step: str, file_idx: int, total: int, current: Path, **kwargs) -> None:
        if on_step:
            try:
                on_step(step, file_idx, total, current, **kwargs)
            except Exception:
                pass

    access_token = ensure_baidu_access_token()
    app_id = get_baidu_app_id()
    if not app_id:
        raise ValueError('请先到 系统设置 → 百度网盘 填写 App ID。')
    if not file_pairs:
        return 0, []
    client = BaiduPanClient(app_id, access_token)
    ok_count = 0
    failed: list[tuple[Path, str]] = []
    total = len(file_pairs)
    # 累计字节进度（跨文件累计）
    total_bytes_all = sum(p.stat().st_size for p, _ in file_pairs)
    bytes_done_overall = 0
    for idx, (local_path, relative_suffix) in enumerate(file_pairs, start=1):
        remote_path = BaiduPanClient.build_remote_file_path(remote_root, relative_suffix)
        if on_progress:
            try:
                on_progress(idx - 1, total, local_path)
            except Exception:
                pass
        try:
            _emit_step('analyze', idx, total, local_path, size=local_path.stat().st_size)
            plan = BaiduPanClient.analyze_file(local_path)
            _emit_step('precreate', idx, total, local_path, remote_path=remote_path)
            precreate = client.precreate_file(remote_path, plan)
            uploadid = str(precreate.get('uploadid') or '').strip()
            if not uploadid:
                raise ValueError(f'precreate 未返回 uploadid: {precreate}')
            _emit_step('locate_host', idx, total, local_path, uploadid=uploadid[:24])
            upload_host = client.locate_upload_host(remote_path, uploadid)
            total_chunks = len(plan.chunks)
            with local_path.open('rb') as fh:
                for chunk_i, chunk in enumerate(plan.chunks, start=1):
                    _emit_step(
                        'chunk_start', idx, total, local_path,
                        chunk_i=chunk_i, total_chunks=total_chunks,
                        chunk_size=chunk.size,
                        bytes_done=bytes_done_overall + sum(c.size for c in plan.chunks[:chunk_i - 1]),
                        bytes_total=total_bytes_all,
                    )
                    chunk_bytes = fh.read(chunk.size)
                    result = client.upload_tmpfile(upload_host, remote_path, uploadid, chunk.index, chunk_bytes)
                    server_md5 = str(result.get('md5') or '').strip().lower()
                    if server_md5 and server_md5 != chunk.md5.lower():
                        raise ValueError(f'分片 {chunk.index} MD5 不匹配')
                    if on_chunk_progress:
                        try:
                            # file_bytes_done / file_bytes_total = 当前文件级（用于日志里的 %）
                            # bytes_done_overall / total_bytes_all = 跨文件累计（用于进度条平滑）
                            file_bytes_done = sum(c.size for c in plan.chunks[:chunk_i])
                            on_chunk_progress(
                                idx, total, local_path,
                                chunk_i, total_chunks,
                                bytes_done_overall + file_bytes_done,
                                total_bytes_all,
                                file_bytes_done,
                                plan.size,
                            )
                        except Exception:
                            pass
            _emit_step('create', idx, total, local_path, uploadid=uploadid[:24])
            client.create_file(remote_path, plan, uploadid)
            bytes_done_overall += plan.size
            ok_count += 1
        except Exception as exc:
            failed.append((local_path, str(exc)))
        if on_progress:
            try:
                on_progress(idx, total, local_path)
            except Exception:
                pass
    return ok_count, failed


# ── OAuth 本地回调监听（独立线程，监听 127.0.0.1:port）────────────────────


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

            def log_message(self, format: str, *args) -> None:  # noqa: A002
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


# ── 浏览器内嵌授权页（Qt WebEngine） ──────────────────────────────────────


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

    def _on_js_value(self, value) -> None:
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


# ── 远程目录选择器（用于"选择百度目录"按钮） ──────────────────────────────


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


# ── 顶层 widget：7 字段 + 4 配置按钮 ─────────────────────────────────────


def _log(msg: str) -> None:
    """settings_tab 没有日志面板，用 print 替代。"""
    print(f'[百度网盘] {msg}')


class BaiduPanSettingsWidget(QWidget):
    """系统设置 → 百度网盘 子 tab。

    包含：7 字段 + 4 配置按钮（保存/打开授权页/导入授权回跳内容/选择百度目录）。
    上传功能（开始上传到百度网盘按钮）不在这里——它在 upload_tab 的"自由上传 → 网盘上传 → 百度网盘"里。
    """

    def __init__(self) -> None:
        super().__init__()
        self._baidu_refresh_token = ''
        self._baidu_auth_state = ''
        self.baidu_auth_worker: BaiduOAuthCallbackWorker | None = None
        self._build_ui()
        self._load_saved_config()

    def _build_ui(self) -> None:
        page_layout = QVBoxLayout(self)
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

        baidu_btn_row = QHBoxLayout()
        baidu_btn_row.addWidget(self.save_baidu_btn)
        baidu_btn_row.addWidget(self.open_baidu_auth_btn)
        baidu_btn_row.addWidget(self.import_baidu_token_btn)
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
        page_layout.addStretch(1)

    def _load_saved_config(self) -> None:
        baidu_cfg = load_baidu_pan_config()
        if not baidu_cfg:
            return
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
        _log('百度网盘配置已保存。')

    def _open_baidu_auth_page(self) -> None:
        app_key = self.baidu_app_key_input.text().strip()
        redirect_uri = self.baidu_redirect_input.text().strip() or DEFAULT_REDIRECT_URI
        if redirect_uri == LEGACY_BAIDU_LOCAL_REDIRECT:
            redirect_uri = DEFAULT_REDIRECT_URI
            self.baidu_redirect_input.setText(redirect_uri)
        if not app_key:
            _log('[提示] 请先填写百度网盘 App Key。')
            return
        try:
            self._stop_baidu_auth_listener()
            auth_url = BaiduPanClient.build_implicit_authorize_url(app_key, redirect_uri=redirect_uri)
            if QWebEngineView is not None:
                from PySide6.QtWidgets import QDialog as _QD
                dialog = BaiduAuthBrowserDialog(auth_url, redirect_uri, self)
                if dialog.exec() == _QD.DialogCode.Accepted and dialog.captured_payload:
                    _log('已在应用内捕获百度授权结果，正在解析 token。')
                    self._consume_baidu_auth_payload(dialog.captured_payload)
                else:
                    _log('百度授权窗口已关闭，未捕获到授权回跳。')
                return
            import webbrowser
            webbrowser.open(auth_url)
            _log('已打开百度授权页。当前按 app 的简化模式授权运行，完成登录后请将最终 URL 或页面中的 access_token 内容粘贴回来。')
        except Exception as exc:
            _log(f'[错误] 打开百度授权页失败: {exc}')
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
            _log(f'[错误] 导入百度网盘 Access Token 失败: {exc}')

    def _choose_baidu_remote_dir(self) -> None:
        if not self._ensure_baidu_access_token():
            _log('[提示] 请先完成百度网盘授权。')
            return
        access_token = self.baidu_access_token_input.text().strip()
        initial_path = self.baidu_remote_root_input.text().strip() or '/'
        try:
            client = BaiduPanClient('', access_token)
            dialog = BaiduDirectoryPickerDialog(client, initial_path, self)
            if dialog.exec() == QDialog.DialogCode.Accepted and dialog.selected_path:
                self.baidu_remote_root_input.setText(dialog.selected_path)
                _log(f'已选择百度网盘目录：{dialog.selected_path}')
        except Exception as exc:
            _log(f'[错误] 打开百度网盘目录选择器失败: {exc}')

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
            _log(f'[错误] 百度授权失败: {message}')

    def _consume_baidu_auth_payload(self, payload: str) -> None:
        text = str(payload or '').strip()
        if not text:
            raise ValueError('百度授权结果为空。')
        if 'access_token=' in text:
            parsed = BaiduPanClient.parse_implicit_redirect_payload(text)
            self._apply_baidu_token_payload(parsed)
            _log('百度网盘 Access Token 已自动获取。')
            return
        if 'code=' in text or text.startswith('oob') or '授权码' in text:
            parsed = BaiduPanClient.parse_authorize_code_redirect(text)
            self._exchange_baidu_authorization_code(parsed.get('code', ''), parsed.get('state', ''))
            return
        raise ValueError('未从百度授权结果中识别到 access_token 或 code。')

    def _exchange_baidu_authorization_code(self, code: str, state: str = '') -> None:
        expected_state = self._baidu_auth_state
        if expected_state and state and state != expected_state:
            _log('[错误] 百度授权 state 校验失败，已拒绝本次授权结果。')
            return
        app_key = self.baidu_app_key_input.text().strip()
        app_secret = self.baidu_app_secret_input.text().strip()
        redirect_uri = self.baidu_redirect_input.text().strip() or DEFAULT_REDIRECT_URI
        token_payload = BaiduPanClient.exchange_authorization_code(app_key, app_secret, code, redirect_uri)
        self._apply_baidu_token_payload(token_payload)
        _log('百度网盘授权成功，Access Token 已自动获取。')
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
                _log('[提示] 百度网盘 Access Token 已过期，请重新授权。')
                return False
            return True
        app_key = self.baidu_app_key_input.text().strip()
        app_secret = self.baidu_app_secret_input.text().strip()
        try:
            token_payload = BaiduPanClient.refresh_access_token(app_key, app_secret, self._baidu_refresh_token)
            self._apply_baidu_token_payload(token_payload)
            _log('百度网盘 Access Token 已自动刷新。')
            return True
        except Exception as exc:
            _log(f'[错误] 自动刷新百度网盘 Access Token 失败: {exc}')
            return bool(self.baidu_access_token_input.text().strip())

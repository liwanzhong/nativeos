from __future__ import annotations

import json
from pathlib import Path

from PySide6.QtCore import QThread, Signal
from PySide6.QtWidgets import (
    QAbstractItemView,
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
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

from tabs.baidu_pan_client import BaiduPanApiError, BaiduPanClient
from tabs.baidu_pan_settings import (
    ensure_baidu_access_token,
    get_baidu_app_id,
    get_baidu_remote_root,
    load_baidu_pan_config,
)
from tabs.fixed_upload_tab import FixedUploadTab
from tabs.runtime_support import load_oss_config, save_oss_config

DRIVE_VIDEO_SUFFIXES = ('.mp4',)



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







class UploadTab(QWidget):
    def __init__(self) -> None:
        super().__init__()
        self.selected_files: list[Path] = []
        self.selected_root_dir: Path | None = None
        self.worker: UploadWorker | BaiduPanUploadWorker | None = None
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

        hint = QLabel('OSS 配置（Endpoint / Bucket / AccessKey / 目录前缀）请到 系统设置 → OSS。')
        hint.setWordWrap(True)
        page_layout.addWidget(hint)

        self.upload_btn = QPushButton('开始上传到 OSS')
        self.upload_btn.clicked.connect(self._start_upload)
        page_layout.addWidget(self.upload_btn)
        page_layout.addStretch(1)
        return page

    def _build_drive_page(self) -> QWidget:
        page = QWidget()
        page_layout = QVBoxLayout(page)
        page_layout.setContentsMargins(0, 0, 0, 0)
        page_layout.setSpacing(12)
        self.drive_tabs = QTabWidget()
        self.drive_tabs.addTab(self._build_baidu_pan_page(), '百度网盘')
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
        """网盘上传 → 百度网盘 子 tab。

        只保留上传入口 + 当前 baidu 配置的**只读**显示。
        配置和授权 7 字段 + 4 按钮在 系统设置 → 百度网盘 子 tab。
        """
        page = QWidget()
        page_layout = QVBoxLayout(page)
        page_layout.setContentsMargins(0, 0, 0, 0)
        page_layout.setSpacing(12)

        info_group = QGroupBox('百度网盘（只读，配置请到 系统设置 → 百度网盘）')
        info_form = QFormLayout(info_group)
        cfg = load_baidu_pan_config()
        self.baidu_app_id_label = QLabel(cfg.get('app_id', '') or '—')
        self.baidu_remote_root_label = QLabel(cfg.get('remote_root', '') or '—')
        expires_at = cfg.get('expires_at', '')
        self.baidu_expires_at_label = QLabel(expires_at or '未授权')
        info_form.addRow('App ID:', self.baidu_app_id_label)
        info_form.addRow('网盘目录:', self.baidu_remote_root_label)
        info_form.addRow('过期时间:', self.baidu_expires_at_label)
        page_layout.addWidget(info_group)

        self.baidu_upload_btn = QPushButton('开始上传到百度网盘')
        self.baidu_upload_btn.clicked.connect(self._start_baidu_upload)
        page_layout.addWidget(self.baidu_upload_btn)
        page_layout.addStretch(1)
        return page


    def _load_saved_config(self) -> None:
        # OSS 配置在 系统设置 → OSS（这里不持有 widget）
        pass

    def _get_bucket(self):
        try:
            import oss2
        except ImportError:
            self.log_box.appendPlainText('[错误] 未安装 oss2，请执行 pip install oss2')
            return None
        cfg = load_oss_config()
        endpoint = cfg.get('endpoint', '').strip()
        bucket_name = cfg.get('bucket', '').strip()
        ak = cfg.get('access_key_id', '').strip()
        sk = cfg.get('access_key_secret', '').strip()
        if not all([endpoint, bucket_name, ak, sk]):
            self.log_box.appendPlainText('[提示] 请先到 系统设置 → OSS 填写完整 OSS 配置。')
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
        return 'baidu_pan'

    def _build_active_target_path(self, relative_suffix: str) -> str:
        target = self._active_upload_target()
        if target == 'oss':
            prefix = load_oss_config().get('prefix', 'videos/').strip()
            return f'{prefix}{relative_suffix}'
        if target == 'fixed_oss':
            return relative_suffix
        if target == 'baidu_pan':
            remote_root = get_baidu_remote_root()
            if not remote_root:
                return relative_suffix
            try:
                return BaiduPanClient.build_remote_file_path(remote_root, relative_suffix)
            except Exception:
                return relative_suffix
        return relative_suffix

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

    # --- 上传 ---

    def _start_upload(self) -> None:
        if not self.selected_files:
            self.log_box.appendPlainText('[提示] 请先选择要上传的文件。')
            return

        self.log_box.appendPlainText('正在连接 OSS…')
        bucket = self._get_bucket()
        if not bucket:
            return

        prefix = load_oss_config().get('prefix', 'videos/').strip()
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
        app_id = get_baidu_app_id()
        remote_root = get_baidu_remote_root()
        if not app_id:
            self.log_box.appendPlainText('[提示] 请先到 系统设置 → 百度网盘 填写 App ID。')
            return
        if not remote_root:
            self.log_box.appendPlainText('[提示] 请先到 系统设置 → 百度网盘 填写网盘目录。')
            return
        try:
            access_token = ensure_baidu_access_token()
        except Exception as exc:
            self.log_box.appendPlainText(f'[错误] {exc}')
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

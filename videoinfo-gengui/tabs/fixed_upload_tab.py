from __future__ import annotations

from pathlib import Path

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
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from tabs.upload_tab import UploadWorker, load_oss_config, save_oss_config

SERIES_IMAGE_SUFFIXES = {'.jpg', '.jpeg', '.png', '.webp'}
VIDEO_SUFFIXES = {'.mp4', '.webm', '.mkv', '.mov', '.avi'}


def _should_include_series_file(path: Path) -> bool:
    name = path.name.lower()
    suffix = path.suffix.lower()
    if suffix in VIDEO_SUFFIXES:
        return False
    if name == 'series.json':
        return True
    if name.endswith('.info.json'):
        return True
    if name.endswith('.ai-practice.json'):
        return True
    if name.endswith('.zh.json'):
        return True
    if name.endswith('.json3'):
        return True
    if suffix in SERIES_IMAGE_SUFFIXES:
        return True
    return False


class FixedUploadTab(QWidget):
    def __init__(self) -> None:
        super().__init__()
        self.catalog_file: Path | None = None
        self.series_dir: Path | None = None
        self.preview_files: list[tuple[Path, str]] = []
        self.worker: UploadWorker | None = None
        self._build_ui()
        self._load_saved_config()

    def _build_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(12)

        config_group = QGroupBox('OSS 配置（固定上传）')
        config_form = QFormLayout(config_group)
        self.endpoint_input = QLineEdit()
        self.endpoint_input.setPlaceholderText('例: https://oss-cn-beijing.aliyuncs.com')
        self.bucket_input = QLineEdit()
        self.bucket_input.setPlaceholderText('仅填 Bucket 名称，例: nativeos')
        self.access_key_input = QLineEdit()
        self.access_key_input.setPlaceholderText('AccessKey ID')
        self.access_secret_input = QLineEdit()
        self.access_secret_input.setPlaceholderText('AccessKey Secret')
        self.access_secret_input.setEchoMode(QLineEdit.EchoMode.Password)
        self.fixed_prefix_label = QLabel('固定上传目录：videos/')
        self.save_config_btn = QPushButton('保存 OSS 配置')
        self.save_config_btn.clicked.connect(self._save_config)
        config_form.addRow('Endpoint', self.endpoint_input)
        config_form.addRow('Bucket', self.bucket_input)
        config_form.addRow('AccessKey ID', self.access_key_input)
        config_form.addRow('AccessKey Secret', self.access_secret_input)
        config_form.addRow('固定目录', self.fixed_prefix_label)
        config_form.addRow('', self.save_config_btn)
        layout.addWidget(config_group)

        catalog_group = QGroupBox('1. 上传总系列文件')
        catalog_layout = QVBoxLayout(catalog_group)
        self.catalog_path_label = QLabel('未选择总系列 JSON 文件')
        self.catalog_path_label.setWordWrap(True)
        catalog_btn_row = QHBoxLayout()
        self.choose_catalog_btn = QPushButton('选择总系列 JSON')
        self.choose_catalog_btn.clicked.connect(self._choose_catalog_file)
        self.upload_catalog_btn = QPushButton('上传总系列文件到 videos/')
        self.upload_catalog_btn.clicked.connect(self._start_catalog_upload)
        catalog_btn_row.addWidget(self.choose_catalog_btn)
        catalog_btn_row.addWidget(self.upload_catalog_btn)
        catalog_btn_row.addStretch(1)
        catalog_layout.addWidget(self.catalog_path_label)
        catalog_layout.addLayout(catalog_btn_row)
        layout.addWidget(catalog_group)

        series_group = QGroupBox('2. 上传系列目录关键文件（不含视频）')
        series_layout = QVBoxLayout(series_group)
        series_hint = QLabel('选择系列目录后，将固定上传该目录下的关键文件到 videos/<目录名>/，包含 series.json、字幕、AI 文件、info 和封面图片，不包含视频文件。')
        series_hint.setWordWrap(True)
        self.series_dir_label = QLabel('未选择系列目录')
        self.series_dir_label.setWordWrap(True)
        series_btn_row = QHBoxLayout()
        self.choose_series_dir_btn = QPushButton('选择系列目录')
        self.choose_series_dir_btn.clicked.connect(self._choose_series_dir)
        self.upload_series_btn = QPushButton('上传系列关键文件到 videos/<目录名>/')
        self.upload_series_btn.clicked.connect(self._start_series_upload)
        series_btn_row.addWidget(self.choose_series_dir_btn)
        series_btn_row.addWidget(self.upload_series_btn)
        series_btn_row.addStretch(1)
        series_layout.addWidget(series_hint)
        series_layout.addWidget(self.series_dir_label)
        series_layout.addLayout(series_btn_row)
        layout.addWidget(series_group)

        preview_group = QGroupBox('上传预览')
        preview_layout = QVBoxLayout(preview_group)
        self.preview_table = QTableWidget(0, 3)
        self.preview_table.setHorizontalHeaderLabels(['本地文件', '大小', 'OSS 目标'])
        self.preview_table.verticalHeader().setVisible(False)
        self.preview_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.preview_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        preview_header = self.preview_table.horizontalHeader()
        preview_header.setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        preview_header.setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)
        preview_header.setSectionResizeMode(2, QHeaderView.ResizeMode.Stretch)
        preview_layout.addWidget(self.preview_table)
        layout.addWidget(preview_group, 1)

        control_row = QHBoxLayout()
        self.pause_btn = QPushButton('暂停')
        self.stop_btn = QPushButton('停止')
        self.pause_btn.clicked.connect(self._toggle_pause)
        self.stop_btn.clicked.connect(self._stop_upload)
        self.pause_btn.setEnabled(False)
        self.stop_btn.setEnabled(False)
        self.progress_bar = QProgressBar()
        self.progress_bar.setValue(0)
        control_row.addWidget(QLabel('当前上传控制'))
        control_row.addWidget(self.pause_btn)
        control_row.addWidget(self.stop_btn)
        control_row.addWidget(self.progress_bar, 1)
        layout.addLayout(control_row)

        log_group = QGroupBox('上传日志')
        log_layout = QVBoxLayout(log_group)
        self.log_box = QPlainTextEdit()
        self.log_box.setReadOnly(True)
        self.log_box.setMaximumHeight(160)
        self.log_box.setPlaceholderText('固定业务上传日志…')
        log_layout.addWidget(self.log_box)
        layout.addWidget(log_group)

    def _load_saved_config(self) -> None:
        cfg = load_oss_config()
        if not cfg:
            return
        self.endpoint_input.setText(cfg.get('endpoint', ''))
        self.bucket_input.setText(cfg.get('bucket', ''))
        self.access_key_input.setText(cfg.get('access_key_id', ''))
        self.access_secret_input.setText(cfg.get('access_key_secret', ''))

    def _save_config(self) -> None:
        cfg = {
            'endpoint': self.endpoint_input.text().strip(),
            'bucket': self.bucket_input.text().strip(),
            'access_key_id': self.access_key_input.text().strip(),
            'access_key_secret': self.access_secret_input.text().strip(),
            'prefix': 'videos/',
        }
        save_oss_config(cfg)
        self.log_box.appendPlainText('固定上传页的 OSS 配置已保存。')

    def _choose_catalog_file(self) -> None:
        chosen, _ = QFileDialog.getOpenFileName(self, '选择总系列 JSON 文件', str(Path.home()), 'JSON Files (*.json)')
        if not chosen:
            return
        self.catalog_file = Path(chosen)
        self.catalog_path_label.setText(str(self.catalog_file))
        self.preview_files = self._build_catalog_file_pairs()
        self._render_preview()

    def _choose_series_dir(self) -> None:
        chosen = QFileDialog.getExistingDirectory(self, '选择系列目录', str(Path.home()))
        if not chosen:
            return
        self.series_dir = Path(chosen)
        self.series_dir_label.setText(str(self.series_dir))
        self.preview_files = self._build_series_file_pairs()
        self._render_preview()
        if not (self.series_dir / 'series.json').exists():
            self.log_box.appendPlainText('[提示] 当前目录中未找到 series.json，建议先在“扫描 & 生成”里更新当前系列。')

    def _build_catalog_file_pairs(self) -> list[tuple[Path, str]]:
        if not self.catalog_file:
            return []
        return [(self.catalog_file, f'videos/{self.catalog_file.name}')]

    def _build_series_file_pairs(self) -> list[tuple[Path, str]]:
        if not self.series_dir:
            return []
        file_pairs: list[tuple[Path, str]] = []
        base_prefix = f'videos/{self.series_dir.name}/'
        for path in sorted(self.series_dir.iterdir()):
            if not path.is_file() or path.name.startswith('.'):
                continue
            if not _should_include_series_file(path):
                continue
            file_pairs.append((path, f'{base_prefix}{path.name}'))
        return file_pairs

    def _render_preview(self) -> None:
        self.preview_table.setRowCount(len(self.preview_files))
        for row, (path, oss_key) in enumerate(self.preview_files):
            size_kb = path.stat().st_size / 1024
            size_text = f'{size_kb / 1024:.1f} MB' if size_kb > 1024 else f'{size_kb:.0f} KB'
            self.preview_table.setItem(row, 0, QTableWidgetItem(path.name))
            self.preview_table.setItem(row, 1, QTableWidgetItem(size_text))
            self.preview_table.setItem(row, 2, QTableWidgetItem(oss_key))

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
            return oss2.Bucket(auth, endpoint, bucket_name)
        except Exception as exc:
            self.log_box.appendPlainText(f'[错误] 创建 OSS Bucket 连接失败: {exc}')
            return None

    def _start_catalog_upload(self) -> None:
        file_pairs = self._build_catalog_file_pairs()
        if not file_pairs:
            self.log_box.appendPlainText('[提示] 请先选择总系列 JSON 文件。')
            return
        self.preview_files = file_pairs
        self._render_preview()
        self._start_upload(file_pairs, '总系列文件')

    def _start_series_upload(self) -> None:
        file_pairs = self._build_series_file_pairs()
        if not self.series_dir:
            self.log_box.appendPlainText('[提示] 请先选择系列目录。')
            return
        if not file_pairs:
            self.log_box.appendPlainText('[提示] 当前系列目录中没有可上传的关键文件。')
            return
        if not (self.series_dir / 'series.json').exists():
            QMessageBox.warning(self, '缺少 series.json', '当前目录缺少 series.json，请先在“扫描 & 生成”中生成当前系列。')
            return
        self.preview_files = file_pairs
        self._render_preview()
        self._start_upload(file_pairs, f'系列目录 {self.series_dir.name}')

    def _start_upload(self, file_pairs: list[tuple[Path, str]], label: str) -> None:
        bucket = self._get_bucket()
        if not bucket:
            return
        self.log_box.appendPlainText(f'准备上传 {label}，共 {len(file_pairs)} 个文件，固定目录: videos/')
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

    def _set_start_buttons_enabled(self, enabled: bool) -> None:
        self.upload_catalog_btn.setEnabled(enabled)
        self.upload_series_btn.setEnabled(enabled)
        self.choose_catalog_btn.setEnabled(enabled)
        self.choose_series_dir_btn.setEnabled(enabled)
        self.save_config_btn.setEnabled(enabled)

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
        self.log_box.appendPlainText('--- 固定上传完成 ---')
        self.worker = None

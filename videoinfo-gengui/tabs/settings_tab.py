"""
Settings tab — sub-tab per concern (Supabase / .env / 视频处理).

Read-only by design for .env: the user edits `.env` in their text editor and clicks
"重新加载" to re-read. We do NOT write back to .env from the GUI in v1 —
.env edits in code are a footgun (escaping, line endings, comments).

What each sub-tab does:
  - Supabase: shows current URL + masked service_key, tests connection.
  - .env 文件: opens .env in OS editor, shows current contents.
  - 视频处理: ffmpeg 目录配置 (写 config.json, download_tab / generate_tab 共享).
"""

from __future__ import annotations

import os
from pathlib import Path

from PySide6.QtCore import Qt, QThread, Signal
from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)
# OSS 读写直接用 load_json_config / save_json_config, 没必要再抽 provider_config

from services.env_config import get_supabase_config
from services.supabase_client import HealthCheckResult, SupabaseAdmin
from tabs.ai_client import load_ai_config, save_ai_config
from tabs.asr_client import load_asr_config, save_asr_config
from tabs.baidu_pan_settings import BaiduPanSettingsWidget
from tabs.runtime_support import load_json_config, resolve_ffmpeg_dir, save_json_config


def _mask_key(key: str) -> str:
    """Show first 8 + last 4 chars so the user can verify which key it is."""
    if not key or len(key) < 16:
        return '●' * len(key or '')
    head = key[:8]
    tail = key[-4:]
    return f'{head}…{tail}'


class _HealthCheckWorker(QThread):
    """Run health_check off the UI thread so the click never freezes Qt."""

    done = Signal(object)  # HealthCheckResult

    def __init__(self, admin: SupabaseAdmin) -> None:
        super().__init__()
        self._admin = admin

    def run(self) -> None:
        self.done.emit(self._admin.health_check())


class SettingsTab(QWidget):
    # 单例引用, 供下载 / 生成 tab 通过 bus.request_focus_tab 切到本 tab
    _instance: 'SettingsTab | None' = None

    def __init__(self) -> None:
        super().__init__()
        self._worker: _HealthCheckWorker | None = None
        self._build_ui()
        self._refresh_from_env()
        SettingsTab._instance = self

    @classmethod
    def get_instance(cls) -> 'SettingsTab | None':
        return cls._instance

    # ── UI construction ────────────────────────────────────────────

    def _build_ui(self) -> None:
        root = QVBoxLayout(self)
        root.setContentsMargins(20, 20, 20, 20)
        root.setSpacing(16)

        # Title
        title = QLabel('系统设置')
        title_font = QFont()
        title_font.setPointSize(16)
        title_font.setBold(True)
        title.setFont(title_font)
        root.addWidget(title)

        # 每个设置一个 sub-tab, 方便后续扩展
        self._sub_tabs = QTabWidget()
        supabase_page = QWidget()
        supabase_layout = QVBoxLayout(supabase_page)
        supabase_layout.setSpacing(12)
        supabase_layout.addWidget(self._build_supabase_group())
        supabase_layout.addStretch(1)
        self._sub_tabs.addTab(supabase_page, 'Supabase')
        video_page = QWidget()
        video_layout = QVBoxLayout(video_page)
        video_layout.setSpacing(12)
        video_layout.addWidget(self._build_ffmpeg_group())
        video_layout.addStretch(1)
        self._sub_tabs.addTab(video_page, '视频处理')
        self._sub_tabs.addTab(self._build_ai_page(), 'AI 大模型')
        self._sub_tabs.addTab(self._build_asr_page(), 'ASR')
        self._sub_tabs.addTab(self._build_oss_page(), 'OSS')
        self._sub_tabs.addTab(BaiduPanSettingsWidget(), '百度网盘')
        root.addWidget(self._sub_tabs, 1)

    def _build_ffmpeg_group(self) -> QGroupBox:
        box = QGroupBox('ffmpeg 目录（用于 ASR 音频抽取 / 章节封面 / 视频处理）')
        form = QFormLayout(box)
        form.setLabelAlignment(Qt.AlignmentFlag.AlignRight)
        form.setHorizontalSpacing(12)
        form.setVerticalSpacing(8)

        mono = QFont('Consolas')
        mono.setStyleHint(QFont.StyleHint.Monospace)

        self._ffmpeg_dir_input = QLineEdit()
        self._ffmpeg_dir_input.setPlaceholderText('选择 ffmpeg.exe 所在目录（为空则自动从 PATH / vendor 找）')
        self._ffmpeg_dir_input.setFont(mono)
        form.addRow('ffmpeg 目录:', self._ffmpeg_dir_input)

        # 状态 (检测当前配置是否可用)
        self._ffmpeg_status_label = QLabel('—')
        self._ffmpeg_status_label.setWordWrap(True)
        form.addRow('当前状态:', self._ffmpeg_status_label)

        button_row = QHBoxLayout()
        browse_btn = QPushButton('选择目录')
        browse_btn.clicked.connect(self._choose_ffmpeg_dir)
        detect_btn = QPushButton('自动检测')
        detect_btn.clicked.connect(self._auto_detect_ffmpeg)
        clear_btn = QPushButton('清空（用 PATH / vendor）')
        clear_btn.clicked.connect(self._clear_ffmpeg_dir)
        refresh_btn = QPushButton('刷新状态')
        refresh_btn.clicked.connect(self._refresh_ffmpeg_status)
        button_row.addWidget(browse_btn)
        button_row.addWidget(detect_btn)
        button_row.addWidget(clear_btn)
        button_row.addWidget(refresh_btn)
        button_row.addStretch(1)
        form.addRow('', button_row)

        # 加载初始值
        config = load_json_config()
        ffmpeg_dir = config.get('ffmpeg_dir', '')
        self._ffmpeg_dir_input.setText(ffmpeg_dir)
        self._ffmpeg_dir_input.editingFinished.connect(self._on_ffmpeg_dir_edited)
        self._refresh_ffmpeg_status()

        return box

    def _build_ai_page(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setSpacing(12)
        layout.addWidget(self._build_ai_group())
        layout.addStretch(1)
        return page

    def _build_ai_group(self) -> QGroupBox:
        box = QGroupBox('AI 大模型（Qwen / OpenAI 兼容，配置一次自动保存）')
        form = QFormLayout(box)
        form.setLabelAlignment(Qt.AlignmentFlag.AlignRight)
        form.setHorizontalSpacing(12)
        form.setVerticalSpacing(8)

        self.ai_base_url_input = QLineEdit()
        self.ai_base_url_input.setPlaceholderText('https://dashscope.aliyuncs.com/compatible-mode/v1')
        form.addRow('Base URL', self.ai_base_url_input)

        self.ai_api_key_input = QLineEdit()
        self.ai_api_key_input.setPlaceholderText('API Key')
        self.ai_api_key_input.setEchoMode(QLineEdit.EchoMode.Password)
        form.addRow('API Key', self.ai_api_key_input)

        self.ai_model_input = QLineEdit()
        self.ai_model_input.setPlaceholderText('qwen-plus')
        self.ai_model_input.setText('qwen-plus')
        form.addRow('Model', self.ai_model_input)

        # 失焦自动保存
        self.ai_base_url_input.editingFinished.connect(self._save_ai_settings)
        self.ai_api_key_input.editingFinished.connect(self._save_ai_settings)
        self.ai_model_input.editingFinished.connect(self._save_ai_settings)

        # 加载现有配置
        ai = load_ai_config()
        if ai.get('base_url'):
            self.ai_base_url_input.setText(ai['base_url'])
        if ai.get('api_key'):
            self.ai_api_key_input.setText(ai['api_key'])
        if ai.get('model'):
            self.ai_model_input.setText(ai['model'])

        return box

    def _save_ai_settings(self) -> None:
        cfg = {
            'base_url': self.ai_base_url_input.text().strip(),
            'api_key': self.ai_api_key_input.text().strip(),
            'model': self.ai_model_input.text().strip() or 'qwen-plus',
        }
        save_ai_config(cfg)

    def _build_asr_page(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setSpacing(12)
        layout.addWidget(self._build_asr_group())
        layout.addStretch(1)
        return page

    def _build_asr_group(self) -> QGroupBox:
        box = QGroupBox('ASR（火山引擎视频字幕生成接口，用于英文字幕生成）')
        form = QFormLayout(box)
        form.setLabelAlignment(Qt.AlignmentFlag.AlignRight)
        form.setHorizontalSpacing(12)
        form.setVerticalSpacing(8)

        self.asr_app_id_input = QLineEdit()
        self.asr_app_id_input.setPlaceholderText('火山 ASR App ID')
        form.addRow('App ID', self.asr_app_id_input)

        self.asr_access_token_input = QLineEdit()
        self.asr_access_token_input.setPlaceholderText('火山 ASR Access Token')
        self.asr_access_token_input.setEchoMode(QLineEdit.EchoMode.Password)
        form.addRow('Access Token', self.asr_access_token_input)

        # 失焦自动保存
        self.asr_app_id_input.editingFinished.connect(self._save_asr_settings)
        self.asr_access_token_input.editingFinished.connect(self._save_asr_settings)

        # 加载现有配置
        asr = load_asr_config()
        if asr.get('app_id'):
            self.asr_app_id_input.setText(asr['app_id'])
        if asr.get('access_token'):
            self.asr_access_token_input.setText(asr['access_token'])

        return box

    def _save_asr_settings(self) -> None:
        cfg = {
            'app_id': self.asr_app_id_input.text().strip(),
            'access_token': self.asr_access_token_input.text().strip(),
        }
        save_asr_config(cfg)

    # ── OSS / 网盘配置 ──────────────────────────────────────────

    def _build_oss_page(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setSpacing(12)
        layout.addWidget(self._build_oss_group())
        layout.addStretch(1)
        return page

    def _build_oss_group(self) -> QGroupBox:
        box = QGroupBox('阿里云 OSS（用于自由上传 / 备份）')
        form = QFormLayout(box)
        form.setLabelAlignment(Qt.AlignmentFlag.AlignRight)
        form.setHorizontalSpacing(12)
        form.setVerticalSpacing(8)

        self.oss_endpoint_input = QLineEdit()
        self.oss_endpoint_input.setPlaceholderText('例: https://oss-cn-beijing.aliyuncs.com')
        form.addRow('Endpoint', self.oss_endpoint_input)

        self.oss_bucket_input = QLineEdit()
        self.oss_bucket_input.setPlaceholderText('仅填 Bucket 名称，例: nativeos（不要填完整域名）')
        form.addRow('Bucket', self.oss_bucket_input)

        self.oss_access_key_input = QLineEdit()
        self.oss_access_key_input.setPlaceholderText('AccessKey ID')
        form.addRow('AccessKey ID', self.oss_access_key_input)

        self.oss_access_secret_input = QLineEdit()
        self.oss_access_secret_input.setPlaceholderText('AccessKey Secret')
        self.oss_access_secret_input.setEchoMode(QLineEdit.EchoMode.Password)
        form.addRow('AccessKey Secret', self.oss_access_secret_input)

        self.oss_prefix_input = QLineEdit()
        self.oss_prefix_input.setPlaceholderText('上传到 OSS 的目录前缀，例: videos/')
        form.addRow('OSS 目录前缀', self.oss_prefix_input)

        # 失焦自动保存
        for w in (self.oss_endpoint_input, self.oss_bucket_input,
                  self.oss_access_key_input, self.oss_access_secret_input,
                  self.oss_prefix_input):
            w.editingFinished.connect(self._save_oss_settings)

        # 状态
        self.oss_status_label = QLabel('—')
        self.oss_status_label.setWordWrap(True)
        form.addRow('当前状态', self.oss_status_label)

        # 显式保存按钮（失焦自动保存 + 手动保存，配置更可控）
        self.oss_save_btn = QPushButton('保存 OSS 配置')
        self.oss_save_btn.clicked.connect(self._save_oss_settings)
        form.addRow('', self.oss_save_btn)

        # 加载现有配置
        cfg = self._load_oss_cfg()
        if cfg.get('endpoint'):
            self.oss_endpoint_input.setText(cfg['endpoint'])
        if cfg.get('bucket'):
            self.oss_bucket_input.setText(cfg['bucket'])
        if cfg.get('access_key_id'):
            self.oss_access_key_input.setText(cfg['access_key_id'])
        if cfg.get('access_key_secret'):
            self.oss_access_secret_input.setText(cfg['access_key_secret'])
        if cfg.get('prefix'):
            self.oss_prefix_input.setText(cfg['prefix'])
        self._refresh_oss_status()

        return box

    def _save_oss_settings(self) -> None:
        cfg = {
            'endpoint': self.oss_endpoint_input.text().strip(),
            'bucket': self.oss_bucket_input.text().strip(),
            'access_key_id': self.oss_access_key_input.text().strip(),
            'access_key_secret': self.oss_access_secret_input.text().strip(),
            'prefix': self.oss_prefix_input.text().strip() or 'videos/',
        }
        save_json_config({'oss': cfg})
        self._refresh_oss_status()
        self.oss_status_label.setText(
            (self.oss_status_label.text() or '').rstrip() + '  ✓ 已保存'
        )

    def _load_oss_cfg(self) -> dict[str, str]:
        data = load_json_config()
        return data.get('oss', {}) or {}

    def _refresh_oss_status(self) -> None:
        cfg = self._load_oss_cfg()
        if not (cfg.get('endpoint') and cfg.get('bucket')
                and cfg.get('access_key_id') and cfg.get('access_key_secret')):
            self.oss_status_label.setText('✗ 未完整配置 — 自由上传 OSS 会失败')
            return
        prefix = cfg.get('prefix') or 'videos/'
        self.oss_status_label.setText(
            f'✓ {cfg["bucket"]} @ {cfg["endpoint"]}（前缀: {prefix}）'
        )


    def _build_supabase_group(self) -> QGroupBox:
        box = QGroupBox('Supabase 连接')
        form = QFormLayout(box)
        form.setLabelAlignment(Qt.AlignmentFlag.AlignRight)
        form.setHorizontalSpacing(12)
        form.setVerticalSpacing(8)

        self._url_label = QLabel('—')
        self._url_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self._key_label = QLabel('—')
        self._key_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self._source_label = QLabel('—')
        self._source_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self._source_label.setWordWrap(True)
        mono = QFont('Consolas')
        mono.setStyleHint(QFont.StyleHint.Monospace)
        self._url_label.setFont(mono)
        self._key_label.setFont(mono)
        self._source_label.setFont(mono)

        self._status_label = QLabel('—')
        self._latency_label = QLabel('—')
        self._sample_label = QLabel('—')
        self._sample_label.setWordWrap(True)
        self._sample_label.setTextInteractionFlags(
            Qt.TextInteractionFlag.TextSelectableByMouse
        )

        form.addRow('URL:', self._url_label)
        form.addRow('service_role key:', self._key_label)
        form.addRow('状态:', self._status_label)
        form.addRow('来源:', self._source_label)
        form.addRow('延迟:', self._latency_label)
        form.addRow('样本行:', self._sample_label)

        button_row = QHBoxLayout()
        self._test_btn = QPushButton('测试连接')
        self._test_btn.clicked.connect(self._on_test_clicked)
        self._reload_btn = QPushButton('重新加载')
        self._reload_btn.clicked.connect(self._on_reload_clicked)
        button_row.addWidget(self._test_btn)
        button_row.addWidget(self._reload_btn)
        button_row.addStretch(1)
        form.addRow('', button_row)

        return box

    # ── actions ────────────────────────────────────────────────────

    def _refresh_from_env(self) -> None:
        cfg = get_supabase_config()
        self._url_label.setText(cfg.url or '（未配置）')
        self._key_label.setText(_mask_key(cfg.service_key) if cfg.service_key else '（未配置）')
        self._source_label.setText(cfg.source)

        if cfg.is_configured:
            self._status_label.setText('✓ 已配置')
        elif cfg.has_partial:
            self._status_label.setText('⚠ 配置不完整（URL 和 key 必须都填）')
        else:
            self._status_label.setText('✗ 未配置 — 都没有，请检查 rn-app/.env.local')

        self._latency_label.setText('—')
        self._sample_label.setText('—')

    def _on_reload_clicked(self) -> None:
        self._refresh_from_env()
        QMessageBox.information(self, '已重新加载', '已重新读取 .env 文件。')

    def _on_test_clicked(self) -> None:
        cfg = get_supabase_config()
        if not cfg.is_configured:
            QMessageBox.warning(
                self,
                '未配置',
                '请先在 .env 里填好 SUPABASE_URL 和 SUPABASE_SERVICE_KEY，然后点「重新加载」。',
            )
            return
        if self._worker is not None and self._worker.isRunning():
            return
        self._test_btn.setEnabled(False)
        self._status_label.setText('正在测试…')
        self._latency_label.setText('—')
        self._sample_label.setText('—')

        admin = SupabaseAdmin(cfg.url or '', cfg.service_key or '')
        self._worker = _HealthCheckWorker(admin)
        self._worker.done.connect(self._on_health_done)
        self._worker.start()

    def _on_health_done(self, result: HealthCheckResult) -> None:
        self._test_btn.setEnabled(True)
        if result.ok:
            self._status_label.setText('✓ 连接成功')
            self._latency_label.setText(f'{result.latency_ms} ms' if result.latency_ms is not None else '—')
            if result.sample_row:
                self._sample_label.setText(
                    f"id={result.sample_row.get('id')}  "
                    f"title={result.sample_row.get('title')}  "
                    f"published={result.sample_row.get('is_published')}"
                )
            else:
                self._sample_label.setText('（表为空，连接仍正常）')
        else:
            self._status_label.setText('✗ 连接失败')
            self._latency_label.setText(f'{result.latency_ms} ms' if result.latency_ms is not None else '—')
            self._sample_label.setText(result.error or '未知错误')
            QMessageBox.critical(self, '连接失败', result.error or '未知错误')

    # ── ffmpeg 目录配置 ──────────────────────────────────────────

    def _choose_ffmpeg_dir(self) -> None:
        initial = self._ffmpeg_dir_input.text().strip() or str(Path.home())
        chosen = QFileDialog.getExistingDirectory(self, '选择 ffmpeg 所在目录', initial)
        if chosen:
            self._ffmpeg_dir_input.setText(chosen)
            save_json_config({'ffmpeg_dir': chosen})
            self._refresh_ffmpeg_status()
            QMessageBox.information(self, '已保存', f'ffmpeg 目录已设置：{chosen}\n下载 / AI 生成 tab 会立即生效。')

    def _auto_detect_ffmpeg(self) -> None:
        """在常见位置 (PATH / vendor / D:\\yt-dlp 等) 自动找 ffmpeg.exe。"""
        import shutil

        # 1) PATH
        which = shutil.which('ffmpeg')
        if which:
            self._ffmpeg_dir_input.setText(str(Path(which).parent))
            save_json_config({'ffmpeg_dir': str(Path(which).parent)})
            self._refresh_ffmpeg_status()
            return

        # 2) app_root / vendor
        from tabs.runtime_support import get_app_root, get_vendor_dir
        for base in (get_vendor_dir(), get_app_root()):
            exe = base / ('ffmpeg.exe' if os.name == 'nt' else 'ffmpeg')
            if exe.exists():
                self._ffmpeg_dir_input.setText(str(base))
                save_json_config({'ffmpeg_dir': str(base)})
                self._refresh_ffmpeg_status()
                return

        # 3) 常见 yt-dlp 安装目录
        for guess in (r'D:\yt-dlp', r'C:\yt-dlp', r'C:\ffmpeg', r'D:\ffmpeg'):
            exe = Path(guess) / ('ffmpeg.exe' if os.name == 'nt' else 'ffmpeg')
            if exe.exists():
                self._ffmpeg_dir_input.setText(guess)
                save_json_config({'ffmpeg_dir': guess})
                self._refresh_ffmpeg_status()
                return

        QMessageBox.warning(
            self,
            '未找到 ffmpeg',
            '在 PATH / vendor / 常见位置都找不到 ffmpeg.exe。\n请手动选择目录。',
        )

    def _clear_ffmpeg_dir(self) -> None:
        self._ffmpeg_dir_input.clear()
        save_json_config({'ffmpeg_dir': ''})
        self._refresh_ffmpeg_status()
        QMessageBox.information(self, '已清空', 'ffmpeg 目录已清空，将回退到 PATH / vendor 自动检测。')

    def _on_ffmpeg_dir_edited(self) -> None:
        # 输入框编辑完成 (回车 / 失焦) 时同步到 config
        text = self._ffmpeg_dir_input.text().strip()
        save_json_config({'ffmpeg_dir': text})
        self._refresh_ffmpeg_status()

    def _refresh_ffmpeg_status(self) -> None:
        configured = self._ffmpeg_dir_input.text().strip()
        resolved = resolve_ffmpeg_dir(configured)
        if not resolved:
            self._ffmpeg_status_label.setText('✗ 未配置 — ASR 音频抽取 / 视频处理会失败')
            return
        resolved_path = Path(resolved)
        has_ffmpeg = (resolved_path / ('ffmpeg.exe' if os.name == 'nt' else 'ffmpeg')).exists()
        has_ffprobe = (resolved_path / ('ffprobe.exe' if os.name == 'nt' else 'ffprobe')).exists()
        if has_ffmpeg and has_ffprobe:
            self._ffmpeg_status_label.setText(f'✓ {resolved}（ffmpeg + ffprobe 都在）')
        elif has_ffmpeg:
            self._ffmpeg_status_label.setText(f'⚠ {resolved}（只有 ffmpeg，没有 ffprobe）')
        else:
            self._ffmpeg_status_label.setText(f'✗ {resolved}（目录里没找到 ffmpeg.exe）')

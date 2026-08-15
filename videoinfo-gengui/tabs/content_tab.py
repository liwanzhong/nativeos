"""
Content management tab — CRUD on `official_video_series`.

What you can do:
  - List all series (with search + level + status filters)
  - New / Edit (dialog with all schema fields)
  - Toggle publish (one click on the row)
  - Delete (with confirm)
  - "上传到此合集" — placeholder button; in step 3 it pre-fills the
    pipeline tab with this series id

Why a worker thread:
  Every Supabase call (list / insert / update / delete) is HTTP. Blocking
  the UI thread for a network round-trip freezes Qt. We do all calls in
  `_SeriesListWorker` / `_SeriesMutationWorker` QThreads and route results
  back to the main thread via signals.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from PySide6.QtCore import Qt, QThread, Signal
from PySide6.QtWidgets import (
    QAbstractItemView,
    QCheckBox,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QSpinBox,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from models.official_episode import OfficialEpisode
from models.official_series import LEVELS, TYPES, OfficialSeries
from services.env_config import get_supabase_config
from services.oss_client import OSSConfig, build_bucket, upload_files
from services.supabase_client import SupabaseAdmin
from services.tab_bus import bus
from tabs.episode_editor import EpisodeEditDialog
from tabs.import_episodes_dialog import (
    ImportEpisodesDialog,
    fetch_series_json_from_url,
    parse_series_json_for_import,
    parse_series_json_text,
)


# ── Cover upload worker ──────────────────────────────────────────────


class _CoverUploadWorker(QThread):
    """Push one local image to OSS at `videos/<series_id>/cover.<ext>`.

    The dialog hands us an OSSConfig (built from the runtime config the
    user already filled in for the series-upload tab) and the desired
    OSS key + local path. We resolve the bucket lazily (so the import
    doesn't crash on a workstation that hasn't installed oss2 yet) and
    emit a single done signal with the result.

    Why a separate worker instead of reusing `_SeriesUploadWorker`:
      Cover uploads are tiny (one image, <1MB usually) and have a
      different UX (one file, single progress tick, dialog stays open
      on success). Reusing the big worker would mean either threading
      the dialog context through it or splitting it into a "single-file
      mode" with its own state machine. Cheaper to just have a tiny
      dedicated worker.
    """

    progress = Signal(str)
    done = Signal(bool, str, str)  # ok, error_or_empty, oss_key

    def __init__(self, oss_cfg: OSSConfig, oss_key: str, local_path: Path) -> None:
        super().__init__()
        self._oss_cfg = oss_cfg
        self._oss_key = oss_key
        self._local_path = local_path

    def run(self) -> None:
        try:
            bucket = build_bucket(self._oss_cfg)
            self.progress.emit(f'正在上传封面到 OSS {self._oss_key}…')
            bucket.put_object_from_file(self._oss_key, str(self._local_path))
            self.progress.emit('✓ 封面上传完成')
            self.done.emit(True, '', self._oss_key)
        except Exception as exc:
            self.done.emit(False, str(exc) or exc.__class__.__name__, '')


# ── Worker threads (network on a background QThread) ────────────────


class _ListWorker(QThread):
    """Fetch series rows. Result is emitted as a list of dicts."""

    done = Signal(list, str)  # rows, error_message (empty on success)

    def __init__(self, admin: SupabaseAdmin, *, level: str | None,
                 is_published: bool | None, search: str | None) -> None:
        super().__init__()
        self._admin = admin
        self._level = level
        self._is_published = is_published
        self._search = search

    def run(self) -> None:
        try:
            rows = self._admin.list_series(
                level=self._level,
                is_published=self._is_published,
                search=self._search,
            )
            self.done.emit(rows, '')
        except Exception as exc:
            self.done.emit([], str(exc) or exc.__class__.__name__)


class _MutationWorker(QThread):
    """Run one CRUD op. Emits (success, message, payload)."""

    done = Signal(bool, str, object)

    def __init__(self, admin: SupabaseAdmin, op: str, **kwargs: Any) -> None:
        super().__init__()
        self._admin = admin
        self._op = op
        self._kwargs = kwargs

    def run(self) -> None:
        try:
            if self._op == 'create':
                row = self._admin.create_series(self._kwargs['data'])
                self.done.emit(True, '已新建', row)
            elif self._op == 'update':
                row = self._admin.update_series(
                    self._kwargs['series_id'],
                    self._kwargs['data'],
                )
                self.done.emit(True, '已更新', row)
            elif self._op == 'delete':
                self._admin.delete_series(self._kwargs['series_id'])
                self.done.emit(True, '已删除', None)
            elif self._op == 'toggle_publish':
                self._admin.set_published(
                    self._kwargs['series_id'],
                    self._kwargs['is_published'],
                )
                state = '已上架' if self._kwargs['is_published'] else '已下架'
                self.done.emit(True, state, None)
            else:
                self.done.emit(False, f'未知操作: {self._op}', None)
        except Exception as exc:
            self.done.emit(False, str(exc) or exc.__class__.__name__, None)


class _EpisodesListWorker(QThread):
    """Fetch all episodes for a series. Result is a list of dicts."""

    done = Signal(str, list, str)  # series_id, rows, error

    def __init__(self, admin: SupabaseAdmin, series_id: str) -> None:
        super().__init__()
        self._admin = admin
        self._series_id = series_id

    def run(self) -> None:
        try:
            rows = self._admin.list_episodes(self._series_id)
            self.done.emit(self._series_id, rows, '')
        except Exception as exc:
            self.done.emit(self._series_id, [], str(exc) or exc.__class__.__name__)


class _EpisodeMutationWorker(QThread):
    """Create / update / delete / toggle-publish a single episode."""

    done = Signal(bool, str, str)  # ok, message, series_id (to trigger refresh)

    def __init__(self, admin: SupabaseAdmin, op: str, **kwargs: Any) -> None:
        super().__init__()
        self._admin = admin
        self._op = op
        self._kwargs = kwargs

    def run(self) -> None:
        try:
            series_id = self._kwargs.get('series_id', '')
            if self._op == 'upsert_one':
                # Build the dict, including series_id (set by caller)
                episode_dict = self._kwargs['episode_dict']
                self._admin.upsert_episodes(series_id, [episode_dict])
                self.done.emit(True, '已保存', series_id)
            elif self._op == 'delete_one':
                ep_id = self._kwargs['episode_id']
                self._admin.delete_episode(series_id, ep_id)
                self.done.emit(True, '已删除', series_id)
            elif self._op == 'toggle_publish':
                ep_id = self._kwargs['episode_id']
                row = self._admin.client \
                    .table('official_video_episodes') \
                    .select('*') \
                    .eq('series_id', series_id) \
                    .eq('id', ep_id) \
                    .limit(1) \
                    .execute()
                if not row.data:
                    self.done.emit(False, f'未找到 episode {ep_id}', series_id)
                    return
                cur = row.data[0]
                new_state = not bool(cur.get('is_published'))
                self._admin.client \
                    .table('official_video_episodes') \
                    .update({'is_published': new_state}) \
                    .eq('series_id', series_id) \
                    .eq('id', ep_id) \
                    .execute()
                self.done.emit(True, '已上架' if new_state else '已下架', series_id)
            elif self._op == 'bulk_upsert':
                # Used by the "从 series.json 导入" flow. The admin's
                # upsert_episodes slices into 100-row batches under
                # the hood, so this is the only place we need to
                # worry about size — the worker just passes the list
                # through.
                episode_dicts = self._kwargs['episode_dicts']
                self._admin.upsert_episodes(series_id, episode_dicts)
                self.done.emit(True, f'已批量保存 {len(episode_dicts)} 条', series_id)
            else:
                self.done.emit(False, f'未知操作: {self._op}', series_id)
        except Exception as exc:
            self.done.emit(False, str(exc) or exc.__class__.__name__, self._kwargs.get('series_id', ''))


# ── New / Edit dialog ─────────────────────────────────────────────────


class SeriesEditDialog(QDialog):
    """Single dialog used for both new and edit. Pass an existing
    OfficialSeries to pre-fill, or None for new.

    `oss_cfg` is the runtime OSS config (from the user's config.json)
    used by the cover-upload button. It can be unconfigured — the
    upload button is just disabled in that case, the rest of the
    dialog still works.
    """

    def __init__(self, parent: QWidget | None, series: OfficialSeries | None,
                 existing_ids: set[str], oss_cfg: OSSConfig | None = None) -> None:
        super().__init__(parent)
        self._existing_ids = existing_ids
        self._oss_cfg = oss_cfg
        self._cover_worker: _CoverUploadWorker | None = None
        self._id_user_touched = series is not None  # editing pre-fills, treat as touched
        self._build_ui(series)

    def _build_ui(self, series: OfficialSeries | None) -> None:
        self.setWindowTitle('新建合集' if series is None else f'编辑合集: {series.id}')
        self.resize(620, 640)

        root = QVBoxLayout(self)
        form = QFormLayout()
        form.setLabelAlignment(Qt.AlignmentFlag.AlignRight)
        form.setHorizontalSpacing(12)
        form.setVerticalSpacing(8)

        # ID + generate button
        self._id_input = QLineEdit()
        self._id_input.setPlaceholderText('点击右侧「🎲 生成」创建 12 位 UUID')
        self._id_input.setMaxLength(64)
        self._id_input.textEdited.connect(self._on_id_edited)
        self._gen_id_btn = QPushButton('🎲 生成')
        self._gen_id_btn.setFixedWidth(80)
        self._gen_id_btn.clicked.connect(self._on_generate_id)
        id_row = QHBoxLayout()
        id_row.addWidget(self._id_input, 1)
        id_row.addWidget(self._gen_id_btn)
        id_row_container = QWidget()
        id_row_container.setLayout(id_row)

        self._title_input = QLineEdit()
        self._level_combo = QComboBox()
        self._level_combo.addItems(LEVELS)
        self._category_input = QLineEdit()
        self._category_input.setPlaceholderText('例如: 综合 / 旅行 / 社交 / 美食')
        self._type_combo = QComboBox()
        self._type_combo.addItems(TYPES)
        self._description_input = QPlainTextEdit()
        self._description_input.setMaximumHeight(80)
        self._description_input.setPlaceholderText('一行简介，手机端列表展示用')

        # Cover filename + upload button
        self._cover_url_input = QLineEdit()
        self._cover_url_input.setPlaceholderText('OSS 上封面文件名（裸文件名，不是 URL）')
        self._upload_cover_btn = QPushButton('上传…')
        self._upload_cover_btn.setFixedWidth(80)
        self._upload_cover_btn.clicked.connect(self._on_upload_cover)
        cover_row = QHBoxLayout()
        cover_row.addWidget(self._cover_url_input, 1)
        cover_row.addWidget(self._upload_cover_btn)
        cover_row_container = QWidget()
        cover_row_container.setLayout(cover_row)
        self._cover_status_label = QLabel('')
        self._cover_status_label.setStyleSheet('color: #475569;')
        self._cover_status_label.setWordWrap(True)

        self._tags_input = QLineEdit()
        self._tags_input.setPlaceholderText('逗号分隔，例如: beginner, slow, daily')
        self._sort_input = QSpinBox()
        self._sort_input.setRange(-10000, 10000)
        self._sort_input.setValue(100)

        # manifest_url — read-only display only. The pipeline tab owns
        # this field; the dialog shouldn't pretend the user types it.
        # We still surface the current value so the admin can see at
        # a glance whether the pipeline has been run.
        self._manifest_label = QLabel('（未生成）')
        self._manifest_label.setStyleSheet('color: #475569; font-family: Consolas, monospace;')
        self._manifest_label.setWordWrap(True)
        self._manifest_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self._manifest_hint = QLabel('由「按合集上传」tab 写入。')
        self._manifest_hint.setStyleSheet('color: #94A3B8; font-size: 11px;')

        # resource_base_url is intentionally NOT in the form. The
        # rn-app's URL resolution strips the basename off `manifest_url`
        # and uses that as the OSS base — `resource_base_url` is dead
        # in practice. The DB column stays for back-compat with
        # already-imported series; nothing in the admin pipeline
        # writes to it any more.

        self._published_check = QCheckBox('上架 (is_published)')
        self._published_check.setChecked(True)

        if series is not None:
            self._id_input.setText(series.id)
            self._id_input.setReadOnly(True)  # PK 不让改
            self._id_input.setStyleSheet('color: #6B7280;')
            self._gen_id_btn.setEnabled(False)  # can't regenerate PK
            self._title_input.setText(series.title)
            idx = self._level_combo.findText(series.level)
            if idx >= 0:
                self._level_combo.setCurrentIndex(idx)
            self._category_input.setText(series.category)
            idx = self._type_combo.findText(series.type)
            if idx >= 0:
                self._type_combo.setCurrentIndex(idx)
            self._description_input.setPlainText(series.description)
            self._cover_url_input.setText(series.cover_url)
            self._tags_input.setText(', '.join(series.tags))
            self._sort_input.setValue(series.sort_order)
            self._set_manifest_label(series.manifest_url)
            self._published_check.setChecked(series.is_published)
        else:
            self._id_input.textChanged.connect(self._validate_id_uniqueness)
            # New series: hide the manifest row entirely (nothing to show
            # yet — it'll appear after the pipeline tab runs).
            self._manifest_label.setVisible(False)
            self._manifest_hint.setVisible(False)

        # Disable cover upload if OSS isn't configured yet.
        if self._oss_cfg is None or not self._oss_cfg.is_configured:
            self._upload_cover_btn.setEnabled(False)
            self._upload_cover_btn.setToolTip('请先在 config.json 配好 OSS endpoint / bucket / ak / sk')

        form.addRow('ID *:', id_row_container)
        form.addRow('标题 *:', self._title_input)
        form.addRow('等级 *:', self._level_combo)
        form.addRow('分类 *:', self._category_input)
        form.addRow('类型 *:', self._type_combo)
        form.addRow('简介:', self._description_input)
        form.addRow('封面图:', cover_row_container)
        form.addRow('', self._cover_status_label)
        form.addRow('标签:', self._tags_input)
        form.addRow('排序:', self._sort_input)
        form.addRow('manifest_url:', self._manifest_label)
        form.addRow('', self._manifest_hint)
        form.addRow('状态:', self._published_check)
        root.addLayout(form)

        self._error_label = QLabel('')
        self._error_label.setStyleSheet('color: #DC2626;')
        self._error_label.setWordWrap(True)
        root.addWidget(self._error_label)

        button_box = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Save | QDialogButtonBox.StandardButton.Cancel
        )
        button_box.accepted.connect(self._on_accept)
        button_box.rejected.connect(self.reject)
        root.addWidget(button_box)

    def _set_manifest_label(self, url: str) -> None:
        if url:
            self._manifest_label.setText(url)
            self._manifest_label.setStyleSheet('color: #1E293B; font-family: Consolas, monospace;')
        else:
            self._manifest_label.setText('（未生成）')
            self._manifest_label.setStyleSheet('color: #94A3B8; font-family: Consolas, monospace;')

    def _on_id_edited(self, _text: str) -> None:
        # Once the user touches the id field we stop auto-generating.
        # (No-op for now — auto-gen is on the button click — but the
        # hook is here in case we later want "auto-fill once, then
        # leave alone".)
        self._id_user_touched = True

    def _on_generate_id(self) -> None:
        """Generate a fresh UUID. If the existing value would collide
        with a known series id, keep generating until it's unique."""
        for _ in range(8):
            new_id = OfficialSeries.new_id()
            if new_id not in self._existing_ids:
                self._id_input.setText(new_id)
                return
        # 8 attempts in a 12-hex-char space colliding with at most a
        # few thousand existing series is essentially impossible —
        # but fail safe rather than spin forever.
        QMessageBox.warning(self, '生成失败', '连续 8 次都撞到已存在 id，请手动指定一个。')

    def _validate_id_uniqueness(self) -> None:
        if self._id_input.text().strip() in self._existing_ids:
            self._error_label.setText('⚠ 这个 id 已存在，新建时 id 必须唯一')
        else:
            self._error_label.setText('')

    def _on_upload_cover(self) -> None:
        series_id = self._id_input.text().strip()
        if not series_id:
            QMessageBox.warning(
                self, '请先生成 id',
                '封面 OSS key 用 `videos/<id>/cover.<ext>` 命名，所以必须先有 id。\n'
                '点 ID 旁边的「🎲 生成」按钮先。',
            )
            return
        path_str, _ = QFileDialog.getOpenFileName(
            self, '选封面图', '',
            '图片 (*.jpg *.jpeg *.png *.webp);;所有文件 (*)',
        )
        if not path_str:
            return
        local_path = Path(path_str)
        ext = local_path.suffix.lower().lstrip('.') or 'jpg'
        # Bare filename convention (no leading path), matches how
        # `resolveSeriesCoverUrl` joins this with `manifest_url` on
        # the rn-app side. The OSS key in the bucket keeps the full
        # `videos/<id>/` prefix for namespacing.
        bare_name = f'cover.{ext}'
        oss_key = f'videos/{series_id}/{bare_name}'

        if self._oss_cfg is None or not self._oss_cfg.is_configured:
            QMessageBox.warning(
                self, 'OSS 未配置',
                '请先在 config.json 配好 endpoint / bucket / ak / sk。',
            )
            return
        if self._cover_worker is not None and self._cover_worker.isRunning():
            return  # already busy

        self._upload_cover_btn.setEnabled(False)
        self._cover_status_label.setText('上传中…')
        self._cover_worker = _CoverUploadWorker(self._oss_cfg, oss_key, local_path)
        self._cover_worker.progress.connect(self._cover_status_label.setText)
        self._cover_worker.done.connect(self._on_cover_upload_done)
        self._cover_worker.start()

    def _on_cover_upload_done(self, ok: bool, error: str, oss_key: str) -> None:
        self._upload_cover_btn.setEnabled(True)
        if not ok:
            self._cover_status_label.setText('')
            QMessageBox.critical(self, '封面上传失败', error)
            return
        # The Supabase column stores the BARE filename — `resolveSeriesCoverUrl`
        # joins it with the series `manifest_url` on the rn-app side.
        bare_name = oss_key.rsplit('/', 1)[-1] if oss_key else ''
        self._cover_url_input.setText(bare_name)
        self._cover_status_label.setText(f'✓ 已上传到 {oss_key}')

    def _on_accept(self) -> None:
        title = self._title_input.text().strip()
        if not title:
            self._error_label.setText('标题不能为空')
            return
        category = self._category_input.text().strip()
        if not category:
            self._error_label.setText('分类不能为空')
            return
        id_text = self._id_input.text().strip()
        if not id_text:
            self._error_label.setText('ID 不能为空 — 点 ID 旁边的「🎲 生成」按钮先')
            return
        if self._id_input.isReadOnly() is False and id_text in self._existing_ids:
            self._error_label.setText('ID 已存在，请换一个')
            return
        # All checks passed
        self.accept()

    def to_series(self, original: OfficialSeries | None) -> OfficialSeries:
        """Build the OfficialSeries from form values. `original` is the
        pre-existing record (for fields the form doesn't show, like
        created_at); for new records pass None and we get defaults.
        `manifest_url` / `resource_base_url` come from `original` —
        the dialog doesn't expose them, so editing other fields
        leaves the pipeline-owned values alone."""
        id_text = self._id_input.text().strip()
        if not id_text:
            id_text = OfficialSeries.new_id()
        tags_raw = self._tags_input.text().strip()
        tags = [t.strip() for t in tags_raw.split(',') if t.strip()] if tags_raw else []
        return OfficialSeries(
            id=id_text,
            title=self._title_input.text().strip(),
            level=self._level_combo.currentText(),
            category=self._category_input.text().strip(),
            type=self._type_combo.currentText(),
            description=self._description_input.toPlainText().strip(),
            cover_url=self._cover_url_input.text().strip(),
            tags=tags,
            sort_order=self._sort_input.value(),
            manifest_url=(original.manifest_url if original else ''),
            resource_base_url=(original.resource_base_url if original else ''),
            is_published=self._published_check.isChecked(),
        )


# ── Main tab ──────────────────────────────────────────────────────────


class ContentTab(QWidget):
    def __init__(self) -> None:
        super().__init__()
        self._rows: list[dict[str, Any]] = []
        self._worker: QThread | None = None
        self._build_ui()
        self._refresh()

    # ── UI ────────────────────────────────────────────────────────

    def _build_ui(self) -> None:
        root = QVBoxLayout(self)
        root.setContentsMargins(16, 16, 16, 16)
        root.setSpacing(12)

        # Toolbar
        toolbar = QHBoxLayout()
        self._new_btn = QPushButton('新建合集')
        self._new_btn.clicked.connect(self._on_new_clicked)
        self._refresh_btn = QPushButton('刷新')
        self._refresh_btn.clicked.connect(self._refresh)
        self._count_label = QLabel('—')
        toolbar.addWidget(self._new_btn)
        toolbar.addWidget(self._refresh_btn)
        toolbar.addStretch(1)
        toolbar.addWidget(self._count_label)
        root.addLayout(toolbar)

        # Filter row
        filter_row = QHBoxLayout()
        self._search_input = QLineEdit()
        self._search_input.setPlaceholderText('搜索标题或 id…')
        self._search_input.setMaximumWidth(260)
        self._search_input.textChanged.connect(self._on_filter_changed)
        self._level_combo = QComboBox()
        self._level_combo.addItem('全部等级', '')
        for lvl in LEVELS:
            self._level_combo.addItem(lvl, lvl)
        self._level_combo.currentIndexChanged.connect(self._on_filter_changed)
        self._status_combo = QComboBox()
        self._status_combo.addItem('全部状态', '')
        self._status_combo.addItem('已上架', 'true')
        self._status_combo.addItem('草稿', 'false')
        self._status_combo.currentIndexChanged.connect(self._on_filter_changed)
        filter_row.addWidget(QLabel('搜索:'))
        filter_row.addWidget(self._search_input)
        filter_row.addSpacing(12)
        filter_row.addWidget(QLabel('等级:'))
        filter_row.addWidget(self._level_combo)
        filter_row.addSpacing(12)
        filter_row.addWidget(QLabel('状态:'))
        filter_row.addWidget(self._status_combo)
        filter_row.addStretch(1)
        root.addLayout(filter_row)

        # Table
        self._table = QTableWidget(0, 8)
        self._table.setHorizontalHeaderLabels([
            'id', '标题', '等级', '分类', '类型', '排序', '状态', 'manifest',
        ])
        self._table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self._table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self._table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self._table.setAlternatingRowColors(True)
        self._table.verticalHeader().setVisible(False)
        header = self._table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        header.setSectionResizeMode(2, QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(3, QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(4, QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(5, QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(6, QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(7, QHeaderView.ResizeMode.Stretch)
        self._table.doubleClicked.connect(self._on_row_double_clicked)
        root.addWidget(self._table, 1)

        # Action row
        action_row = QHBoxLayout()
        self._edit_btn = QPushButton('编辑')
        self._edit_btn.clicked.connect(self._on_edit_clicked)
        self._toggle_btn = QPushButton('上下架')
        self._toggle_btn.clicked.connect(self._on_toggle_publish_clicked)
        self._upload_btn = QPushButton('⬆ 上传到 OSS')
        self._upload_btn.setEnabled(True)
        self._upload_btn.clicked.connect(self._on_upload_to_oss_clicked)
        self._delete_btn = QPushButton('删除')
        self._delete_btn.clicked.connect(self._on_delete_clicked)
        action_row.addWidget(self._edit_btn)
        action_row.addWidget(self._toggle_btn)
        action_row.addWidget(self._upload_btn)
        action_row.addStretch(1)
        action_row.addWidget(self._delete_btn)
        root.addLayout(action_row)

        # ── Episodes sub-panel ────────────────────────────────────
        # Hidden by default. Pops into view when a series row is
        # selected. We deliberately don't auto-show on every refresh
        # — only on explicit row selection — to keep the page calm
        # during a bulk refresh.
        self._episodes_group = QGroupBox('Episodes')
        self._episodes_group.setVisible(False)
        ep_root = QVBoxLayout(self._episodes_group)
        ep_root.setContentsMargins(8, 8, 8, 8)
        ep_root.setSpacing(8)

        ep_toolbar = QHBoxLayout()
        self._ep_new_btn = QPushButton('新建 episode')
        self._ep_new_btn.clicked.connect(self._on_ep_new_clicked)
        self._ep_import_btn = QPushButton('从 series.json 导入')
        self._ep_import_btn.setToolTip('从一个已生成的 series.json 批量写入 episodes（不传 OSS）')
        self._ep_import_btn.clicked.connect(self._on_ep_import_clicked)
        self._ep_import_oss_btn = QPushButton('从 OSS 导入')
        self._ep_import_oss_btn.setToolTip('从该合集在 OSS 上的 manifest_url 拉 series.json 并写入 episodes')
        self._ep_import_oss_btn.clicked.connect(self._on_ep_import_from_oss_clicked)
        self._ep_refresh_btn = QPushButton('刷新')
        self._ep_refresh_btn.clicked.connect(self._on_ep_refresh_clicked)
        self._ep_count_label = QLabel('—')
        ep_toolbar.addWidget(self._ep_new_btn)
        ep_toolbar.addWidget(self._ep_import_btn)
        ep_toolbar.addWidget(self._ep_import_oss_btn)
        ep_toolbar.addWidget(self._ep_refresh_btn)
        ep_toolbar.addStretch(1)
        ep_toolbar.addWidget(self._ep_count_label)
        ep_root.addLayout(ep_toolbar)

        self._ep_table = QTableWidget(0, 7)
        self._ep_table.setHorizontalHeaderLabels([
            '#', 'id', '标题', '等级', '视频文件', 'roleplay', '状态',
        ])
        self._ep_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self._ep_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self._ep_table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self._ep_table.verticalHeader().setVisible(False)
        ep_header = self._ep_table.horizontalHeader()
        ep_header.setSectionResizeMode(0, QHeaderView.ResizeMode.ResizeToContents)
        ep_header.setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)
        ep_header.setSectionResizeMode(2, QHeaderView.ResizeMode.Stretch)
        ep_header.setSectionResizeMode(3, QHeaderView.ResizeMode.ResizeToContents)
        ep_header.setSectionResizeMode(4, QHeaderView.ResizeMode.Stretch)
        ep_header.setSectionResizeMode(5, QHeaderView.ResizeMode.ResizeToContents)
        ep_header.setSectionResizeMode(6, QHeaderView.ResizeMode.ResizeToContents)
        self._ep_table.doubleClicked.connect(self._on_ep_row_double_clicked)
        ep_root.addWidget(self._ep_table, 1)

        ep_action_row = QHBoxLayout()
        self._ep_edit_btn = QPushButton('编辑')
        self._ep_edit_btn.clicked.connect(self._on_ep_edit_clicked)
        self._ep_toggle_btn = QPushButton('上下架')
        self._ep_toggle_btn.clicked.connect(self._on_ep_toggle_clicked)
        self._ep_delete_btn = QPushButton('删除')
        self._ep_delete_btn.clicked.connect(self._on_ep_delete_clicked)
        ep_action_row.addWidget(self._ep_edit_btn)
        ep_action_row.addWidget(self._ep_toggle_btn)
        ep_action_row.addStretch(1)
        ep_action_row.addWidget(self._ep_delete_btn)
        ep_root.addLayout(ep_action_row)

        root.addWidget(self._episodes_group)

        # React to series row selection — populate the sub-panel.
        self._table.itemSelectionChanged.connect(self._on_series_selection_changed)

        # Episode state (populated by selection)
        self._episodes_rows: list[dict[str, Any]] = []
        self._episodes_worker: QThread | None = None
        self._episodes_mutation_worker: QThread | None = None

    # ── data ops ──────────────────────────────────────────────────

    def _admin(self) -> SupabaseAdmin | None:
        cfg = get_supabase_config()
        if not cfg.is_configured:
            QMessageBox.warning(self, '未配置', '请先在系统 tab 配置 Supabase')
            return None
        return SupabaseAdmin(cfg.url or '', cfg.service_key or '')

    def _refresh(self) -> None:
        admin = self._admin()
        if admin is None:
            return
        if self._worker is not None and self._worker.isRunning():
            return
        level = self._level_combo.currentData() or None
        status = self._status_combo.currentData()
        is_published: bool | None
        if status == 'true':
            is_published = True
        elif status == 'false':
            is_published = False
        else:
            is_published = None
        search = self._search_input.text().strip() or None
        self._count_label.setText('加载中…')
        self._worker = _ListWorker(
            admin,
            level=level,
            is_published=is_published,
            search=search,
        )
        self._worker.done.connect(self._on_list_done)
        self._worker.start()

    def _on_list_done(self, rows: list[dict[str, Any]], error: str) -> None:
        if error:
            self._count_label.setText('加载失败')
            QMessageBox.critical(self, '加载失败', error)
            return
        self._rows = rows
        self._count_label.setText(f'共 {len(rows)} 条')
        self._render_table()

    def _render_table(self) -> None:
        self._table.setRowCount(len(self._rows))
        for row, data in enumerate(self._rows):
            series = OfficialSeries.from_row(data)
            cells = [
                series.id,
                series.title,
                series.level,
                series.category,
                series.type,
                str(series.sort_order),
                '✓ 上架' if series.is_published else '○ 草稿',
                series.manifest_url or '—',
            ]
            for col, value in enumerate(cells):
                item = QTableWidgetItem(value)
                if col == 6 and not series.is_published:
                    item.setForeground(Qt.GlobalColor.gray)
                if col == 7 and not series.manifest_url:
                    item.setForeground(Qt.GlobalColor.gray)
                self._table.setItem(row, col, item)

    def _on_filter_changed(self) -> None:
        # Debounce-ish: only refetch on idle; simplest is to just call
        # _refresh and let the QThread handle overlap.
        self._refresh()

    # ── selection / row ops ───────────────────────────────────────

    def _selected_row_index(self) -> int:
        rows = self._table.selectionModel().selectedRows()
        if not rows:
            return -1
        return rows[0].row()

    def _selected_series(self) -> OfficialSeries | None:
        idx = self._selected_row_index()
        if idx < 0 or idx >= len(self._rows):
            return None
        return OfficialSeries.from_row(self._rows[idx])

    def _on_row_double_clicked(self, _index) -> None:
        self._on_edit_clicked()

    def _on_new_clicked(self) -> None:
        admin = self._admin()
        if admin is None:
            return
        existing_ids = {r.get('id') for r in self._rows}
        dialog = SeriesEditDialog(self, None, existing_ids, oss_cfg=OSSConfig.from_runtime_config())
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        series = dialog.to_series(None)
        self._run_mutation(admin, 'create', data=series.to_insert_dict())

    def _on_edit_clicked(self) -> None:
        admin = self._admin()
        if admin is None:
            return
        series = self._selected_series()
        if series is None:
            QMessageBox.information(self, '未选中', '请先在列表里选一行')
            return
        existing_ids = {r.get('id') for r in self._rows if r.get('id') != series.id}
        dialog = SeriesEditDialog(self, series, existing_ids, oss_cfg=OSSConfig.from_runtime_config())
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        updated = dialog.to_series(series)
        self._run_mutation(admin, 'update', series_id=series.id, data=updated.to_update_dict())

    def _on_toggle_publish_clicked(self) -> None:
        admin = self._admin()
        if admin is None:
            return
        series = self._selected_series()
        if series is None:
            QMessageBox.information(self, '未选中', '请先在列表里选一行')
            return
        new_state = not series.is_published
        verb = '上架' if new_state else '下架'
        if not QMessageBox.question(
            self,
            f'确认{verb}',
            f'将合集 "{series.id}" 设为{verb}？',
        ):
            return
        self._run_mutation(
            admin,
            'toggle_publish',
            series_id=series.id,
            is_published=new_state,
        )

    def _on_delete_clicked(self) -> None:
        admin = self._admin()
        if admin is None:
            return
        series = self._selected_series()
        if series is None:
            QMessageBox.information(self, '未选中', '请先在列表里选一行')
            return
        if not QMessageBox.question(
            self,
            '确认删除',
            f'真的要删除合集 "{series.id}" ({series.title})？\n此操作不可撤销。',
        ):
            return
        self._run_mutation(admin, 'delete', series_id=series.id)

    def _on_upload_to_oss_clicked(self) -> None:
        series = self._selected_series()
        if series is None:
            QMessageBox.information(self, '未选中', '请先在列表里选一行')
            return
        # Emit the bus signal — SeriesUploadTab listens and pre-selects
        # this series. MainWindow listens to request_focus_tab and
        # switches the visible tab.
        bus.upload_series_requested.emit(series.id)

    # ── mutation runner ───────────────────────────────────────────

    def _run_mutation(self, admin: SupabaseAdmin, op: str, **kwargs: Any) -> None:
        if self._worker is not None and self._worker.isRunning():
            QMessageBox.information(self, '请稍候', '上一次操作还没完成')
            return
        self._worker = _MutationWorker(admin, op, **kwargs)
        self._worker.done.connect(self._on_mutation_done)
        self._worker.start()

    def _on_mutation_done(self, ok: bool, message: str, _payload: object) -> None:
        if ok:
            self._refresh()
        else:
            QMessageBox.critical(self, '操作失败', message)

    # ── episodes sub-panel ───────────────────────────────────────

    def _on_series_selection_changed(self) -> None:
        """Series row click → load that series' episodes + show panel."""
        series = self._selected_series()
        if series is None:
            self._episodes_group.setVisible(False)
            self._episodes_rows = []
            self._ep_table.setRowCount(0)
            self._ep_count_label.setText('—')
            return
        self._episodes_group.setTitle(f'Episodes of: {series.title}  ({series.id})')
        self._episodes_group.setVisible(True)
        self._load_episodes(series.id)

    def _load_episodes(self, series_id: str) -> None:
        admin = self._admin()
        if admin is None:
            return
        if self._episodes_worker is not None and self._episodes_worker.isRunning():
            return
        self._ep_count_label.setText('加载中…')
        self._episodes_worker = _EpisodesListWorker(admin, series_id)
        self._episodes_worker.done.connect(self._on_episodes_list_done)
        self._episodes_worker.start()

    def _on_episodes_list_done(self, series_id: str, rows: list[dict[str, Any]], error: str) -> None:
        # Ignore stale results if the user moved on to a different series
        current = self._selected_series()
        if current is None or current.id != series_id:
            return
        if error:
            self._ep_count_label.setText('加载失败')
            QMessageBox.critical(self, '加载 episodes 失败', error)
            return
        self._episodes_rows = rows
        self._ep_count_label.setText(f'共 {len(rows)} 条')
        self._render_episodes_table()

    def _render_episodes_table(self) -> None:
        self._ep_table.setRowCount(len(self._episodes_rows))
        for row, data in enumerate(self._episodes_rows):
            ep = OfficialEpisode.from_row(data)
            cells = [
                str(ep.episode_index),
                ep.id,
                ep.title,
                ep.level,
                ep.video_file,
                '✓' if ep.has_roleplay else '—',
                '✓ 上架' if ep.is_published else '○ 草稿',
            ]
            for col, value in enumerate(cells):
                item = QTableWidgetItem(value)
                if col == 6 and not ep.is_published:
                    item.setForeground(Qt.GlobalColor.gray)
                self._ep_table.setItem(row, col, item)

    def _on_ep_refresh_clicked(self) -> None:
        series = self._selected_series()
        if series is None:
            return
        self._load_episodes(series.id)

    def _selected_episode_index(self) -> int:
        rows = self._ep_table.selectionModel().selectedRows()
        if not rows:
            return -1
        return rows[0].row()

    def _selected_episode(self) -> OfficialEpisode | None:
        idx = self._selected_episode_index()
        if idx < 0 or idx >= len(self._episodes_rows):
            return None
        return OfficialEpisode.from_row(self._episodes_rows[idx])

    def _on_ep_row_double_clicked(self, _index) -> None:
        self._on_ep_edit_clicked()

    def _on_ep_new_clicked(self) -> None:
        admin = self._admin()
        if admin is None:
            return
        series = self._selected_series()
        if series is None:
            QMessageBox.information(self, '未选 series', '请先在上方列表里选一个合集')
            return
        existing_ids = {r.get('id') for r in self._episodes_rows}
        dialog = EpisodeEditDialog(self, None, existing_ids)
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        ep = dialog.to_episode(None, series.id)
        self._run_ep_mutation(admin, 'upsert_one', series_id=series.id, episode_dict=ep.to_upsert_dict())

    def _on_ep_import_clicked(self) -> None:
        """Bulk-import episodes from a series.json file.

        Use case: the asset files are already on OSS (a previous
        upload, or someone else's setup) and we just need to (re)write
        the per-episode rows in Supabase. No OSS traffic in this
        handler — `upsert_episodes` only touches the DB.

        The user picks a local series.json, sees a preview with each
        row labeled 新增 / 覆盖, unchecks anything they don't want,
        and confirms. The dialog enforces the caller's series_id so
        the import can't accidentally land in the wrong series.
        """
        admin = self._admin()
        if admin is None:
            return
        series = self._selected_series()
        if series is None:
            QMessageBox.information(self, '未选 series', '请先在上方列表里选一个合集')
            return

        path_str, _ = QFileDialog.getOpenFileName(
            self, '选 series.json', '',
            'series.json (*.json);;所有文件 (*)',
        )
        if not path_str:
            return
        path = Path(path_str)

        try:
            parsed = parse_series_json_for_import(path)
        except FileNotFoundError:
            QMessageBox.critical(self, '文件不存在', f'找不到 {path}')
            return
        except Exception as exc:
            QMessageBox.critical(
                self, '解析失败',
                f'无法解析 series.json:\n{exc}\n\n确认是合法的 JSON + 含 episodes[] 数组。',
            )
            return
        if not parsed:
            QMessageBox.information(
                self, '无 episode',
                'series.json 里没找到任何 episode — 检查文件内容。',
            )
            return

        existing_ids = {r.get('id') for r in self._episodes_rows if r.get('id')}
        dialog = ImportEpisodesDialog(
            self,
            series_id=series.id,
            series_title=series.title,
            source_path=path,
            parsed_episodes=parsed,
            existing_ids=existing_ids,
        )
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        selected = dialog.get_selected()
        if not selected:
            return

        dicts = [e.to_upsert_dict() for e in selected]
        self._run_ep_mutation(
            admin, 'bulk_upsert',
            series_id=series.id,
            episode_dicts=dicts,
        )

    def _on_ep_import_from_oss_clicked(self) -> None:
        """Bulk-import episodes from the series's `manifest_url` on OSS.

        The "按合集上传" tab writes a `series.json` next to the
        assets at `videos/<id>/series.json` and stores the URL on
        the series row. This handler re-pulls that file (no local
        copy needed) and shows the same preview/confirm dialog as the
        local-file import. Use it to:
          - re-import after the Supabase episodes table got wiped
            (assets are still on OSS, just the rows are gone)
          - sync a series after a previous "按合集上传" run on
            another machine
          - backfill episodes for a series whose row was created
            manually in the Supabase dashboard

        If the series has no `manifest_url` yet, we surface a
        friendly message pointing at the 按合集上传 tab instead of
        silently failing.
        """
        admin = self._admin()
        if admin is None:
            return
        series = self._selected_series()
        if series is None:
            QMessageBox.information(self, '未选 series', '请先在上方列表里选一个合集')
            return
        if not series.manifest_url:
            QMessageBox.information(
                self, 'manifest_url 还没生成',
                f'合集 "{series.id}" 的 manifest_url 字段是空的。\n'
                '先去「按合集上传」tab 跑一次把 manifest.json 推到 OSS，'
                '或者用本地的 series.json 文件走「从 series.json 导入」。',
            )
            return

        try:
            raw_text = fetch_series_json_from_url(series.manifest_url)
            parsed = parse_series_json_text(raw_text)
        except Exception as exc:
            QMessageBox.critical(
                self, '从 OSS 拉 series.json 失败',
                f'URL: {series.manifest_url}\n错误: {exc}',
            )
            return
        if not parsed:
            QMessageBox.information(
                self, '无 episode',
                'OSS 上的 series.json 里没找到任何 episode — 检查 manifest.json 内容。',
            )
            return

        # Source path is a virtual one for the preview label; the
        # dialog only uses it for display, not for I/O.
        fake_source = Path(series.manifest_url)
        existing_ids = {r.get('id') for r in self._episodes_rows if r.get('id')}
        dialog = ImportEpisodesDialog(
            self,
            series_id=series.id,
            series_title=series.title,
            source_path=fake_source,
            parsed_episodes=parsed,
            existing_ids=existing_ids,
        )
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        selected = dialog.get_selected()
        if not selected:
            return

        dicts = [e.to_upsert_dict() for e in selected]
        self._run_ep_mutation(
            admin, 'bulk_upsert',
            series_id=series.id,
            episode_dicts=dicts,
        )

    def _on_ep_edit_clicked(self) -> None:
        admin = self._admin()
        if admin is None:
            return
        series = self._selected_series()
        ep = self._selected_episode()
        if series is None or ep is None:
            QMessageBox.information(self, '未选 episode', '请先在下方列表里选一行')
            return
        existing_ids = {r.get('id') for r in self._episodes_rows if r.get('id') != ep.id}
        dialog = EpisodeEditDialog(self, ep, existing_ids)
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        updated = dialog.to_episode(ep, series.id)
        self._run_ep_mutation(admin, 'upsert_one', series_id=series.id, episode_dict=updated.to_upsert_dict())

    def _on_ep_toggle_clicked(self) -> None:
        admin = self._admin()
        if admin is None:
            return
        ep = self._selected_episode()
        if ep is None:
            QMessageBox.information(self, '未选 episode', '请先在下方列表里选一行')
            return
        series = self._selected_series()
        new_state = not ep.is_published
        verb = '上架' if new_state else '下架'
        if not QMessageBox.question(
            self, f'确认{verb}', f'将 episode "{ep.id}" 设为{verb}？',
        ):
            return
        self._run_ep_mutation(
            admin, 'toggle_publish',
            series_id=series.id if series else '',
            episode_id=ep.id,
        )

    def _on_ep_delete_clicked(self) -> None:
        admin = self._admin()
        if admin is None:
            return
        ep = self._selected_episode()
        if ep is None:
            QMessageBox.information(self, '未选 episode', '请先在下方列表里选一行')
            return
        if not QMessageBox.question(
            self, '确认删除',
            f'真的要删除 episode "{ep.id}" ({ep.title})？\n只删 Supabase 记录，不动 OSS 上的文件。',
        ):
            return
        series = self._selected_series()
        self._run_ep_mutation(
            admin, 'delete_one',
            series_id=series.id if series else '',
            episode_id=ep.id,
        )

    def _run_ep_mutation(self, admin: SupabaseAdmin, op: str, **kwargs: Any) -> None:
        if self._episodes_mutation_worker is not None and self._episodes_mutation_worker.isRunning():
            QMessageBox.information(self, '请稍候', '上一次操作还没完成')
            return
        self._episodes_mutation_worker = _EpisodeMutationWorker(admin, op, **kwargs)
        self._episodes_mutation_worker.done.connect(self._on_ep_mutation_done)
        self._episodes_mutation_worker.start()

    def _on_ep_mutation_done(self, ok: bool, message: str, series_id: str) -> None:
        if ok:
            # Refresh only the currently-displayed series (don't trigger
            # a full series-list refresh; that resets selection)
            if series_id and self._selected_series() and self._selected_series().id == series_id:
                self._load_episodes(series_id)
        else:
            QMessageBox.critical(self, '操作失败', message)

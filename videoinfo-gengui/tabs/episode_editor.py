"""
Episode editor dialog. Used by ContentTab to add/edit a single
episode row. Mirrors `models.official_episode.OfficialEpisode`.

Kept as a separate module so ContentTab doesn't grow unbounded.
"""

from __future__ import annotations

from typing import Any

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from models.official_episode import OfficialEpisode
from models.official_series import LEVELS, TYPES, OfficialSeries


class EpisodeEditDialog(QDialog):
    """Single dialog for new + edit. Pass existing episode to pre-fill,
    or None for new.

    New-episode behavior:
      - ID is auto-generated as a 12-char UUID (collision-checked
        against `existing_ids`). The user can overwrite it before
        saving; the 🎲 button regenerates a fresh one.
      - The video filename (and other asset filenames) is what
        the user types — there's no OSS upload here. The "按合集
        上传" tab is the bulk path; this dialog is for ad-hoc
        fixups.
    """

    def __init__(self, parent: QWidget | None, episode: OfficialEpisode | None,
                 existing_ids: set[str]) -> None:
        super().__init__(parent)
        self._existing_ids = existing_ids
        self._build_ui(episode)

    def _build_ui(self, episode: OfficialEpisode | None) -> None:
        self.setWindowTitle('新建 episode' if episode is None else f'编辑 episode: {episode.id}')
        self.resize(620, 720)

        root = QVBoxLayout(self)
        form = QFormLayout()
        form.setLabelAlignment(Qt.AlignmentFlag.AlignRight)
        form.setHorizontalSpacing(12)
        form.setVerticalSpacing(6)

        # ID + 🎲 regenerate button. We pre-fill on open so the user
        # can save without touching it; the button is for "I want a
        # different UUID" rather than "give me my first UUID".
        self._id_input = QLineEdit()
        self._id_input.setMaxLength(64)
        self._id_input.textEdited.connect(self._on_id_edited)
        self._gen_id_btn = QPushButton('🎲 重新生成')
        self._gen_id_btn.setFixedWidth(96)
        self._gen_id_btn.clicked.connect(self._on_generate_id)
        id_row = QHBoxLayout()
        id_row.addWidget(self._id_input, 1)
        id_row.addWidget(self._gen_id_btn)
        id_row_container = QWidget()
        id_row_container.setLayout(id_row)

        self._index_input = QSpinBox()
        self._index_input.setRange(1, 100000)
        self._index_input.setValue(1)
        self._title_input = QLineEdit()
        self._level_combo = QComboBox()
        self._level_combo.addItems(LEVELS)
        self._category_input = QLineEdit()
        self._category_input.setPlaceholderText('例如: 口语表达 / 日常生活')
        self._type_combo = QComboBox()
        self._type_combo.addItems(TYPES)
        self._source_input = QLineEdit()
        self._source_input.setPlaceholderText('例如: Miss Honey / 官方')

        # Asset filenames (bare, no path). The user types the logical
        # name; the player joins it with the series `manifest_url` to
        # build the full OSS URL. mp4 (video_file) is NOT on OSS — the
        # user binds it to their baidu pan via `cloud_bindings`.
        self._video_input = QLineEdit()
        self._video_input.setPlaceholderText('必填：mp4 文件名（用户后续绑定到百度网盘）')
        self._sub_en_input = QLineEdit()
        self._sub_en_input.setPlaceholderText('en.json3 / .en.json3 — YouTube json3 主字幕')
        self._sub_en_seg_input = QLineEdit()
        self._sub_en_seg_input.setPlaceholderText('可选：.en.seg.json — 预分段版（给 ASR 用）')
        self._sub_zh_input = QLineEdit()
        self._sub_zh_input.setPlaceholderText('可选：.zh.json — 翻译轨')
        self._info_input = QLineEdit()
        self._info_input.setPlaceholderText('可选：.info.json — yt-dlp 元信息')
        self._ai_input = QLineEdit()
        self._ai_input.setPlaceholderText('可选：.ai-practice.json — 陪练卡片')
        self._cover_input = QLineEdit()
        self._cover_input.setPlaceholderText('可选：cover.jpg — 封面图裸文件名')

        # Toggles inline so they take one row instead of two.
        self._roleplay_check = QCheckBox('包含 roleplay 场景')
        self._roleplay_check.setChecked(True)
        self._published_check = QCheckBox('上架 (is_published)')
        self._published_check.setChecked(True)
        toggle_row = QHBoxLayout()
        toggle_row.addWidget(self._roleplay_check)
        toggle_row.addWidget(self._published_check)
        toggle_row.addStretch(1)
        toggle_row_container = QWidget()
        toggle_row_container.setLayout(toggle_row)

        if episode is not None:
            self._id_input.setText(episode.id)
            self._id_input.setReadOnly(True)  # PK 不让改
            self._id_input.setStyleSheet('color: #6B7280;')
            self._gen_id_btn.setEnabled(False)  # can't regenerate PK
            self._index_input.setValue(episode.episode_index)
            self._title_input.setText(episode.title)
            idx = self._level_combo.findText(episode.level)
            if idx >= 0:
                self._level_combo.setCurrentIndex(idx)
            self._category_input.setText(episode.category)
            idx = self._type_combo.findText(episode.type)
            if idx >= 0:
                self._type_combo.setCurrentIndex(idx)
            self._source_input.setText(episode.source_label)
            self._video_input.setText(episode.video_file)
            self._sub_en_input.setText(episode.subtitle_json3_file)
            self._sub_en_seg_input.setText(episode.subtitle_en_segmented_file)
            self._sub_zh_input.setText(episode.subtitle_zh_file)
            self._info_input.setText(episode.info_file)
            self._ai_input.setText(episode.ai_practice_file)
            self._cover_input.setText(episode.cover_file)
            self._roleplay_check.setChecked(episode.has_roleplay)
            self._published_check.setChecked(episode.is_published)
        else:
            # New episode — seed a UUID so the user can save immediately.
            self._seed_new_id()
            self._id_input.textChanged.connect(self._validate_id_uniqueness)

        form.addRow('ID *:', id_row_container)
        form.addRow('集数 *:', self._index_input)
        form.addRow('标题 *:', self._title_input)
        form.addRow('等级 *:', self._level_combo)
        form.addRow('分类:', self._category_input)
        form.addRow('类型 *:', self._type_combo)
        form.addRow('来源:', self._source_input)
        form.addRow('视频文件 *:', self._video_input)
        form.addRow('英文字幕:', self._sub_en_input)
        form.addRow('英文字幕 (分段):', self._sub_en_seg_input)
        form.addRow('中文字幕:', self._sub_zh_input)
        form.addRow('info.json:', self._info_input)
        form.addRow('AI 练习:', self._ai_input)
        form.addRow('封面:', self._cover_input)
        form.addRow('', toggle_row_container)
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

    def _on_id_edited(self, _text: str) -> None:
        # Hook for "auto-regenerate only until user touched it" if we
        # ever add cross-field inference. No-op for now.
        pass

    def _seed_new_id(self) -> None:
        """Generate an initial UUID and put it in the id input. We try
        a few times to avoid colliding with `existing_ids` (covers the
        common case of two consecutive dialogs in the same session)."""
        for _ in range(8):
            candidate = OfficialSeries.new_id()
            if candidate not in self._existing_ids:
                self._id_input.setText(candidate)
                return
        # 8 attempts in 12-hex-char space is essentially impossible
        # to fail (collision probability ≈ 8 / 16T), but fail safe.
        self._id_input.setText(OfficialSeries.new_id())

    def _on_generate_id(self) -> None:
        for _ in range(8):
            new_id = OfficialSeries.new_id()
            if new_id not in self._existing_ids:
                self._id_input.setText(new_id)
                self._validate_id_uniqueness()
                return
        QMessageBox.warning(self, '生成失败', '连续 8 次都撞到已存在 id，请手动指定一个。')

    def _validate_id_uniqueness(self) -> None:
        if self._id_input.text().strip() in self._existing_ids:
            self._error_label.setText('⚠ id 已存在，新建时必须唯一')
        else:
            self._error_label.setText('')

    def _on_accept(self) -> None:
        title = self._title_input.text().strip()
        if not title:
            self._error_label.setText('标题不能为空')
            return
        video = self._video_input.text().strip()
        if not video:
            self._error_label.setText('视频文件不能为空')
            return
        id_text = self._id_input.text().strip()
        if not id_text:
            self._error_label.setText('ID 不能为空 — 点 ID 旁边的「🎲 重新生成」按钮拿一个')
            return
        if not self._id_input.isReadOnly() and id_text in self._existing_ids:
            self._error_label.setText('ID 已存在，请换一个')
            return
        if self._index_input.value() < 1:
            self._error_label.setText('集数必须 ≥ 1')
            return
        self.accept()

    def to_episode(self, original: OfficialEpisode | None, series_id: str) -> OfficialEpisode:
        id_text = self._id_input.text().strip()
        return OfficialEpisode(
            id=id_text,
            series_id=series_id,
            episode_index=int(self._index_input.value()),
            title=self._title_input.text().strip(),
            level=self._level_combo.currentText(),
            category=self._category_input.text().strip(),
            type=self._type_combo.currentText(),
            source_label=self._source_input.text().strip(),
            video_file=self._video_input.text().strip(),
            subtitle_json3_file=self._sub_en_input.text().strip(),
            subtitle_en_segmented_file=self._sub_en_seg_input.text().strip(),
            subtitle_zh_file=self._sub_zh_input.text().strip(),
            info_file=self._info_input.text().strip(),
            ai_practice_file=self._ai_input.text().strip(),
            cover_file=self._cover_input.text().strip(),
            has_roleplay=self._roleplay_check.isChecked(),
            is_published=self._published_check.isChecked(),
            duration_seconds=original.duration_seconds if original else None,
        )

"""
Import-from-series.json dialog. Bulk-create / overwrite episode rows
from a previously-generated `series.json` file.

This is the read-only counterpart of the "按合集上传" pipeline tab:
where the upload tab builds a series.json from a local directory and
ships everything to OSS + Supabase, this dialog just reads an
EXISTING series.json (offline, no OSS traffic) and writes the
per-episode rows back to Supabase. Use it when:

  - DB was wiped and you want to re-import from a known-good manifest
  - Migrating from another tool's output format
  - The asset files are already on OSS (this dialog doesn't push them)

The dialog shows a preview with per-episode 新增 / 覆盖 status so the
admin can sanity-check before committing. Confirmation just closes
the dialog; the actual Supabase write happens in the caller's worker.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QAbstractItemView,
    QCheckBox,
    QDialog,
    QDialogButtonBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QMessageBox,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from models.official_episode import OfficialEpisode


@dataclass
class ImportPreviewRow:
    """One row in the preview table. `action` is one of
    'new' | 'overwrite' | 'skip' — used to drive the "what's
    going to happen" column.
    """
    episode: OfficialEpisode
    action: str  # 'new' | 'overwrite' | 'skip'


class ImportEpisodesDialog(QDialog):
    """Show a preview of what would be written, let the user pick
    which rows to include (per-row checkbox), and return the chosen
    list on accept.

    The caller provides:
      - the parsed episodes from a series.json
      - the existing episode ids in Supabase (so we can label each
        row 新增 vs 覆盖)
      - the series_id these episodes will be written under

    We do NOT validate that the series.json's own series metadata
    matches the caller's series_id — the caller decides. If they
    want strict matching, they check before opening this dialog.
    """

    def __init__(
        self,
        parent: QWidget | None,
        *,
        series_id: str,
        series_title: str,
        source_path: Path,
        parsed_episodes: list[OfficialEpisode],
        existing_ids: set[str],
    ) -> None:
        super().__init__(parent)
        self._series_id = series_id
        self._source_path = source_path
        self._rows: list[ImportPreviewRow] = []

        # Build preview rows. An episode that has the same id as an
        # existing row in the same series is "overwrite" (PK is
        # (series_id, id)); everything else is "new".
        for ep in parsed_episodes:
            if not ep.id:
                # No id = unparseable entry. Skip with a hint.
                self._rows.append(ImportPreviewRow(episode=ep, action='skip'))
                continue
            ep.series_id = series_id  # enforce caller's series_id
            action = 'overwrite' if ep.id in existing_ids else 'new'
            self._rows.append(ImportPreviewRow(episode=ep, action=action))

        self._build_ui(series_title)

    def _build_ui(self, series_title: str) -> None:
        self.setWindowTitle(f'从 series.json 导入 — {series_title}')
        self.resize(720, 480)

        root = QVBoxLayout(self)

        # Header: source + counts
        new_count = sum(1 for r in self._rows if r.action == 'new')
        overwrite_count = sum(1 for r in self._rows if r.action == 'overwrite')
        skip_count = sum(1 for r in self._rows if r.action == 'skip')

        source_label = QLabel(
            f'<b>来源:</b> {self._source_path}<br/>'
            f'<b>写入 series_id:</b> {self._series_id}'
        )
        source_label.setWordWrap(True)
        source_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        root.addWidget(source_label)

        summary_label = QLabel(
            f'<b>共 {len(self._rows)} 条:</b> '
            f'<span style="color: #059669;">新增 {new_count}</span> · '
            f'<span style="color: #D97706;">覆盖 {overwrite_count}</span>'
            + (f' · <span style="color: #94A3B8;">跳过 {skip_count}</span>' if skip_count else '')
        )
        root.addWidget(summary_label)

        # Preview table
        self._table = QTableWidget(len(self._rows), 5)
        self._table.setHorizontalHeaderLabels(['导入', '操作', 'ID', '集数', '标题'])
        self._table.verticalHeader().setVisible(False)
        self._table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        fh = self._table.horizontalHeader()
        fh.setSectionResizeMode(0, QHeaderView.ResizeMode.ResizeToContents)
        fh.setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)
        fh.setSectionResizeMode(2, QHeaderView.ResizeMode.ResizeToContents)
        fh.setSectionResizeMode(3, QHeaderView.ResizeMode.ResizeToContents)
        fh.setSectionResizeMode(4, QHeaderView.ResizeMode.Stretch)
        self._table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)

        self._row_checks: list[QCheckBox] = []
        for row, preview in enumerate(self._rows):
            # Checkbox (col 0)
            check = QCheckBox()
            # Skip rows can't be imported (no id), so disable the checkbox
            check.setEnabled(preview.action != 'skip')
            check.setChecked(preview.action != 'skip')  # default: import all eligible
            self._row_checks.append(check)
            check_container = QWidget()
            check_layout = QHBoxLayout(check_container)
            check_layout.setContentsMargins(0, 0, 0, 0)
            check_layout.addStretch(1)
            check_layout.addWidget(check)
            check_layout.addStretch(1)
            self._table.setCellWidget(row, 0, check_container)

            # Action label (col 1)
            if preview.action == 'new':
                action_text = '✓ 新增'
                action_color = '#059669'
            elif preview.action == 'overwrite':
                action_text = '↻ 覆盖'
                action_color = '#D97706'
            else:
                action_text = '⊘ 跳过 (无 id)'
                action_color = '#94A3B8'
            action_item = QTableWidgetItem(action_text)
            action_item.setForeground(Qt.GlobalColor.transparent)  # set via stylesheet below
            action_item.setData(Qt.ItemDataRole.UserRole, action_color)
            self._table.setItem(row, 1, action_item)

            # ID, index, title (cols 2, 3, 4)
            self._table.setItem(row, 2, QTableWidgetItem(preview.episode.id or '(空)'))
            self._table.setItem(row, 3, QTableWidgetItem(str(preview.episode.episode_index or '')))
            self._table.setItem(row, 4, QTableWidgetItem(preview.episode.title or '(无标题)'))

        # Apply the per-row color from UserRole
        for row in range(self._table.rowCount()):
            item = self._table.item(row, 1)
            if item is not None:
                color = item.data(Qt.ItemDataRole.UserRole)
                if color:
                    item.setForeground(Qt.GlobalColor.transparent)  # placeholder
                    # We have to set via stylesheet on the item to get a custom color;
                    # QTableWidgetItem.setForeground takes a QBrush/QColor.
                    from PySide6.QtGui import QColor
                    item.setForeground(QColor(color))
        root.addWidget(self._table, 1)

        # Warning footer
        if overwrite_count > 0:
            warn = QLabel(
                f'⚠ 这次会覆盖 Supabase 里 {overwrite_count} 条已有 episode。'
                '确认前请确认 series.json 里的内容是对的。'
            )
            warn.setStyleSheet('color: #D97706;')
            warn.setWordWrap(True)
            root.addWidget(warn)

        # Buttons
        button_box = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        button_box.button(QDialogButtonBox.StandardButton.Ok).setText('导入所选')
        button_box.accepted.connect(self._on_accept)
        button_box.rejected.connect(self.reject)
        root.addWidget(button_box)

    def _on_accept(self) -> None:
        selected: list[OfficialEpisode] = []
        for check, preview in zip(self._row_checks, self._rows):
            if check.isChecked() and preview.action != 'skip':
                selected.append(preview.episode)
        if not selected:
            QMessageBox.information(self, '未选任何 episode', '勾上要导入的行再确认。')
            return
        self._selected_episodes = selected
        self.accept()

    def get_selected(self) -> list[OfficialEpisode]:
        """Episodes the user chose to import. Only valid after accept()."""
        return getattr(self, '_selected_episodes', [])


def parse_series_json_for_import(path: Path) -> list[OfficialEpisode]:
    """Read a series.json file and return a list of `OfficialEpisode`s.

    Thin wrapper around `parse_series_json_text` that handles the
    file-read step. Use this from any caller that has a local path
    (e.g. the user picked a file via QFileDialog).
    """
    raw = path.read_text(encoding='utf-8')
    return parse_series_json_text(raw)


def parse_series_json_text(raw_text: str) -> list[OfficialEpisode]:
    """Parse a series.json string and return a list of `OfficialEpisode`s.

    Why a top-level helper:
      The caller (ContentTab's import handler) needs to do the file
      I/O + JSON parse before opening the preview dialog — that way
      the dialog can show "we found N episodes, here's the preview"
      instead of "click OK and then we'll see what's in there".

    Reusable across local-file and remote-URL paths: the URL fetcher
    just does `parse_series_json_text(requests.get(url).text)` and
    gets the same shape.

    Schema: see `tabs/build_oss_manifest_from_yt_dir.build_series_manifest`
    for the canonical shape. We accept any subset:
      - top-level `episodes[]` is required
      - each episode uses the same `assets.X` nesting that the
        upload-tab manifest builder produces
      - missing assets come through as empty strings (Supabase
        columns are nullable; we send `None` instead)

    Raises:
      json.JSONDecodeError, ValueError — caller catches and shows QMessageBox.
      (FileNotFoundError is the wrapper's job, not ours.)
    """
    import json
    data: dict[str, Any] = json.loads(raw_text)
    raw_episodes = data.get('episodes') or []
    if not isinstance(raw_episodes, list):
        raise ValueError(f'series.json 顶层 episodes 字段不是 list（{type(raw_episodes).__name__}）')

    # The series.json's `series.id` is informational — the dialog
    # caller decides which series_id to write under. We default to
    # using whatever's in the file so the parsed episodes have a
    # sensible series_id; the dialog enforces the caller's pick.
    file_series_id = ''
    series_meta = data.get('series')
    if isinstance(series_meta, dict):
        file_series_id = str(series_meta.get('id') or '').strip()

    episodes: list[OfficialEpisode] = []
    for ep_dict in raw_episodes:
        if not isinstance(ep_dict, dict):
            continue
        try:
            ep = OfficialEpisode.from_manifest_episode(ep_dict, file_series_id)
        except Exception:
            # Bad entry — skip rather than abort the whole import.
            continue
        if not ep.id:
            # The from_manifest_episode requires a non-empty id. If
            # missing, the row is unimportable; the dialog shows it
            # as 'skip' so the user knows why.
            ep.id = ''
        episodes.append(ep)
    return episodes


def fetch_series_json_from_url(url: str, timeout_seconds: float = 15.0) -> str:
    """Fetch a series.json from an OSS (or any HTTP) URL and return
    the raw text. Uses urllib (stdlib) — no new dependency.

    Caller's responsibility: validate the URL is HTTPS / from a
    trusted host. We don't pin to aliyun specifically because
    `manifest_url` is just an OSS URL we wrote ourselves in
    `SeriesUploadWorker`, so a `https://` URL is sufficient.

    Raises:
      urllib.error.URLError, TimeoutError, ValueError on non-200.
    """
    import urllib.error
    import urllib.request
    req = urllib.request.Request(url, headers={'User-Agent': 'videoinfo-gengui/import'})
    with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
        # HTTP/HTTPS responses have a `.status` int; file:// responses
        # don't — we skip the status check for those (anything we can
        # open locally is fine, by construction).
        status = getattr(resp, 'status', None)
        if status is not None and status != 200:
            raise ValueError(f'HTTP {status} 从 {url} 拉 series.json')
        charset = resp.headers.get_content_charset() or 'utf-8'
        return resp.read().decode(charset)

"""
Series upload tab — pushes a local directory of yt-dlp downloads to OSS
under `videos/<series-id>/`, parses them as episodes, and writes both
`official_video_episodes` rows AND the series `manifest_url` to
Supabase.

This is the "step 3" tab that closes the loop:
  ContentTab (edit metadata) → SeriesUploadTab (build & ship) → Supabase
                                                            ↑ ↓
                                                           OSS

The legacy UploadTab (free-form OSS / 百度网盘) is kept as a
sibling for one-off uploads and ad-hoc testing.

The per-series `manifest.json` on OSS is no longer the source of truth
for episode lists — Supabase is. We do still write a manifest.json
file to OSS for back-compat with older clients (read-only legacy
cache), but it's regenerated from Supabase on every upload, not the
other way around.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PySide6.QtCore import Qt, QThread, Signal
from PySide6.QtGui import QColor
from PySide6.QtWidgets import (
    QAbstractItemView,
    QCheckBox,
    QComboBox,
    QFileDialog,
    QFormLayout,
  QGroupBox,
  QHBoxLayout,
  QHeaderView,
  QLabel,
  QMessageBox,
  QPlainTextEdit,
  QProgressBar,
  QPushButton,
  QTableWidget,
  QTableWidgetItem,
  QVBoxLayout,
  QWidget,
)

from models.official_ai_practice import OfficialAiPracticeCard
from models.official_episode import OfficialEpisode
from models.official_series import OfficialSeries
from services.env_config import get_supabase_config
from services.oss_client import OSSConfig, build_bucket, upload_files
from services.series_manifest import build_series_manifest
from services.supabase_client import SupabaseAdmin
from services.tab_bus import bus
from tabs.baidu_pan_settings import get_baidu_remote_root, upload_files_to_baidu
from tabs.runtime_support import load_json_config


SUPPORTED_SUFFIXES = (
    # Video — RECOGNIZED but NOT uploaded. mp4 lives on the user's
    # own baidu pan; we only keep the filename as a logical id in
    # `official_video_episodes.video_file` so the rn-app can match
    # a baidu-pan binding to it. The `find_sets` parser still walks
    # the local video files to derive episode ids + titles, so they
    # need to be on disk during upload.
    '.mp4', '.webm', '.mkv',
    # Everything below is uploaded to OSS as-is.
    '.json3', '.json', '.info.json',
    '.jpg', '.jpeg', '.png', '.webp',
    '.ai-practice.json',
    '.zh.json', '.en.seg.json',
)


# The subset of `SUPPORTED_SUFFIXES` that actually get pushed to OSS.
# Videos are excluded — see the comment above. Keep this in sync with
# `SUPPORTED_SUFFIXES`; the intent is "everything except the video
# extensions".
UPLOAD_SUFFIXES = tuple(
    s for s in SUPPORTED_SUFFIXES
    if s not in ('.mp4', '.webm', '.mkv')
)


# ── Worker: full upload pipeline ─────────────────────────────────────


@dataclass
class _UploadResult:
    ok: bool
    message: str
    manifest_url: str | None = None
    episode_count: int = 0
    uploaded_keys: list[str] | None = None
    failed: list[tuple[str, str]] | None = None  # (key, error)
    baidu_uploaded_count: int = 0
    baidu_failed: list[tuple[Path, str]] | None = None  # (local_path, error)


class _SeriesUploadWorker(QThread):
    """Run the whole series-upload pipeline off the UI thread.

    Steps:
      1. List all files in the source dir (skip dotfiles + unsupported).
         Video files (mp4/webm/mkv) are RECOGNIZED but NOT uploaded —
         the user keeps those locally and binds a baidu-pan file via
         `cloud_bindings` on the rn-app side. We still need them on
         disk so the parser can derive episode ids + titles.
      2. Parse the existing manifest to extract per-episode metadata.
      3. Upload the non-video files (subs, covers, info.json, AI cards)
         to OSS at `videos/<series_id>/<basename>`. The video filename
         is recorded in `official_video_episodes.video_file` as a
         logical name (no OSS path).
      4. Build a manifest.json from the parsed episodes and upload it too.
      5. Compute the public URL, upsert all episodes into
         `official_video_episodes`, and write `manifest_url` to the
         series row in `official_video_series`.
    """

    log = Signal(str)
    progress = Signal(int, int)  # done, total
    done = Signal(object)  # _UploadResult

    def __init__(
        self,
        *,
        series_id: str,
        series_meta: dict[str, Any],
        local_dir: Path,
        oss_cfg: OSSConfig,
        admin: SupabaseAdmin | None,
        upload_videos_to_baidu: bool = False,
    ) -> None:
        super().__init__()
        self._series_id = series_id
        self._series_meta = series_meta
        self._local_dir = local_dir
        self._oss_cfg = oss_cfg
        self._admin = admin
        self._upload_videos_to_baidu = upload_videos_to_baidu

    def run(self) -> None:
        try:
            self._run_inner()
        except Exception as exc:
            self.done.emit(_UploadResult(
                ok=False,
                message=f'未捕获异常: {exc}',
            ))

    def _run_inner(self) -> None:
        # 1. collect files. We scan everything recognized (including
        # local video files) so the manifest parser can derive episode
        # ids/titles, but only push the non-video subset to OSS.
        all_recognized = sorted(
            p for p in self._local_dir.rglob('*')
            if p.is_file()
            and not p.name.startswith('.')
            and self._is_supported(p)
        )
        if not all_recognized:
            self.done.emit(_UploadResult(ok=False, message='本地目录里没有可识别的文件'))
            return
        local_videos = [p for p in all_recognized if self._is_local_video(p)]
        upload_files_list = [p for p in all_recognized if self._is_uploadable(p)]
        prefix = self._oss_cfg.prefix.rstrip('/')
        key_prefix = f'{prefix}/{self._series_id}' if prefix else self._series_id
        file_pairs = [(p, f'{key_prefix}/{p.name}') for p in upload_files_list]
        total = len(file_pairs) + 1  # +1 for manifest
        self.log.emit(
            f'准备上传 {len(upload_files_list)} 个文件到 OSS {key_prefix}/ '
            f'（{len(local_videos)} 个本地视频文件仅作为 video_file 逻辑名保留）'
        )

        bucket = build_bucket(self._oss_cfg)
        self.log.emit('OSS 连接已建立，开始上传…')

        def on_progress(done: int, total_count: int, current: Path) -> None:
            self.progress.emit(done, total)
            self.log.emit(f'  [{done}/{total_count}] {current.name}')

        results = upload_files(bucket, file_pairs, on_progress=on_progress)
        ok_count = sum(1 for _, _, ok, _ in results if ok)
        failed = [(key, err) for (_, key, ok, err) in results if not ok]
        self.log.emit(f'文件上传完成: 成功 {ok_count}/{len(results)}')

        # 1.5 upload local videos to baidu pan (opt-in). Runs BEFORE
        # parsing so the manifest's per-episode `video_file` field
        # (a logical name) matches what the user can bind in-app.
        baidu_uploaded_count = 0
        baidu_failed: list[tuple[Path, str]] = []
        if self._upload_videos_to_baidu and local_videos:
            baidu_root = get_baidu_remote_root()
            if not baidu_root:
                self.log.emit('[百度网盘] 跳过：未配置 网盘目录（请到 系统设置 → 百度网盘 设置）')
            else:
                baidu_pairs = [(p, f'{self._series_id}/{p.name}') for p in local_videos]
                baidu_target_root = f'{baidu_root.rstrip("/")}/{self._series_id}'
                total_baidu_bytes = sum(p.stat().st_size for p, _ in baidu_pairs)
                self.log.emit(f'准备上传 {len(baidu_pairs)} 个视频到 百度网盘 {baidu_target_root}/ (共 {total_baidu_bytes / 1e6:.1f} MB)')

                def baidu_progress(done: int, total_count: int, current: Path) -> None:
                    self.log.emit(f'  [百度 {done}/{total_count}] {current.name}')

                def baidu_chunk_progress(
                    file_idx: int, total_files: int, current: Path,
                    chunk_done: int, total_chunks: int,
                    bytes_done: int, bytes_total: int,
                    file_bytes_done: int, file_bytes_total: int,
                ) -> None:
                    # 日志里的 % 用当前文件级（直观），进度条用全集累计（平滑）
                    file_mb_done = file_bytes_done / 1e6
                    file_mb_total = file_bytes_total / 1e6
                    file_pct = file_bytes_done * 100 // max(file_bytes_total, 1)
                    overall_mb_done = bytes_done / 1e6
                    overall_mb_total = bytes_total / 1e6
                    overall_pct = bytes_done * 100 // max(bytes_total, 1)
                    self.log.emit(
                        f'    百度 [{file_idx}/{total_files}] {current.name} 分片 {chunk_done}/{total_chunks}  '
                        f'({file_mb_done:.1f}/{file_mb_total:.1f} MB, {file_pct}%) '
                        f'[合集 {overall_mb_done:.1f}/{overall_mb_total:.1f} MB, {overall_pct}%]'
                    )
                    # 进度条按字节累计更新（更平滑）
                    self.progress.emit(bytes_done, bytes_total)

                def baidu_step(
                    step: str, file_idx: int, total_files: int, current: Path, **kwargs,
                ) -> None:
                    """在每个阶段**前** emit 一次 log，让 UI 立刻知道在干啥。
                    避免大文件走完 analyze/precreate/locate 几个慢步骤看起来像死锁。
                    """
                    if step == 'analyze':
                        self.log.emit(
                            f'    百度 [{file_idx}/{total_files}] {current.name} '
                            f'分析分片 ({kwargs.get("size", 0) / 1e6:.1f} MB)...'
                        )
                    elif step == 'precreate':
                        self.log.emit(
                            f'    百度 [{file_idx}/{total_files}] precreate {current.name}...'
                        )
                    elif step == 'locate_host':
                        self.log.emit(
                            f'    百度 [{file_idx}/{total_files}] locate upload host...'
                        )
                    elif step == 'chunk_start':
                        self.log.emit(
                            f'    百度 [{file_idx}/{total_files}] {current.name} '
                            f'分片 {kwargs.get("chunk_i", 0)}/{kwargs.get("total_chunks", 0)} 开始 '
                            f'({kwargs.get("chunk_size", 0) / 1e6:.1f} MB)...'
                        )
                    elif step == 'create':
                        self.log.emit(
                            f'    百度 [{file_idx}/{total_files}] create {current.name}...'
                        )

                try:
                    baidu_uploaded_count, baidu_failed = upload_files_to_baidu(
                        remote_root=baidu_root,
                        file_pairs=baidu_pairs,
                        on_progress=baidu_progress,
                        on_chunk_progress=baidu_chunk_progress,
                        on_step=baidu_step,
                    )
                    self.log.emit(
                        f'百度网盘视频上传完成: 成功 {baidu_uploaded_count}/{len(baidu_pairs)}'
                    )
                except Exception as exc:
                    self.log.emit(f'[错误] 百度网盘视频上传失败: {exc}')
                    # record all videos as failed
                    baidu_failed = [(p, str(exc)) for p in local_videos]
        elif self._upload_videos_to_baidu and not local_videos:
            self.log.emit('[百度网盘] 跳过：本地没有视频文件')
        if baidu_failed:
            for p, err in baidu_failed:
                self.log.emit(f'  · 百度网盘失败 {p.name}: {err}')

        # 2. parse manifest → list of episodes (for Supabase upsert).
        # The parser walks the local video files to derive episode
        # ids + titles — we don't upload the videos, but we DO need
        # them on disk during parsing. The resulting `video_file`
        # field on each episode is a logical name (no OSS path).
        self.log.emit('正在解析 episodes…')
        manifest = build_series_manifest(self._local_dir)
        raw_episodes = manifest.get('episodes') or []
        episodes = [
            OfficialEpisode.from_manifest_episode(ep, self._series_id)
            for ep in raw_episodes
        ]
        # Drop episodes that ended up with no video_file (parser
        # couldn't match a video to the entry — usually a corrupt
        # local dir).
        episodes = [e for e in episodes if e.video_file]
        self.log.emit(f'解析出 {len(episodes)} 个 episodes')

        # 3. inject series meta into the manifest
        manifest['seriesId'] = self._series_id
        if self._series_meta:
            manifest['seriesTitle'] = self._series_meta.get('title')
            manifest['level'] = self._series_meta.get('level')
            manifest['category'] = self._series_meta.get('category')

        # 4. upload manifest.json
        manifest_key = f'{key_prefix}/series.json'
        manifest_json = json.dumps(manifest, ensure_ascii=False, indent=2)
        self.log.emit(f'正在上传 manifest: {manifest_key}')
        try:
            bucket.put_object(manifest_key, manifest_json.encode('utf-8'))
        except Exception as exc:
            self.done.emit(_UploadResult(
                ok=False,
                message=f'manifest 上传失败: {exc}',
                uploaded_keys=[k for _, k, ok, _ in results if ok],
                failed=[(manifest_key, str(exc))],
            ))
            return
        self.progress.emit(total, total)

        # 5. build the public URL
        endpoint = self._oss_cfg.endpoint.rstrip('/')
        bucket_name = self._oss_cfg.bucket
        host = endpoint.replace('https://', '').replace('http://', '')
        manifest_url = f'https://{bucket_name}.{host}/{manifest_key}'

        # 6. write to Supabase (episodes + cover_url + manifest_url)
        if self._admin is not None:
            self.log.emit('正在写入 episodes 到 Supabase…')
            try:
                self._admin.upsert_episodes(
                    self._series_id,
                    [e.to_upsert_dict() for e in episodes],
                )
                self.log.emit(f'✓ {len(episodes)} episodes 已写入')
            except Exception as exc:
                self.done.emit(_UploadResult(
                    ok=False,
                    message=(
                        f'文件 + manifest 上传成功，但写 episodes 失败: {exc}\n'
                        f'manifest_url: {manifest_url}'
                    ),
                    manifest_url=manifest_url,
                    episode_count=0,
                    uploaded_keys=[k for _, k, ok, _ in results if ok] + [manifest_key],
                    failed=[('supabase_episodes_write', str(exc))],
                ))
                return

            # Backfill the series row with whatever the manifest thinks
            # the cover is. We only write if non-empty — an empty
            # coverUrl in the manifest usually means "the user removed
            # the cover from the local dir on purpose", and we don't
            # want to silently clobber the value the user set via the
            # new "上传封面" button in the dialog. Failure here is
            # non-fatal: the assets are still on OSS and the series
            # row is mostly correct (just missing the cover), so we
            # log and move on.
            manifest_cover = str(manifest.get('series', {}).get('coverUrl') or '').strip()
            if manifest_cover:
                try:
                    self._admin.update_series(self._series_id, {'cover_url': manifest_cover})
                    self.log.emit(f'✓ cover_url 已回写: {manifest_cover}')
                except Exception as exc:
                    self.log.emit(f'⚠ cover_url 回写失败（不影响整体）: {exc}')

            # AI practice cards: for each episode that references a
            # local .ai-practice.json, parse the file and upsert the
            # cards into `official_video_ai_practice`. Per-episode
            # failure is non-fatal — we log and continue with the
            # next episode. Cards that disappeared from the local
            # file (vs a previous upload) are also pruned, so a re-run
            # is fully idempotent.
            self.log.emit('正在写入 AI 陪练卡片到 Supabase…')
            total_cards = 0
            for ep in episodes:
                if not ep.ai_practice_file:
                    continue
                local_ai_path = self._local_dir / ep.ai_practice_file
                if not local_ai_path.exists():
                    # Try a recursive find (the file might be in a
                    # subdir if the user organized the local dir
                    # by series).
                    matches = list(self._local_dir.rglob(ep.ai_practice_file))
                    if matches:
                        local_ai_path = matches[0]
                    else:
                        self.log.emit(f'  ⚠ [{ep.id}] 找不到本地 .ai-practice.json，跳过')
                        continue
                try:
                    with local_ai_path.open('r', encoding='utf-8') as f:
                        ai_payload = json.load(f)
                except Exception as exc:
                    self.log.emit(f'  ⚠ [{ep.id}] 读 {local_ai_path.name} 失败: {exc}，跳过')
                    continue
                # Tolerate the same shapes as the rn-app's loader
                # (top-level array, or {items: [...]} / {cards: [...]}).
                raw_cards = (
                    ai_payload if isinstance(ai_payload, list)
                    else (ai_payload.get('items') if isinstance(ai_payload.get('items'), list) else None)
                    or (ai_payload.get('cards') if isinstance(ai_payload.get('cards'), list) else None)
                    or []
                )
                if not raw_cards:
                    self.log.emit(f'  · [{ep.id}] {local_ai_path.name} 里没 cards，跳过')
                    continue
                cards = [
                    OfficialAiPracticeCard.from_oss_card(
                        c,
                        series_id=self._series_id,
                        episode_id=ep.id,
                        card_index=i,
                    )
                    for i, c in enumerate(raw_cards)
                    if isinstance(c, dict)
                ]
                # Drop cards missing a stable id (table PK is
                # (series_id, id) — an empty id would block the
                # upsert and any later deletes by id).
                cards = [c for c in cards if c.id]
                if not cards:
                    self.log.emit(f'  · [{ep.id}] {local_ai_path.name} 全是空 id，跳过')
                    continue
                # Wipe-and-rewrite: simpler than diffing and matches
                # the desktop's "this local file is the new truth"
                # contract. Cheap because the typical episode has
                # 2-8 cards.
                try:
                    self._admin.delete_ai_practice_cards_for_episode(self._series_id, ep.id)
                    self._admin.upsert_ai_practice_cards(
                        self._series_id, ep.id,
                        [c.to_upsert_dict() for c in cards],
                    )
                    total_cards += len(cards)
                    self.log.emit(f'  ✓ [{ep.id}] {len(cards)} 张 AI 卡片已写入')
                except Exception as exc:
                    self.log.emit(f'  ⚠ [{ep.id}] AI 卡片写 Supabase 失败: {exc}，继续')
            if total_cards:
                self.log.emit(f'✓ AI 陪练卡片共 {total_cards} 张已写入')

            self.log.emit('正在回写 manifest_url 到 series 行…')
            try:
                self._admin.set_manifest_url(self._series_id, manifest_url)
                self.log.emit('✓ manifest_url 已写入')
            except Exception as exc:
                self.done.emit(_UploadResult(
                    ok=False,
                    message=(
                        f'episodes 已写入，但回写 manifest_url 失败: {exc}\n'
                        f'你可能需要手动在「内容管理」里把 manifest_url 改成:\n{manifest_url}'
                    ),
                    manifest_url=manifest_url,
                    episode_count=len(episodes),
                    uploaded_keys=[k for _, k, ok, _ in results if ok] + [manifest_key],
                    failed=[('supabase_manifest_url_write', str(exc))],
                ))
                return

        uploaded_keys = [k for _, k, ok, _ in results if ok] + [manifest_key]
        msg = '✓ 上传完成'
        if failed:
            msg += f'（OSS 失败 {len(failed)} 个）'
        if baidu_failed:
            msg += f'（百度网盘失败 {len(baidu_failed)} 个）'
        self.done.emit(_UploadResult(
            ok=True,
            message=msg,
            manifest_url=manifest_url,
            episode_count=len(episodes),
            uploaded_keys=uploaded_keys,
            failed=failed or None,
            baidu_uploaded_count=baidu_uploaded_count,
            baidu_failed=baidu_failed or None,
        ))

    @staticmethod
    def _is_supported(p: Path) -> bool:
        """Recognized on disk — includes video files. Used by both the
        file scan (UI display) and the manifest parser (derives
        episode ids + titles from local mp4 stems)."""
        name = p.name.lower()
        if name.endswith('.ai-practice.json'):
            return True
        return p.suffix.lower() in SUPPORTED_SUFFIXES

    @staticmethod
    def _is_local_video(p: Path) -> bool:
        """Video files we keep on disk only — they back the
        `video_file` logical name but never go to OSS."""
        return p.suffix.lower() in ('.mp4', '.webm', '.mkv')

    @staticmethod
    def _is_uploadable(p: Path) -> bool:
        """Recognized AND not a local video — these are the ones
        actually pushed to OSS."""
        return _SeriesUploadWorker._is_supported(p) and not _SeriesUploadWorker._is_local_video(p)


# ── Tab ──────────────────────────────────────────────────────────────


class SeriesUploadTab(QWidget):
    def __init__(self) -> None:
        super().__init__()
        self._series_rows: list[dict[str, Any]] = []
        self._worker: _SeriesUploadWorker | None = None
        self._prefill_series_id: str | None = None
        self._build_ui()
        self._refresh_series_list()

        # Listen for "go upload this series" requests from ContentTab.
        bus.upload_series_requested.connect(self._on_upload_requested)

    # ── UI ────────────────────────────────────────────────────────

    def _build_ui(self) -> None:
        root = QVBoxLayout(self)
        root.setContentsMargins(16, 16, 16, 16)
        root.setSpacing(12)

        # Top hint
        hint = QLabel(
            '按合集上传：选一个 Supabase 里的合集 + 本地目录，'
            '把字幕/封面/AI 卡片/info.json 推到 OSS 的 videos/<合集id>/，'
            '生成 series.json，回写 manifest_url。\n'
            'mp4 / webm / mkv 保留在本地 — 只作为 video_file 逻辑名写入 Supabase，'
            '用户后续在 app 里把本地视频关联到自己的百度网盘。'
        )
        hint.setWordWrap(True)
        hint.setStyleSheet('color: #475569;')
        root.addWidget(hint)

        # Series selector
        select_group = QGroupBox('1. 选合集')
        select_form = QFormLayout(select_group)
        self._series_combo = QComboBox()
        self._series_combo.setMinimumWidth(360)
        self._series_combo.currentIndexChanged.connect(self._on_series_changed)
        self._refresh_series_btn = QPushButton('刷新列表')
        self._refresh_series_btn.clicked.connect(self._refresh_series_list)
        self._series_info_label = QLabel('—')
        self._series_info_label.setStyleSheet('color: #475569;')
        self._series_info_label.setWordWrap(True)
        select_row = QHBoxLayout()
        select_row.addWidget(self._series_combo, 1)
        select_row.addWidget(self._refresh_series_btn)
        select_form.addRow('合集:', select_row)
        select_form.addRow('当前元数据:', self._series_info_label)
        root.addWidget(select_group)

        # Local dir picker
        dir_group = QGroupBox('2. 选本地目录（包含 mp4 / json3 / 封面等）')
        dir_layout = QVBoxLayout(dir_group)
        dir_row = QHBoxLayout()
        self._dir_input = QLabel('（未选择）')
        self._dir_input.setStyleSheet('color: #6B7280; font-family: Consolas, monospace;')
        self._dir_input.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self._choose_dir_btn = QPushButton('选择目录…')
        self._choose_dir_btn.clicked.connect(self._on_choose_dir)
        self._scan_btn = QPushButton('扫描')
        self._scan_btn.clicked.connect(self._scan_local_dir)
        dir_row.addWidget(self._dir_input, 1)
        dir_row.addWidget(self._choose_dir_btn)
        dir_row.addWidget(self._scan_btn)
        dir_layout.addLayout(dir_row)

        self._file_table = QTableWidget(0, 5)
        self._file_table.setHorizontalHeaderLabels(['文件名', '大小', '处理', '目标 OSS key / 备注', '目标 百度网盘'])
        self._file_table.verticalHeader().setVisible(False)
        self._file_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        fh = self._file_table.horizontalHeader()
        fh.setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        fh.setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)
        fh.setSectionResizeMode(2, QHeaderView.ResizeMode.ResizeToContents)
        fh.setSectionResizeMode(3, QHeaderView.ResizeMode.Stretch)
        fh.setSectionResizeMode(4, QHeaderView.ResizeMode.Stretch)
        dir_layout.addWidget(self._file_table, 1)
        root.addWidget(dir_group)

        # 百度网盘上传选项
        self._upload_videos_to_baidu_check = QCheckBox('同时上传视频 (mp4/webm/mkv) 到配置的 百度网盘')
        self._upload_videos_to_baidu_check.setChecked(False)
        self._upload_videos_to_baidu_check.setToolTip(
            '勾选后会把本地视频文件上传到 系统设置 → 百度网盘 配置的网盘目录下\n'
            '（路径: {网盘目录}/{合集id}/{视频文件名}）。\n'
            'app 端用户后续把这个目录绑定到合集即可观看。\n'
            '未配置 百度网盘 时此选项无效。'
        )
        # 放到「3. 上传」group 上面一行
        root.addWidget(self._upload_videos_to_baidu_check)

        # Start / progress
        action_group = QGroupBox('3. 上传')
        action_layout = QVBoxLayout(action_group)
        action_row = QHBoxLayout()
        self._start_btn = QPushButton('开始上传 + 回写 manifest_url')
        self._start_btn.setEnabled(False)
        self._start_btn.clicked.connect(self._on_start)
        self._progress_bar = QProgressBar()
        self._progress_bar.setValue(0)
        action_row.addWidget(self._start_btn)
        action_row.addWidget(self._progress_bar, 1)
        action_layout.addLayout(action_row)

        self._log_box = QPlainTextEdit()
        self._log_box.setReadOnly(True)
        self._log_box.setMaximumHeight(180)
        self._log_box.setPlaceholderText('上传日志…')
        action_layout.addWidget(self._log_box)
        root.addWidget(action_group)

        self._current_dir: Path | None = None

    # ── data ──────────────────────────────────────────────────────

    def _admin(self) -> SupabaseAdmin | None:
        cfg = get_supabase_config()
        if not cfg.is_configured:
            return None
        return SupabaseAdmin(cfg.url or '', cfg.service_key or '')

    def _oss_cfg(self) -> OSSConfig:
        return OSSConfig.from_runtime_config()

    def _refresh_series_list(self) -> None:
        admin = self._admin()
        if admin is None:
            self._series_combo.clear()
            self._series_combo.addItem('（未配置 Supabase）', None)
            return
        try:
            rows = admin.list_series()
        except Exception as exc:
            # Don't show a modal — it's annoying during tab switches
            # and CI/smoke tests. Surface in the log box + leave the
            # combo with a "加载失败" placeholder so the rest of the
            # tab stays usable.
            self._series_combo.clear()
            self._series_combo.addItem('（加载失败 — 看下方日志）', None)
            self._log_box.appendPlainText(f'[错误] 加载合集列表失败: {exc}')
            return
        self._series_rows = rows
        self._series_combo.blockSignals(True)
        self._series_combo.clear()
        self._series_combo.addItem('— 选择合集 —', None)
        for row in rows:
            series = OfficialSeries.from_row(row)
            status = '✓' if series.is_published else '○'
            label = f'{status} [{series.level}] {series.title}  ({series.id})'
            self._series_combo.addItem(label, series.id)
        self._series_combo.blockSignals(False)
        # Apply pending prefill (e.g. from ContentTab)
        if self._prefill_series_id:
            self._select_series_by_id(self._prefill_series_id)
            self._prefill_series_id = None
        else:
            self._on_series_changed()

    def _select_series_by_id(self, series_id: str) -> None:
        for i in range(self._series_combo.count()):
            if self._series_combo.itemData(i) == series_id:
                self._series_combo.setCurrentIndex(i)
                return

    def _on_series_changed(self) -> None:
        series_id = self._series_combo.currentData()
        if not series_id:
            self._series_info_label.setText('—')
            return
        for row in self._series_rows:
            if row.get('id') == series_id:
                s = OfficialSeries.from_row(row)
                info = (
                    f'分类 {s.category}  ·  类型 {s.type}  ·  '
                    f'排序 {s.sort_order}  ·  状态 {"已上架" if s.is_published else "草稿"}\n'
                    f'当前 manifest_url: {s.manifest_url or "（空）"}'
                )
                self._series_info_label.setText(info)
                return
        self._series_info_label.setText('—')

    # ── file scan ─────────────────────────────────────────────────

    def _on_choose_dir(self) -> None:
        chosen = QFileDialog.getExistingDirectory(self, '选择本地合集目录')
        if not chosen:
            return
        self._current_dir = Path(chosen)
        self._dir_input.setText(str(self._current_dir))
        self._scan_local_dir()

    def _scan_local_dir(self) -> None:
        if not self._current_dir or not self._current_dir.exists():
            self._file_table.setRowCount(0)
            self._start_btn.setEnabled(False)
            return
        files = sorted(
            p for p in self._current_dir.rglob('*')
            if p.is_file()
            and not p.name.startswith('.')
            and _SeriesUploadWorker._is_supported(p)
        )
        prefix = self._oss_cfg().prefix.rstrip('/')
        series_id = self._series_combo.currentData() or 'UNKNOWN'
        key_prefix = f'{prefix}/{series_id}' if prefix else series_id
        baidu_root = get_baidu_remote_root()
        baidu_target_root = f'{baidu_root.rstrip("/")}/{series_id}' if baidu_root else ''

        self._file_table.setRowCount(len(files))
        uploadable_count = 0
        video_count = 0
        for row, p in enumerate(files):
            size_kb = p.stat().st_size / 1024
            size_str = f'{size_kb / 1024:.1f} MB' if size_kb > 1024 else f'{size_kb:.0f} KB'
            is_video = _SeriesUploadWorker._is_local_video(p)
            if is_video:
                action = '不上传（仅逻辑名）'
                target = '→ Supabase `video_file`'
                baidu_target = f'{baidu_target_root}/{p.name}' if baidu_target_root else '— 未配置 网盘目录'
                video_count += 1
                row_color = '#F1F5F9'  # gray-100 — visually de-emphasize
            else:
                action = '上传到 OSS'
                target = f'{key_prefix}/{p.name}'
                baidu_target = '—'
                uploadable_count += 1
                row_color = None
            self._file_table.setItem(row, 0, QTableWidgetItem(p.name))
            self._file_table.setItem(row, 1, QTableWidgetItem(size_str))
            self._file_table.setItem(row, 2, QTableWidgetItem(action))
            self._file_table.setItem(row, 3, QTableWidgetItem(target))
            self._file_table.setItem(row, 4, QTableWidgetItem(baidu_target))
            if row_color:
                for col in range(5):
                    item = self._file_table.item(row, col)
                    if item is not None:
                        item.setBackground(QColor(row_color))
        self._start_btn.setEnabled(uploadable_count > 0 and bool(series_id))

    # ── upload ────────────────────────────────────────────────────

    def _on_start(self) -> None:
        if not self._current_dir or not self._current_dir.exists():
            QMessageBox.warning(self, '未选目录', '请先选一个本地目录')
            return
        series_id = self._series_combo.currentData()
        if not series_id:
            QMessageBox.warning(self, '未选合集', '请先选一个 Supabase 合集')
            return
        oss_cfg = self._oss_cfg()
        if not oss_cfg.is_configured:
            QMessageBox.warning(
                self, 'OSS 未配置',
                '请在 config.json（%APPDATA%/DeckMind/videoinfo-gengui/config.json）的 oss 节点填好 endpoint / bucket / ak / sk。',
            )
            return
        if not QMessageBox.question(
            self, '确认上传',
            f'将把 {self._file_table.rowCount()} 个文件 + manifest.json 推到 OSS\n'
            f'合集: {series_id}\n本地: {self._current_dir}\n'
            f'视频上传到百度网盘: {"是" if self._upload_videos_to_baidu_check.isChecked() else "否"}\n\n继续？',
        ):
            return

        # Find the matching series row for the manifest metadata
        series_meta: dict[str, Any] = {}
        for row in self._series_rows:
            if row.get('id') == series_id:
                series_meta = row
                break

        self._start_btn.setEnabled(False)
        self._progress_bar.setValue(0)
        self._log_box.clear()
        upload_videos = self._upload_videos_to_baidu_check.isChecked()
        if upload_videos:
            if not get_baidu_remote_root():
                QMessageBox.warning(
                    self, '百度网盘未配置',
                    '勾选了「同时上传视频到百度网盘」，但 系统设置 → 百度网盘 的 网盘目录 为空。\n'
                    '请先到系统设置填好 网盘目录 后再开始。',
                )
                return
        self._worker = _SeriesUploadWorker(
            series_id=series_id,
            series_meta=series_meta,
            local_dir=self._current_dir,
            oss_cfg=oss_cfg,
            admin=self._admin(),
            upload_videos_to_baidu=upload_videos,
        )
        self._worker.log.connect(self._log_box.appendPlainText)
        self._worker.progress.connect(self._on_progress)
        self._worker.done.connect(self._on_done)
        self._worker.start()

    def _on_progress(self, done: int, total: int) -> None:
        self._progress_bar.setMaximum(total)
        self._progress_bar.setValue(done)

    def _on_done(self, result: _UploadResult) -> None:
        self._start_btn.setEnabled(True)
        self._log_box.appendPlainText('')
        self._log_box.appendPlainText(result.message)
        if result.ok:
            QMessageBox.information(
                self, '上传完成',
                f'manifest_url:\n{result.manifest_url}\n\n内容管理 tab 刷新后会看到。',
            )
        else:
            QMessageBox.warning(self, '部分失败', result.message)

    # ── bus integration ───────────────────────────────────────────

    def _on_upload_requested(self, series_id: str) -> None:
        """Triggered by ContentTab's "上传到此合集" button. Switch
        the dropdown to the requested series (refreshing the list
        if it isn't loaded yet) and ask MainWindow to bring this
        tab to the front."""
        if self._series_combo.findData(series_id) < 0:
            self._prefill_series_id = series_id
            self._refresh_series_list()
        else:
            self._select_series_by_id(series_id)
        # Tell MainWindow to bring this tab into focus. Passing self
        # so MainWindow can find our index by widget identity (no
        # hardcoded magic numbers).
        bus.request_focus_tab.emit(self)

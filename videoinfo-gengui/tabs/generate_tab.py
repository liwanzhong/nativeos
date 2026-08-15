from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
from pathlib import Path

from PySide6.QtCore import QThread, Signal, Qt
from PySide6.QtGui import QFont
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
    QLineEdit,
    QPlainTextEdit,
    QPushButton,
    QSpinBox,
    QTabWidget,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from tabs.ai_client import (
    load_ai_config,
    generate_practice_cards,
    classify_video,
    generate_zh_subtitle_file,
)
from tabs.asr_client import generate_asr_subtitle_for_record, load_asr_config
from tabs.runtime_support import get_config_path, load_json_config, resolve_ffmpeg_dir, save_json_config

import tabs.build_oss_manifest_from_yt_dir as manifest_script
import tabs.build_local_package_from_yt_dir as package_script
import tabs.generate_ai_practice_from_yt_dir as ai_script


DEFAULT_MAX_WORKERS = 3
MAX_MAX_WORKERS = 8


# ---------------------------------------------------------------------------
# 扫描逻辑
# ---------------------------------------------------------------------------

def _canonical_stem(path: Path) -> str:
    name = path.name
    for suffix in ('.info.json', '.ai-practice.json', '.en.json3', '.json3'):
        if name.endswith(suffix):
            return name[: -len(suffix)]
    return path.stem


def _collect(target_dir: Path, patterns: tuple[str, ...]) -> dict[str, Path]:
    matched: dict[str, Path] = {}
    for pattern in patterns:
        for p in sorted(target_dir.glob(pattern)):
            matched.setdefault(_canonical_stem(p), p)
    return matched


def _collect_zh(target_dir: Path) -> dict[str, Path]:
    matched: dict[str, Path] = {}
    for p in sorted(target_dir.glob('*.zh.json')):
        stem = p.name[:-8]  # strip ".zh.json"
        matched.setdefault(stem, p)
    return matched


def scan_directory(target_dir: Path, recursive: bool = False) -> list[dict]:
    """扫描 target_dir 下的视频素材。

    ``recursive=False`` (默认): 只看 target_dir 直接子目录, 跟旧版行为一致。

    ``recursive=True``: 递归扫所有层, **以 ``*.mp4`` 为锚点** 找 video set。
    - 适配 yt-dlp 的 ``<uploader>/<title>/`` 落盘结构
    - 父 video 和它 ``chapters/`` 下面的 chapter 切片都算独立 record
      (chapter 视频是独立可用的短视频, 每个有 mp4 + json3 + jpg, 没有 .info.json)
    - 跳过 ``packages/`` / ``__pycache__/`` / ``.yt-dlp-archives/`` 这些真正是
      副产物的目录
    每个 record 多带一个 ``relative_dir`` (相对 target_dir 的路径) 字段, 表格里展示用。
    """
    if not recursive:
        local_dirs = [(target_dir, '')]
    else:
        # 真正的副产物目录 (chapter 视频是独立可用资源, 不算副产物, 不跳过)
        SKIP_DIR_NAMES = {'packages', '__pycache__'}

        def _is_skipped_dir(rel_parts: tuple[str, ...]) -> bool:
            for p in rel_parts:
                if p in SKIP_DIR_NAMES:
                    return True
                if p.lstrip('.').startswith('yt-dlp-archives'):
                    return True
            return False

        # 收集所有 mp4 所在的 (local_dir, rel_dir) 对, 跳过副产物目录
        # 用 mp4 当锚点而不是 info.json, 因为 chapter 视频没有 .info.json
        VIDEO_EXTS = ('*.mp4', '*.webm', '*.mkv')
        local_dirs_set: set[tuple[Path, str]] = set()
        local_dirs_set.add((target_dir, ''))
        for ext in VIDEO_EXTS:
            for vid_path in target_dir.rglob(ext):
                # 跳过 yt-dlp 下载未完成的 .part 文件
                if vid_path.suffix == '.part' or vid_path.name.endswith('.part'):
                    continue
                try:
                    rel = vid_path.relative_to(target_dir)
                except ValueError:
                    continue
                if _is_skipped_dir(rel.parts[:-1]):
                    continue
                local_dir = vid_path.parent
                rel_dir = rel.parent.as_posix() if str(rel.parent) != '.' else ''
                local_dirs_set.add((local_dir, rel_dir))
        local_dirs = sorted(local_dirs_set, key=lambda x: x[1])

    records: list[dict] = []
    for local_dir, rel_dir in local_dirs:
        info_map = _collect(local_dir, ('*.info.json',))
        # *.json3 不匹配 *.en.json3 / *.zh.json3 (Python glob 的 * 不跨 .), yt-dlp 下载的
        # 字幕文件都带 .en 后缀 (e.g. "01 - Tropical Day Trip.en.json3"), 必须把这两个
        # pattern 都加进去, 否则 _generate_zh_subtitles / _generate_ai_practice
        # 找不到 subtitle, 全部 "0 个文件"。
        sub_map = _collect(local_dir, ('*.en.json3', '*.json3'))
        vid_map = _collect(local_dir, ('*.mp4', '*.webm', '*.mkv'))
        cover_map = _collect(local_dir, ('*.jpg', '*.jpeg', '*.png', '*.webp'))
        ai_map = _collect(local_dir, ('*.ai-practice.json',))
        zh_map = _collect_zh(local_dir)
        all_stems = sorted(
            set(info_map) | set(sub_map) | set(vid_map) | set(cover_map) | set(ai_map) | set(zh_map)
        )
        for stem in all_stems:
            _append_record(
                records, target_dir, local_dir, rel_dir,
                stem,
                info_map.get(stem),
                sub_map.get(stem),
                vid_map.get(stem),
                cover_map.get(stem),
                ai_map.get(stem),
                zh_map.get(stem),
            )
    return records


def _append_record(
    records: list[dict],
    target_dir: Path,
    local_dir: Path,
    rel_dir: str,
    stem: str,
    info_path: Path | None,
    sub_path: Path | None,
    vid_path: Path | None,
    cover_path: Path | None,
    ai_path: Path | None,
    zh_path: Path | None,
) -> None:
    title = stem
    if info_path:
        try:
            info = ai_script.load_json(info_path)
            title = str(info.get('title') or stem)
        except Exception:
            pass
    missing: list[str] = []
    if not vid_path:
        missing.append('视频')
    if not sub_path:
        missing.append('字幕')
    if not info_path:
        missing.append('Info')

    # can_generate 现在放宽到 video + sub 齐就行, info.json 可选
    # (chapter 切片通常没 info.json, 但有 mp4 + json3 + jpg, 也能跑 AI 陪练)
    can_generate = bool(vid_path) and bool(sub_path)

    if missing:
        status = f"缺失：{' / '.join(missing)}"
        if vid_path and info_path and not sub_path:
            status = '可生成 ASR 英文字幕 · 缺失：字幕'
        elif vid_path and not sub_path:
            status = '可生成 ASR 英文字幕 · 缺失：Info / 字幕'
        elif can_generate and info_path is None:
            status = '可生成 AI 陪练 · 缺失：Info'
        elif can_generate and not ai_path:
            status = '就绪 · 待生成 (仅 mp4 + 字幕, 无 info)'
    else:
        parts: list[str] = []
        if ai_path:
            parts.append('AI')
        if zh_path:
            parts.append('中文字幕')
        if parts:
            status = '就绪 · ' + ' + '.join(parts) + ' 已生成'
        else:
            status = '就绪 · 待生成'

    records.append({
        'stem': stem,
        'title': title,
        'status': status,
        'video': vid_path,
        'subtitle': sub_path,
        'zh': zh_path,
        'info': info_path,
        'cover': cover_path,
        'ai': ai_path,
        'can_generate': can_generate,
        'can_generate_asr': bool(vid_path),
        'relative_dir': rel_dir,
        'local_dir': local_dir,
        'target_dir': target_dir,
    })


# ---------------------------------------------------------------------------
# 后台线程
# ---------------------------------------------------------------------------

class GenerateWorker(QThread):
    log_line = Signal(str)
    finished_signal = Signal()

    def __init__(
        self,
        target_dir: Path,
        generate_ai: bool,
        generate_manifest: bool,
        generate_zh: bool = False,
        ai_cfg: dict[str, str] | None = None,
        generate_asr: bool = False,
        asr_cfg: dict[str, str] | None = None,
        export_packages: bool = False,
        package_output_dir: Path | None = None,
        max_workers: int = DEFAULT_MAX_WORKERS,
        english_segmentation_mode: str = 'auto',
        series_meta: dict[str, str] | None = None,
        update_catalog: bool = False,
        force_regenerate: bool = False,
        catalog_output_path: Path | None = None,
        catalog_manifest_url: str = '',
        catalog_resource_base_url: str = '',
        standalone_manifest_url: str = '',
        records: list[dict] | None = None,
        ffmpeg_dir: str = '',
        recursive_scan: bool = True,
    ) -> None:
        super().__init__()
        self.target_dir = target_dir
        self.generate_ai = generate_ai
        self.generate_manifest = generate_manifest
        self.generate_zh = generate_zh
        self.ai_cfg = ai_cfg
        self.generate_asr = generate_asr
        self.asr_cfg = asr_cfg or {}
        self.ffmpeg_dir = resolve_ffmpeg_dir(ffmpeg_dir)  # 解析成实际可用的目录
        self.export_packages = export_packages
        self.package_output_dir = package_output_dir
        self.max_workers = max(1, max_workers)
        self.english_segmentation_mode = english_segmentation_mode or 'auto'
        self.series_meta = series_meta or {}
        self.update_catalog = update_catalog
        self.force_regenerate = force_regenerate
        self.catalog_output_path = catalog_output_path
        self.catalog_manifest_url = catalog_manifest_url
        self.catalog_resource_base_url = catalog_resource_base_url
        self.standalone_manifest_url = standalone_manifest_url
        self.recursive_scan = recursive_scan
        # _scan 已经把 records 算好了, worker 不要再 re-glob, 直接消费
        self.records = records or []

    def _stem_from_subtitle_path(self, json3_path: Path) -> str:
        stem = json3_path.name
        for suffix in ('.en.json3', '.json3'):
            if stem.endswith(suffix):
                return stem[:-len(suffix)]
        return json3_path.stem

    def _effective_workers(self, task_count: int) -> int:
        return max(1, min(self.max_workers, task_count))

    def _generate_ai_practice_for_set(
        self, stem: str, info_path: Path, subtitle_path: Path, output_path: Path
    ) -> tuple[Path, int, str]:
        # info.json 在 chapter 视频里可能没有, fallback 用 stem 当 title
        if info_path and info_path.exists():
            info = ai_script.load_json(info_path)
        else:
            info = {}
        title = ai_script.normalize_space(str(info.get('title') or stem))
        description = ai_script.first_meaningful_sentence(str(info.get('description') or ''))
        transcript_lines = ai_script.extract_utterances(subtitle_path)
        self.log_line.emit(f'  [AI][{title[:40]}] 分析等级…')
        classification: dict[str, object] = {}
        try:
            classification = classify_video(title, description, transcript_lines, self.ai_cfg)
            level = classification.get('level', 'B1')
            if level not in ('A1', 'A2', 'B1', 'B2', 'C1', 'C2'):
                level = 'B1'
            self.log_line.emit(f'  [AI][{title[:40]}] 等级: {level}')
        except Exception as exc:
            self.log_line.emit(f'  [AI][{title[:40]}] [分类跳过, 默认B1] {exc}')
            level = 'B1'
        self.log_line.emit(f'  [AI][{title[:40]}] 生成陪练…')
        cards = generate_practice_cards(title, description, transcript_lines, self.ai_cfg, level=level)

        stem_slug = ai_script.slug_from_stem(stem)
        items = []
        for idx, card in enumerate(cards, start=1):
            card['id'] = f'{stem_slug}__ai__{idx}'
            if not card.get('npcSystemPrompt'):
                card['npcSystemPrompt'] = (
                    f"You are {card.get('npcName', 'Partner')}, a character in a scenario about {title}. "
                    f'Help the learner practise spoken English at {level} level.'
                )
            items.append(card)

        payload = {
            'sourceVideo': stem,
            'videoTitle': info.get('title') or stem,
            'videoAnalysis': {
                'level': level,
                'category': str(classification.get('category') or '').strip(),
                'type': str(classification.get('type') or '').strip(),
                'theme': str(classification.get('theme') or '').strip(),
                'tags': [str(tag).strip() for tag in (classification.get('tags') or []) if str(tag).strip()],
            },
            'items': items,
        }
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with output_path.open('w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        return output_path, len(items), level

    def _generate_zh_subtitle_for_file(self, json3_path: Path, output_path: Path) -> int:
        self.log_line.emit(f'  [字幕][{json3_path.name}] 处理中…')
        translations = generate_zh_subtitle_file(
            json3_path, output_path, self.ai_cfg,
            correction_mode=self.english_segmentation_mode,
            on_progress=lambda msg, name=json3_path.name: self.log_line.emit(f'  [字幕][{name}] {msg}'),
        )
        return len(translations)

    def _generate_asr_subtitle_for_set(self, record: dict) -> tuple[Path, int]:
        stem = str(record['stem'])
        # ASR 字幕要写到 record 自己的 local_dir (chapter 视频在 chapters/<n>/ 下)
        local_dir = record.get('local_dir') or self.target_dir
        output_path = local_dir / f'{stem}.en.json3'
        self.log_line.emit(f'  [ASR][{stem}] 处理中…')
        payload = generate_asr_subtitle_for_record(
            local_dir,
            stem,
            record.get('video'),
            record.get('info'),
            output_path,
            self.asr_cfg,
            ffmpeg_dir=self.ffmpeg_dir,
            force_regenerate=self.force_regenerate,
            on_progress=lambda msg, name=stem: self.log_line.emit(f'  [ASR][{name}] {msg}'),
        )
        return output_path, len(payload.get('events') or [])

    def _generate_ai_practice(self) -> None:
        self.log_line.emit('正在用 AI 生成陪练文件…')
        # _scan_records 已经扫过, 直接用 self.records 而不是再 glob 一遍
        pending: list[dict] = []
        self.log_line.emit(f'[调试] _generate_ai_practice 收到 {len(self.records)} 个 record')
        for idx, record in enumerate(self.records):
            can_gen = record.get('can_generate')
            sub_path = record.get('subtitle')
            vid_path = record.get('video')
            self.log_line.emit(f'[调试] record[{idx}] stem={record.get("stem")!r} can_generate={can_gen} subtitle={sub_path!r} video={vid_path!r}')
            if not can_gen:
                continue
            local_dir = record.get('local_dir') or self.target_dir
            output_path = local_dir / f"{record['stem']}.ai-practice.json"
            if output_path.exists() and not self.force_regenerate:
                self.log_line.emit(f'  跳过（已存在）: {Path(local_dir).name}/{output_path.name}')
                continue
            pending.append({**record, '_output_path': output_path})
        if not pending:
            self.log_line.emit('AI 陪练生成完成：0 个文件')
            return
        worker_count = self._effective_workers(len(pending))
        self.log_line.emit(f'并行任务数：{worker_count}')
        created = 0
        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            future_map = {
                executor.submit(
                    self._generate_ai_practice_for_set,
                    record['stem'],
                    record['info'],
                    record['subtitle'],
                    record['_output_path'],
                ): record
                for record in pending
            }
            for future in as_completed(future_map):
                record = future_map[future]
                try:
                    output_path, item_count, level = future.result()
                    self.log_line.emit(f'  OK {output_path.name} ({item_count} 个场景, {level})')
                    created += 1
                except Exception as exc:
                    self.log_line.emit(f'  [失败] {record["stem"]}: {exc}')
        self.log_line.emit(f'AI 陪练生成完成：{created} 个文件')

    def _generate_manifest(self) -> None:
        self.log_line.emit('正在根据系列目录实时扫描并更新 series.json…')
        try:
            manifest = manifest_script.build_series_manifest(self.target_dir, self.series_meta)
            output = self.target_dir / 'series.json'
            with output.open('w', encoding='utf-8') as f:
                json.dump(manifest, f, ensure_ascii=False, indent=2)
            episodes = manifest.get('episodes', [])
            self.log_line.emit(f'series.json 已保存到 {output}，共 {len(episodes)} 集')

            if self.update_catalog:
                catalog_path = self.catalog_output_path or (self.target_dir.parent / 'official-video-catalog.json')
                if catalog_path.exists():
                    try:
                        catalog = json.loads(catalog_path.read_text('utf-8'))
                    except Exception:
                        catalog = {}
                else:
                    catalog = manifest_script.build_catalog_manifest([])
                try:
                    manifest_url = os.path.relpath(str(output.resolve()), str(catalog_path.parent.resolve())).replace('\\', '/')
                except Exception as exc:
                    raise RuntimeError(f'无法计算 series.json 相对总系列文件目录的路径: {exc}') from exc
                entry = manifest_script.build_catalog_entry(manifest, manifest_url)
                catalog = manifest_script.upsert_series_entry(catalog, entry)
                catalog_path.parent.mkdir(parents=True, exist_ok=True)
                catalog_path.write_text(json.dumps(catalog, ensure_ascii=False, indent=2), 'utf-8')
                self.log_line.emit(f'已将当前目录的 series.json 引用合并/更新到总系列文件：{catalog_path}')
                self.log_line.emit(f'  引用路径: {manifest_url}')
        except Exception as exc:
            self.log_line.emit(f'[错误] {exc}')

    def _generate_zh_subtitles(self) -> None:
        self.log_line.emit('正在用 AI 翻译生成中文字幕…')
        pending_jobs: list[tuple[Path, Path]] = []
        created = 0
        self.log_line.emit(f'[调试] _generate_zh_subtitles 收到 {len(self.records)} 个 record')
        for idx, record in enumerate(self.records):
            sub_path = record.get('subtitle')
            self.log_line.emit(f'[调试] record[{idx}] stem={record.get("stem")!r} subtitle={sub_path!r} zh_exists={record.get("zh")!r}')
            if not sub_path:
                continue
            local_dir = record.get('local_dir') or self.target_dir
            output_path = local_dir / f"{record['stem']}.zh.json"
            if output_path.exists() and not self.force_regenerate:
                self.log_line.emit(f'  跳过（已存在）: {Path(local_dir).name}/{output_path.name}')
                continue
            pending_jobs.append((sub_path, output_path))
        if not pending_jobs:
            self.log_line.emit('中文字幕生成完成：0 个文件')
            return
        worker_count = self._effective_workers(len(pending_jobs))
        self.log_line.emit(f'并行任务数：{worker_count}')
        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            future_map = {
                executor.submit(self._generate_zh_subtitle_for_file, json3_path, output_path): (json3_path, output_path)
                for json3_path, output_path in pending_jobs
            }
            for future in as_completed(future_map):
                json3_path, output_path = future_map[future]
                try:
                    translated = future.result()
                    self.log_line.emit(f'  OK {output_path.name}（{translated} 句已翻译）')
                    created += 1
                except Exception as exc:
                    self.log_line.emit(f'  [失败] {json3_path.name}: {exc}')
        self.log_line.emit(f'中文字幕生成完成：{created} 个文件')

    def _generate_asr_subtitles(self) -> None:
        self.log_line.emit('正在用 ASR 生成英文字幕…')
        pending_records: list[dict] = []
        for record in self.records:
            if not record.get('can_generate_asr'):
                continue
            local_dir = record.get('local_dir') or self.target_dir
            output_path = local_dir / f"{record['stem']}.en.json3"
            if output_path.exists() and not self.force_regenerate:
                self.log_line.emit(f'  跳过（已存在）: {Path(local_dir).name}/{output_path.name}')
                continue
            pending_records.append({**record, '_output_path': output_path})
        if not pending_records:
            self.log_line.emit('ASR 英文字幕生成完成：0 个文件')
            return
        worker_count = self._effective_workers(len(pending_records))
        self.log_line.emit(f'并行任务数：{worker_count}')
        created = 0
        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            future_map = {
                executor.submit(self._generate_asr_subtitle_for_set, record): record
                for record in pending_records
            }
            for future in as_completed(future_map):
                record = future_map[future]
                try:
                    output_path, event_count = future.result()
                    self.log_line.emit(f'  OK {output_path.name}（{event_count} 条 ASR 字幕事件）')
                    created += 1
                except Exception as exc:
                    self.log_line.emit(f'  [失败] {record["stem"]}: {exc}')
        self.log_line.emit(f'ASR 英文字幕生成完成：{created} 个文件')

    def _export_packages(self) -> None:
        output_dir = self.package_output_dir or (self.target_dir / 'packages')
        self.log_line.emit(f'正在导出 Deckpack 包到：{output_dir}')
        created = package_script.export_packages(
            self.target_dir,
            output_dir,
            on_progress=lambda msg: self.log_line.emit(msg),
        )
        self.log_line.emit(f'Deckpack 包导出完成：{len(created)} 个文件')

    def run(self) -> None:
        try:
            if self.generate_asr:
                self._generate_asr_subtitles()
                # ASR 写盘后, self.records 里的 subtitle 字段是启动时扫的旧快照,
                # 后续 _generate_zh_subtitles / _generate_ai_practice 会因为
                # record['subtitle'] == None 全跳过. 在这里重扫一次, 让后续步骤
                # 看到刚生成的 .en.json3 文件. 这也是为什么单独按钮能跑、综合
                # 按钮不行的 root cause — 单独按钮的 ASR 完成后, 主线程的
                # _on_generate_done 会调 _scan() 重扫 records, 第二次点击时
                # records 已经是新状态.
                self.log_line.emit(f'[调试] ASR 阶段完成, 重新扫描目录以刷新 records…')
                try:
                    self.records = scan_directory(self.target_dir, recursive=self.recursive_scan)
                    self.log_line.emit(f'[调试] 重新扫描完成, 当前 {len(self.records)} 个 record')
                    for idx, record in enumerate(self.records):
                        self.log_line.emit(
                            f'[调试]  re-scan record[{idx}] stem={record.get("stem")!r} '
                            f'subtitle={record.get("subtitle")!r} zh={record.get("zh")!r}'
                        )
                except Exception as exc:
                    self.log_line.emit(f'[错误] ASR 后重扫目录失败: {exc}')
            if self.generate_zh:
                self._generate_zh_subtitles()
            if self.generate_ai:
                self._generate_ai_practice()
            if self.generate_manifest:
                self._generate_manifest()
            if self.export_packages:
                self._export_packages()
        except Exception as exc:
            self.log_line.emit(f'[错误] {exc}')
        finally:
            self.finished_signal.emit()


# ---------------------------------------------------------------------------
# 标签页 UI
# ---------------------------------------------------------------------------

class GenerateTab(QWidget):
    def __init__(self) -> None:
        super().__init__()
        self.records: list[dict] = []
        self.current_dir: Path | None = None
        self.package_output_dir: Path | None = None
        self.catalog_output_path: Path | None = None
        self.worker: GenerateWorker | None = None
        self._build_ui()
        self._load_config()

    def _build_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(12)

        # --- 目录选择 ---
        dir_group = QGroupBox('选择已下载的视频目录')
        dir_layout = QVBoxLayout(dir_group)
        dir_row = QHBoxLayout()
        self.dir_input = QLineEdit()
        self.dir_input.setPlaceholderText('点击右侧按钮选择 yt-dlp 已下载的目录')
        self.dir_input.setReadOnly(True)
        dir_row.addWidget(self.dir_input)
        self.browse_btn = QPushButton('选择目录')
        self.browse_btn.clicked.connect(self._choose_dir)
        self.scan_btn = QPushButton('扫描素材')
        self.scan_btn.clicked.connect(self._scan)
        dir_row.addWidget(self.browse_btn)
        dir_row.addWidget(self.scan_btn)
        dir_layout.addLayout(dir_row)
        self.recursive_scan_checkbox = QCheckBox('递归扫描子目录 (适配 yt-dlp 下载的 <uploader>/<title>/ 结构, 跳过 chapters/ 等副产物)')
        self.recursive_scan_checkbox.setChecked(True)
        self.recursive_scan_checkbox.toggled.connect(lambda _checked: self._save_config(generate_recursive_scan=str(self.recursive_scan_checkbox.isChecked())))
        dir_layout.addWidget(self.recursive_scan_checkbox)
        self.scan_summary_label = QLabel('请先选择目录并扫描素材。')
        dir_layout.addWidget(self.scan_summary_label)
        layout.addWidget(dir_group)

        self.function_tabs = QTabWidget()
        self.function_tabs.addTab(self._build_overview_page(), '素材概览')
        self.function_tabs.addTab(self._build_ai_page(), 'AI 生成')
        # 2026-08-14 隐藏: 合并/更新到 App 总系列 已经被 Supabase 总系列取代
        # self.function_tabs.addTab(self._build_manifest_page(), '合并/更新到 App 总系列')
        # 2026-08-14 隐藏: Deckpack 导出已经被 Supabase + OSS 直传取代
        # self.function_tabs.addTab(self._build_export_page(), '导出')
        layout.addWidget(self.function_tabs, 1)

        # --- 日志 ---
        log_group = QGroupBox('日志')
        log_layout = QVBoxLayout(log_group)
        self.log_box = QPlainTextEdit()
        self.log_box.setReadOnly(True)
        self.log_box.setMaximumHeight(180)
        self.log_box.setPlaceholderText('操作日志会显示在这里…')
        log_layout.addWidget(self.log_box)
        layout.addWidget(log_group)

    def _build_overview_page(self) -> QWidget:
        page = QWidget()
        page_layout = QVBoxLayout(page)
        page_layout.setContentsMargins(0, 0, 0, 0)
        page_layout.setSpacing(12)
        self.table = QTableWidget(0, 9)
        self.table.setHorizontalHeaderLabels(
            ['标题', '所属子目录', '状态', '视频', '字幕', '中文字幕', 'Info', '封面', 'AI 文件']
        )
        self.table.verticalHeader().setVisible(False)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        header.setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)
        for col in range(2, 9):
            header.setSectionResizeMode(col, QHeaderView.ResizeMode.ResizeToContents)
        page_layout.addWidget(self.table)
        return page

    def _build_ai_page(self) -> QWidget:
        page = QWidget()
        page_layout = QVBoxLayout(page)
        page_layout.setContentsMargins(0, 0, 0, 0)
        page_layout.setSpacing(12)
        # AI / ASR 配置在「系统设置」tab, 这里只读显示 + 跳过去改
        config_group = QGroupBox('AI / ASR 配置（在「系统设置」tab 维护）')
        config_form = QFormLayout(config_group)
        self.ai_config_status_label = QLabel('—')
        self.ai_config_status_label.setWordWrap(True)
        self.ai_config_status_label.setTextInteractionFlags(
            Qt.TextInteractionFlag.TextSelectableByMouse
        )
        mono = QFont('Consolas')
        mono.setStyleHint(QFont.StyleHint.Monospace)
        self.ai_config_status_label.setFont(mono)
        config_form.addRow('当前配置', self.ai_config_status_label)
        ai_jump_btn = QPushButton('去系统设置改…')
        ai_jump_btn.clicked.connect(self._jump_to_ai_settings)
        config_form.addRow('', ai_jump_btn)
        page_layout.addWidget(config_group)

        # 运行时选项保留在生成 tab (并行数 / 断句模式 / 强制重生成)
        run_group = QGroupBox('运行选项')
        run_form = QFormLayout(run_group)
        self.parallel_spin = QSpinBox()
        self.parallel_spin.setMinimum(1)
        self.parallel_spin.setMaximum(MAX_MAX_WORKERS)
        self.parallel_spin.setValue(DEFAULT_MAX_WORKERS)
        run_form.addRow('并行任务数', self.parallel_spin)
        self.english_segment_mode_combo = QComboBox()
        self.english_segment_mode_combo.addItem('自动判断（质量差才调用 AI）', 'auto')
        self.english_segment_mode_combo.addItem('仅使用本地断句', 'local')
        self.english_segment_mode_combo.addItem('始终使用 AI 矫正英文断句', 'ai')
        run_form.addRow('英文断句模式', self.english_segment_mode_combo)
        self.force_regenerate_checkbox = QCheckBox('已存在时重新生成字幕/陪练')
        self.force_regenerate_checkbox.setChecked(False)
        run_form.addRow('', self.force_regenerate_checkbox)
        page_layout.addWidget(run_group)

        ai_actions_group = QGroupBox('AI 相关操作')
        ai_actions_layout = QHBoxLayout(ai_actions_group)
        self.gen_asr_btn = QPushButton('生成 ASR 英文字幕')
        self.gen_zh_btn = QPushButton('生成中文字幕')
        self.gen_ai_btn = QPushButton('生成 AI 陪练文件')
        self.gen_series_btn = QPushButton('生成/更新当前系列')
        self.gen_all_btn = QPushButton('生成 ASR 字幕 + 中文字幕 + AI + 更新 series.json')
        self.gen_asr_btn.clicked.connect(lambda: self._generate(ai=False, manifest=False, generate_asr=True))
        self.gen_zh_btn.clicked.connect(lambda: self._generate(ai=False, manifest=False, zh=True))
        self.gen_ai_btn.clicked.connect(lambda: self._generate(ai=True, manifest=False))
        self.gen_series_btn.clicked.connect(lambda: self._generate(ai=False, manifest=True))
        self.gen_all_btn.clicked.connect(lambda: self._generate(ai=True, manifest=True, zh=True, generate_asr=True))
        ai_actions_layout.addWidget(self.gen_asr_btn)
        ai_actions_layout.addWidget(self.gen_zh_btn)
        ai_actions_layout.addWidget(self.gen_ai_btn)
        ai_actions_layout.addWidget(self.gen_series_btn)
        ai_actions_layout.addWidget(self.gen_all_btn)
        ai_actions_layout.addStretch(1)
        page_layout.addWidget(ai_actions_group)
        page_layout.addStretch(1)
        return page

    def _build_manifest_page(self) -> QWidget:
        page = QWidget()
        page_layout = QVBoxLayout(page)
        page_layout.setContentsMargins(0, 0, 0, 0)
        page_layout.setSpacing(12)
        auto_series_group = QGroupBox('当前系列（自动生成）')
        auto_series_layout = QVBoxLayout(auto_series_group)
        self.series_auto_hint_label = QLabel('Series ID、Series Title、Level、Category、Type、Cover、Source Label、Sort Order 都会根据当前目录自动生成。')
        self.series_auto_hint_label.setWordWrap(True)
        auto_series_layout.addWidget(self.series_auto_hint_label)
        page_layout.addWidget(auto_series_group)
        catalog_group = QGroupBox('App 总系列配置（可选）')
        catalog_form = QFormLayout(catalog_group)
        self.catalog_output_input = QLineEdit()
        self.catalog_output_input.setPlaceholderText('选择 App 总系列文件（例如 official-video-catalog.json）')
        self.catalog_output_input.setReadOnly(True)
        catalog_output_row = QHBoxLayout()
        catalog_output_row.addWidget(self.catalog_output_input)
        self.catalog_browse_btn = QPushButton('选择文件')
        self.catalog_browse_btn.clicked.connect(self._choose_catalog_output)
        catalog_output_row.addWidget(self.catalog_browse_btn)
        catalog_output_widget = QWidget()
        catalog_output_widget.setLayout(catalog_output_row)
        catalog_form.addRow('App 总系列文件', catalog_output_widget)
        catalog_merge_hint = QLabel('合并时默认读取当前目录下的 series.json，并在总系列文件中增加或更新它的引用，不会把系列内容直接拷贝进去。')
        catalog_merge_hint.setWordWrap(True)
        catalog_form.addRow('', catalog_merge_hint)
        page_layout.addWidget(catalog_group)
        manifest_actions_group = QGroupBox('App 总系列操作')
        manifest_actions_layout = QHBoxLayout(manifest_actions_group)
        self.gen_catalog_btn = QPushButton('合并/更新到 App 总系列')
        self.gen_catalog_btn.clicked.connect(lambda: self._generate(ai=False, manifest=True, update_catalog=True))
        manifest_actions_layout.addWidget(self.gen_catalog_btn)
        manifest_actions_layout.addStretch(1)
        page_layout.addWidget(manifest_actions_group)
        page_layout.addStretch(1)
        return page

    def _build_export_page(self) -> QWidget:
        page = QWidget()
        page_layout = QVBoxLayout(page)
        page_layout.setContentsMargins(0, 0, 0, 0)
        page_layout.setSpacing(12)
        package_group = QGroupBox('Deckpack 包导出目录')
        package_layout = QHBoxLayout(package_group)
        self.package_dir_input = QLineEdit()
        self.package_dir_input.setPlaceholderText('默认导出到当前视频目录下的 packages 子目录（Deckpack）')
        self.package_dir_input.setReadOnly(True)
        package_layout.addWidget(self.package_dir_input)
        self.package_browse_btn = QPushButton('选择目录')
        self.package_browse_btn.clicked.connect(self._choose_package_dir)
        package_layout.addWidget(self.package_browse_btn)
        page_layout.addWidget(package_group)
        export_actions_group = QGroupBox('导出操作')
        export_actions_layout = QHBoxLayout(export_actions_group)
        self.export_pkg_btn = QPushButton('导出 Deckpack 包')
        self.gen_all_export_btn = QPushButton('全部生成并导出 Deckpack 包')
        self.export_pkg_btn.clicked.connect(lambda: self._generate(ai=False, manifest=False, export_packages=True))
        self.gen_all_export_btn.clicked.connect(lambda: self._generate(ai=True, manifest=True, zh=True, export_packages=True, generate_asr=True))
        export_actions_layout.addWidget(self.export_pkg_btn)
        export_actions_layout.addWidget(self.gen_all_export_btn)
        export_actions_layout.addStretch(1)
        page_layout.addWidget(export_actions_group)
        page_layout.addStretch(1)
        return page

    # --- 交互 ---

    @staticmethod
    def _config_path() -> Path:
        return get_config_path()

    def _update_scan_summary(self, total: int | None = None, ready: int | None = None, ai_done: int | None = None, zh_done: int | None = None) -> None:
        if total is None:
            self.scan_summary_label.setText('请先选择目录并扫描素材。')
            return
        self.scan_summary_label.setText(
            f'当前素材：共 {total} 条，可生成 {ready or 0} 条，AI 已生成 {ai_done or 0} 条，中文字幕 {zh_done or 0} 条'
        )

    def _auto_series_id(self) -> str:
        if not self.current_dir:
            return ''
        return manifest_script.slugify(self.current_dir.name)

    def _auto_series_title(self) -> str:
        return self.current_dir.name if self.current_dir else ''

    def _update_series_auto_hint(self) -> None:
        if not hasattr(self, 'series_auto_hint_label'):
            return
        series_id = self._auto_series_id()
        series_title = self._auto_series_title()
        if not series_id or not series_title:
            self.series_auto_hint_label.setText('Series ID、Series Title、Level、Category、Type、Cover、Source Label、Sort Order 都会根据当前目录自动生成。')
            return
        self.series_auto_hint_label.setText(
            f'当前目录将自动生成：Series ID = {series_id}；Series Title = {series_title}。'
            'Level、Category、Type、Cover、Source Label、Sort Order 也会根据目录内素材自动推断。'
        )

    def _load_config(self) -> None:
        data = load_json_config()
        gdir = data.get('generate_dir', '')
        if gdir:
            self.dir_input.setText(gdir)
            self.current_dir = Path(gdir)
            self.scan_summary_label.setText('已恢复上次目录，请点击“扫描素材”刷新当前状态。')
        # 递归扫描开关 (默认 True, 跟 uploader/title/ 下载结构对齐)
        self.recursive_scan_checkbox.setChecked(bool(data.get('generate_recursive_scan', True)))
        pkg_dir = data.get('package_output_dir', '')
        if pkg_dir:
            # package_dir_input 在被隐藏的 _build_export_page 里创建, 可能不存在
            if hasattr(self, 'package_dir_input') and self.package_dir_input is not None:
                self.package_dir_input.setText(pkg_dir)
            self.package_output_dir = Path(pkg_dir)
        catalog_cfg = data.get('catalog_manifest', {})
        catalog_output = catalog_cfg.get('output_path', '')
        if catalog_output:
            # catalog_output_input 在被隐藏的 _build_manifest_page 里创建, 可能不存在
            if hasattr(self, 'catalog_output_input') and self.catalog_output_input is not None:
                self.catalog_output_input.setText(catalog_output)
            self.catalog_output_path = Path(catalog_output)
        self._update_series_auto_hint()
        # AI / ASR 配置在系统设置 tab, 这里只刷新 status label
        self._refresh_ai_config_status()
        parallelism = data.get('generate_parallelism', DEFAULT_MAX_WORKERS)
        try:
            parallelism_value = int(parallelism)
        except Exception:
            parallelism_value = DEFAULT_MAX_WORKERS
        parallelism_value = max(1, min(MAX_MAX_WORKERS, parallelism_value))
        self.parallel_spin.setValue(parallelism_value)
        mode = str(data.get('generate_english_segmentation_mode', 'auto') or 'auto')
        index = self.english_segment_mode_combo.findData(mode)
        self.english_segment_mode_combo.setCurrentIndex(index if index >= 0 else 0)
        self.force_regenerate_checkbox.setChecked(bool(data.get('generate_force_regenerate', False)))

    def _refresh_ai_config_status(self) -> None:
        """只读显示当前 AI / ASR 配置 (从 config.json 读)."""
        if not hasattr(self, 'ai_config_status_label'):
            return
        ai = load_ai_config()
        asr = load_asr_config()
        lines = []
        lines.append(f"Base URL:    {ai.get('base_url') or '（未配置）'}")
        lines.append(f"API Key:     {('●' * 8 + '…' + (ai.get('api_key') or '')[-4:]) if (ai.get('api_key') or '') else '（未配置）'}")
        lines.append(f"Model:       {ai.get('model') or 'qwen-plus'}")
        lines.append(f"ASR App ID:  {asr.get('app_id') or '（未配置）'}")
        lines.append(f"ASR Token:   {'（已配置）' if (asr.get('access_token') or '') else '（未配置）'}")
        self.ai_config_status_label.setText('\n'.join(lines))

    def _jump_to_ai_settings(self) -> None:
        """跳到系统设置 → AI 大模型 / ASR sub-tab."""
        from services.tab_bus import bus
        from tabs.settings_tab import SettingsTab
        target = SettingsTab.get_instance()
        if target is not None:
            bus.request_focus_tab.emit(target)
        else:
            self.log_box.appendPlainText('[提示] 请切到「系统设置」tab 维护 AI / ASR 配置。')

    def _get_ai_cfg(self) -> dict[str, str]:
        return load_ai_config()

    def _get_asr_cfg(self) -> dict[str, str]:
        return load_asr_config()

    def _save_config(self, **updates: str) -> None:
        save_json_config(updates)

    def _choose_dir(self) -> None:
        initial = self.dir_input.text().strip() or str(Path.home())
        chosen = QFileDialog.getExistingDirectory(self, '选择已下载的视频目录', initial)
        if chosen:
            self.dir_input.setText(chosen)
            self.current_dir = Path(chosen)
            self._update_series_auto_hint()
            # package_dir_input 在被隐藏的 _build_export_page 里创建, 可能不存在
            if hasattr(self, 'package_dir_input') and self.package_dir_input is not None:
                if not self.package_dir_input.text().strip():
                    default_package_dir = str(Path(chosen) / 'packages')
                    self.package_dir_input.setText(default_package_dir)
                    self.package_output_dir = Path(default_package_dir)
                    self._save_config(generate_dir=chosen, package_output_dir=default_package_dir)
                else:
                    self._save_config(generate_dir=chosen)
            else:
                self._save_config(generate_dir=chosen)
            self.scan_summary_label.setText('目录已切换，请点击“扫描素材”查看当前素材状态。')
            self.log_box.appendPlainText(f'已选择目录：{chosen}')
            self.log_box.appendPlainText('点击“扫描素材”开始分析目录。')

    def _choose_package_dir(self) -> None:
        # 兼容: package_dir_input 在被隐藏的 _build_export_page 里创建, 可能不存在
        if not hasattr(self, 'package_dir_input') or self.package_dir_input is None:
            return
        initial = self.package_dir_input.text().strip() or self.dir_input.text().strip() or str(Path.home())
        chosen = QFileDialog.getExistingDirectory(self, '选择 Deckpack 包导出目录', initial)
        if chosen:
            self.package_dir_input.setText(chosen)
            self.package_output_dir = Path(chosen)
            self._save_config(package_output_dir=chosen)
            self.log_box.appendPlainText(f'Deckpack 包导出目录已设置：{chosen}')

    def _choose_catalog_output(self) -> None:
        # 兼容: catalog_output_input 在被隐藏的 _build_manifest_page 里创建, 可能不存在
        if not hasattr(self, 'catalog_output_input') or self.catalog_output_input is None:
            return
        initial = self.catalog_output_input.text().strip() or str((self.current_dir.parent if self.current_dir else Path.home()) / 'official-video-catalog.json')
        chosen, _ = QFileDialog.getSaveFileName(self, '选择 App 总系列文件', initial, 'JSON Files (*.json)')
        if chosen:
            self.catalog_output_input.setText(chosen)
            self.catalog_output_path = Path(chosen)
            self._save_config(catalog_manifest={
                'output_path': chosen,
            })
            self.log_box.appendPlainText(f'App 总系列文件已设置：{chosen}')

    def _scan(self) -> None:
        if not self.current_dir:
            self.log_box.appendPlainText('[提示] 请先选择目录。')
            return
        recursive = self.recursive_scan_checkbox.isChecked()
        self.log_box.appendPlainText(f'扫描中…({"递归 1 层" if recursive else "仅当前目录"})')
        try:
            self.records = scan_directory(self.current_dir, recursive=recursive)
        except Exception as exc:
            self.log_box.appendPlainText(f'[错误] {exc}')
            return
        self._render_table()
        total = len(self.records)
        ready = sum(1 for r in self.records if r['can_generate'])
        ai_done = sum(1 for r in self.records if r['ai'])
        zh_done = sum(1 for r in self.records if r['zh'])
        self._update_scan_summary(total, ready, ai_done, zh_done)
        # 列出 unique 子目录, 让用户看到集合分布
        sub_dirs = sorted({r.get('relative_dir') or '（当前目录）' for r in self.records})
        if len(sub_dirs) > 1 or (sub_dirs and sub_dirs != ['（当前目录）']):
            self.log_box.appendPlainText(f'涉及子目录：{", ".join(sub_dirs)}')
        self.log_box.appendPlainText(
            f'扫描完成：共 {total} 条，可生成 {ready} 条，AI 已生成 {ai_done} 条，中文字幕 {zh_done} 条'
        )

    def _get_series_meta(self) -> dict[str, str]:
        return {
            'id': self._auto_series_id(),
            'title': self._auto_series_title(),
            'description': '',
            'tags': '',
            'resourceBaseUrl': '',
        }

    def _get_catalog_config(self) -> dict[str, str]:
        # catalog_output_input 在被隐藏的 _build_manifest_page 里创建, 可能不存在
        output_path = ''
        catalog_input = getattr(self, 'catalog_output_input', None)
        if catalog_input is not None:
            output_path = catalog_input.text().strip()
        return {
            'output_path': output_path,
        }

    def _generate(self, ai: bool, manifest: bool, zh: bool = False, export_packages: bool = False, update_catalog: bool = False, generate_asr: bool = False) -> None:
        if not self.current_dir:
            self.log_box.appendPlainText('[提示] 请先选择目录。')
            return
        ai_cfg = self._get_ai_cfg()
        asr_cfg = self._get_asr_cfg()
        requires_ai = ai or zh
        if requires_ai and (not ai_cfg.get('base_url') or not ai_cfg.get('api_key')):
            self.log_box.appendPlainText('[提示] 请先配置 AI API（Base URL 和 API Key）。')
            return
        if generate_asr and (not asr_cfg.get('app_id') or not asr_cfg.get('access_token')):
            self.log_box.appendPlainText('[提示] 请先配置火山 ASR App ID 和 Access Token。')
            return
        series_meta = self._get_series_meta()
        if manifest and (not series_meta.get('id') or not series_meta.get('title')):
            self.log_box.appendPlainText('[提示] 当前目录不足以自动生成系列信息，请先选择有效的视频目录。')
            return
        catalog_cfg = self._get_catalog_config()
        if update_catalog and not catalog_cfg.get('output_path'):
            self.log_box.appendPlainText('[提示] 请选择总 catalog 输出文件。')
            return
        package_output_dir = self.package_output_dir
        if export_packages and package_output_dir is None:
            package_output_dir = self.current_dir / 'packages'
            self.package_output_dir = package_output_dir
            self.package_dir_input.setText(str(package_output_dir))
            self._save_config(package_output_dir=str(package_output_dir))
        max_workers = self.parallel_spin.value()
        force_regenerate = self.force_regenerate_checkbox.isChecked()
        english_segmentation_mode = str(self.english_segment_mode_combo.currentData() or 'auto')
        recursive_scan = self.recursive_scan_checkbox.isChecked()
        self._save_config(
            generate_parallelism=str(max_workers),
            generate_english_segmentation_mode=english_segmentation_mode,
            generate_force_regenerate=force_regenerate,
            catalog_manifest=catalog_cfg,
            asr=asr_cfg,
        )
        self._set_buttons_enabled(False)
        self.worker = GenerateWorker(
            self.current_dir,
            ai,
            manifest,
            zh,
            ai_cfg,
            generate_asr=generate_asr,
            asr_cfg=asr_cfg,
            export_packages=export_packages,
            package_output_dir=package_output_dir,
            max_workers=max_workers,
            english_segmentation_mode=english_segmentation_mode,
            series_meta=series_meta,
            update_catalog=update_catalog,
            force_regenerate=force_regenerate,
            catalog_output_path=Path(catalog_cfg['output_path']) if catalog_cfg.get('output_path') else None,
            catalog_manifest_url=catalog_cfg.get('manifest_url', ''),
            catalog_resource_base_url=catalog_cfg.get('resource_base_url', ''),
            standalone_manifest_url=catalog_cfg.get('standalone_manifest_url', ''),
            records=self.records,
            ffmpeg_dir=load_json_config().get('ffmpeg_dir', ''),
            recursive_scan=recursive_scan,
        )
        self.worker.log_line.connect(self.log_box.appendPlainText)
        self.worker.finished_signal.connect(self._on_generate_done)
        self.worker.start()

    def _on_generate_done(self) -> None:
        self._set_buttons_enabled(True)
        self.worker = None
        self._scan()

    def _set_buttons_enabled(self, enabled: bool) -> None:
        # 部分 button 在被隐藏的 tab (合并/更新到 App 总系列, 导出) 里创建,
        # 当这两个 tab 注释掉后这些属性可能不存在, 用 getattr 过滤
        button_names = (
            'browse_btn',
            'package_browse_btn',
            'catalog_browse_btn',
            'scan_btn',
            'gen_asr_btn',
            'gen_zh_btn',
            'gen_ai_btn',
            'gen_series_btn',
            'gen_catalog_btn',
            'export_pkg_btn',
            'gen_all_btn',
            'gen_all_export_btn',
        )
        for name in button_names:
            btn = getattr(self, name, None)
            if btn is not None:
                btn.setEnabled(enabled)

    def _render_table(self) -> None:
        self.table.setRowCount(len(self.records))
        for row, rec in enumerate(self.records):
            def name(p, fallback='—'):
                return p.name if p else fallback

            rel_dir = rec.get('relative_dir') or '（当前目录）'
            cells = [
                rec['title'],
                rel_dir,
                rec['status'],
                name(rec['video']),
                name(rec['subtitle']),
                name(rec['zh'], '待生成'),
                name(rec['info']),
                name(rec['cover'], '可选'),
                name(rec['ai'], '待生成'),
            ]
            for col, text in enumerate(cells):
                item = QTableWidgetItem(text)
                if col == 2 and not rec['can_generate']:
                    item.setForeground(Qt.GlobalColor.red)
                self.table.setItem(row, col, item)

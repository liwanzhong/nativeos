from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
from pathlib import Path

from PySide6.QtCore import QThread, Signal, Qt
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
    save_ai_config,
    generate_practice_cards,
    classify_video,
    generate_zh_subtitle_file,
)
from tabs.asr_client import generate_asr_subtitle_for_record, load_asr_config, save_asr_config
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


def scan_directory(target_dir: Path) -> list[dict]:
    info_map = _collect(target_dir, ('*.info.json',))
    sub_map = _collect(target_dir, ('*.json3',))
    vid_map = _collect(target_dir, ('*.mp4', '*.webm', '*.mkv'))
    cover_map = _collect(target_dir, ('*.jpg', '*.jpeg', '*.png', '*.webp'))
    ai_map = _collect(target_dir, ('*.ai-practice.json',))
    zh_map = _collect_zh(target_dir)

    all_stems = sorted(
        set(info_map) | set(sub_map) | set(vid_map) | set(cover_map) | set(ai_map) | set(zh_map)
    )
    records = []
    for stem in all_stems:
        info_path = info_map.get(stem)
        title = stem
        if info_path:
            try:
                info = ai_script.load_json(info_path)
                title = str(info.get('title') or stem)
            except Exception:
                pass
        missing = []
        if stem not in vid_map:
            missing.append('视频')
        if stem not in sub_map:
            missing.append('字幕')
        if stem not in info_map:
            missing.append('Info')

        if missing:
            status = f"缺失：{' / '.join(missing)}"
            if stem in vid_map and stem in info_map and stem not in sub_map:
                status = '可生成 ASR 英文字幕 · 缺失：字幕'
            elif stem in vid_map and stem not in sub_map:
                # No info.json yet, but ASR only needs the video. We can
                # still generate subtitles; downstream AI steps (translate /
                # practice / manifest) will be skipped automatically because
                # they require info.json to be present.
                status = '可生成 ASR 英文字幕 · 缺失：Info / 字幕'
        else:
            parts = []
            if stem in ai_map:
                parts.append('AI')
            if stem in zh_map:
                parts.append('中文字幕')
            if parts:
                status = '就绪 · ' + ' + '.join(parts) + ' 已生成'
            else:
                status = '就绪 · 待生成'

        records.append({
            'stem': stem,
            'title': title,
            'status': status,
            'video': vid_map.get(stem),
            'subtitle': sub_map.get(stem),
            'zh': zh_map.get(stem),
            'info': info_path,
            'cover': cover_map.get(stem),
            'ai': ai_map.get(stem),
            'can_generate': not missing,
            'can_generate_asr': stem in vid_map,
        })
    return records


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
    ) -> None:
        super().__init__()
        self.target_dir = target_dir
        self.generate_ai = generate_ai
        self.generate_manifest = generate_manifest
        self.generate_zh = generate_zh
        self.ai_cfg = ai_cfg
        self.generate_asr = generate_asr
        self.asr_cfg = asr_cfg or {}
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

    def _stem_from_subtitle_path(self, json3_path: Path) -> str:
        stem = json3_path.name
        for suffix in ('.en.json3', '.json3'):
            if stem.endswith(suffix):
                return stem[:-len(suffix)]
        return json3_path.stem

    def _effective_workers(self, task_count: int) -> int:
        return max(1, min(self.max_workers, task_count))

    def _generate_ai_practice_for_set(self, stem: str, info_path: Path, subtitle_path: Path) -> tuple[Path, int, str]:
        info = ai_script.load_json(info_path)
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
        output_path = self.target_dir / f'{stem}.ai-practice.json'
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
        output_path = self.target_dir / f'{stem}.en.json3'
        self.log_line.emit(f'  [ASR][{stem}] 处理中…')
        payload = generate_asr_subtitle_for_record(
            self.target_dir,
            stem,
            record.get('video'),
            record.get('info'),
            output_path,
            self.asr_cfg,
            ffmpeg_dir=str(resolve_ffmpeg_dir()),
            force_regenerate=self.force_regenerate,
            on_progress=lambda msg, name=stem: self.log_line.emit(f'  [ASR][{name}] {msg}'),
        )
        return output_path, len(payload.get('events') or [])

    def _generate_ai_practice(self) -> None:
        self.log_line.emit('正在用 AI 生成陪练文件…')
        video_sets = ai_script.find_video_sets(self.target_dir)
        if not video_sets:
            self.log_line.emit('[提示] 没有找到完整的视频集（需要 video + subtitle + info.json）')
            return
        pending_sets: list[tuple[str, Path, Path]] = []
        for stem, info_path, subtitle_path in video_sets:
            output_path = self.target_dir / f'{stem}.ai-practice.json'
            if output_path.exists() and not self.force_regenerate:
                self.log_line.emit(f'  跳过（已存在）: {output_path.name}')
                continue
            pending_sets.append((stem, info_path, subtitle_path))
        if not pending_sets:
            self.log_line.emit('AI 陪练生成完成：0 个文件')
            return
        worker_count = self._effective_workers(len(pending_sets))
        self.log_line.emit(f'并行任务数：{worker_count}')
        created = 0
        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            future_map = {
                executor.submit(self._generate_ai_practice_for_set, stem, info_path, subtitle_path): stem
                for stem, info_path, subtitle_path in pending_sets
            }
            for future in as_completed(future_map):
                stem = future_map[future]
                try:
                    output_path, item_count, level = future.result()
                    self.log_line.emit(f'  OK {output_path.name} ({item_count} 个场景, {level})')
                    created += 1
                except Exception as exc:
                    self.log_line.emit(f'  [失败] {stem}: {exc}')
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
        json3_files = sorted(self.target_dir.glob('*.json3'))
        if not json3_files:
            self.log_line.emit('[提示] 没有找到 json3 字幕文件')
            return
        pending_jobs: list[tuple[Path, Path]] = []
        created = 0
        for json3_path in json3_files:
            stem = json3_path.name
            for suffix in ('.en.json3', '.json3'):
                if stem.endswith(suffix):
                    stem = stem[:-len(suffix)]
                    break
            output_path = self.target_dir / f'{stem}.zh.json'
            if output_path.exists():
                if not self.force_regenerate:
                    self.log_line.emit(f'  跳过（已存在）: {output_path.name}')
                    continue
            pending_jobs.append((json3_path, output_path))
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
        records = scan_directory(self.target_dir)
        pending_records = []
        for record in records:
            if not record.get('can_generate_asr'):
                continue
            output_path = self.target_dir / f"{record['stem']}.en.json3"
            if output_path.exists() and not self.force_regenerate:
                self.log_line.emit(f'  跳过（已存在）: {output_path.name}')
                continue
            pending_records.append(record)
        if not pending_records:
            self.log_line.emit('ASR 英文字幕生成完成：0 个文件')
            return
        worker_count = self._effective_workers(len(pending_records))
        self.log_line.emit(f'并行任务数：{worker_count}')
        created = 0
        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            future_map = {
                executor.submit(self._generate_asr_subtitle_for_set, record): record['stem']
                for record in pending_records
            }
            for future in as_completed(future_map):
                stem = future_map[future]
                try:
                    output_path, event_count = future.result()
                    self.log_line.emit(f'  OK {output_path.name}（{event_count} 条 ASR 字幕事件）')
                    created += 1
                except Exception as exc:
                    self.log_line.emit(f'  [失败] {stem}: {exc}')
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
        self.scan_summary_label = QLabel('请先选择目录并扫描素材。')
        dir_layout.addWidget(self.scan_summary_label)
        layout.addWidget(dir_group)

        self.function_tabs = QTabWidget()
        self.function_tabs.addTab(self._build_overview_page(), '素材概览')
        self.function_tabs.addTab(self._build_ai_page(), 'AI 生成')
        self.function_tabs.addTab(self._build_manifest_page(), '合并/更新到 App 总系列')
        self.function_tabs.addTab(self._build_export_page(), '导出')
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
        self.table = QTableWidget(0, 8)
        self.table.setHorizontalHeaderLabels(
            ['标题', '状态', '视频', '字幕', '中文字幕', 'Info', '封面', 'AI 文件']
        )
        self.table.verticalHeader().setVisible(False)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        for col in range(1, 8):
            header.setSectionResizeMode(col, QHeaderView.ResizeMode.ResizeToContents)
        page_layout.addWidget(self.table)
        return page

    def _build_ai_page(self) -> QWidget:
        page = QWidget()
        page_layout = QVBoxLayout(page)
        page_layout.setContentsMargins(0, 0, 0, 0)
        page_layout.setSpacing(12)
        ai_group = QGroupBox('AI API 配置（Qwen / OpenAI 兼容，配置一次自动保存）')
        ai_form = QFormLayout(ai_group)
        self.ai_base_url_input = QLineEdit()
        self.ai_base_url_input.setPlaceholderText('https://dashscope.aliyuncs.com/compatible-mode/v1')
        self.ai_api_key_input = QLineEdit()
        self.ai_api_key_input.setPlaceholderText('API Key')
        self.ai_api_key_input.setEchoMode(QLineEdit.EchoMode.Password)
        self.ai_model_input = QLineEdit()
        self.ai_model_input.setPlaceholderText('qwen-plus')
        self.ai_model_input.setText('qwen-plus')
        ai_form.addRow('Base URL', self.ai_base_url_input)
        ai_form.addRow('API Key', self.ai_api_key_input)
        ai_form.addRow('Model', self.ai_model_input)
        self.asr_app_id_input = QLineEdit()
        self.asr_app_id_input.setPlaceholderText('火山 ASR App ID')
        self.asr_access_token_input = QLineEdit()
        self.asr_access_token_input.setPlaceholderText('火山 ASR Access Token')
        self.asr_access_token_input.setEchoMode(QLineEdit.EchoMode.Password)
        ai_form.addRow('ASR App ID', self.asr_app_id_input)
        ai_form.addRow('ASR Access Token', self.asr_access_token_input)
        self.parallel_spin = QSpinBox()
        self.parallel_spin.setMinimum(1)
        self.parallel_spin.setMaximum(MAX_MAX_WORKERS)
        self.parallel_spin.setValue(DEFAULT_MAX_WORKERS)
        ai_form.addRow('并行任务数', self.parallel_spin)
        self.english_segment_mode_combo = QComboBox()
        self.english_segment_mode_combo.addItem('自动判断（质量差才调用 AI）', 'auto')
        self.english_segment_mode_combo.addItem('仅使用本地断句', 'local')
        self.english_segment_mode_combo.addItem('始终使用 AI 矫正英文断句', 'ai')
        ai_form.addRow('英文断句模式', self.english_segment_mode_combo)
        self.force_regenerate_checkbox = QCheckBox('已存在时重新生成字幕/陪练')
        self.force_regenerate_checkbox.setChecked(False)
        ai_form.addRow('', self.force_regenerate_checkbox)
        self.save_ai_btn = QPushButton('保存 AI 配置')
        self.save_ai_btn.clicked.connect(self._save_ai_config)
        ai_form.addRow('', self.save_ai_btn)
        page_layout.addWidget(ai_group)
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
        pkg_dir = data.get('package_output_dir', '')
        if pkg_dir:
            self.package_dir_input.setText(pkg_dir)
            self.package_output_dir = Path(pkg_dir)
        catalog_cfg = data.get('catalog_manifest', {})
        catalog_output = catalog_cfg.get('output_path', '')
        if catalog_output:
            self.catalog_output_input.setText(catalog_output)
            self.catalog_output_path = Path(catalog_output)
        self._update_series_auto_hint()
        ai = data.get('ai', {})
        if ai.get('base_url'):
            self.ai_base_url_input.setText(ai['base_url'])
        if ai.get('api_key'):
            self.ai_api_key_input.setText(ai['api_key'])
        if ai.get('model'):
            self.ai_model_input.setText(ai['model'])
        asr = load_asr_config()
        if asr.get('app_id'):
            self.asr_app_id_input.setText(asr['app_id'])
        if asr.get('access_token'):
            self.asr_access_token_input.setText(asr['access_token'])
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

    def _save_ai_config(self) -> None:
        cfg = {
            'base_url': self.ai_base_url_input.text().strip(),
            'api_key': self.ai_api_key_input.text().strip(),
            'model': self.ai_model_input.text().strip() or 'qwen-plus',
        }
        save_ai_config(cfg)
        save_asr_config(self._get_asr_cfg())
        self._save_config(generate_parallelism=str(self.parallel_spin.value()))
        self.log_box.appendPlainText('AI / ASR 配置已保存。')

    def _get_ai_cfg(self) -> dict[str, str]:
        return {
            'base_url': self.ai_base_url_input.text().strip(),
            'api_key': self.ai_api_key_input.text().strip(),
            'model': self.ai_model_input.text().strip() or 'qwen-plus',
        }

    def _get_asr_cfg(self) -> dict[str, str]:
        return {
            'app_id': self.asr_app_id_input.text().strip(),
            'access_token': self.asr_access_token_input.text().strip(),
        }

    def _save_config(self, **updates: str) -> None:
        save_json_config(updates)

    def _choose_dir(self) -> None:
        initial = self.dir_input.text().strip() or str(Path.home())
        chosen = QFileDialog.getExistingDirectory(self, '选择已下载的视频目录', initial)
        if chosen:
            self.dir_input.setText(chosen)
            self.current_dir = Path(chosen)
            self._update_series_auto_hint()
            if not self.package_dir_input.text().strip():
                default_package_dir = str(Path(chosen) / 'packages')
                self.package_dir_input.setText(default_package_dir)
                self.package_output_dir = Path(default_package_dir)
                self._save_config(generate_dir=chosen, package_output_dir=default_package_dir)
            else:
                self._save_config(generate_dir=chosen)
            self.scan_summary_label.setText('目录已切换，请点击“扫描素材”查看当前素材状态。')
            self.log_box.appendPlainText(f'已选择目录：{chosen}')
            self.log_box.appendPlainText('点击“扫描素材”开始分析目录。')

    def _choose_package_dir(self) -> None:
        initial = self.package_dir_input.text().strip() or self.dir_input.text().strip() or str(Path.home())
        chosen = QFileDialog.getExistingDirectory(self, '选择 Deckpack 包导出目录', initial)
        if chosen:
            self.package_dir_input.setText(chosen)
            self.package_output_dir = Path(chosen)
            self._save_config(package_output_dir=chosen)
            self.log_box.appendPlainText(f'Deckpack 包导出目录已设置：{chosen}')

    def _choose_catalog_output(self) -> None:
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
        self.log_box.appendPlainText('扫描中…')
        try:
            self.records = scan_directory(self.current_dir)
        except Exception as exc:
            self.log_box.appendPlainText(f'[错误] {exc}')
            return
        self._render_table()
        total = len(self.records)
        ready = sum(1 for r in self.records if r['can_generate'])
        ai_done = sum(1 for r in self.records if r['ai'])
        zh_done = sum(1 for r in self.records if r['zh'])
        self._update_scan_summary(total, ready, ai_done, zh_done)
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
        return {
            'output_path': self.catalog_output_input.text().strip(),
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
        )
        self.worker.log_line.connect(self.log_box.appendPlainText)
        self.worker.finished_signal.connect(self._on_generate_done)
        self.worker.start()

    def _on_generate_done(self) -> None:
        self._set_buttons_enabled(True)
        self.worker = None
        self._scan()

    def _set_buttons_enabled(self, enabled: bool) -> None:
        for btn in (
            self.browse_btn,
            self.package_browse_btn,
            self.catalog_browse_btn,
            self.scan_btn,
            self.gen_asr_btn,
            self.gen_zh_btn,
            self.gen_ai_btn,
            self.gen_series_btn,
            self.gen_catalog_btn,
            self.export_pkg_btn,
            self.gen_all_btn,
            self.gen_all_export_btn,
        ):
            btn.setEnabled(enabled)

    def _render_table(self) -> None:
        self.table.setRowCount(len(self.records))
        for row, rec in enumerate(self.records):
            def name(p, fallback='—'):
                return p.name if p else fallback

            cells = [
                rec['title'],
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
                if col == 1 and not rec['can_generate']:
                    item.setForeground(Qt.GlobalColor.red)
                self.table.setItem(row, col, item)

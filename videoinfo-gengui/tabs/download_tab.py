from __future__ import annotations

import hashlib
import json
import os
import re
import signal
import subprocess
import shutil
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from PySide6.QtCore import QThread, Signal, Qt
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPlainTextEdit,
    QProgressDialog,
    QPushButton,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from tabs.runtime_support import get_config_path, get_proxy_env, load_json_config, load_proxy_config, resolve_executable, resolve_ffmpeg_dir, save_json_config

# ============================================================
# Universal emoji + fullwidth detection
# ============================================================
# 之前用硬编码 codepoint 范围 (0x1F1E6..0x1F1FF / 0x1F300..0x1FAFF / ...),
# 漏掉了一堆: 区域指示符 (🇬🇧 在 Unicode 14.0 不在 Extended_Pictographic),
# CJK 全角标点 (？U+FF1F, ｜U+FF5C), 未来 Unicode 新增 emoji.
# 通用方案:
#   1) 优先用 `emoji` 库 (600KB, 跟 Unicode 官方 emoji-data.txt 同步,
#      自动处理 ZWJ / flag pair / skin tone / 未来 emoji).
#   2) Fallback 到 `regex` 库 (yt-dlp 自带, 项目里已有 v2.5.147),
#      用 \p{Extended_Pictographic} Unicode property 显式加 regional
#      indicator 和 keycap 序列, 避开 ASCII 数字误伤.
#   3) 最后兜底: 硬编码范围 (不如 1+2 准, 但保证不报错).
# 安装 emoji 库 (推荐): pip install emoji
_EMOJI_BACKEND = 'builtin'  # 'emoji-lib' | 'regex' | 'builtin'
_EMOJI_LIB = None
_EMOJI_REGEX_PATTERN = None
try:
    import emoji as _EMOJI_LIB
    _EMOJI_BACKEND = 'emoji-lib'
except ImportError:
    _EMOJI_LIB = None
    try:
        import regex as _regex_mod
        # \p{Extended_Pictographic} 起步 (避开 \p{Emoji_Component}, 那个
        # 会把 ASCII 数字 0-9 当 keycap 起始误伤). 区域指示符 + keycap
        # 序列作为独立 alternation 显式处理.
        _EMOJI_REGEX_PATTERN = _regex_mod.compile(
            r'(?:\p{Extended_Pictographic}'
            r'(?:\p{Emoji_Modifier}|\uFE0F)*'
            r'(?:\u200D\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\uFE0F)*)*)'
            r'|[\U0001F1E6-\U0001F1FF]+'  # regional indicator (lone or pair)
            r'|[0-9*#]\uFE0F?\u20E3'  # keycap sequence (0️⃣ *️⃣ #️⃣)
        )
        _EMOJI_BACKEND = 'regex'
    except ImportError:
        # 兜底: 硬编码范围, 不如 1+2 准
        _EMOJI_BACKEND = 'builtin'

# 全角 / CJK 标点 Unicode 块 (稳定, 不会随 emoji 标准变化)
_FULLWIDTH_RANGES: tuple[tuple[int, int], ...] = (
    (0x3000, 0x303F),  # CJK Symbols and Punctuation (、。「」)
    (0xFF00, 0xFFEF),  # Halfwidth and Fullwidth Forms (？，！｜～)
)


def _is_fullwidth_punct(cp: int) -> bool:
    return any(lo <= cp <= hi for lo, hi in _FULLWIDTH_RANGES)


def _strip_emoji_and_fullwidth(name: str) -> str:
    """通用: 清除字符串里所有 emoji 序列 + 全角/CJK 标点.

    - 用 emoji 库 (Unicode emoji-data.txt 同步) 或 regex 库 (Unicode
      property) 处理 emoji; 自动覆盖 ZWJ / flag pair / skin tone / 未来
      Unicode 新增.
    - 全角标点走稳定的 Unicode block 范围 (CJK Symbols / Halfwidth and
      Fullwidth Forms).
    - 不会误伤 ASCII 数字 / 拉丁字母 / CJK 汉字 / 平假名 / 片假名.
    """
    if not name:
        return name
    if _EMOJI_BACKEND == 'emoji-lib':
        name = _EMOJI_LIB.replace_emoji(name, replace='')
    elif _EMOJI_BACKEND == 'regex':
        name = _EMOJI_REGEX_PATTERN.sub('', name)
    else:
        # 兜底: 单字符范围检查, 不处理 ZWJ / flag pair / skin tone
        name = ''.join(
            c for c in name
            if not (
                0x1F1E6 <= ord(c) <= 0x1F1FF
                or 0x1F300 <= ord(c) <= 0x1FAFF
                or 0x2600 <= ord(c) <= 0x27BF
                or 0x200D == ord(c) or 0x20E3 == ord(c)
                or 0xFE0E == ord(c) or 0xFE0F == ord(c)
            )
        )
    name = ''.join(c for c in name if not _is_fullwidth_punct(ord(c)))
    name = ' '.join(name.split())
    return name.strip()


def _is_emoji_or_fullwidth_char(char: str) -> bool:
    """单字符判定, 用于日志里描述识别到哪些字符.

    注意: 区域指示符 (🇬🇧) 单字符不在 Extended_Pictographic (Unicode 14.0),
    但作为 flag pair 会被整体 strip; 这里返回 False, 因为单字符的 🇬
    或 🇧 单独出现时确实无意义, 不应标为 'emoji-like char found'.
    """
    if not char or len(char) != 1:
        return False
    cp = ord(char)
    if _is_fullwidth_punct(cp):
        return True
    if _EMOJI_BACKEND == 'emoji-lib':
        # emoji.is_emoji 支持多 codepoint, 但单 char 时也能用
        return _EMOJI_LIB.is_emoji(char)
    if _EMOJI_BACKEND == 'regex':
        return bool(_regex_mod.match(r'\p{Extended_Pictographic}', char))
    # builtin fallback
    return (
        0x1F1E6 <= cp <= 0x1F1FF
        or 0x1F300 <= cp <= 0x1FAFF
        or 0x2600 <= cp <= 0x27BF
    )


def _dedupe_target_path(source: Path, cleaned_name: str) -> Path:
    """如果目标名已存在, 加 _1 / _2 后缀避免覆盖."""
    target = source.with_name(cleaned_name)
    if target == source or not target.exists():
        return target
    suffix = ''.join(source.suffixes) if source.is_file() else ''
    base_name = cleaned_name[:-len(suffix)] if suffix and cleaned_name.endswith(suffix) else cleaned_name
    index = 1
    while True:
        candidate = source.with_name(f'{base_name}_{index}{suffix}')
        if not candidate.exists() or candidate == source:
            return candidate
        index += 1


def _scan_and_rename_emoji_files(
    root_dir: Path,
    log_line,
    mtime_threshold: float | None,
    label: str,
) -> int:
    """遍历目录, 把含 emoji / 全角标点的文件/目录名重命名. 返回重命名数量.

    通用清理逻辑, DownloadWorker (post-download) 和 EmojiCleanupWorker
    (历史文件) 都走这里, 区别只在 mtime_threshold:
      - post-download: 只清理本次下载 (mtime >= self._started_at - 2)
      - 历史文件清理: 不限 mtime, 把整个目录的脏名字都清掉
    """
    if not root_dir.exists():
        log_line(f'[提示] {label} 目录不存在: {root_dir}')
        return 0
    renamed_paths: list[tuple[Path, Path]] = []
    scanned_entries = 0
    rename_candidates = 0
    for root, dir_names, file_names in os.walk(root_dir, topdown=False):
        root_path = Path(root)
        for entry_name in [*file_names, *dir_names]:
            scanned_entries += 1
            source = root_path / entry_name
            if mtime_threshold is not None:
                try:
                    if source.stat().st_mtime < mtime_threshold:
                        continue
                except OSError:
                    continue
            cleaned_name = _strip_emoji_and_fullwidth(entry_name)
            if not cleaned_name or cleaned_name == entry_name:
                continue
            rename_candidates += 1
            emoji_desc = _describe_emoji_in_name(entry_name)
            if emoji_desc:
                log_line(f'[调试] {label} 原始值: {entry_name}')
                log_line(f'[调试] {label} 识别到的 emoji-like 字符: {emoji_desc}')
                log_line(f'[调试] {label} 清理结果: {cleaned_name}')
            elif entry_name != cleaned_name:
                log_line(f'[调试] {label} 原始值: {entry_name}')
                log_line(f'[调试] {label} 清理结果: {cleaned_name}')
            target = _dedupe_target_path(source, cleaned_name)
            if target == source:
                continue
            try:
                source.rename(target)
                renamed_paths.append((source, target))
            except OSError as exc:
                log_line(f'[提示] 文件名清理失败：{source.name} -> {target.name} ({exc})')
    if not renamed_paths:
        log_line(f'[调试] {label} 扫描完成：共扫描 {scanned_entries} 个文件/目录，命中 {rename_candidates} 个候选，实际重命名 0 个')
        return 0
    log_line(f'[调试] {label} 扫描完成：共扫描 {scanned_entries} 个文件/目录，命中 {rename_candidates} 个候选，实际重命名 {len(renamed_paths)} 个')
    for source, target in renamed_paths[:12]:
        try:
            source_display = source.relative_to(root_dir)
        except ValueError:
            source_display = source
        try:
            target_display = target.relative_to(root_dir)
        except ValueError:
            target_display = target
        log_line(f'[重命名] {source_display} -> {target_display}')
    if len(renamed_paths) > 12:
        log_line(f'[提示] 另有 {len(renamed_paths) - 12} 个文件/目录名已清理 Emoji')
    return len(renamed_paths)


def _describe_emoji_in_name(name: str) -> str:
    """调试日志用: 列出被识别为 emoji-like 的字符. 单字符判定."""
    parts = [f'{char}(U+{ord(char):04X})' for char in name if _is_emoji_or_fullwidth_char(char)]
    return ', '.join(parts)


def _scan_and_clean_info_json_metadata(
    root_dir: Path,
    log_line,
    mtime_threshold: float | None,
    label: str,
) -> int:
    """遍历目录里所有 .info.json, 清理掉 title / fulltitle / playlist / playlist_title
    / uploader / channel 字段里的 emoji + 全角标点. 返回更新的文件数量.

    这是 _scan_and_rename_emoji_files 的"内容"姊妹: 文件名是落盘外壳, info.json
    是 yt-dlp 存的原始元数据. 用户在桌面 app 扫描 tab 看到的"标题"列, 实际
    读的是 info.json 的 title 字段. 只改文件名不改 info.json 的话, 扫描结果
    还是会显示原始的 emoji 标题, 看着像没清理干净.

    DownloadWorker (post-download) 和 EmojiCleanupWorker (历史文件) 都走这个,
    区别仍然是 mtime_threshold.
    """
    if not root_dir.exists():
        log_line(f'[提示] {label} 目录不存在: {root_dir}')
        return 0
    candidate_fields = ('title', 'fulltitle', 'playlist', 'playlist_title', 'uploader', 'channel')
    scanned_files = 0
    updated_files = 0
    for info_path in sorted(root_dir.rglob('*.info.json')):
        if mtime_threshold is not None:
            try:
                if info_path.stat().st_mtime < mtime_threshold:
                    continue
            except OSError:
                continue
        scanned_files += 1
        try:
            payload = json.loads(info_path.read_text('utf-8'))
        except Exception as exc:
            log_line(f'[提示] 读取 info.json 失败：{info_path.name} ({exc})')
            continue
        if not isinstance(payload, dict):
            continue
        changed_fields: list[str] = []
        for field in candidate_fields:
            raw_value = payload.get(field)
            if not isinstance(raw_value, str) or not raw_value.strip():
                continue
            cleaned_value = _strip_emoji_and_fullwidth(raw_value)
            if not cleaned_value or cleaned_value == raw_value:
                continue
            emoji_desc = _describe_emoji_in_name(raw_value)
            if emoji_desc:
                log_line(f'[调试] {label} info.{field} 原始值: {raw_value}')
                log_line(f'[调试] {label} info.{field} 识别到的 emoji-like 字符: {emoji_desc}')
                log_line(f'[调试] {label} info.{field} 清理结果: {cleaned_value}')
            payload[field] = cleaned_value
            changed_fields.append(field)
        if not changed_fields:
            continue
        try:
            info_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), 'utf-8')
            updated_files += 1
            try:
                display_path = info_path.relative_to(root_dir)
            except ValueError:
                display_path = info_path
            log_line(f'[重写] {display_path} 已清理字段: {", ".join(changed_fields)}')
        except OSError as exc:
            log_line(f'[提示] 写回 info.json 失败：{info_path.name} ({exc})')
    log_line(f'[调试] {label} info.json 内容清理完成：扫描 {scanned_files} 个文件，实际更新 {updated_files} 个')
    return updated_files


# ============================================================

DOWNLOAD_TYPES = [
    ('单个视频', 'single', '粘贴单个 YouTube 视频 URL，例: https://www.youtube.com/watch?v=xxx'),
    ('单个播放列表', 'playlist', '粘贴 YouTube 播放列表 URL，例: https://www.youtube.com/playlist?list=xxx'),
    ('博主全部播放列表', 'channel', '粘贴博主播放列表页 URL，例: https://www.youtube.com/@xxx/playlists'),
]

# ---- 高级选项 (用户可配置的 yt-dlp 参数) ----

DEFAULT_DOWNLOAD_OPTIONS: dict[str, Any] = {
    'video_format': 'h264_720p',
    'max_duration_minutes': 0,  # 0 = 不限制; >0 = 跳过超过 N 分钟的视频 (防 10+ 小时超长视频)
    'write_subs': True,
    'sub_langs': 'en',
    'sub_format': 'json3',
    'write_thumbnail': True,
    'write_info_json': True,
    'sponsorblock_action': 'remove',
    'sponsorblock_categories': 'sponsor,intro,outro,interaction',
    'split_chapters': False,
}

# 学英语场景下, 画质要求不高, 文件大小 / 兼容性优先。
# 4 个旧选项 (h264_mp4 / best / h265_av1 / original) 合并为 4 个新选项。
VIDEO_FORMAT_OPTIONS = [
    ('H.264 MP4 ≤720p (推荐, 学英语, 体积小)', 'h264_720p'),
    ('H.264 MP4 ≤1080p (平板/TV 投屏, 更清晰)', 'h264_1080p'),
    ('H.264 MP4 (原始分辨率, 最高画质)', 'h264_original'),
    ('H.265/AV1 (体积最小, 2018+ 设备)', 'h265_av1'),
]

# 老 config 里的 video_format 值 -> 新值的映射。
# 加载时迁移, 不持久化老值, 避免 UI 下拉框空白。
_LEGACY_VIDEO_FORMAT_MAP = {
    'h264_mp4': 'h264_720p',
    'best': 'h264_720p',
    'original': 'h264_720p',
}

SUB_FORMAT_OPTIONS = [
    ('json3 (推荐)', 'json3'),
    ('vtt', 'vtt'),
    ('srt', 'srt'),
    ('best (任一可用)', 'best'),
]

SPONSORBLOCK_ACTIONS = [
    ('不处理', 'none'),
    ('仅标记 (在章节里打 marker)', 'mark'),
    ('移除片段 (默认)', 'remove'),
]

# yt-dlp 官方 6 个 SponsorBlock 类别 (可组合)
SPONSORBLOCK_CATEGORY_HELP = (
    '可选: sponsor, intro, outro, interaction, self-prom, music_offtopic, '
    'preview, filler (逗号分隔)'
)


def build_yt_dlp_args(options: dict[str, Any]) -> list[str]:
    """根据用户选项生成 yt-dlp 参数列表 (URL 之前的部分)。

    默认选项严格匹配旧版 ``COMMON_YT_DLP_ARGS`` 的行为。
    """
    args: list[str] = []

    fmt = str(options.get('video_format', 'h264_720p'))
    # 兜底: 任何未知值(老 config / 误传)都走 720p, 避免下到几 GB 的 4K webm
    if fmt == 'h264_720p':
        # 学英语默认: 720p H.264, 兼容性最好, 20 分钟 ≈ 80-120MB
        args += ['-S', 'res:720,vcodec:h264,ext:mp4:m4a', '--merge-output-format', 'mp4']
    elif fmt == 'h264_1080p':
        # 平板 / TV 投屏, 1080p H.264, 20 分钟 ≈ 200-300MB
        args += ['-S', 'res:1080,vcodec:h264,ext:mp4:m4a', '--merge-output-format', 'mp4']
    elif fmt == 'h264_original':
        # 原始分辨率: 限 H.264 编码 + MP4 容器, 不限 res
        # 1080p 视频 → 200-300MB; 4K 视频 (YouTube 4K 通常是 VP9/AV1, 不是 H.264) → 实际仍选 1080p H.264
        # 这样比 "best" 模式 (4K VP9 webm 几百 MB) 小很多, 又比 1080p 上限模式可能更清晰
        args += ['-S', 'vcodec:h264,ext:mp4:m4a', '--merge-output-format', 'mp4']
    elif fmt == 'h265_av1':
        # 体积最小: 限 1080p, 优先 AV1 编码, 20 分钟 ≈ 40-80MB
        # 2018+ 设备 / Android 9+ / iOS 16+ 都支持 AV1 软解
        args += ['-S', 'res:1080,vcodec:av1,ext:mp4:m4a', '--merge-output-format', 'mp4']
    else:
        # 兜底: 未知 video_format 值走 720p, 跟 DEFAULT 保持一致
        args += ['-S', 'res:720,vcodec:h264,ext:mp4:m4a', '--merge-output-format', 'mp4']

    # 跳过超长视频 (防 10+ 小时视频下到几 GB)
    # 0 = 不限制, >0 = 跳过超过 N 分钟的视频
    # 用 yt-dlp --match-filter (单个视频和播放列表都生效)
    max_dur_min = int(options.get('max_duration_minutes', 0) or 0)
    if max_dur_min > 0:
        args += ['--match-filter', f'duration <= {max_dur_min * 60}']

    if bool(options.get('write_subs', True)):
        args += ['--write-subs', '--write-auto-subs']
        sub_format = str(options.get('sub_format', 'json3') or '').strip()
        if sub_format and sub_format != 'best':
            args += ['--sub-format', sub_format]
        sub_langs = str(options.get('sub_langs', 'en')).strip()
        if sub_langs:
            args += ['--sub-langs', sub_langs]

    if bool(options.get('write_thumbnail', True)):
        args += ['--write-thumbnail', '--convert-thumbnails', 'jpg']

    if bool(options.get('write_info_json', True)):
        args += ['--write-info-json']

    sb_action = str(options.get('sponsorblock_action', 'remove'))
    sb_cats = str(options.get('sponsorblock_categories', 'sponsor,intro,outro,interaction')).strip()
    if sb_action in ('mark', 'remove') and sb_cats:
        args += [f'--sponsorblock-{sb_action}', sb_cats]

    if bool(options.get('split_chapters', False)):
        # 用 yt-dlp 自带的 --split-chapters, 配合 chapter: 前缀的 -o 模板控制输出结构
        # --no-keep-video 切完删整片, 父字幕/缩略图/info.json 仍按主模板 (真实标题) 保留
        args += ['--split-chapters', '--no-keep-video']

    args += ['--newline']
    return args


# 保留旧名字以防外部代码引用 (等价于 build_yt_dlp_args(DEFAULT_DOWNLOAD_OPTIONS))
COMMON_YT_DLP_ARGS = build_yt_dlp_args(DEFAULT_DOWNLOAD_OPTIONS)

TYPE_EXTRA_ARGS: dict[str, list[str]] = {
    'single': [
        '--no-playlist',
        '-o', '%(uploader)s/%(title)s.%(ext)s',
    ],
    'playlist': [
        '--yes-playlist',
        '-o', '%(uploader)s/%(playlist)s/%(playlist_index)02d - %(title)s.%(ext)s',
    ],
    'channel': [
        '--yes-playlist',
        '-o', '%(uploader)s/%(playlist)s/%(playlist_index)02d - %(title)s.%(ext)s',
    ],
}

COOKIE_BROWSER_OPTIONS = [
    ('不使用浏览器 Cookies', ''),
    ('Chrome', 'chrome'),
    ('Edge', 'edge'),
    ('Firefox', 'firefox'),
    ('Brave', 'brave'),
]

JS_RUNTIME_OPTIONS = [
    ('自动检测', 'auto'),
    ('Node.js', 'node'),
    ('Deno', 'deno'),
    ('Bun', 'bun'),
    ('不启用', 'disabled'),
]


class EmojiCleanupWorker(QThread):
    """清理整个下载目录里所有含 emoji / 全角标点的历史文件名.

    跟 DownloadWorker._cleanup_download_names 走同一份清理逻辑
    (_scan_and_rename_emoji_files), 区别是不限 mtime, 把整个目录
    的脏名字都清掉. 用户痛点: 默认清理只清本次下载, 历史文件从来
    没被处理过, 即使在 2026-08-19 重构 emoji 识别后, 老目录里仍然
    一堆 🇬🇧🛒🍎？｜.
    """
    log_line = Signal(str)
    finished_signal = Signal(int)  # renamed count

    def __init__(self, download_dir: str) -> None:
        super().__init__()
        self.download_dir = download_dir

    def run(self) -> None:
        if _EMOJI_BACKEND == 'emoji-lib':
            backend_msg = 'emoji 库 (Unicode emoji-data.txt 同步, 覆盖 ZWJ/flag/skin tone/未来 emoji)'
        elif _EMOJI_BACKEND == 'regex':
            backend_msg = 'regex 库 (Unicode Extended_Pictographic, 显式加 regional indicator / keycap)'
        else:
            backend_msg = '硬编码范围 (降级模式, 可能漏 Unicode 15+ emoji)'
        self.log_line.emit(f'[清理] 后端: {backend_msg}')
        if _EMOJI_BACKEND == 'builtin':
            self.log_line.emit('[提示] 未检测到 emoji 库 / regex 库, 强烈建议 `pip install emoji` 提升识别准确率')

        # Step 1: 重命名磁盘上的文件/目录名 (落盘外壳)
        renamed = _scan_and_rename_emoji_files(
            root_dir=Path(self.download_dir),
            log_line=self.log_line.emit,
            mtime_threshold=None,  # 历史文件: 不限 mtime
            label='历史文件清理',
        )

        # Step 2: 清理 *.info.json 里的 title / fulltitle / playlist_title 等字段
        # (扫描 tab 的"标题"列就是从这里读的, 不清的话扫描结果还是显示原 emoji 标题)
        updated = _scan_and_clean_info_json_metadata(
            root_dir=Path(self.download_dir),
            log_line=self.log_line.emit,
            mtime_threshold=None,  # 历史文件: 不限 mtime
            label='历史 info.json',
        )

        summary_parts = []
        if renamed:
            summary_parts.append(f'重命名 {renamed} 个文件/目录')
        if updated:
            summary_parts.append(f'清理 {updated} 个 info.json')
        if not summary_parts:
            self.log_line.emit('[清理] 完成, 没有需要清理的文件')
        else:
            self.log_line.emit(f'[清理] 完成, {", ".join(summary_parts)}')
        self.finished_signal.emit(renamed + updated)


class DownloadWorker(QThread):
    log_line = Signal(str)
    finished_signal = Signal(int)

    def __init__(self, url: str, download_dir: str, download_type: str, ffmpeg_dir: str = '', cookies_browser: str = '', js_runtime: str = 'auto', strip_emoji: bool = True, download_asr_audio: bool = True, download_options: dict[str, Any] | None = None) -> None:
        super().__init__()
        self.url = url
        self.download_dir = download_dir
        self.download_type = download_type
        self.ffmpeg_dir = ffmpeg_dir
        self.cookies_browser = cookies_browser
        self.js_runtime = js_runtime
        self.strip_emoji = strip_emoji
        self.download_asr_audio = download_asr_audio
        self.download_options: dict[str, Any] = dict(download_options or DEFAULT_DOWNLOAD_OPTIONS)
        # 章节切分是否真正生效: 探测后才知道 (有的视频没有 chapter 标记)
        self._split_chapters_effective: bool = bool(self.download_options.get('split_chapters', False))
        # 父 video 路径信息 (single 模式 _resolve_output_template 里填充, 章节字幕切分/封面提取用)
        self._parent_video_dir: Path | None = None
        self._parent_video_stem: str | None = None
        self.process: subprocess.Popen | None = None
        self._paused = False
        self._stopped = False
        self._started_at = time.time()
        self._saw_private_video = False
        self._saw_unavailable_video = False
        self._saw_missing_js_runtime = False
        self._saw_ejs_solver_issue = False
        self._saw_missing_ffmpeg = False
        self._private_video_error_count = 0
        self._playlist_item_total = 0
        self._playlist_finished = False

    def _resolve_js_runtime_args(self) -> tuple[list[str], str]:
        if self.js_runtime == 'disabled':
            return [], ''
        runtime_candidates = ['node', 'bun', 'deno'] if self.js_runtime == 'auto' else [self.js_runtime]
        for runtime_name in runtime_candidates:
            runtime_path = shutil.which(runtime_name)
            if runtime_path:
                return ['--js-runtimes', f'{runtime_name}:{runtime_path}'], runtime_name
        return [], ''

    def _archive_identifier(self) -> str:
        if self.download_type == 'playlist':
            playlist_id = parse_qs(urlparse(self.url).query).get('list', [''])[0].strip()
            if playlist_id:
                return playlist_id
        return hashlib.sha1(f'{self.download_type}:{self.url.strip()}'.encode('utf-8')).hexdigest()[:16]

    def _resolve_type_extra_args(self) -> list[str]:
        extra = list(TYPE_EXTRA_ARGS.get(self.download_type, TYPE_EXTRA_ARGS['single']))
        if self.download_type in {'playlist', 'channel'}:
            archive_dir = Path(self.download_dir) / '.yt-dlp-archives'
            archive_dir.mkdir(parents=True, exist_ok=True)
            archive_path = archive_dir / f'{self.download_type}-{self._archive_identifier()}.txt'
            extra.extend(['--download-archive', str(archive_path)])
            self.log_line.emit(f'[提示] 已启用独立下载归档：{archive_path}')
        return extra

    @staticmethod
    def _is_emoji_like(char: str) -> bool:
        """兼容旧调用点: 委托到模块级通用单字符判定."""
        return _is_emoji_or_fullwidth_char(char)

    def _strip_emoji_from_name(self, name: str) -> str:
        """清理文件名/目录名: 委托到模块级通用函数 (emoji + 全角标点)."""
        return _strip_emoji_and_fullwidth(name)

    def _sanitize_path_component(self, name: str) -> str:
        cleaned = self._strip_emoji_from_name(name)
        cleaned = ''.join(' ' if char in '<>:"/\\|?*%' else char for char in cleaned)
        cleaned = ' '.join(cleaned.split())
        cleaned = cleaned.strip(' .')
        return cleaned or 'untitled'

    def _describe_emoji_like_chars(self, name: str) -> str:
        """调试日志用: 列出被识别为 emoji-like 的字符. 走通用单字符判定."""
        parts = [f'{char}(U+{ord(char):04X})' for char in name if _is_emoji_or_fullwidth_char(char)]
        return ', '.join(parts)

    def _log_sanitize_mapping(self, label: str, raw_name: str, cleaned_name: str) -> None:
        emoji_desc = self._describe_emoji_like_chars(raw_name)
        if emoji_desc:
            self.log_line.emit(f'[调试] {label} 原始值: {raw_name}')
            self.log_line.emit(f'[调试] {label} 识别到的 emoji-like 字符: {emoji_desc}')
            self.log_line.emit(f'[调试] {label} 清理结果: {cleaned_name}')
        elif raw_name != cleaned_name:
            self.log_line.emit(f'[调试] {label} 原始值: {raw_name}')
            self.log_line.emit(f'[调试] {label} 清理结果: {cleaned_name}')

    def _cleanup_download_names(self) -> None:
        """post-download 清理: 只清本次下载产生的文件 (mtime 窗口)."""
        if not self.strip_emoji:
            return
        renamed = _scan_and_rename_emoji_files(
            root_dir=Path(self.download_dir),
            log_line=self.log_line.emit,
            mtime_threshold=self._started_at - 2,
            label='下载后落盘名称',
        )
        if renamed == 0:
            self.log_line.emit('[提示] 文件名 Emoji 清理完成：本次下载未发现需要重命名的文件')

    def _cleanup_info_json_metadata(self) -> None:
        """post-download: 清理本次下载产生的 info.json 里 emoji/全角标点."""
        if not self.strip_emoji:
            return
        _scan_and_clean_info_json_metadata(
            root_dir=Path(self.download_dir),
            log_line=self.log_line.emit,
            mtime_threshold=self._started_at - 2,
            label='下载后 info.json',
        )

    def _probe_metadata_json(self, yt_dlp: str, cookies_args: list[str], js_runtime_args: list[str], remote_component_args: list[str]) -> dict:
        probe_cmd = [yt_dlp]
        if self.download_type == 'single':
            probe_cmd += ['--no-playlist']
        else:
            probe_cmd += ['--yes-playlist', '--flat-playlist', '--playlist-end', '1']
        probe_cmd += cookies_args + js_runtime_args + remote_component_args + ['--skip-download', '--dump-single-json', '--no-warnings', self.url]
        try:
            result = subprocess.run(
                probe_cmd,
                cwd=self.download_dir,
                capture_output=True,
                text=True,
                encoding='utf-8',
                errors='replace',
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == 'nt' else 0,
            )
        except Exception as exc:
            self.log_line.emit(f'[提示] 预探测下载路径失败：{exc}')
            return {}
        if result.returncode != 0:
            stderr = result.stderr.strip() or result.stdout.strip()
            if stderr:
                self.log_line.emit(f'[提示] 预探测下载路径失败：{stderr.splitlines()[-1]}')
            return {}
        raw_output = result.stdout.strip()
        if not raw_output:
            return {}
        for line in reversed(raw_output.splitlines()):
            line = line.strip()
            if not line:
                continue
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(data, dict):
                self.log_line.emit(f'[调试] 预探测元数据字段: {", ".join(sorted(data.keys())[:20])}')
                return data
        return {}

    def _resolve_output_template(self, extra: list[str], yt_dlp: str, cookies_args: list[str], js_runtime_args: list[str], remote_component_args: list[str]) -> list[str]:
        if not self.strip_emoji or '-o' not in extra:
            return extra
        metadata = self._probe_metadata_json(yt_dlp, cookies_args, js_runtime_args, remote_component_args)
        if not metadata:
            self.log_line.emit('[调试] 未拿到可用的预探测元数据，沿用原始输出模板')
            return extra

        # 检测是否有真正的章节标记 (有且 > 1 个才视为分章节视频; YouTube 偶尔会塞 1 个伪章节)
        raw_chapters = metadata.get('chapters')
        has_real_chapters = isinstance(raw_chapters, list) and len(raw_chapters) > 1
        if has_real_chapters:
            self.log_line.emit(f'[提示] 检测到 {len(raw_chapters)} 个章节，将按章节切分为独立视频。')
            self._split_chapters_effective = True
        else:
            self._split_chapters_effective = False
            # 2026-08-15: 用户在 UI 勾选了"按章节切分"但视频本身没 chapter 标记
            # (YouTube 老视频/创作者没加章节的情况), 显式 log 提示, 让用户知道
            # 这个选项被忽略了, 而不是默默下载为单段.
            if bool(self.download_options.get('split_chapters', False)):
                chapters_field = metadata.get('chapters')
                if chapters_field is None:
                    reason = '视频本身没有章节标记'
                elif isinstance(chapters_field, list) and len(chapters_field) <= 1:
                    reason = f'视频只有 {len(chapters_field)} 个章节标记 (YouTube 偶尔会塞 1 个伪章节), 不够切分'
                else:
                    reason = f'chapters 字段格式异常: type={type(chapters_field).__name__}'
                self.log_line.emit(
                    f'[章节切分] 已忽略: {reason}. '
                    f'"按章节切分"依赖 yt-dlp 拿到的视频章节元数据, '
                    f'没数据就没法切 — 本次将下载为单段.'
                )

        raw_uploader = str(metadata.get('uploader') or metadata.get('channel') or '下载内容')
        uploader_name = self._sanitize_path_component(raw_uploader)
        self._log_sanitize_mapping('uploader', raw_uploader, uploader_name)
        output_template = ''
        if self.download_type == 'single':
            raw_video_title = str(metadata.get('title') or 'video')
            video_title = self._sanitize_path_component(raw_video_title)
            self._log_sanitize_mapping('single.title', raw_video_title, video_title)
            output_template = f'{uploader_name}/{video_title}.%(ext)s'
            # 父 video 预期路径（章节切分后续步骤读父 info.json 用）
            # 注意: chapter: 前缀模板是 ``<uploader>/<title>/chapters/...`` (多一层 <title>/),
            # 所以父 video dir 必须包含 <title> 这一层
            self._parent_video_dir = Path(self.download_dir) / uploader_name / video_title
            self._parent_video_stem = video_title
        elif self.download_type == 'playlist':
            raw_playlist_title = str(metadata.get('title') or metadata.get('playlist_title') or 'playlist')
            playlist_title = self._sanitize_path_component(raw_playlist_title)
            self._log_sanitize_mapping('playlist.title', raw_playlist_title, playlist_title)
            output_template = f'{uploader_name}/{playlist_title}/%(playlist_index)02d - %(title)s.%(ext)s'
            # playlist 模式下每条 video 是独立子目录, 由 yt-dlp 落盘后才知道具体路径
            self._parent_video_dir = None
            self._parent_video_stem = None
        elif self.download_type == 'channel':
            output_template = f'{uploader_name}/%(playlist)s/%(playlist_index)02d - %(title)s.%(ext)s'
            self._parent_video_dir = None
            self._parent_video_stem = None
        if not output_template:
            return extra
        resolved = list(extra)
        output_index = resolved.index('-o') + 1
        resolved[output_index] = output_template

        # 章节切分时, 加一个 chapter: 前缀的输出模板, 控制每章文件的目录
        # yt-dlp 文档: "The 'chapter:' prefix can be used with '--paths' and '--output'"
        # 父文件 (字幕/缩略图/info.json) 用主模板 (不再有 NA - NA 占位符问题)
        if self._split_chapters_effective:
            # 在主模板基础上, 把文件名部分替换成 chapters/<section>/<section>.ext
            chapter_dir_path = f'{output_template.rsplit(".%(ext)s", 1)[0]}/chapters/%(section_number)02d - %(section_title)s'
            chapter_filename = '%(section_number)02d - %(section_title)s.%(ext)s'
            chapter_template = f'{chapter_dir_path}/{chapter_filename}'
            resolved += ['-o', f'chapter:{chapter_template}']
            self.log_line.emit(f'[提示] 主模板: {output_template}')
            self.log_line.emit(f'[提示] 章节模板: chapter:{chapter_template}')
        else:
            self.log_line.emit(f'[提示] 已预清理下载路径：{output_template}')
        return resolved

    @staticmethod
    def _with_asr_audio_output_template(extra: list[str]) -> list[str]:
        resolved = list(extra)
        if '-o' not in resolved:
            return resolved
        output_index = resolved.index('-o') + 1
        if output_index >= len(resolved):
            return resolved
        template = resolved[output_index]
        marker = '.%(ext)s'
        if marker in template:
            resolved[output_index] = template.replace(marker, f'.asr{marker}', 1)
        else:
            resolved[output_index] = f'{template}.asr.%(ext)s'
        return resolved

    def _download_asr_audio_files(self, yt_dlp: str, extra: list[str], ffmpeg_args: list[str], cookies_args: list[str], js_runtime_args: list[str], remote_component_args: list[str]) -> int:
        audio_extra = self._with_asr_audio_output_template(extra)
        cmd = [
            yt_dlp,
            *audio_extra,
            *ffmpeg_args,
            *cookies_args,
            *js_runtime_args,
            *remote_component_args,
            '-f', 'ba',
            '-x',
            '--audio-format', 'wav',
            '--postprocessor-args', 'ExtractAudio+ffmpeg_o:-ac 1 -ar 16000 -acodec pcm_s16le',
            '--newline',
            self.url,
        ]
        self.log_line.emit('[ASR音频] 开始下载并转换 16kHz 单声道 WAV…')
        self.log_line.emit(f'[执行] {" ".join(cmd)}')
        try:
            process = subprocess.Popen(
                cmd,
                cwd=self.download_dir,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding='utf-8',
                errors='replace',
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == 'nt' else 0,
            )
            assert process.stdout is not None
            for line in iter(process.stdout.readline, ''):
                if self._stopped:
                    break
                stripped_line = line.rstrip()
                if stripped_line:
                    self.log_line.emit(f'[ASR音频] {stripped_line}')
            process.stdout.close()
            return process.wait()
        except Exception as exc:
            self.log_line.emit(f'[ASR音频][异常] {exc}')
            return -1

    def _resolve_ffmpeg_executable(self, ffmpeg_dir: str) -> str:
        if ffmpeg_dir:
            executable_name = 'ffmpeg.exe' if os.name == 'nt' else 'ffmpeg'
            candidate = Path(ffmpeg_dir) / executable_name
            if candidate.exists():
                return str(candidate)
        return resolve_executable('ffmpeg') or 'ffmpeg'

    def _asr_audio_exec_args(self, ffmpeg_dir: str) -> list[str]:
        ffmpeg = self._resolve_ffmpeg_executable(ffmpeg_dir)
        if os.name == 'nt':
            ffmpeg_command = subprocess.list2cmdline([
                ffmpeg,
                '-y',
                '-i',
                '{}',
                '-ac',
                '1',
                '-ar',
                '16000',
                '-vn',
                '-acodec',
                'pcm_s16le',
                '{}.asr.wav',
            ])
        else:
            ffmpeg_command = f'"{ffmpeg}" -y -i {{}} -ac 1 -ar 16000 -vn -acodec pcm_s16le "{{}}.asr.wav"'
        return ['--exec', f'after_move:{ffmpeg_command}']

    def _inspect_log_line(self, line: str) -> None:
        lower_line = line.lower()
        if line.startswith('ERROR:') and 'private video' in lower_line:
            self._saw_private_video = True
            self._private_video_error_count += 1
        if 'this video is not available' in lower_line or 'unavailable video is hidden' in lower_line or 'playability status: unplayable' in lower_line:
            self._saw_unavailable_video = True
        if 'no supported javascript runtime could be found' in lower_line:
            self._saw_missing_js_runtime = True
        if 'remote component challenge solver script' in lower_line or 'challenge solving failed' in lower_line:
            self._saw_ejs_solver_issue = True
        if 'ffmpeg not found' in lower_line:
            self._saw_missing_ffmpeg = True
        playlist_match = re.search(r'downloading\s+(\d+)\s+items\s+of\s+(\d+)', lower_line)
        if playlist_match:
            self._playlist_item_total = max(self._playlist_item_total, int(playlist_match.group(2)))
        if lower_line.startswith('[download] finished downloading playlist:'):
            self._playlist_finished = True

    def _emit_diagnostics(self, returncode: int) -> None:
        if self._stopped:
            return
        hints: list[str] = []
        if returncode != 0 and self._playlist_finished and self._private_video_error_count > 0:
            hints.append(f'[诊断] 播放列表条目已处理完成，但其中有 {self._private_video_error_count} 个 Private video 无法访问，所以 yt-dlp 最终返回了失败码。已成功下载的公开视频不会因此失效。')
        if self._saw_private_video:
            if self.cookies_browser:
                hints.append('[诊断] 检测到 Private video：当前已带浏览器 Cookies。若仍失败，说明当前浏览器登录账号本身也没有该视频访问权限。')
            else:
                hints.append('[诊断] 检测到 Private video：这属于账号权限问题。若你在浏览器登录后能观看，请在“浏览器 Cookies”中选择当前登录浏览器后重试。')
        if self._saw_unavailable_video:
            if self._saw_missing_js_runtime or self._saw_ejs_solver_issue:
                hints.append('[诊断] 检测到 unavailable 且伴随 JS/EJS 解析告警：这通常不是视频真的不可下载，而是 YouTube 解析链路不完整。请启用 Node.js/自动检测，程序会自动启用 ejs:github。')
            else:
                hints.append('[诊断] 检测到 unavailable：如果浏览器里也无法打开该视频，多半是源视频被下架、私密、区域限制或年龄限制；如果浏览器能打开，建议再试一次并带上浏览器 Cookies。')
        if self._saw_missing_ffmpeg:
            hints.append('[诊断] 未检测到 ffmpeg：下载仍可能继续，但最佳格式选择、音视频合并或转封装可能受影响。建议在页面上配置 ffmpeg 目录。')
        if returncode != 0 and not hints:
            hints.append('[诊断] 本次下载失败，但未匹配到常见错误模式。可优先检查 URL 是否可在浏览器播放、yt-dlp 是否为最新版，以及是否需要浏览器 Cookies。')
        for hint in hints:
            self.log_line.emit(hint)

    def _should_run_post_download_cleanup(self, returncode: int) -> bool:
        if returncode == 0:
            return True
        return self._playlist_finished and (self._private_video_error_count > 0 or self._saw_unavailable_video)

    def _has_ffmpeg(self) -> bool:
        ffmpeg_dir = resolve_ffmpeg_dir(self.ffmpeg_dir)
        if ffmpeg_dir:
            p = Path(ffmpeg_dir)
            if (p / 'ffmpeg.exe').exists() or (p / 'ffprobe.exe').exists():
                return True
        return shutil.which('ffmpeg') is not None or shutil.which('ffprobe') is not None

    def run(self) -> None:
        yt_dlp = resolve_executable('yt-dlp')
        if not yt_dlp:
            self.log_line.emit('[错误] 未找到 yt-dlp，可将 yt-dlp.exe 放到程序目录或 vendor 目录中')
            self.finished_signal.emit(1)
            return

        # 预检: 章节切分 / SponsorBlock 移除 / ASR 音频 都依赖 ffmpeg
        needs_ffmpeg = (
            self.download_asr_audio
            or self.download_options.get('sponsorblock_action') == 'remove'
            or self.download_options.get('split_chapters', False)
        )
        if needs_ffmpeg and not self._has_ffmpeg():
            self.log_line.emit('[警告] 当前选项需要 ffmpeg (SponsorBlock 移除 / 章节切分 / ASR 音频)，但未检测到 ffmpeg/ffmpeg.exe。')
            self.log_line.emit('[警告] 请在页面上方填写 ffmpeg 目录 (内含 ffmpeg.exe/ffprobe.exe)，否则下载会在后处理阶段失败。')

        extra = self._resolve_type_extra_args()
        ffmpeg_args = []
        ffmpeg_dir = resolve_ffmpeg_dir(self.ffmpeg_dir)
        if ffmpeg_dir:
            ffmpeg_args = ['--ffmpeg-location', ffmpeg_dir]
        cookies_args: list[str] = []
        if self.cookies_browser:
            cookies_args = ['--cookies-from-browser', self.cookies_browser]
        js_runtime_args, resolved_runtime = self._resolve_js_runtime_args()
        remote_component_args: list[str] = []
        if resolved_runtime:
            remote_component_args = ['--remote-components', 'ejs:github']
            self.log_line.emit(f'[提示] 已启用 JS Runtime: {resolved_runtime}')
            self.log_line.emit('[提示] 已启用 YouTube EJS challenge solver: ejs:github')
        elif self.js_runtime != 'disabled':
            self.log_line.emit('[提示] 未检测到可用 JS Runtime，YouTube 解析可能不稳定。')
        if self.cookies_browser:
            self.log_line.emit(f'[提示] 已启用浏览器 Cookies: {self.cookies_browser}')
        extra = self._resolve_output_template(extra, yt_dlp, cookies_args, js_runtime_args, remote_component_args)
        if self.strip_emoji:
            self.log_line.emit('[提示] 已启用文件名 Emoji 清理（路径预清理 + 下载完成后兜底重命名）')
        asr_exec_args: list[str] = []
        if self.download_asr_audio:
            asr_exec_args = self._asr_audio_exec_args(ffmpeg_dir)
            self.log_line.emit('[ASR音频] 已启用随视频下载生成 ASR WAV：每个视频落盘后立即转换')
        # 章节切分是否真的生效取决于探测结果 (没有 chapter 标记的会回退)
        effective_options = {**self.download_options, 'split_chapters': self._split_chapters_effective}
        yt_dlp_common_args = build_yt_dlp_args(effective_options)
        cmd = [yt_dlp] + extra + ffmpeg_args + cookies_args + js_runtime_args + remote_component_args + asr_exec_args + yt_dlp_common_args + [self.url]
        self.log_line.emit(f'[执行] {" ".join(cmd)}')
        self.log_line.emit(f'[目录] {self.download_dir}')

        # 代理: 仅本次 yt-dlp 子进程注入, 不影响主进程和其他模块 (ASR/AI/OSS 不走代理)
        proxy_cfg = load_proxy_config()
        proxy_env = get_proxy_env(proxy_cfg)
        if proxy_env:
            self.log_line.emit(
                f'[代理] 已为本次 yt-dlp 子进程注入代理: {proxy_env["HTTP_PROXY"]}'
            )
        elif proxy_cfg.get('enabled'):
            self.log_line.emit('[代理] 代理已勾选但 URL 为空, 不会生效')
        else:
            self.log_line.emit('[代理] 代理未启用, yt-dlp 直连 YouTube (国内可能 timeout)')

        # 注意: env 只用于这次 Popen, 不污染 os.environ
        subprocess_env = os.environ.copy()
        subprocess_env.update(proxy_env)

        try:
            self.process = subprocess.Popen(
                cmd,
                cwd=self.download_dir,
                env=subprocess_env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding='utf-8',
                errors='replace',
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == 'nt' else 0,
            )
            for line in iter(self.process.stdout.readline, ''):
                if self._stopped:
                    break
                stripped_line = line.rstrip()
                self._inspect_log_line(stripped_line)
                self.log_line.emit(stripped_line)
            self.process.stdout.close()
            returncode = self.process.wait()
        except Exception as exc:
            self.log_line.emit(f'[异常] {exc}')
            returncode = -1

        if self._should_run_post_download_cleanup(returncode):
            if returncode != 0:
                self.log_line.emit('[提示] 播放列表已处理完成，但存在不可访问条目；仍将执行一次文件名 Emoji 兜底清理。')
            self._cleanup_download_names()
            self._cleanup_info_json_metadata()
        # 章节切分成功后, 把父字幕按章节切片, 然后从每段视频抽一帧作为封面
        if self._split_chapters_effective and returncode == 0:
            try:
                self._split_subtitles_by_chapter()
            except Exception as exc:
                self.log_line.emit(f'[字幕切分][异常] {exc}')
            try:
                self._extract_chapter_thumbnails()
            except Exception as exc:
                self.log_line.emit(f'[章节封面][异常] {exc}')
        self._emit_diagnostics(returncode)
        self.finished_signal.emit(returncode)

    @staticmethod
    def _parse_vtt_timestamp(stamp: str) -> float:
        """解析 VTT/SRT 时间戳 (HH:MM:SS.mmm 或 MM:SS.mmm) 为秒。"""
        s = stamp.strip().replace(',', '.')
        parts = s.split(':')
        if len(parts) == 3:
            h, m, sec = parts
        elif len(parts) == 2:
            h, m, sec = '0', parts[0], parts[1]
        else:
            return 0.0
        try:
            return int(h) * 3600 + int(m) * 60 + float(sec)
        except ValueError:
            return 0.0

    def _extract_chapter_thumbnails(self) -> None:
        """章节切分成功后, 用 ffmpeg 从每个章节视频抽一帧作为封面 jpg。

        抽帧位置: 章节起点 + 2s, 避开片头黑屏。

        章节的 start_time 从父 info.json 的 ``chapters`` 数组里读 (yt-dlp
        不会为每个章节生成独立 info.json)。
        """
        if self._stopped:
            return
        parent_info, parent_video_dir, _, chapters_root = self._find_chapter_assets()
        if not parent_info or not chapters_root:
            return
        root = Path(self.download_dir)
        if not root.exists():
            return
        # 找 ffmpeg
        ffmpeg_path = self._resolve_ffmpeg_executable(self.ffmpeg_dir)
        if not ffmpeg_path or not Path(ffmpeg_path).exists():
            alt = shutil.which('ffmpeg')
            if alt:
                ffmpeg_path = alt
            else:
                self.log_line.emit('[章节封面] 找不到 ffmpeg, 跳过封面提取')
                return

        try:
            parent_payload = json.loads(parent_info.read_text('utf-8'))
        except Exception as exc:
            self.log_line.emit(f'[章节封面] 读父 info.json 失败: {exc}')
            return
        raw_chapters = parent_payload.get('chapters')
        if not isinstance(raw_chapters, list) or len(raw_chapters) < 2:
            return

        self.log_line.emit(f'[章节封面] 开始为 {len(raw_chapters)} 个章节抽封面...')
        success = 0
        for idx, ch in enumerate(raw_chapters, start=1):
            if self._stopped:
                return
            title = str(ch.get('title') or '').strip()
            start_time = ch.get('start_time')
            if not title or start_time is None:
                continue
            chapter_stem = f'{idx:02d} - {title}'
            chapter_dir = chapters_root / chapter_stem
            video_path = chapter_dir / f'{chapter_stem}.mp4'
            if not video_path.exists():
                continue
            jpg_path = chapter_dir / f'{chapter_stem}.jpg'
            if jpg_path.exists():
                continue
            # chapter mp4 已被 ffmpeg 切出来, 视频 0 秒 = 章节起点, 所以 seek 用章节内偏移 (2.0s)
            # 而非 ``start_time + 2.0`` (那是父视频的绝对时间, 加后会 seek 到 chapter 视频外)
            seek_to = 2.0
            cmd = [
                ffmpeg_path, '-y',
                '-ss', f'{seek_to:.3f}',
                '-i', str(video_path),
                '-frames:v', '1',
                '-q:v', '2',
                str(jpg_path),
            ]
            try:
                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    encoding='utf-8',
                    errors='replace',
                    timeout=60,
                )
                if result.returncode == 0 and jpg_path.exists():
                    success += 1
                    self.log_line.emit(f'[章节封面] {chapter_stem}.jpg 已生成')
                else:
                    err = (result.stderr or '').strip().splitlines()[-1] if result.stderr else 'unknown'
                    self.log_line.emit(f'[章节封面] {chapter_stem}: ffmpeg 失败: {err}')
            except Exception as exc:
                self.log_line.emit(f'[章节封面] {chapter_stem}: {exc}')
        if success > 0:
            self.log_line.emit(f'[章节封面] 完成, 共 {success} 个章节封面已生成')

    @staticmethod
    def _format_vtt_timestamp(seconds: float) -> str:
        """把秒格式化为 HH:MM:SS.mmm。"""
        if seconds < 0:
            seconds = 0
        total_ms = int(round(seconds * 1000))
        h, rem = divmod(total_ms, 3600 * 1000)
        m, rem = divmod(rem, 60 * 1000)
        s, ms = divmod(rem, 1000)
        return f'{h:02d}:{m:02d}:{s:02d}.{ms:03d}'

    def _slice_subtitle_file(self, sub_path: Path, target_dir: Path, chapter_stem: str, start_time: float, end_time: float) -> int:
        """把单个父字幕文件按章节切片, 写到 ``<target_dir>/<chapter_stem><原后缀>``。

        返回切片后的时间点 (cue/event) 数量; 0 = 这个章节没有字幕内容。
        """
        name = sub_path.name
        suffix = sub_path.suffix.lower()  # .json3 / .vtt / .srt
        first_dot = name.find('.')
        if first_dot <= 0:
            new_name = f'{chapter_stem}{name}'
        else:
            new_name = f'{chapter_stem}{name[first_dot:]}'
        new_path = target_dir / new_name
        if new_path.exists():
            self.log_line.emit(f'[字幕切分] {new_name} 已存在, 跳过')
            return 0

        if suffix == '.json3':
            try:
                payload = json.loads(sub_path.read_text('utf-8'))
            except Exception as exc:
                self.log_line.emit(f'[字幕切分] 读取 {name} 失败: {exc}')
                return 0
            events = payload.get('events') or []
            sliced: list[dict] = []
            for event in events:
                # yt-dlp 输出的 json3 用驼峰字段 (tStartMs / dDurationMs, YouTube 原生名);
                # 兼容蛇形 (t_start_ms / d_duration_ms) 方便其它来源 / 自定义生成
                t_start = event.get('tStartMs') if 'tStartMs' in event else event.get('t_start_ms')
                t_dur = event.get('dDurationMs') if 'dDurationMs' in event else event.get('d_duration_ms')
                if t_start is None:
                    continue
                ev_start = t_start / 1000.0
                ev_end = ev_start + (t_dur / 1000.0 if t_dur else 0)
                # 交集条件: 字幕时间与章节时间有重叠
                if ev_end <= start_time or ev_start >= end_time:
                    continue
                new_event = dict(event)
                # 裁剪到章节边界内, 时间码重新对齐章节起点
                clipped_start = max(ev_start, start_time)
                clipped_end = min(ev_end, end_time) if ev_end > 0 else end_time
                new_event['t_start_ms'] = int(round((clipped_start - start_time) * 1000))
                new_event['d_duration_ms'] = int(round((clipped_end - clipped_start) * 1000))
                sliced.append(new_event)
            if not sliced:
                return 0
            new_payload = dict(payload)
            new_payload['events'] = sliced
            try:
                new_path.write_text(json.dumps(new_payload, ensure_ascii=False), 'utf-8')
            except Exception as exc:
                self.log_line.emit(f'[字幕切分] 写入 {new_name} 失败: {exc}')
                return 0
            return len(sliced)

        if suffix in ('.vtt', '.srt'):
            is_vtt = suffix == '.vtt'
            try:
                raw = sub_path.read_text('utf-8', errors='replace')
            except Exception as exc:
                self.log_line.emit(f'[字幕切分] 读取 {name} 失败: {exc}')
                return 0
            # 解析 cues: cue = (start_str, end_str, text_lines)
            cues: list[tuple[str, str, list[str]]] = []
            current: list[str] | None = None
            for line in raw.splitlines():
                if is_vtt and line.strip().startswith('WEBVTT'):
                    continue
                if '-->' in line:
                    parts = line.split('-->', 1)
                    start_str = parts[0].strip()
                    end_str = parts[1].strip().split(' ', 1)[0]
                    current = [start_str, end_str, []]
                    cues.append((current[0], current[1], current[2]))
                elif current is not None and line.strip():
                    current[2].append(line)
                elif not line.strip():
                    current = None
            sliced_cues: list[tuple[float, float, list[str]]] = []
            for start_str, end_str, text_lines in cues:
                ev_start = self._parse_vtt_timestamp(start_str)
                ev_end = self._parse_vtt_timestamp(end_str)
                if ev_end <= start_time or ev_start >= end_time:
                    continue
                clipped_start = max(ev_start, start_time)
                clipped_end = min(ev_end, end_time) if ev_end > 0 else end_time
                if clipped_end <= clipped_start:
                    continue
                sliced_cues.append((clipped_start - start_time, clipped_end - start_time, text_lines))
            if not sliced_cues:
                return 0
            out_lines: list[str] = []
            if is_vtt:
                out_lines.append('WEBVTT')
                out_lines.append('')
            for i, (c_start, c_end, text_lines) in enumerate(sliced_cues, start=1):
                if not is_vtt:
                    out_lines.append(str(i))
                start_ts = self._format_vtt_timestamp(c_start)
                end_ts = self._format_vtt_timestamp(c_end)
                if is_vtt:
                    out_lines.append(f'{start_ts} --> {end_ts}')
                else:
                    out_lines.append(f'{start_ts} --> {end_ts}'.replace('.', ','))
                out_lines.extend(text_lines)
                out_lines.append('')
            try:
                new_path.write_text('\n'.join(out_lines), 'utf-8')
            except Exception as exc:
                self.log_line.emit(f'[字幕切分] 写入 {new_name} 失败: {exc}')
                return 0
            return len(sliced_cues)

        # 其它格式不处理
        self.log_line.emit(f'[字幕切分] {name} 是不支持的字幕格式 ({suffix}), 跳过')
        return 0

    def _find_chapter_assets(self) -> tuple[Path | None, Path | None, list[Path], Path | None]:
        """定位章节切分后的关键资产:
        - 父 info.json (含 chapters 数组)
        - 父 video dir (uploader 目录, 父 info.json 所在目录, 用来 glob 父字幕)
        - 父字幕列表 (json3 / vtt / srt, 跟 info.json 同目录)
        - chapters 根目录 (实际章节子目录的父: ``<uploader>/<title>/chapters/``,
          chapter: 模板比主模板多一层 ``<title>/``)

        优先用本次下载记录的 ``self._parent_video_dir`` (single 模式下确切的
        ``<download_dir>/<uploader>/<title>`` 路径, 跟本次 yt-dlp 任务的输出
        template 一一对应, 不会扫到老视频的 .info.json)。fallback 才用 rglob
        (playlist 模式没记录具体 video 路径), 并按 mtime 取最新, 避免 rglob
        顺序随机返回老文件。
        """
        root = Path(self.download_dir)
        if not root.exists():
            return None, None, [], None
        parent_info: Path | None = None
        parent_video_dir: Path | None = None
        # Path 1: 用本次下载记录的目标路径 (single 模式)
        if self._parent_video_dir is not None and self._parent_video_stem:
            candidate_dir = Path(self._parent_video_dir)
            candidate_info = candidate_dir / f'{self._parent_video_stem}.info.json'
            if candidate_info.exists():
                parent_info = candidate_info
                parent_video_dir = candidate_dir
        # Path 2: fallback rglob, 排除 chapters/ 和 .yt-dlp-archives/, mtime 最新优先
        if parent_info is None:
            candidates: list[Path] = []
            for info_path in root.rglob('*.info.json'):
                if any(part.lstrip('.').startswith('yt-dlp-archives') for part in info_path.parts):
                    continue
                if 'chapters' in info_path.parts:
                    continue
                candidates.append(info_path)
            if candidates:
                # mtime 最新优先, 避免 rglob 顺序随机返回老的 .info.json
                candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
                parent_info = candidates[0]
                parent_video_dir = parent_info.parent
        if not parent_info or not parent_video_dir:
            return None, None, [], None
        # 父字幕: 跟父 info.json 同目录, 跟父 info.json 同 stem, 字幕后缀
        stem = parent_info.stem
        if stem.endswith('.info'):
            stem = stem[:-5]
        subs: list[Path] = []
        for pattern in ('*.json3', '*.vtt', '*.srt'):
            subs.extend(parent_video_dir.glob(f'{stem}.{pattern}'))
        # ASR wav 不是字幕, 不会匹配
        # chapters 根目录: chapter: 模板是 <uploader>/<title>/chapters/...,
        # 父 info.json 落在 <uploader>/<title>.info.json, 所以 chapters 根在
        # ``parent_video_dir / <title> / 'chapters'``。
        chapters_root = parent_video_dir / stem / 'chapters' if stem else None
        self.log_line.emit(f'[调试] _find_chapter_assets: parent_video_dir={self._parent_video_dir!r} parent_video_stem={self._parent_video_stem!r} resolved_parent_info={parent_info!r} chapters_root={chapters_root!r}')
        return parent_info, parent_video_dir, subs, chapters_root

    def _split_subtitles_by_chapter(self) -> None:
        """章节切分成功后, 把父字幕按章节切片, 写到对应章节子目录。

        yt-dlp 的 --split-chapters 不会为每个章节生成独立 info.json,
        章节元数据 (start_time / end_time / title) 只在父 info.json 的 ``chapters`` 数组里。
        流程:
        1. 找父 info.json (download_dir 下, 不在 chapters/ 或 .yt-dlp-archives/ 里)
        2. 读 ``chapters`` 数组
        3. 对每个章节, 找到对应章节子目录 (chapter_stem = ``<n>02d - <title>``)
        4. 把父字幕切片写到章节子目录里
        """
        if self._stopped:
            return
        parent_info, parent_video_dir, parent_subs, chapters_root = self._find_chapter_assets()
        if not parent_info:
            self.log_line.emit('[字幕切分] 找不到父 info.json, 跳过')
            return
        if not parent_subs:
            self.log_line.emit('[字幕切分] 父 video 目录下没找到字幕文件, 跳过')
            return
        if not chapters_root:
            self.log_line.emit('[字幕切分] 推不出 chapters 根目录, 跳过')
            return
        try:
            parent_payload = json.loads(parent_info.read_text('utf-8'))
        except Exception as exc:
            self.log_line.emit(f'[字幕切分] 读父 info.json 失败: {exc}')
            return
        raw_chapters = parent_payload.get('chapters')
        if not isinstance(raw_chapters, list) or len(raw_chapters) < 2:
            self.log_line.emit('[字幕切分] 父 info.json 里没有 chapters 数组 (或不足 2 个), 跳过')
            return
        self.log_line.emit(f'[字幕切分] 发现 {len(raw_chapters)} 个章节 + {len(parent_subs)} 个父字幕, 开始按章节切分... (chapters 根目录: {chapters_root})')
        sliced_files = 0
        sliced_cues = 0
        for idx, ch in enumerate(raw_chapters, start=1):
            if self._stopped:
                return
            title = str(ch.get('title') or '').strip()
            start_time = ch.get('start_time')
            end_time = ch.get('end_time')
            if not title or start_time is None or end_time is None:
                self.log_line.emit(f'[字幕切分] ch{idx}: 缺字段, 跳过 (title={title!r}, start={start_time}, end={end_time})')
                continue
            chapter_stem = f'{idx:02d} - {title}'
            chapter_dir = chapters_root / chapter_stem
            if not chapter_dir.exists():
                self.log_line.emit(f'[字幕切分] {chapter_stem}: 子目录不存在 ({chapter_dir}), 跳过')
                continue
            for sub_path in parent_subs:
                count = self._slice_subtitle_file(sub_path, chapter_dir, chapter_stem, float(start_time), float(end_time))
                if count > 0:
                    sliced_files += 1
                    sliced_cues += count
                    self.log_line.emit(f'[字幕切分] {chapter_stem}: {count} 个时间点 ← {sub_path.name}')
        if sliced_files > 0:
            self.log_line.emit(f'[字幕切分] 完成, 共 {sliced_files} 个字幕文件, {sliced_cues} 个时间点')
        else:
            self.log_line.emit('[字幕切分] 没有可切的父字幕 (子文件可能已经存在, 或没下载字幕)')

    def _suspend_resume_win(self, suspend: bool) -> bool:
        """Use NtSuspendProcess / NtResumeProcess to truly freeze the process tree on Windows."""
        try:
            import ctypes
            from ctypes import wintypes

            ntdll = ctypes.WinDLL('ntdll')
            kernel32 = ctypes.WinDLL('kernel32')

            PROCESS_SUSPEND_RESUME = 0x0800
            fn = ntdll.NtSuspendProcess if suspend else ntdll.NtResumeProcess

            pids = [self.process.pid]
            try:
                import psutil
                parent = psutil.Process(self.process.pid)
                pids += [c.pid for c in parent.children(recursive=True)]
            except Exception:
                pass

            for pid in pids:
                handle = kernel32.OpenProcess(PROCESS_SUSPEND_RESUME, False, pid)
                if handle:
                    fn(handle)
                    kernel32.CloseHandle(handle)
            return True
        except Exception as exc:
            self.log_line.emit(f'[错误] 挂起/恢复失败: {exc}')
            return False

    def pause(self) -> None:
        if self.process and self.process.poll() is None:
            if os.name == 'nt':
                if self._suspend_resume_win(suspend=True):
                    self._paused = True
                    self.log_line.emit('[暂停] 下载已暂停')
            else:
                self.process.send_signal(signal.SIGSTOP)
                self._paused = True
                self.log_line.emit('[暂停] 下载已暂停')

    def resume(self) -> None:
        if self.process and self.process.poll() is None and self._paused:
            if os.name == 'nt':
                if self._suspend_resume_win(suspend=False):
                    self._paused = False
                    self.log_line.emit('[继续] 下载已恢复')
            else:
                self.process.send_signal(signal.SIGCONT)
                self._paused = False
                self.log_line.emit('[继续] 下载已恢复')

    def stop(self) -> None:
        self._stopped = True
        if self.process and self.process.poll() is None:
            if self._paused:
                self.resume()
            self.process.terminate()
            self.log_line.emit('[停止] 下载已终止')

    @property
    def is_paused(self) -> bool:
        return self._paused


class DownloadTab(QWidget):
    def __init__(self) -> None:
        super().__init__()
        self.worker: DownloadWorker | None = None
        self.cleanup_worker: EmojiCleanupWorker | None = None
        self._build_ui()

    def _build_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(12)

        # --- 参数区 ---
        params = QGroupBox('下载参数')
        params_layout = QVBoxLayout(params)

        # 类型选择
        type_row = QHBoxLayout()
        type_row.addWidget(QLabel('下载类型'))
        self.type_combo = QComboBox()
        for label, _, _ in DOWNLOAD_TYPES:
            self.type_combo.addItem(label)
        self.type_combo.setMinimumWidth(200)
        self.type_combo.currentIndexChanged.connect(self._on_type_changed)
        type_row.addWidget(self.type_combo)
        type_row.addStretch(1)
        params_layout.addLayout(type_row)

        # URL
        url_row = QHBoxLayout()
        url_row.addWidget(QLabel('视频 URL  '))
        self.url_input = QLineEdit()
        self.url_input.setPlaceholderText(DOWNLOAD_TYPES[0][2])
        url_row.addWidget(self.url_input)
        params_layout.addLayout(url_row)

        # 下载目录
        dir_row = QHBoxLayout()
        dir_row.addWidget(QLabel('下载目录  '))
        self.dir_input = QLineEdit()
        self.dir_input.setPlaceholderText('选择下载保存的目录')
        dir_row.addWidget(self.dir_input)
        self.browse_btn = QPushButton('选择目录')
        self.browse_btn.clicked.connect(self._choose_dir)
        dir_row.addWidget(self.browse_btn)
        params_layout.addLayout(dir_row)

        # ffmpeg 路径 — 配置统一在系统设置 tab, 这里只读显示 + 跳过去改
        ffmpeg_row = QHBoxLayout()
        ffmpeg_row.addWidget(QLabel('ffmpeg 目录'))
        self.ffmpeg_input = QLineEdit()
        self.ffmpeg_input.setReadOnly(True)
        self.ffmpeg_input.setPlaceholderText('在「系统设置 → 视频处理」里配置')
        ffmpeg_row.addWidget(self.ffmpeg_input)
        self.ffmpeg_browse_btn = QPushButton('去系统设置改…')
        self.ffmpeg_browse_btn.clicked.connect(self._jump_to_ffmpeg_settings)
        ffmpeg_row.addWidget(self.ffmpeg_browse_btn)
        params_layout.addLayout(ffmpeg_row)

        cookies_row = QHBoxLayout()
        cookies_row.addWidget(QLabel('浏览器 Cookies'))
        self.cookies_combo = QComboBox()
        for label, value in COOKIE_BROWSER_OPTIONS:
            self.cookies_combo.addItem(label, value)
        cookies_row.addWidget(self.cookies_combo)
        cookies_row.addStretch(1)
        params_layout.addLayout(cookies_row)

        js_runtime_row = QHBoxLayout()
        js_runtime_row.addWidget(QLabel('JS Runtime'))
        self.js_runtime_combo = QComboBox()
        for label, value in JS_RUNTIME_OPTIONS:
            self.js_runtime_combo.addItem(label, value)
        js_runtime_row.addWidget(self.js_runtime_combo)
        js_runtime_row.addStretch(1)
        params_layout.addLayout(js_runtime_row)

        strip_emoji_row = QHBoxLayout()
        self.strip_emoji_checkbox = QCheckBox('清理文件名中的 Emoji（推荐）')
        self.strip_emoji_checkbox.setChecked(True)
        strip_emoji_row.addWidget(self.strip_emoji_checkbox)
        self.strip_emoji_row = strip_emoji_row
        # 2026-08-24 新增: 历史文件清理按钮.
        # 默认清理逻辑只处理 mtime 在 2s 窗口内的本次下载文件, 历史脏文件
        # (例如 D:\yt-dlp\videos\English by Jay - Sprout\English Fluency
        # Blueprint\ 下的 🇬🇧🛒🍎？｜) 永远碰不到. 这个按钮给用户手动
        # 触发, 不限 mtime, 走同样的通用 emoji 识别 (emoji 库 / regex /
        # 全角标点).
        self.cleanup_existing_btn = QPushButton('清理历史文件')
        self.cleanup_existing_btn.setToolTip(
            '扫描整个下载目录, 把所有含 Emoji / 全角标点的历史文件/目录重命名.\n'
            '默认清理逻辑只处理本次下载, 历史文件需要这个按钮手动清.'
        )
        self.cleanup_existing_btn.clicked.connect(self._on_cleanup_existing_clicked)
        strip_emoji_row.addWidget(self.cleanup_existing_btn)
        strip_emoji_row.addStretch(1)
        params_layout.addLayout(strip_emoji_row)
        self.download_asr_audio_checkbox = QCheckBox('同时下载 ASR 音频 WAV（16kHz 单声道，推荐）')
        self.download_asr_audio_checkbox.setChecked(True)
        params_layout.addWidget(self.download_asr_audio_checkbox)

        layout.addWidget(params)

        # --- 高级选项 (可折叠，展开后看到 yt-dlp 详细参数) ---
        self.advanced_group = QGroupBox('高级选项 (yt-dlp 参数，默认折叠)')
        self.advanced_group.setCheckable(True)
        self.advanced_group.setChecked(False)
        adv_layout = QFormLayout(self.advanced_group)
        adv_layout.setLabelAlignment(Qt.AlignRight)
        adv_layout.setContentsMargins(12, 8, 12, 12)
        adv_layout.setHorizontalSpacing(8)
        adv_layout.setVerticalSpacing(6)

        self.format_combo = QComboBox()
        for label, value in VIDEO_FORMAT_OPTIONS:
            self.format_combo.addItem(label, value)
        self.format_combo.setMinimumWidth(220)
        adv_layout.addRow('视频格式', self.format_combo)

        self.write_subs_checkbox = QCheckBox('下载字幕（含自动字幕）')
        adv_layout.addRow(self.write_subs_checkbox)

        self.sub_langs_input = QLineEdit()
        self.sub_langs_input.setPlaceholderText('en,zh-Hans,en.*,zh-Hans.*')
        adv_layout.addRow('字幕语言', self.sub_langs_input)

        self.sub_format_combo = QComboBox()
        for label, value in SUB_FORMAT_OPTIONS:
            self.sub_format_combo.addItem(label, value)
        adv_layout.addRow('字幕格式', self.sub_format_combo)

        self.write_thumbnail_checkbox = QCheckBox('写缩略图 (jpg)')
        adv_layout.addRow(self.write_thumbnail_checkbox)
        self.write_info_json_checkbox = QCheckBox('写 info.json')
        adv_layout.addRow(self.write_info_json_checkbox)

        self.sponsorblock_action_combo = QComboBox()
        for label, value in SPONSORBLOCK_ACTIONS:
            self.sponsorblock_action_combo.addItem(label, value)
        adv_layout.addRow('SponsorBlock', self.sponsorblock_action_combo)

        self.sponsorblock_categories_input = QLineEdit()
        self.sponsorblock_categories_input.setPlaceholderText(SPONSORBLOCK_CATEGORY_HELP)
        adv_layout.addRow('SponsorBlock 类别', self.sponsorblock_categories_input)

        self.split_chapters_checkbox = QCheckBox('按章节切分为独立视频（用 yt-dlp 原生 --split-chapters，章节子目录结构: chapters/<n> - <title>/）')
        adv_layout.addRow(self.split_chapters_checkbox)

        # 跳过超长视频 (防 10+ 小时巨长视频占满硬盘)
        # 0 = 不限制, >0 = 跳过超过 N 分钟的视频
        self.max_duration_spin = QSpinBox()
        self.max_duration_spin.setRange(0, 99999)
        self.max_duration_spin.setSuffix(' 分钟 (0=不限制)')
        self.max_duration_spin.setValue(DEFAULT_DOWNLOAD_OPTIONS['max_duration_minutes'])
        self.max_duration_spin.setToolTip(
            '播放列表里超过这个时长的视频会被自动跳过, 避免下到几 GB 的超长内容。\n'
            '例如 60 = 跳过超过 1 小时的视频, 180 = 跳过超过 3 小时的。0 = 全部下。\n'
            '走 yt-dlp --match-filter, 列表里的短视频不受影响。'
        )
        adv_layout.addRow('跳过超长视频', self.max_duration_spin)

        layout.addWidget(self.advanced_group)

        # 所有控件就位后再加载配置 (高级选项需要 format_combo 等)
        self._load_config()

        # --- 操作按钮 ---
        btn_row = QHBoxLayout()
        self.start_btn = QPushButton('开始下载')
        self.pause_btn = QPushButton('暂停')
        self.stop_btn = QPushButton('停止')
        self.start_btn.clicked.connect(self._start_download)
        self.pause_btn.clicked.connect(self._toggle_pause)
        self.stop_btn.clicked.connect(self._stop_download)
        self.pause_btn.setEnabled(False)
        self.stop_btn.setEnabled(False)
        btn_row.addWidget(self.start_btn)
        btn_row.addWidget(self.pause_btn)
        btn_row.addWidget(self.stop_btn)
        btn_row.addStretch(1)
        layout.addLayout(btn_row)

        # --- 日志区 ---
        log_group = QGroupBox('下载日志')
        log_layout = QVBoxLayout(log_group)
        self.log_box = QPlainTextEdit()
        self.log_box.setReadOnly(True)
        self.log_box.setPlaceholderText('下载日志会显示在这里…')
        log_layout.addWidget(self.log_box)
        layout.addWidget(log_group, 1)

    def _choose_ffmpeg_dir(self) -> None:  # 保留以防旧 import 调用, 跳到系统设置
        self._jump_to_ffmpeg_settings()

    def _jump_to_ffmpeg_settings(self) -> None:
        # 跳到系统设置 tab, 由用户在「视频处理」sub-tab 里改
        from services.tab_bus import bus
        from tabs.settings_tab import SettingsTab
        target = SettingsTab.get_instance()
        if target is not None:
            bus.request_focus_tab.emit(target)
        else:
            QMessageBox.information(self, '提示', '请切到「系统设置」tab 改 ffmpeg 目录。')

    @staticmethod
    def _config_path() -> Path:
        return get_config_path()

    def _load_config(self) -> None:
        data = load_json_config()
        if data.get('ffmpeg_dir'):
            self.ffmpeg_input.setText(data['ffmpeg_dir'])
        else:
            bundled_ffmpeg_dir = resolve_ffmpeg_dir()
            if bundled_ffmpeg_dir:
                self.ffmpeg_input.setText(bundled_ffmpeg_dir)
        if data.get('download_dir'):
            self.dir_input.setText(data['download_dir'])
        cookies_browser = data.get('download_cookies_browser', '')
        for index in range(self.cookies_combo.count()):
            if self.cookies_combo.itemData(index) == cookies_browser:
                self.cookies_combo.setCurrentIndex(index)
                break
        js_runtime = data.get('download_js_runtime', 'auto')
        for index in range(self.js_runtime_combo.count()):
            if self.js_runtime_combo.itemData(index) == js_runtime:
                self.js_runtime_combo.setCurrentIndex(index)
                break
        self.strip_emoji_checkbox.setChecked(bool(data.get('download_strip_emoji', True)))
        self.download_asr_audio_checkbox.setChecked(bool(data.get('download_asr_audio', True)))

        # 高级选项
        video_format = data.get('download_video_format', DEFAULT_DOWNLOAD_OPTIONS['video_format'])
        # 老 config 值迁移 (h264_mp4 / best / original -> h264_720p)
        if video_format in _LEGACY_VIDEO_FORMAT_MAP:
            video_format = _LEGACY_VIDEO_FORMAT_MAP[video_format]
        for index in range(self.format_combo.count()):
            if self.format_combo.itemData(index) == video_format:
                self.format_combo.setCurrentIndex(index)
                break
        self.write_subs_checkbox.setChecked(bool(data.get('download_write_subs', DEFAULT_DOWNLOAD_OPTIONS['write_subs'])))
        self.sub_langs_input.setText(str(data.get('download_sub_langs', DEFAULT_DOWNLOAD_OPTIONS['sub_langs'])))
        sub_format = str(data.get('download_sub_format', DEFAULT_DOWNLOAD_OPTIONS['sub_format']))
        for index in range(self.sub_format_combo.count()):
            if self.sub_format_combo.itemData(index) == sub_format:
                self.sub_format_combo.setCurrentIndex(index)
                break
        self.write_thumbnail_checkbox.setChecked(bool(data.get('download_write_thumbnail', DEFAULT_DOWNLOAD_OPTIONS['write_thumbnail'])))
        self.write_info_json_checkbox.setChecked(bool(data.get('download_write_info_json', DEFAULT_DOWNLOAD_OPTIONS['write_info_json'])))
        sb_action = str(data.get('download_sponsorblock_action', DEFAULT_DOWNLOAD_OPTIONS['sponsorblock_action']))
        for index in range(self.sponsorblock_action_combo.count()):
            if self.sponsorblock_action_combo.itemData(index) == sb_action:
                self.sponsorblock_action_combo.setCurrentIndex(index)
                break
        self.sponsorblock_categories_input.setText(str(data.get('download_sponsorblock_categories', DEFAULT_DOWNLOAD_OPTIONS['sponsorblock_categories'])))
        self.split_chapters_checkbox.setChecked(bool(data.get('download_split_chapters', DEFAULT_DOWNLOAD_OPTIONS['split_chapters'])))
        self.max_duration_spin.setValue(int(data.get('download_max_duration_minutes', DEFAULT_DOWNLOAD_OPTIONS['max_duration_minutes'])))

    def _save_config(self, **updates: str) -> None:
        save_json_config(updates)

    def _collect_download_options(self) -> dict[str, Any]:
        """从 UI 读取当前高级选项。"""
        return {
            'video_format': str(self.format_combo.currentData() or DEFAULT_DOWNLOAD_OPTIONS['video_format']),
            'max_duration_minutes': int(self.max_duration_spin.value()),
            'write_subs': self.write_subs_checkbox.isChecked(),
            'sub_langs': self.sub_langs_input.text().strip() or DEFAULT_DOWNLOAD_OPTIONS['sub_langs'],
            'sub_format': str(self.sub_format_combo.currentData() or DEFAULT_DOWNLOAD_OPTIONS['sub_format']),
            'write_thumbnail': self.write_thumbnail_checkbox.isChecked(),
            'write_info_json': self.write_info_json_checkbox.isChecked(),
            'sponsorblock_action': str(self.sponsorblock_action_combo.currentData() or DEFAULT_DOWNLOAD_OPTIONS['sponsorblock_action']),
            'sponsorblock_categories': self.sponsorblock_categories_input.text().strip() or DEFAULT_DOWNLOAD_OPTIONS['sponsorblock_categories'],
            'split_chapters': self.split_chapters_checkbox.isChecked(),
        }

    @staticmethod
    def _download_options_to_config(options: dict[str, Any]) -> dict[str, str]:
        """转成 config.json 友好的字符串键值对。"""
        return {
            'download_video_format': str(options['video_format']),
            'download_max_duration_minutes': str(int(options.get('max_duration_minutes', 0))),
            'download_write_subs': str(bool(options['write_subs'])),
            'download_sub_langs': str(options['sub_langs']),
            'download_sub_format': str(options['sub_format']),
            'download_write_thumbnail': str(bool(options['write_thumbnail'])),
            'download_write_info_json': str(bool(options['write_info_json'])),
            'download_sponsorblock_action': str(options['sponsorblock_action']),
            'download_sponsorblock_categories': str(options['sponsorblock_categories']),
            'download_split_chapters': str(bool(options['split_chapters'])),
        }

    def _on_type_changed(self, idx: int) -> None:
        if 0 <= idx < len(DOWNLOAD_TYPES):
            self.url_input.setPlaceholderText(DOWNLOAD_TYPES[idx][2])

    def _choose_dir(self) -> None:
        initial = self.dir_input.text().strip() or str(Path.home())
        chosen = QFileDialog.getExistingDirectory(self, '选择下载目录', initial)
        if chosen:
            self.dir_input.setText(chosen)
            self._save_config(download_dir=chosen)

    @staticmethod
    def _looks_like_playlist_url(url: str) -> bool:
        parsed = urlparse(url)
        query = parse_qs(parsed.query)
        has_playlist_id = bool(query.get('list'))
        has_video_id = bool(query.get('v'))
        return has_playlist_id and ('playlist' in parsed.path or not has_video_id)

    def _start_download(self) -> None:
        url = self.url_input.text().strip()
        download_dir = self.dir_input.text().strip()
        if not url:
            self.log_box.appendPlainText('[提示] 请先输入 URL。')
            return
        if not download_dir:
            self.log_box.appendPlainText('[提示] 请先选择下载目录。')
            return
        Path(download_dir).mkdir(parents=True, exist_ok=True)

        idx = self.type_combo.currentIndex()
        download_type = DOWNLOAD_TYPES[idx][1]
        if download_type == 'single' and self._looks_like_playlist_url(url):
            self.type_combo.setCurrentIndex(1)
            self.log_box.appendPlainText('[提示] 当前 URL 看起来是播放列表链接，但你选的是“单个视频”。我已自动切换到“单个播放列表”，请再次点击“开始下载”。')
            return

        self.start_btn.setEnabled(False)
        self.pause_btn.setEnabled(True)
        self.stop_btn.setEnabled(True)
        self.cleanup_existing_btn.setEnabled(False)

        ffmpeg_dir = self.ffmpeg_input.text().strip()
        cookies_browser = str(self.cookies_combo.currentData() or '')
        js_runtime = str(self.js_runtime_combo.currentData() or 'auto')
        strip_emoji = self.strip_emoji_checkbox.isChecked()
        download_asr_audio = self.download_asr_audio_checkbox.isChecked()
        download_options = self._collect_download_options()
        config_updates = {
            'download_dir': download_dir,
            'download_cookies_browser': cookies_browser,
            'download_js_runtime': js_runtime,
            'download_strip_emoji': str(strip_emoji),
            'download_asr_audio': str(download_asr_audio),
        }
        config_updates.update(self._download_options_to_config(download_options))
        self._save_config(**config_updates)

        self.log_box.appendPlainText(f'--- 开始下载 [{DOWNLOAD_TYPES[idx][0]}] ---')
        if download_options.get('split_chapters'):
            self.log_box.appendPlainText('[提示] 已启用按章节切分，每个章节会下载为独立视频。')
        self.worker = DownloadWorker(
            url, download_dir, download_type, ffmpeg_dir, cookies_browser, js_runtime,
            strip_emoji, download_asr_audio, download_options,
        )
        self.worker.log_line.connect(self.log_box.appendPlainText)
        self.worker.finished_signal.connect(self._on_finished)
        self.worker.start()

    def _toggle_pause(self) -> None:
        if not self.worker:
            return
        if self.worker.is_paused:
            self.worker.resume()
            self.pause_btn.setText('暂停')
        else:
            self.worker.pause()
            self.pause_btn.setText('继续')

    def _stop_download(self) -> None:
        if self.worker:
            self.worker.stop()

    def _on_finished(self, returncode: int) -> None:
        self.start_btn.setEnabled(True)
        self.pause_btn.setEnabled(False)
        self.pause_btn.setText('暂停')
        self.stop_btn.setEnabled(False)
        if returncode == 0:
            self.log_box.appendPlainText('--- 下载完成 ---')
            if self.strip_emoji_checkbox.isChecked():
                self.log_box.appendPlainText('[提示] 文件名 Emoji 清理只会在本次下载成功完成后执行；如果目录里仍有 .part 文件，说明任务尚未完成，尚未进入重命名阶段。')
        elif self.worker and self.worker._playlist_finished and self.worker._private_video_error_count > 0:
            failed_count = self.worker._private_video_error_count
            if self.worker._playlist_item_total > 0:
                self.log_box.appendPlainText(f'--- 播放列表处理完成，但有 {failed_count}/{self.worker._playlist_item_total} 个私密视频无法下载 (code={returncode}) ---')
            else:
                self.log_box.appendPlainText(f'--- 播放列表处理完成，但有 {failed_count} 个私密视频无法下载 (code={returncode}) ---')
            if self.strip_emoji_checkbox.isChecked():
                self.log_box.appendPlainText('[提示] 这类非零返回通常是因为列表里混有无权限视频，不代表前面已经成功下载的公开视频失效。')
        else:
            self.log_box.appendPlainText(f'--- 下载结束 (code={returncode}) ---')
            if self.strip_emoji_checkbox.isChecked():
                self.log_box.appendPlainText('[提示] 本次下载未成功完成，文件名 Emoji 清理不会执行；保留当前名称可避免影响 .part 断点续传。')
        self.worker = None
        self.cleanup_existing_btn.setEnabled(True)

    def _on_cleanup_existing_clicked(self) -> None:
        """用户点"清理历史文件"按钮: 不限 mtime 扫整个下载目录.

        跑在独立 QThread 里, 避免 UI 卡死. 跟下载 worker 互斥 (不同时跑).
        """
        if self.cleanup_worker is not None and self.cleanup_worker.isRunning():
            self.log_box.appendPlainText('[提示] 清理任务正在跑, 请等完成')
            return
        if self.worker is not None and self.worker.isRunning():
            self.log_box.appendPlainText('[提示] 下载任务正在跑, 清理任务等下载完再触发')
            return
        download_dir = self.dir_input.text().strip()
        if not download_dir:
            QMessageBox.warning(self, '清理历史文件', '请先选择下载目录.')
            return
        if not Path(download_dir).exists():
            QMessageBox.warning(self, '清理历史文件', f'下载目录不存在:\n{download_dir}')
            return
        # 二次确认: 历史清理可能改一堆名字
        reply = QMessageBox.question(
            self, '清理历史文件',
            f'将扫描整个下载目录:\n{download_dir}\n\n'
            '把所有含 Emoji / 全角标点的文件/目录重命名.\n'
            '不会删除任何内容, 仅重命名.\n\n继续?',
            QMessageBox.Yes | QMessageBox.No, QMessageBox.No,
        )
        if reply != QMessageBox.Yes:
            return
        self.cleanup_existing_btn.setEnabled(False)
        self.log_box.appendPlainText(f'--- 开始清理历史文件 [{download_dir}] ---')
        self.cleanup_worker = EmojiCleanupWorker(download_dir)
        self.cleanup_worker.log_line.connect(self.log_box.appendPlainText)
        self.cleanup_worker.finished_signal.connect(self._on_cleanup_finished)
        self.cleanup_worker.start()

    def _on_cleanup_finished(self, renamed_count: int) -> None:
        self.cleanup_existing_btn.setEnabled(True)
        self.cleanup_worker = None

from __future__ import annotations

import hashlib
import json
import os
import re
import signal
import subprocess
import shutil
import time
import unicodedata
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from PySide6.QtCore import QThread, Signal, Qt
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QFileDialog,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPlainTextEdit,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from tabs.runtime_support import get_config_path, load_json_config, resolve_executable, resolve_ffmpeg_dir, save_json_config

DOWNLOAD_TYPES = [
    ('单个视频', 'single', '粘贴单个 YouTube 视频 URL，例: https://www.youtube.com/watch?v=xxx'),
    ('单个播放列表', 'playlist', '粘贴 YouTube 播放列表 URL，例: https://www.youtube.com/playlist?list=xxx'),
    ('博主全部播放列表', 'channel', '粘贴博主播放列表页 URL，例: https://www.youtube.com/@xxx/playlists'),
]

COMMON_YT_DLP_ARGS = [
    '-S', 'vcodec:h264,ext:mp4:m4a',
    '--merge-output-format', 'mp4',
    '--write-subs', '--write-auto-subs',
    '--sub-format', 'json3',
    '--sub-langs', 'en',
    '--write-thumbnail', '--convert-thumbnails', 'jpg',
    '--write-info-json',
    '--sponsorblock-remove', 'sponsor,intro,outro,interaction',
    '--newline',
]

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


class DownloadWorker(QThread):
    log_line = Signal(str)
    finished_signal = Signal(int)

    def __init__(self, url: str, download_dir: str, download_type: str, ffmpeg_dir: str = '', cookies_browser: str = '', js_runtime: str = 'auto', strip_emoji: bool = True, download_asr_audio: bool = True) -> None:
        super().__init__()
        self.url = url
        self.download_dir = download_dir
        self.download_type = download_type
        self.ffmpeg_dir = ffmpeg_dir
        self.cookies_browser = cookies_browser
        self.js_runtime = js_runtime
        self.strip_emoji = strip_emoji
        self.download_asr_audio = download_asr_audio
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
        codepoint = ord(char)
        return (
            codepoint == 0xFFFD
            or codepoint in {0x200D, 0x20E3, 0xFE0E, 0xFE0F}
            or 0x1F1E6 <= codepoint <= 0x1F1FF
            or 0x1F300 <= codepoint <= 0x1FAFF
            or 0x2600 <= codepoint <= 0x27BF
            or 'EMOJI' in unicodedata.name(char, '')
        )

    def _strip_emoji_from_name(self, name: str) -> str:
        cleaned = ''.join(char for char in name if not self._is_emoji_like(char))
        cleaned = ' '.join(cleaned.split())
        return cleaned.strip()

    def _sanitize_path_component(self, name: str) -> str:
        cleaned = self._strip_emoji_from_name(name)
        cleaned = ''.join(' ' if char in '<>:"/\\|?*%' else char for char in cleaned)
        cleaned = ' '.join(cleaned.split())
        cleaned = cleaned.strip(' .')
        return cleaned or 'untitled'

    def _describe_emoji_like_chars(self, name: str) -> str:
        parts = [f'{char}(U+{ord(char):04X})' for char in name if self._is_emoji_like(char)]
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

    @staticmethod
    def _dedupe_target_path(source: Path, cleaned_name: str) -> Path:
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

    def _cleanup_download_names(self) -> None:
        if not self.strip_emoji:
            return
        renamed_paths: list[tuple[Path, Path]] = []
        root_dir = Path(self.download_dir)
        scanned_entries = 0
        rename_candidates = 0
        for root, dir_names, file_names in os.walk(root_dir, topdown=False):
            root_path = Path(root)
            for entry_name in [*file_names, *dir_names]:
                scanned_entries += 1
                source = root_path / entry_name
                try:
                    if source.stat().st_mtime < self._started_at - 2:
                        continue
                except OSError:
                    continue
                cleaned_name = self._strip_emoji_from_name(entry_name)
                if not cleaned_name or cleaned_name == entry_name:
                    continue
                rename_candidates += 1
                self._log_sanitize_mapping('落盘名称', entry_name, cleaned_name)
                target = self._dedupe_target_path(source, cleaned_name)
                if target == source:
                    continue
                try:
                    source.rename(target)
                    renamed_paths.append((source, target))
                except OSError as exc:
                    self.log_line.emit(f'[提示] 文件名清理失败：{source.name} -> {target.name} ({exc})')
        if not renamed_paths:
            self.log_line.emit(f'[调试] 下载后重命名扫描完成：共扫描 {scanned_entries} 个文件/目录，命中 {rename_candidates} 个候选，实际重命名 0 个')
            self.log_line.emit('[提示] 文件名 Emoji 清理完成：本次下载未发现需要重命名的文件')
            return
        self.log_line.emit(f'[调试] 下载后重命名扫描完成：共扫描 {scanned_entries} 个文件/目录，命中 {rename_candidates} 个候选，实际重命名 {len(renamed_paths)} 个')
        for source, target in renamed_paths[:12]:
            try:
                source_display = source.relative_to(root_dir)
            except ValueError:
                source_display = source
            try:
                target_display = target.relative_to(root_dir)
            except ValueError:
                target_display = target
            self.log_line.emit(f'[重命名] {source_display} -> {target_display}')
        if len(renamed_paths) > 12:
            self.log_line.emit(f'[提示] 另有 {len(renamed_paths) - 12} 个文件/目录名已清理 Emoji')

    def _cleanup_info_json_metadata(self) -> None:
        if not self.strip_emoji:
            return
        root_dir = Path(self.download_dir)
        scanned_files = 0
        updated_files = 0
        candidate_fields = ('title', 'fulltitle', 'playlist', 'playlist_title', 'uploader', 'channel')
        for info_path in sorted(root_dir.rglob('*.info.json')):
            try:
                if info_path.stat().st_mtime < self._started_at - 2:
                    continue
            except OSError:
                continue
            scanned_files += 1
            try:
                payload = json.loads(info_path.read_text('utf-8'))
            except Exception as exc:
                self.log_line.emit(f'[提示] 读取 info.json 失败：{info_path.name} ({exc})')
                continue
            if not isinstance(payload, dict):
                continue
            changed_fields: list[str] = []
            for field in candidate_fields:
                raw_value = payload.get(field)
                if not isinstance(raw_value, str) or not raw_value.strip():
                    continue
                cleaned_value = self._strip_emoji_from_name(raw_value)
                if not cleaned_value or cleaned_value == raw_value:
                    continue
                self._log_sanitize_mapping(f'info.{field}', raw_value, cleaned_value)
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
                self.log_line.emit(f'[重写] {display_path} 已清理字段: {", ".join(changed_fields)}')
            except OSError as exc:
                self.log_line.emit(f'[提示] 写回 info.json 失败：{info_path.name} ({exc})')
        self.log_line.emit(f'[调试] info.json 内容清理完成：扫描 {scanned_files} 个文件，实际更新 {updated_files} 个')

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
        raw_uploader = str(metadata.get('uploader') or metadata.get('channel') or '下载内容')
        uploader_name = self._sanitize_path_component(raw_uploader)
        self._log_sanitize_mapping('uploader', raw_uploader, uploader_name)
        output_template = ''
        if self.download_type == 'single':
            raw_video_title = str(metadata.get('title') or 'video')
            video_title = self._sanitize_path_component(raw_video_title)
            self._log_sanitize_mapping('single.title', raw_video_title, video_title)
            output_template = f'{uploader_name}/{video_title}.%(ext)s'
        elif self.download_type == 'playlist':
            raw_playlist_title = str(metadata.get('title') or metadata.get('playlist_title') or 'playlist')
            playlist_title = self._sanitize_path_component(raw_playlist_title)
            self._log_sanitize_mapping('playlist.title', raw_playlist_title, playlist_title)
            output_template = f'{uploader_name}/{playlist_title}/%(playlist_index)02d - %(title)s.%(ext)s'
        elif self.download_type == 'channel':
            output_template = f'{uploader_name}/%(playlist)s/%(playlist_index)02d - %(title)s.%(ext)s'
        if not output_template:
            return extra
        resolved = list(extra)
        output_index = resolved.index('-o') + 1
        resolved[output_index] = output_template
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

    def run(self) -> None:
        yt_dlp = resolve_executable('yt-dlp')
        if not yt_dlp:
            self.log_line.emit('[错误] 未找到 yt-dlp，可将 yt-dlp.exe 放到程序目录或 vendor 目录中')
            self.finished_signal.emit(1)
            return

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
        cmd = [yt_dlp] + extra + ffmpeg_args + cookies_args + js_runtime_args + remote_component_args + asr_exec_args + list(COMMON_YT_DLP_ARGS) + [self.url]
        self.log_line.emit(f'[执行] {" ".join(cmd)}')
        self.log_line.emit(f'[目录] {self.download_dir}')

        try:
            self.process = subprocess.Popen(
                cmd,
                cwd=self.download_dir,
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
        self._emit_diagnostics(returncode)
        self.finished_signal.emit(returncode)

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

        # ffmpeg 路径
        ffmpeg_row = QHBoxLayout()
        ffmpeg_row.addWidget(QLabel('ffmpeg 目录'))
        self.ffmpeg_input = QLineEdit()
        self.ffmpeg_input.setPlaceholderText('可选：选择 ffmpeg 所在目录（含 ffmpeg.exe）')
        ffmpeg_row.addWidget(self.ffmpeg_input)
        self.ffmpeg_browse_btn = QPushButton('选择目录')
        self.ffmpeg_browse_btn.clicked.connect(self._choose_ffmpeg_dir)
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

        self.strip_emoji_checkbox = QCheckBox('清理文件名中的 Emoji（推荐）')
        self.strip_emoji_checkbox.setChecked(True)
        params_layout.addWidget(self.strip_emoji_checkbox)
        self.download_asr_audio_checkbox = QCheckBox('同时下载 ASR 音频 WAV（16kHz 单声道，推荐）')
        self.download_asr_audio_checkbox.setChecked(True)
        params_layout.addWidget(self.download_asr_audio_checkbox)

        self._load_config()

        layout.addWidget(params)

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

    def _choose_ffmpeg_dir(self) -> None:
        initial = self.ffmpeg_input.text().strip() or str(Path.home())
        chosen = QFileDialog.getExistingDirectory(self, '选择 ffmpeg 所在目录', initial)
        if chosen:
            self.ffmpeg_input.setText(chosen)
            self._save_config(ffmpeg_dir=chosen)
            self.log_box.appendPlainText(f'ffmpeg 目录已设置：{chosen}')

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

    def _save_config(self, **updates: str) -> None:
        save_json_config(updates)

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

        ffmpeg_dir = self.ffmpeg_input.text().strip()
        cookies_browser = str(self.cookies_combo.currentData() or '')
        js_runtime = str(self.js_runtime_combo.currentData() or 'auto')
        strip_emoji = self.strip_emoji_checkbox.isChecked()
        download_asr_audio = self.download_asr_audio_checkbox.isChecked()
        self._save_config(
            download_dir=download_dir,
            download_cookies_browser=cookies_browser,
            download_js_runtime=js_runtime,
            download_strip_emoji=strip_emoji,
            download_asr_audio=download_asr_audio,
        )

        self.log_box.appendPlainText(f'--- 开始下载 [{DOWNLOAD_TYPES[idx][0]}] ---')
        self.worker = DownloadWorker(url, download_dir, download_type, ffmpeg_dir, cookies_browser, js_runtime, strip_emoji, download_asr_audio)
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

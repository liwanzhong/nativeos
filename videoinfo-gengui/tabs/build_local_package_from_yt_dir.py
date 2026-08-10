from __future__ import annotations

import json
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from tabs.build_oss_manifest_from_yt_dir import build_item, find_sets

PACKAGE_EXTENSION = '.deckpack'
ProgressCallback = Callable[[str], None]


def build_local_package_manifest(record: dict[str, Any]) -> dict[str, Any]:
    base_item = build_item(record)
    info = record['info']
    manifest: dict[str, Any] = {
        'schemaVersion': 1,
        'id': base_item['id'],
        'title': base_item['title'],
        'level': base_item['level'],
        'category': base_item['category'],
        'type': base_item['type'],
        'sourceLabel': base_item['sourceLabel'],
        'hasRoleplay': bool(base_item.get('hasRoleplay')),
        'videoFile': record['video_path'].name,
        'subtitleJson3File': record['subtitle_path'].name,
        'infoFile': record['info_path'].name,
        'createdAt': datetime.now(timezone.utc).isoformat(),
        'tool': 'videoinfo-gengui',
    }

    if record.get('en_segmented_path'):
        manifest['subtitleEnSegmentedFile'] = record['en_segmented_path'].name
    if record.get('zh_path'):
        manifest['subtitleZhFile'] = record['zh_path'].name
    if record.get('ai_path'):
        manifest['aiPracticeFile'] = record['ai_path'].name
    if record.get('cover_path'):
        manifest['coverFile'] = record['cover_path'].name
    if info.get('duration') is not None:
        manifest['durationSeconds'] = info.get('duration')
    if info.get('thumbnail'):
        manifest['thumbnail'] = info.get('thumbnail')
    if info.get('uploader'):
        manifest['uploader'] = info.get('uploader')
    if info.get('description'):
        manifest['description'] = info.get('description')
    return manifest


def collect_package_files(record: dict[str, Any]) -> list[Path]:
    files = [
        record['video_path'],
        record['subtitle_path'],
        record['info_path'],
    ]
    for key in ('en_segmented_path', 'zh_path', 'ai_path', 'cover_path'):
        path = record.get(key)
        if path:
            files.append(path)
    return files


def export_record(record: dict[str, Any], output_dir: Path, overwrite: bool = True) -> Path:
    manifest = build_local_package_manifest(record)
    package_name = f"{manifest['id']}{PACKAGE_EXTENSION}"
    output_path = output_dir / package_name
    output_dir.mkdir(parents=True, exist_ok=True)

    if output_path.exists():
        if not overwrite:
            raise FileExistsError(f'目标包已存在: {output_path.name}')
        output_path.unlink()

    with zipfile.ZipFile(output_path, 'w', compression=zipfile.ZIP_STORED) as archive:
        archive.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
        for source_path in collect_package_files(record):
            archive.write(source_path, arcname=source_path.name)
    return output_path


def export_packages(
    target_dir: Path,
    output_dir: Path,
    overwrite: bool = True,
    on_progress: ProgressCallback | None = None,
) -> list[Path]:
    records = find_sets(target_dir)
    created: list[Path] = []
    total = len(records)

    if total == 0:
        if on_progress:
            on_progress('[提示] 没有找到可导出的完整 Deckpack 视频集（至少需要 video + json3 + info.json）')
        return created

    for index, record in enumerate(records, start=1):
        title = str(record.get('title') or record.get('stem') or 'video')
        if on_progress:
            on_progress(f'  [{index}/{total}] 打包: {title[:60]}')
        try:
            output_path = export_record(record, output_dir, overwrite=overwrite)
            created.append(output_path)
            if on_progress:
                extras: list[str] = []
                if record.get('zh_path'):
                    extras.append('中文字幕')
                if record.get('ai_path'):
                    extras.append('AI')
                extra_label = f" · {' + '.join(extras)}" if extras else ''
                on_progress(f'  OK {output_path.name}{extra_label}')
        except Exception as exc:
            if on_progress:
                on_progress(f'  [失败] {title}: {exc}')
    return created


def main() -> int:
    if len(sys.argv) < 3:
        print('Usage: python build_local_package_from_yt_dir.py <target_dir> <deckpack_output_dir>')
        return 1
    target_dir = Path(sys.argv[1])
    output_dir = Path(sys.argv[2])
    if not target_dir.exists() or not target_dir.is_dir():
        print(f'Invalid directory: {target_dir}')
        return 1
    created = export_packages(target_dir, output_dir, on_progress=print)
    print(f'Exported {len(created)} Deckpack package(s).')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

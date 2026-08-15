from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

from tabs.generate_ai_practice_from_yt_dir import extract_utterances, first_meaningful_sentence, infer_level, infer_theme, load_json


DEFAULT_SOURCE_LABEL = "Official Collection"


def normalize_space(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def slugify(text: str) -> str:
    text = text.lower()
    text = text.replace("&", " and ")
    text = text.replace("|", " ").replace("｜", " ")
    text = text.replace("：", " ").replace(":", " ")
    text = re.sub(r"[^a-z0-9\s-]", " ", text)
    text = re.sub(r"\s+", "-", text)
    text = re.sub(r"-+", "-", text).strip("-")
    return text or "video"


def category_from_theme(theme: str) -> str:
    return {
        "hotel": "酒店",
        "airport": "机场",
        "haircut": "理发",
        "shopping": "购物",
        "small_talk": "社交",
        "slang": "口语",
        "learning_advice": "学习",
        "holiday": "节日",
        "home_life": "日常",
        "travel_city": "旅行",
        "qa_reflection": "访谈",
        "lifestyle": "生活",
    }.get(theme, "生活")


def type_from_theme(theme: str) -> str:
    return {
        "hotel": "dialogue",
        "airport": "dialogue",
        "haircut": "dialogue",
        "shopping": "dialogue",
        "small_talk": "dialogue",
        "slang": "lecture",
        "learning_advice": "lecture",
        "holiday": "vlog",
        "home_life": "vlog",
        "travel_city": "vlog",
        "qa_reflection": "interview",
        "lifestyle": "vlog",
    }.get(theme, "vlog")


def matches_keyword(text: str, keyword: str) -> bool:
    pattern = re.compile(rf"(?<![a-z0-9]){re.escape(keyword.lower())}(?![a-z0-9])")
    return bool(pattern.search(text.lower()))


def infer_manifest_theme(title: str, transcript: list[str], fallback_theme: str) -> str:
    text = f"{title} {' '.join(transcript[:8])}".lower()
    title_text = title.lower()
    keyword_checks = [
      ("hotel", ["hotel"]),
      ("airport", ["airport"]),
      ("haircut", ["haircut", "barbershop", "barber"]),
      ("small_talk", ["small talk"]),
      ("shopping", ["supermarket", "mall", "shopping", "clothes"]),
      ("slang", ["slang"]),
      ("qa_reflection", ["q&a", "100k subscribers"]),
      ("holiday", ["christmas", "birthday"]),
      ("learning_advice", ["good habits", "bad habits", "be good at english", "become fluent", "don't go to school", "learning english like this"]),
      ("travel_city", ["explore singapore", "busan", "seoul", "trip to london", "city at night", "mountain", "beach", "countryside", "travel", "hanok village", "gyeonbokgung"]),
      ("home_life", ["moving house", "clean my house", "daily routine", "start my day", "buy a plant", "cook pasta", "café hopping", "daily life"]),
    ]
    for theme, keywords in keyword_checks:
        if any(matches_keyword(title_text, keyword) for keyword in keywords):
            return theme
    for theme, keywords in keyword_checks:
        if any(matches_keyword(text, keyword) for keyword in keywords):
            return theme
    return fallback_theme


def source_label(info: dict[str, Any]) -> str:
    uploader = normalize_space(str(info.get("uploader") or info.get("channel") or "English by Jay"))
    return uploader or "English by Jay"


def normalize_match_key(text: str) -> str:
    return slugify(normalize_space(text)).replace("-", "")


def read_info_records(target_dir: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    # 用 rglob 递归扫, 兼容 chapter-split 后 info.json 在 target_dir/chapters/<n> - <title>/ 下的情况
    seen_paths: set[Path] = set()
    for info_path in sorted(target_dir.rglob("*.info.json")):
        # 跳过 yt-dlp 的下载归档目录 (.yt-dlp-archives)
        # parts 里会带点 ('.yt-dlp-archives') 也有可能不带, 都兼容
        if any(part.lstrip('.').startswith('yt-dlp-archives') for part in info_path.parts):
            continue
        if info_path in seen_paths:
            continue
        seen_paths.add(info_path)
        if info_path.name == "00 - Learn English with VLOG (Comprehensible Input).info.json":
            continue
        info = load_json(info_path)
        title = normalize_space(str(info.get("title") or info_path.name[:-10]))
        # yt-dlp 在 --split-chapters 时会给每个章节 info.json 写入 section_number
        raw_section = info.get("section_number")
        section_number: int | None = None
        if raw_section is not None:
            try:
                section_number = int(raw_section)
            except (TypeError, ValueError):
                section_number = None
        records.append(
            {
                "stem": info_path.name[:-10],
                "info_path": info_path,
                "info": info,
                "title": title,
                "title_key": normalize_match_key(title),
                "section_number": section_number,
            }
        )
    return records


def build_path_maps(target_dir: Path, patterns: tuple[str, ...], suffixes: tuple[str, ...]) -> tuple[dict[str, Path], dict[str, Path]]:
    by_stem: dict[str, Path] = {}
    by_title_key: dict[str, Path] = {}
    for pattern in patterns:
        for path in sorted(target_dir.glob(pattern)):
            by_stem[path.stem] = path
            title_key = normalize_match_key(path.stem)
            by_title_key.setdefault(title_key, path)
            for suffix in suffixes:
                if path.name.endswith(suffix):
                    stem = path.name[: -len(suffix)]
                    by_stem[stem] = path
                    by_title_key.setdefault(normalize_match_key(stem), path)
                    break
    return by_stem, by_title_key


def pick_series_cover_file(target_dir: Path) -> str:
    image_paths: list[Path] = []
    for pattern in ("*.jpg", "*.jpeg", "*.png", "*.webp"):
        image_paths.extend(sorted(target_dir.glob(pattern)))
    if not image_paths:
        return ""

    def sort_key(path: Path) -> tuple[int, int, str]:
        match = re.match(r"^(\d+)", path.stem)
        if match:
            return (0, int(match.group(1)), path.name.lower())
        return (1, 10**9, path.name.lower())

    return sorted(image_paths, key=sort_key)[0].name


def build_ai_maps(target_dir: Path) -> tuple[dict[str, Path], dict[str, Path]]:
    by_stem: dict[str, Path] = {}
    by_title_key: dict[str, Path] = {}
    for path in sorted(target_dir.glob("*.ai-practice.json")):
        stem = path.name[:-17]
        by_stem[stem] = path
        by_title_key.setdefault(normalize_match_key(stem), path)
        try:
            payload = load_json(path)
        except Exception:
            continue
        title = normalize_space(str(payload.get("videoTitle") or payload.get("sourceVideo") or ""))
        if title:
            by_title_key[normalize_match_key(title)] = path
    return by_stem, by_title_key


def pick_matching_path(stem: str, title_key: str, by_stem: dict[str, Path], by_title_key: dict[str, Path]) -> Path | None:
    return by_stem.get(stem) or by_title_key.get(title_key)


def build_zh_maps(target_dir: Path) -> tuple[dict[str, Path], dict[str, Path]]:
    by_stem: dict[str, Path] = {}
    by_title_key: dict[str, Path] = {}
    for path in sorted(target_dir.glob("*.zh.json")):
        stem = path.name[:-8]  # strip ".zh.json"
        by_stem[stem] = path
        by_title_key.setdefault(normalize_match_key(stem), path)
    return by_stem, by_title_key


def build_en_segmented_maps(target_dir: Path) -> tuple[dict[str, Path], dict[str, Path]]:
    by_stem: dict[str, Path] = {}
    by_title_key: dict[str, Path] = {}
    for path in sorted(target_dir.glob("*.en.segmented.json")):
        stem = path.name[:-18]  # strip ".en.segmented.json"
        by_stem[stem] = path
        by_title_key.setdefault(normalize_match_key(stem), path)
    return by_stem, by_title_key


def find_sets(target_dir: Path) -> list[dict[str, Any]]:
    """找出 target_dir 下所有可打包的视频集。

    **以 ``*.mp4`` 为锚点** (而不是 info.json), 兼容 chapter-split 后
    章节子目录里有独立 mp4 + sub + cover 但没 info.json 的情况。

    对每个 mp4, 在它自己的父目录里找 companion files (info/sub/cover/ai/zh),
    info.json 是可选的, 找不到时用 stem 当 title, 仍可打包。

    同时保留 read_info_records 找到的 record (兼容历史用法, 比如旧章节
    info.json 还在的情况), 用 (local_dir, stem) 去重避免重复。
    """
    SKIP_DIR_NAMES = {"packages", "__pycache__"}

    def _is_skipped_path(p: Path) -> bool:
        try:
            rel = p.relative_to(target_dir)
        except ValueError:
            return True
        for part in rel.parts:
            if part in SKIP_DIR_NAMES:
                return True
            if part.lstrip(".").startswith("yt-dlp-archives"):
                return True
        return False

    # Step 1: 收集所有 info.json 记录 (兼容老逻辑)
    info_records = read_info_records(target_dir)
    info_by_anchor: dict[tuple[Path, str], dict[str, Any]] = {}
    for record in info_records:
        anchor = (record["info_path"].parent, record["stem"])
        info_by_anchor[anchor] = record

    # Step 2: 用 mp4 当锚点扫所有视频
    VIDEO_EXTS = ("mp4", "webm", "mkv")
    anchors: list[tuple[Path, str]] = []
    seen: set[tuple[Path, str]] = set()
    for ext in VIDEO_EXTS:
        for vid_path in sorted(target_dir.rglob(f"*.{ext}")):
            if vid_path.name.endswith(".part"):
                continue
            if _is_skipped_path(vid_path):
                continue
            anchor = (vid_path.parent, vid_path.stem)
            if anchor in seen:
                continue
            seen.add(anchor)
            anchors.append(anchor)

    records: list[dict[str, Any]] = []
    seen_dedupe: set[str] = set()
    for local_dir, stem in anchors:
        # 找 companion files
        subtitle_by_stem, subtitle_by_title = build_path_maps(local_dir, ("*.json3",), (".en.json3", ".json3"))
        video_by_stem, video_by_title = build_path_maps(local_dir, ("*.mp4", "*.webm", "*.mkv"), (".mp4", ".webm", ".mkv"))
        cover_by_stem, cover_by_title = build_path_maps(local_dir, ("*.jpg", "*.jpeg", "*.png", "*.webp"), (".jpg", ".jpeg", ".png", ".webp"))
        ai_by_stem, ai_by_title = build_ai_maps(local_dir)
        zh_by_stem, zh_by_title = build_zh_maps(local_dir)
        en_segmented_by_stem, en_segmented_by_title = build_en_segmented_maps(local_dir)

        info_match = info_by_anchor.get((local_dir, stem))
        if info_match:
            title_key = info_match["title_key"]
            info_path = info_match["info_path"]
            info_dict = info_match["info"]
            title = info_match["title"]
            section_number = info_match.get("section_number")
        else:
            # chapter 视频没 info.json, 用 stem 当 title
            title_key = normalize_match_key(stem)
            info_path = local_dir / f"{stem}.info.json"
            info_dict = {}
            title = normalize_space(stem)
            section_number = None

        subtitle_path = pick_matching_path(stem, title_key, subtitle_by_stem, subtitle_by_title)
        video_path = pick_matching_path(stem, title_key, video_by_stem, video_by_title)
        ai_path = pick_matching_path(stem, title_key, ai_by_stem, ai_by_title)
        cover_path = pick_matching_path(stem, title_key, cover_by_stem, cover_by_title)
        zh_path = pick_matching_path(stem, title_key, zh_by_stem, zh_by_title)
        en_segmented_path = pick_matching_path(stem, title_key, en_segmented_by_stem, en_segmented_by_title)
        if not subtitle_path or not video_path:
            continue
        # 用 (local_dir, stem) 去重, 防止父子目录里出现同名 stem 时重复
        dedupe_key = f'{local_dir}::{stem}'
        if dedupe_key in seen_dedupe:
            continue
        seen_dedupe.add(dedupe_key)
        records.append(
            {
                "stem": stem,
                "info_path": info_path,
                "info": info_dict,
                "title": title,
                "section_number": section_number,
                "subtitle_path": subtitle_path,
                "video_path": video_path,
                "ai_path": ai_path,
                "cover_path": cover_path,
                "zh_path": zh_path,
                "en_segmented_path": en_segmented_path,
            }
        )
    return records


def build_item(record: dict[str, Any]) -> dict[str, Any]:
    stem = str(record["stem"])
    video_path = record["video_path"]
    subtitle_path = record["subtitle_path"]
    info_path = record["info_path"]
    ai_path = record["ai_path"]
    cover_path = record["cover_path"]
    zh_path = record.get("zh_path")
    en_segmented_path = record.get("en_segmented_path")
    info = record["info"]
    section_number = record.get("section_number")
    transcript = extract_utterances(subtitle_path)
    title = str(record["title"])
    description = first_meaningful_sentence(str(info.get("description") or ""))
    local_level = infer_level(title, description, transcript)
    local_theme = infer_manifest_theme(title, transcript, infer_theme(title, description, transcript))
    ai_analysis: dict[str, Any] = {}
    if ai_path:
        try:
            ai_payload = load_json(ai_path)
        except Exception:
            ai_payload = {}
        raw_analysis = ai_payload.get("videoAnalysis") if isinstance(ai_payload, dict) else {}
        if isinstance(raw_analysis, dict):
            ai_analysis = raw_analysis
    ai_level = str(ai_analysis.get("level") or "").strip().upper()
    level = ai_level if ai_level in {"A1", "A2", "B1", "B2", "C1", "C2"} else local_level
    theme = str(ai_analysis.get("theme") or "").strip() or local_theme
    category = str(ai_analysis.get("category") or "").strip() or category_from_theme(theme)
    video_type = str(ai_analysis.get("type") or "").strip() or type_from_theme(theme)
    numeric_prefix = re.match(r"^(\d+)", stem)
    if section_number is not None:
        prefix = f"{section_number:02d}"
    elif numeric_prefix:
        prefix = numeric_prefix.group(1)
    else:
        prefix = "video"
    item: dict[str, Any] = {
        "id": f"sprout-{prefix}-{slugify(title)[:60]}",
        "title": title,
        "level": level,
        "category": category,
        "type": video_type,
        "sourceLabel": source_label(info),
        "videoFile": video_path.name,
        "subtitleJson3File": subtitle_path.name,
        "infoFile": info_path.name,
        "aiPracticeFile": ai_path.name if ai_path else "",
        "subtitleZhFile": zh_path.name if zh_path else "",
        "subtitleEnSegmentedFile": en_segmented_path.name if en_segmented_path else "",
        "coverFile": cover_path.name if cover_path else "",
        "hasRoleplay": True,
    }
    if section_number is not None:
        item["sectionNumber"] = section_number
    return item


def build_series_episode(record: dict[str, Any], index: int) -> dict[str, Any]:
    item = build_item(record)
    assets = {
        "video": item["videoFile"],
        "subtitleJson3": item["subtitleJson3File"],
        "info": item["infoFile"],
    }
    if item.get("subtitleEnSegmentedFile"):
        assets["subtitleEnSegmented"] = item["subtitleEnSegmentedFile"]
    if item.get("subtitleZhFile"):
        assets["subtitleZh"] = item["subtitleZhFile"]
    if item.get("aiPracticeFile"):
        assets["aiPractice"] = item["aiPracticeFile"]
    episode: dict[str, Any] = {
        "id": item["id"],
        "episodeIndex": index,
        "episodeTitle": item["title"],
        "title": item["title"],
        "level": item["level"],
        "category": item["category"],
        "type": item["type"],
        "sourceLabel": item.get("sourceLabel") or DEFAULT_SOURCE_LABEL,
        "hasRoleplay": bool(item.get("hasRoleplay")),
        "assets": assets,
    }
    if item.get("coverFile"):
        episode["coverUrl"] = item["coverFile"]
    return episode


def _normalize_series_tags(tags: Any) -> list[str]:
    if isinstance(tags, str):
        return [part.strip() for part in tags.split(",") if part.strip()]
    if isinstance(tags, list):
        return [str(part).strip() for part in tags if str(part).strip()]
    return []


def build_series_manifest(target_dir: Path, series_meta: dict[str, Any]) -> dict[str, Any]:
    records = find_sets(target_dir)
    episodes = [build_series_episode(record, index) for index, record in enumerate(records, start=1)]
    series_id = str(series_meta.get("id") or target_dir.name).strip() or target_dir.name
    series_title = str(series_meta.get("title") or target_dir.name).strip() or target_dir.name
    series_level = str(series_meta.get("level") or (episodes[0].get("level") if episodes else "B1")).strip() or "B1"
    series_category = str(series_meta.get("category") or (episodes[0].get("category") if episodes else "综合")).strip() or "综合"
    series_type = str(series_meta.get("type") or (episodes[0].get("type") if episodes else "vlog")).strip() or "vlog"
    series_source_label = str(series_meta.get("sourceLabel") or (episodes[0].get("sourceLabel") if episodes else DEFAULT_SOURCE_LABEL)).strip() or DEFAULT_SOURCE_LABEL
    manifest: dict[str, Any] = {
        "version": 1,
        "series": {
            "id": series_id,
            "title": series_title,
            "level": series_level,
            "category": series_category,
            "type": series_type,
            "description": str(series_meta.get("description") or "").strip(),
            "tags": _normalize_series_tags(series_meta.get("tags")),
            "sortOrder": int(series_meta.get("sortOrder") or 0),
            "sourceLabel": series_source_label,
        },
        "episodes": episodes,
    }
    cover_file = str(series_meta.get("coverFile") or "").strip()
    if cover_file:
        manifest["series"]["coverUrl"] = cover_file
    elif preferred_cover_file := pick_series_cover_file(target_dir):
        manifest["series"]["coverUrl"] = preferred_cover_file
    elif episodes and episodes[0].get("coverUrl"):
        manifest["series"]["coverUrl"] = episodes[0]["coverUrl"]
    resource_base_url = str(series_meta.get("resourceBaseUrl") or "").strip()
    if resource_base_url:
        manifest["resourceBaseUrl"] = resource_base_url.rstrip("/")
    return manifest


def build_catalog_entry(series_manifest: dict[str, Any], manifest_url: str) -> dict[str, Any]:
    series = series_manifest.get("series") or {}
    episodes = series_manifest.get("episodes") or []
    return {
        "id": series.get("id"),
        "title": series.get("title"),
        "level": series.get("level"),
        "category": series.get("category"),
        "type": series.get("type"),
        "description": series.get("description") or "",
        "coverUrl": series.get("coverUrl") or "",
        "tags": series.get("tags") or [],
        "sortOrder": series.get("sortOrder") or 0,
        "episodeCount": len(episodes),
        "sourceLabel": series.get("sourceLabel") or DEFAULT_SOURCE_LABEL,
        "manifestUrl": manifest_url,
    }


def build_catalog_manifest(
    series_entries: list[dict[str, Any]],
    standalone_manifest_url: str = "",
    resource_base_url: str = "",
) -> dict[str, Any]:
    manifest: dict[str, Any] = {
        "version": 1,
        "series": sorted(
            series_entries,
            key=lambda item: (int(item.get("sortOrder") or 0), str(item.get("title") or "").lower()),
        ),
    }
    if standalone_manifest_url.strip():
        manifest["standaloneManifestUrl"] = standalone_manifest_url.strip()
    if resource_base_url.strip():
        manifest["resourceBaseUrl"] = resource_base_url.strip().rstrip("/")
    return manifest


def upsert_series_entry(catalog: dict[str, Any], entry: dict[str, Any]) -> dict[str, Any]:
    series_entries = catalog.get("series")
    if not isinstance(series_entries, list):
        series_entries = []
    entry_id = str(entry.get("id") or "").strip()
    updated: list[dict[str, Any]] = []
    replaced = False
    for current in series_entries:
        current_id = str((current or {}).get("id") or "").strip()
        if entry_id and current_id == entry_id:
            updated.append(entry)
            replaced = True
        else:
            updated.append(current)
    if not replaced:
        updated.append(entry)
    catalog["series"] = sorted(
        updated,
        key=lambda item: (int(item.get("sortOrder") or 0), str(item.get("title") or "").lower()),
    )
    catalog["version"] = int(catalog.get("version") or 1)
    return catalog


def build_manifest(target_dir: Path, series_meta: dict[str, Any] | None = None) -> dict[str, Any]:
    return build_series_manifest(target_dir, series_meta or {})


def main() -> int:
    if len(sys.argv) < 3:
        print("Usage: python build_oss_manifest_from_yt_dir.py <target_dir> <output_json>")
        return 1
    target_dir = Path(sys.argv[1])
    output_json = Path(sys.argv[2])
    if not target_dir.exists() or not target_dir.is_dir():
        print(f"Invalid directory: {target_dir}")
        return 1
    manifest = build_series_manifest(target_dir, {})
    output_json.parent.mkdir(parents=True, exist_ok=True)
    with output_json.open("w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"Wrote series manifest with {len(manifest['episodes'])} episodes to {output_json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

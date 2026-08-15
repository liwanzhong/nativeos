from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any

APP_VENDOR_DIRNAME = 'vendor'
APP_CONFIG_DIR_PARTS = ('DeckMind', 'videoinfo-gengui')


def get_app_root() -> Path:
    meipass = getattr(sys, '_MEIPASS', '')
    if meipass:
        return Path(meipass).resolve()
    if getattr(sys, 'frozen', False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[1]


def get_vendor_dir() -> Path:
    return get_app_root() / APP_VENDOR_DIRNAME


def _get_user_config_dir() -> Path:
    if os.name == 'nt':
        base = Path(os.environ.get('APPDATA') or (Path.home() / 'AppData' / 'Roaming'))
    else:
        base = Path(os.environ.get('XDG_CONFIG_HOME') or (Path.home() / '.config'))
    return base.joinpath(*APP_CONFIG_DIR_PARTS)


def get_config_path() -> Path:
    config_dir = _get_user_config_dir()
    config_dir.mkdir(parents=True, exist_ok=True)
    return config_dir / 'config.json'


def load_json_config() -> dict[str, Any]:
    config_path = get_config_path()
    if config_path.exists():
        try:
            return json.loads(config_path.read_text('utf-8'))
        except Exception:
            return {}
    return {}


def save_json_config(updates: dict[str, Any]) -> Path:
    config_path = get_config_path()
    data = load_json_config()
    data.update(updates)
    config_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), 'utf-8')
    return config_path


def resolve_executable(name: str) -> str | None:
    executable_name = f'{name}.exe' if os.name == 'nt' and not name.lower().endswith('.exe') else name
    candidates = [
        get_vendor_dir() / executable_name,
        get_app_root() / executable_name,
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return shutil.which(name)


def resolve_ffmpeg_dir(preferred_dir: str = '') -> str:
    if preferred_dir:
        preferred_path = Path(preferred_dir)
        if (preferred_path / 'ffmpeg.exe').exists() or (preferred_path / 'ffprobe.exe').exists():
            return str(preferred_path)
    vendor_dir = get_vendor_dir()
    if (vendor_dir / 'ffmpeg.exe').exists() or (vendor_dir / 'ffprobe.exe').exists():
        return str(vendor_dir)
    return preferred_dir


def load_oss_config() -> dict[str, str]:
    """读 config.json 里的 oss 段。"""
    data = load_json_config()
    return data.get('oss', {}) or {}


def save_oss_config(cfg: dict[str, str]) -> None:
    """把 oss 段写回 config.json。"""
    save_json_config({'oss': cfg})

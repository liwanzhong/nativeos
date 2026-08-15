"""
Environment configuration loaded from a local `.env` file at project root,
with a fallback to the rn-app's `.env.local` (single source of truth for
Supabase URL + service_role key, since the rn-app already manages them).

Lookup order (first match wins):
  1. `videoinfo-gengui/.env` — local override, takes precedence
  2. `<parent>/rn-app/.env.local` — shared with the mobile app
  3. process env vars (e.g. set in a shell for one-off testing)

Recognized keys (case-insensitive when reading .env):
  - SUPABASE_URL  (preferred) or EXPO_PUBLIC_SUPABASE_URL (rn-app)
  - SUPABASE_SERVICE_KEY  (preferred) or SUPABASE_SERVICE_ROLE_KEY (rn-app)

This module is read-only — it does NOT write back to any .env file.
Use your text editor to change values, then click "重新加载" in the
Settings tab.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import NamedTuple

from dotenv import load_dotenv

_PROJECT_ROOT = Path(__file__).resolve().parents[1]
_LOCAL_DOTENV = _PROJECT_ROOT / '.env'

# The rn-app holds the canonical Supabase credentials; fall back to its
# .env.local when the local .env is missing or incomplete. Two key aliases
# are accepted because rn-app uses the EXPO_PUBLIC_ / SERVICE_ROLE_ form
# (legacy / convention from when it was first wired up).
_RN_APP_DOTENV = _PROJECT_ROOT.parent / 'rn-app' / '.env.local'

# Load both. The first one (local) wins because we pass it to load_dotenv
# first, then explicitly override=False for the rn-app file so existing
# values aren't clobbered.
if _LOCAL_DOTENV.exists():
    load_dotenv(_LOCAL_DOTENV, override=True)
if _RN_APP_DOTENV.exists():
    load_dotenv(_RN_APP_DOTENV, override=False)


class SupabaseConfig(NamedTuple):
    url: str | None
    service_key: str | None
    source: str  # which file the values came from (for the UI)

    @property
    def is_configured(self) -> bool:
        return bool(self.url) and bool(self.service_key)

    @property
    def has_partial(self) -> bool:
        return (bool(self.url) ^ bool(self.service_key)) and not self.is_configured


def _read_first(*names: str) -> str | None:
    for name in names:
        value = os.environ.get(name)
        if value and value.strip():
            return value.strip()
    return None


def get_supabase_config() -> SupabaseConfig:
    url = _read_first('SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_URL')
    key = _read_first(
        'SUPABASE_SERVICE_KEY',
        'SUPABASE_SERVICE_ROLE_KEY',
    )
    if not url and not key:
        source = '（未配置）'
    elif _LOCAL_DOTENV.exists() and os.environ.get('SUPABASE_URL'):
        # If a local .env explicitly set SUPABASE_URL, it won out — credit
        # the local file. Otherwise the rn-app file is the effective source.
        source = str(_LOCAL_DOTENV)
    else:
        source = str(_RN_APP_DOTENV) if _RN_APP_DOTENV.exists() else '（未配置）'
    return SupabaseConfig(url=url, service_key=key, source=source)


def dotenv_path() -> Path:
    return _LOCAL_DOTENV


def rn_app_dotenv_path() -> Path:
    return _RN_APP_DOTENV


def dotenv_exists() -> bool:
    return _LOCAL_DOTENV.exists()

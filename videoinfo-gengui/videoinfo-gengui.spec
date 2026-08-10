from __future__ import annotations

from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules

project_root = Path.cwd()
vendor_dir = project_root / 'vendor'

datas: list[tuple[str, str]] = []
if vendor_dir.exists():
    datas.append((str(vendor_dir), 'vendor'))

hiddenimports = collect_submodules('tabs')


a = Analysis(
    ['app.py'],
    pathex=[str(project_root)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='videoinfo-gengui',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='videoinfo-gengui',
)

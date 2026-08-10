$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$vendorDir = Join-Path $PSScriptRoot 'vendor'
if (-not (Test-Path $vendorDir)) {
    Write-Error "缺少 vendor 目录。请先准备 yt-dlp.exe、ffmpeg.exe、ffprobe.exe 到 $vendorDir"
}

$requiredFiles = @('yt-dlp.exe', 'ffmpeg.exe', 'ffprobe.exe')
$missing = $requiredFiles | Where-Object { -not (Test-Path (Join-Path $vendorDir $_)) }
if ($missing.Count -gt 0) {
    Write-Error "vendor 目录缺少文件: $($missing -join ', ')"
}

python -m PyInstaller --noconfirm --clean videoinfo-gengui.spec

Write-Host ''
Write-Host '打包完成。输出目录：' -NoNewline
Write-Host (Join-Path $PSScriptRoot 'dist\videoinfo-gengui') -ForegroundColor Green

# dsh-remote-watchdog.ps1 - keep start-dsh.ps1 alive.
# Run every 5 minutes via Task Scheduler (DSH-Remote-Watchdog). If no start-dsh.ps1
# instance is running, relaunch it hidden. start-dsh.ps1 holds a single-instance Mutex,
# so concurrent launches (VBS autostart + this watchdog) are harmless.
# ASCII-only file (PS 5.1 GBK reads UTF-8-no-BOM).
$ErrorActionPreference = 'Continue'

$LOG = Join-Path $PSScriptRoot 'watchdog-last.log'

$running = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'start-dsh\.ps1' }
if ($running) {
  Set-Content -Path $LOG -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ok') -Encoding ASCII
  exit 0
}

$script = Join-Path $PSScriptRoot 'start-dsh.ps1'
if (-not (Test-Path $script)) {
  Set-Content -Path $LOG -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ERROR: start-dsh.ps1 missing') -Encoding ASCII
  exit 1
}

Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',("`"$script`"") -WindowStyle Hidden
Set-Content -Path $LOG -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' relaunched') -Encoding ASCII

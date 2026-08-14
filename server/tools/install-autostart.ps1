# install-autostart.ps1 - register DSH Remote at user logon (hidden window)
# One-time setup: powershell -ExecutionPolicy Bypass -File install-autostart.ps1
# Creates <Startup>\dsh-remote-autostart.vbs that launches start-dsh.ps1 hidden.
# start-dsh.ps1 keeps a single-instance Mutex, so extra launches are harmless.
# Uninstall: delete the vbs file (path printed below).
$ErrorActionPreference = 'Stop'

$startupDir = [Environment]::GetFolderPath('Startup')
$vbsPath = Join-Path $startupDir 'dsh-remote-autostart.vbs'
$scriptPath = Join-Path $PSScriptRoot 'start-dsh.ps1'

if (-not (Test-Path $scriptPath)) {
  Write-Host "[autostart] NOT FOUND: $scriptPath" -ForegroundColor Red
  exit 1
}

# WScript.Shell.Run with window style 0 = hidden; nested quotes escaped for VBS.
# IMPORTANT: -Encoding Unicode (UTF-16 LE BOM) - WSH reads the vbs as Unicode, so
# non-ASCII paths (Chinese 协作项目) survive; ASCII would turn them into '????'.
# Quote pairing: "" escapes one quote inside the VBS string; the final ", 0 is the
# window-style argument OUTSIDE the string.
$vbs = 'Set ws = CreateObject("WScript.Shell")' + "`r`n" +
       'ws.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""' +
       $scriptPath + '""", 0' + "`r`n"
Set-Content -Path $vbsPath -Value $vbs -Encoding Unicode

Write-Host "[autostart] installed: $vbsPath" -ForegroundColor Green
Write-Host '[autostart] DSH Remote will start automatically at next logon (hidden window).' -ForegroundColor Cyan
Write-Host '[autostart] Current phone URL is written to: tools\last-phone-url.txt' -ForegroundColor Cyan
Write-Host '[autostart] To remove autostart, delete the vbs file above.' -ForegroundColor DarkGray

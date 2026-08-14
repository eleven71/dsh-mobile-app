# start-dsh.ps1 - One-click DSH start: dsh web + cloudflared quick tunnel + fixed-domain DNS auto-sync
# The quick tunnel domain changes every restart; this script captures the new domain and
# updates YOUR fixed domain (e.g. mydsh.de5.net) via the DNSHE API, so the phone always
# uses the fixed domain. Fully configurable - see tools/dsh-config.txt.
# Usage: double-click; tunnel auto-reconnects and re-syncs DNS on every new domain.

$ErrorActionPreference = 'Continue'

# ---- single-instance guard: only one start-dsh.ps1 loop may run at a time ----
$MUTEX = New-Object System.Threading.Mutex($false, 'DSH-Remote-StartScript')
if (-not $MUTEX.WaitOne(0)) {
  Write-Host '[start-dsh] another instance is already running (single-instance lock). Exiting.' -ForegroundColor Red
  exit 1
}

$CF = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$CONFIG = Join-Path $PSScriptRoot 'dsh-config.txt'
$LOG = Join-Path $PSScriptRoot 'quick-tunnel.log'

# ---- load config (dsh-config.txt, key=value lines) ----
$CFG = @{}
if (Test-Path $CONFIG) {
  foreach ($line in Get-Content $CONFIG) {
    $line = $line.Trim()
    if ($line -and -not $line.StartsWith('#')) {
      $p = $line.IndexOf('=')
      if ($p -gt 0) { $CFG[$line.Substring(0, $p).Trim()] = $line.Substring($p + 1).Trim() }
    }
  }
}
$SUBDOMAIN_ID = $CFG['SUBDOMAIN_ID']
$DOMAIN = $CFG['DOMAIN']
$KEY = $CFG['DNSHE_KEY']
$SECRET = $CFG['DNSHE_SECRET']
if (-not $SUBDOMAIN_ID -or -not $DOMAIN -or -not $KEY -or -not $SECRET) {
  Write-Host '[start-dsh] missing config: copy tools/dsh-config.example.txt to tools/dsh-config.txt and fill in DOMAIN / SUBDOMAIN_ID / DNSHE_KEY / DNSHE_SECRET'
  exit 1
}

function Update-Dnshe {
  param([string]$Cname)
  Write-Host ('[dns] sync {0} -> {1}' -f $DOMAIN, $Cname) -ForegroundColor Cyan
  $api = 'https://api005.dnshe.com/index.php?m=domain_hub&endpoint=dns_records'
  $list = curl.exe -s -m 15 ($api + '&action=list&subdomain_id=' + $SUBDOMAIN_ID) -H ('X-API-Key: ' + $KEY) -H ('X-API-Secret: ' + $SECRET)
  try { $records = ($list | ConvertFrom-Json).records } catch { $records = @() }
  foreach ($r in $records) {
    $del = ('{{"record_id":"{0}"}}' -f $r.record_id)
    curl.exe -s -m 15 -X POST ($api + '&action=delete') -H ('X-API-Key: ' + $KEY) -H ('X-API-Secret: ' + $SECRET) -H 'Content-Type: application/json' -d $del | Out-Null
    Write-Host ('[dns] removed old {0} {1}' -f $r.type, $r.content)
  }
  $body = ('{{"subdomain_id":{0},"type":"CNAME","content":"{1}"}}' -f $SUBDOMAIN_ID, $Cname)
  $res = curl.exe -s -m 15 -X POST ($api + '&action=create') -H ('X-API-Key: ' + $KEY) -H ('X-API-Secret: ' + $SECRET) -H 'Content-Type: application/json' -d $body
  Write-Host ('[dns] ' + $res) -ForegroundColor Green
}

# 1) ensure dsh web is running
if (-not (Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue)) {
  Write-Host '[start-dsh] starting dsh web...' -ForegroundColor Cyan
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','start','dsh web' -WindowStyle Minimized
  Start-Sleep -Seconds 6
} else {
  Write-Host '[start-dsh] dsh web already running' -ForegroundColor DarkGray
}

# 2) quick tunnel loop: capture domain -> sync DNS -> reconnect
Write-Host '[start-dsh] starting tunnel, watching for domain...' -ForegroundColor Cyan
$lastDomain = ''
while ($true) {
  # ---- kill the tunnel this loop started last round, plus any leftover DSH tunnels ----
  if ($proc -and -not $proc.HasExited) {
    Write-Host ('[start-dsh] killing previous tunnel pid {0}' -f $proc.Id) -ForegroundColor Yellow
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  }
  Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'tunnel' -and $_.CommandLine -match '--url' -and $_.CommandLine -match '8082' } |
    ForEach-Object {
      Write-Host ('[start-dsh] killing leftover tunnel pid {0}' -f $_.ProcessId) -ForegroundColor Yellow
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
  Start-Sleep -Milliseconds 500

  Remove-Item $LOG -ErrorAction SilentlyContinue
  Remove-Item "$LOG.out" -ErrorAction SilentlyContinue
  $proc = Start-Process -FilePath $CF -ArgumentList 'tunnel','--url','http://127.0.0.1:8082' `
    -WindowStyle Hidden -RedirectStandardError $LOG -RedirectStandardOutput "$LOG.out" -PassThru
  $domain = ''
  while (-not $proc.HasExited) {
    Start-Sleep -Milliseconds 800
    if (Test-Path $LOG) {
      $txt = Get-Content $LOG -Raw -ErrorAction SilentlyContinue
      if ($txt) {
        $m = [regex]::Match($txt, 'https://([a-z0-9-]+\.trycloudflare\.com)')
        if ($m.Success) {
          $domain = $m.Groups[1].Value
          if ($domain -ne $lastDomain) {
            Update-Dnshe -Cname $domain
            $lastDomain = $domain
            # sync current tunnel domain into plugin trustedHosts (cordis.patch.yml),
            # so remote browsers pass the frontend trust fence (settings UI available)
            $patchPath = Join-Path $PSScriptRoot '..\plugin\cordis.patch.yml'
            if (Test-Path $patchPath) {
              $patch = Get-Content $patchPath -Raw -Encoding UTF8
              if ($patch -notmatch [regex]::Escape($domain)) {
                $patch = $patch -replace '(\s+- dsh\.remote)', "`$1`n      - $domain"
                Set-Content $patchPath -Value $patch -Encoding UTF8 -NoNewline
                Write-Host ('[start-dsh] trustedHosts + ' + $domain) -ForegroundColor DarkGray
              }
            }
            Write-Host ('[start-dsh] PHONE URL: https://' + $domain + ' (fixed domain https://' + $DOMAIN + ' when DNSHE is healthy)') -ForegroundColor Green
          }
        }
      }
    }
  }
  Write-Host '[start-dsh] tunnel disconnected, retry in 3s...' -ForegroundColor Yellow
  Start-Sleep -Seconds 3
}

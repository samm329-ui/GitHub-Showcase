<#
.SYNOPSIS
  Ensures a VISIBLE, debuggable Chrome on port 9222 for the GitHub Showcase pipeline.

  Why this exists: the pipeline captures frames through CDP. If port 9222 is not
  served by a real, GPU-windowed Chrome, src\cdp.ts silently spawns a headless
  Chromium instead - invisible window and software rendering, i.e. slow (~9 fps).
  This script guarantees the visible path and fails loudly otherwise.

  Exit codes: 0 = ready on 9222   1 = failed (caller must stop, never fall back)

.PARAMETER ChromeExe
  Full path to chrome.exe / msedge.exe (run.bat resolves it).
#>
param(
  [Parameter(Mandatory = $true)][string]$ChromeExe
)

$ErrorActionPreference = "Stop"
$port = 9222
$probeUrl = "http://127.0.0.1:$port/json/version"
$profileTag = "github-showcase-chrome"
$userDataDir = Join-Path $env:TEMP $profileTag

function Test-PortReady {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 $probeUrl
    return $r.StatusCode -eq 200
  } catch { return $false }
}

function Get-AutomationProcesses {
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.CommandLine -and
      ($_.CommandLine -like "*$profileTag*") -and
      ($_.CommandLine -like "*remote-debugging-port=$port*") -and
      ($_.CommandLine -notmatch "--type=")   # only the main browser process
    }
}

# 1) Port already served by a VISIBLE automation Chrome -> reuse it.
if (Test-PortReady) {
  $mains = @(Get-AutomationProcesses)
  $headless = $mains | Where-Object { $_.CommandLine -match "headless" }
  if ($mains.Count -gt 0 -and -not $headless) {
    Write-Host "Reusing visible debuggable Chrome on port $port (pid $($mains[0].ProcessId))."
    exit 0
  }
  if ($headless) {
    Write-Host "Port $port is served by a HEADLESS Chromium (pid $($headless[0].ProcessId)) - replacing it with visible Chrome."
    Get-CimInstance Win32_Process |
      Where-Object { $_.CommandLine -and ($_.CommandLine -like "*$profileTag*") } |
      ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
    Start-Sleep -Milliseconds 800
  }
  # Port answers but the process shape is unknown: reuse rather than kill a stranger.
  elseif ($mains.Count -eq 0) {
    Write-Host "Reusing debuggable browser on port $port (owner not identified - leaving it alone)."
    exit 0
  }
}

# 2) Port not served (or stale headless just removed): kill leftover automation profile processes, then launch visible.
if (-not (Test-PortReady)) {
  Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -and ($_.CommandLine -like "*$profileTag*") } |
    ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }

  Write-Host "Starting visible Chrome on port $port ..."
  Start-Process -FilePath $ChromeExe -ArgumentList @(
    "--remote-debugging-port=$port",
    "--user-data-dir=$userDataDir",
    # CDP automation: never let the compositor throttle the (background) window,
    # and force the hardware GPU raster path (Chromium 155 blocklists this GPU
    # by default and silently falls back to software SwiftShader).
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-features=CalculateNativeWinOcclusion",
    "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization",
    "--use-gl=angle",
    "--use-angle=d3d11"
  )

  for ($i = 0; $i -lt 24; $i++) {
    Start-Sleep -Seconds 1
    if (Test-PortReady) {
      Write-Host "Chrome is ready on port $port."
      exit 0
    }
  }

  Write-Host ""
  Write-Host "ERROR: Chrome did not open its debugging port on $port within 24 seconds."
  Write-Host "  - Check that this works: `"$ChromeExe`" --remote-debugging-port=$port --user-data-dir=`"$userDataDir`""
  Write-Host "  - Close any stale github-showcase-chrome windows and retry."
  Write-Host "The pipeline will NOT continue into a silent, slow headless fallback."
  exit 1
}

exit 0

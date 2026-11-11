# Chromiagent installer for Windows, by SvRvS. (macOS and Linux: install.sh)
#   install:    irm https://raw.githubusercontent.com/SvRvS3003/chromiagent/main/install.ps1 | iex
#   uninstall:  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/SvRvS3003/chromiagent/main/install.ps1))) -Uninstall
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'

$Repo    = 'https://github.com/SvRvS3003/chromiagent'
$Dir     = if ($env:CHROMIAGENT_DIR) { $env:CHROMIAGENT_DIR } else { Join-Path $env:USERPROFILE '.chromiagent' }
$Startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'Chromiagent.vbs'
$Log     = Join-Path $env:TEMP 'chromiagent.log'

function Say($m) { Write-Host "==> $m" -ForegroundColor Green }
function Die($m) { Write-Host "Error: $m" -ForegroundColor Red; exit 1 }
function Stop-Host {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like "*$Dir*server.js*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($Uninstall) {
  Stop-Host
  Remove-Item $Startup -ErrorAction SilentlyContinue
  Remove-Item $Dir -Recurse -Force -ErrorAction SilentlyContinue
  Say "Removed. Also remove the extension on your browser's extensions page."
  exit 0
}

$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { Die 'Node.js 22.13+ is required: https://nodejs.org' }
& $Node -e 'process.exit(typeof require("node:module").stripTypeScriptTypes === "function" ? 0 : 1)' 2>$null
if ($LASTEXITCODE -ne 0) { Die "Node.js 22.13+ is required (found $(& $Node -v))." }
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Say 'Claude Code was not found. Install it before using the panel: npm install -g @anthropic-ai/claude-code'
}

Say "Downloading to $Dir"
Stop-Host
if (Get-Command git -ErrorAction SilentlyContinue) {
  if (Test-Path (Join-Path $Dir '.git')) { git -C $Dir pull -q --ff-only } else { git clone -q --depth 1 "$Repo.git" $Dir }
} else {
  $zip = Join-Path $env:TEMP 'chromiagent.zip'
  Invoke-WebRequest "$Repo/archive/refs/heads/main.zip" -OutFile $zip -UseBasicParsing
  $tmp = Join-Path $env:TEMP 'chromiagent-src'
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive $zip $tmp -Force
  New-Item -ItemType Directory -Force $Dir | Out-Null
  Copy-Item (Join-Path $tmp 'chromiagent-main\*') $Dir -Recurse -Force
  Remove-Item $zip, $tmp -Recurse -Force
}

Say 'Installing dependencies'
Push-Location $Dir
npm install --omit=dev --no-audit --no-fund --silent
if ($LASTEXITCODE -ne 0) { Pop-Location; Die 'npm install failed.' }
Pop-Location

Say 'Starting the local host (starts again automatically at login)'
$Server = Join-Path $Dir 'host\server.js'
# A hidden launcher in the Startup folder: no console window at login.
Set-Content -Path $Startup -Encoding ASCII -Value "CreateObject(""WScript.Shell"").Run """"""$Node"""" """"$Server"""""", 0, False"
Start-Process -FilePath $Node -ArgumentList "`"$Server`"" -WindowStyle Hidden -RedirectStandardOutput $Log -RedirectStandardError "$Log.err"

$ok = $false
foreach ($i in 1..20) {
  try { (New-Object Net.Sockets.TcpClient('127.0.0.1', 17371)).Close(); $ok = $true; break } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $ok) { Die "Host did not start. See $Log.err" }

$Ext = Join-Path $Dir 'extension'
Set-Clipboard -Value $Ext
Write-Host ''
Write-Host 'Chromiagent host is running.' -ForegroundColor Green -NoNewline
Write-Host ' Last step, in your browser:'
Write-Host ''
Write-Host '  1. Open the extensions page: chrome://extensions  (Edge: edge://extensions, Brave: brave://extensions)'
Write-Host '  2. Turn on "Developer mode".'
Write-Host '  3. Click "Load unpacked" and choose this folder (already copied, paste it into the address bar):'
Write-Host "     $Ext"
Write-Host '  4. Pin "Chromiagent" from the puzzle icon in the toolbar.'
Write-Host ''
Write-Host 'Click the sparkle icon (or press Alt+A) to open the agent panel.'

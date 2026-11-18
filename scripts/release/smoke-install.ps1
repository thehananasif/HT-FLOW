# CI smoke test for the NSIS installer (Windows only): silent per-user install, check the install
# folder, shortcuts and file associations, then silent uninstall (which must keep user data).
# Usage: pwsh scripts/release/smoke-install.ps1 -Setup <path to *-setup.exe>
param([Parameter(Mandatory = $true)][string]$Setup)
$ErrorActionPreference = 'Stop'
$failed = $false
function Check($ok, $what, [switch]$Soft) {
  if ($ok) { Write-Host "ok    $what" }
  elseif ($Soft) { Write-Host "::warning::missing $what" }
  else { Write-Host "::error::missing $what"; $script:failed = $true }
}

$dataDir = Join-Path $env:APPDATA 'HTFlow'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
Set-Content -Path (Join-Path $dataDir 'keep-me.txt') -Value 'user data'

Start-Process -FilePath $Setup -ArgumentList '/S' -Wait
$install = Join-Path $env:LOCALAPPDATA 'HT Flow'
Check (Test-Path (Join-Path $install 'htflow-desktop.exe')) "installed exe in $install"
Check (Test-Path (Join-Path $install 'uninstall.exe')) 'uninstaller'

$lnks = Get-ChildItem -Recurse -Filter '*.lnk' -Path @(
  [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop')
) -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'HT Flow*' }
$lnks | ForEach-Object { Write-Host "shortcut $($_.FullName)" }
Check ($lnks | Where-Object { $_.FullName -like '*Programs*' }) 'Start-menu shortcut' -Soft
Check ($lnks | Where-Object { $_.FullName -like '*Desktop*' }) 'desktop shortcut' -Soft

foreach ($ext in 'htprofile', 'htworkspace', 'htind', 'htidea', 'httemplate', 'htstrat') {
  Check (Test-Path "HKCU:\Software\Classes\.$ext") "file association .$ext" -Soft
}

Start-Process -FilePath (Join-Path $install 'uninstall.exe') -ArgumentList '/S' -Wait
Start-Sleep -Seconds 3
Check (-not (Test-Path (Join-Path $install 'htflow-desktop.exe'))) 'exe removed by uninstall'
Check (Test-Path (Join-Path $dataDir 'keep-me.txt')) 'user data kept by silent uninstall'
Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue
if ($failed) { exit 1 }

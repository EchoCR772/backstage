# Checks build/installer.nsh's cleanup of the old "Clip Editor" Installed apps entry without
# installing anything: builds a tiny installer around removeOldClipEditor with a made-up GUID and
# made-up registry entries, then checks that
#   1. entries pointing at a folder that's gone are deleted, and
#   2. entries of a Clip Editor that's still there are left alone.
# Results go to %TEMP%\backstage-nsis-test\result.txt. Only the made-up keys are ever touched.
$ErrorActionPreference = 'Stop'
$makensis = Get-ChildItem "$env:LOCALAPPDATA\electron-builder\Cache" -Recurse -Filter makensis.exe | Select-Object -First 1 -ExpandProperty FullName
if (-not $makensis) { throw "makensis not found (build the app once so electron-builder downloads NSIS)" }
$guid = '00000000-0000-0000-0000-00c0ffee0042'
$work = Join-Path $env:TEMP 'backstage-nsis-test'
New-Item -ItemType Directory -Force $work | Out-Null
$nsh = (Resolve-Path (Join-Path $PSScriptRoot '..\build\installer.nsh')).Path
$out = Join-Path $work 'result.txt'
@"
Unicode true
!define OLD_CLIP_EDITOR_GUID "$guid"
!include "LogicLib.nsh"
!include "$nsh"
Name "cleanup test"
OutFile "$work\cleanup-test.exe"
RequestExecutionLevel user
SilentInstall silent
Section
  SetShellVarContext current
  InitPluginsDir
  !insertmacro removeOldClipEditor
SectionEnd
"@ | Set-Content -Encoding UTF8 (Join-Path $work 'test.nsi')
& $makensis /V2 (Join-Path $work 'test.nsi') | Out-Null
if ($LASTEXITCODE -ne 0) { "FAIL makensis exit $LASTEXITCODE" | Set-Content $out; exit 1 }
$un = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid"
$sw = "HKCU:\Software\$guid"
function Fake($loc) {
  New-Item -Force $un | Out-Null; New-ItemProperty -Force $un -Name DisplayName -Value 'Clip Editor TEST' | Out-Null
  New-Item -Force $sw | Out-Null; New-ItemProperty -Force $sw -Name InstallLocation -Value $loc | Out-Null
}
$lines = @()
# 1. the old folder is gone
Fake (Join-Path $work 'gone\Clip Editor')
Start-Process (Join-Path $work 'cleanup-test.exe') -ArgumentList '/S' -Wait
$lines += if (-not (Test-Path $un) -and -not (Test-Path $sw)) { 'PASS entries of a removed Clip Editor are deleted' } else { 'FAIL entries of a removed Clip Editor are still there' }
# 2. Clip Editor still installed (its exe is there, no uninstaller to run)
$there = Join-Path $work 'there\Clip Editor'
New-Item -ItemType Directory -Force $there | Out-Null
Set-Content (Join-Path $there 'Clip Editor.exe') 'x'
Fake $there
Start-Process (Join-Path $work 'cleanup-test.exe') -ArgumentList '/S' -Wait
$lines += if ((Test-Path $un) -and (Test-Path $sw)) { 'PASS entries of an installed Clip Editor are kept' } else { 'FAIL entries of an installed Clip Editor were deleted' }
Remove-Item -Recurse -Force $un, $sw -ErrorAction SilentlyContinue
$lines += 'DONE'
$lines | Set-Content $out

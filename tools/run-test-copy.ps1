# Runs the app from source with a fresh copy of your settings (names, trims, folders), so the
# installed app and its data stay as they are. Your clip folders are the real ones, though: deleting
# or replacing a clip in the test copy changes the real file. Dev only; not part of the installed app.
$proj = Split-Path -Parent $PSScriptRoot
$profile = Join-Path $env:TEMP "backstage-test-profile"
# your data: Backstage's folder once you have it, before that Clip Editor's
$real = Join-Path $env:APPDATA "Backstage"
if (-not (Test-Path (Join-Path $real "settings.json"))) { $real = Join-Path $env:APPDATA "Clip Editor" }
Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$proj\*" } | Stop-Process -Force
Start-Sleep -Milliseconds 500
foreach ($old in @($profile, (Join-Path $env:TEMP "clip-editor-test-profile"))) { if (Test-Path $old) { Remove-Item $old -Recurse -Force } }
New-Item -ItemType Directory $profile | Out-Null
# settings and library data only (not Chromium's caches)
foreach ($n in '.migrated', 'settings.json', 'edits.json', 'names.json', 'people.json', 'games.json', 'thumbs', 'icons', 'Local Storage') {
  $p = Join-Path $real $n
  if (Test-Path $p) { Copy-Item $p (Join-Path $profile $n) -Recurse }
}
Set-Location $proj
Start-Process (Join-Path $proj "node_modules\electron\dist\electron.exe") -ArgumentList ".", "--user-data-dir=`"$profile`""

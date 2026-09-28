param(
    [ValidateSet("install", "update")] [string]$Mode = "install",
    [string]$Repo = "https://grebenukevgen41-web.github.io/hrebeniuk-tools/",   # сайт або папка
    [string]$Personal = ""          # тільки для ПК автора: папка особистого репозиторію
)
$ErrorActionPreference = "Continue"
$skip = "blendkit|WireColor|history step|PROGRESS|^\s*$|Read blend|Blender quit"

function Find-Blender {
    if ($env:HRB_BLENDER -and (Test-Path $env:HRB_BLENDER)) { return $env:HRB_BLENDER }
    $c = Get-ChildItem "C:\Program Files\Blender Foundation\Blender *\blender.exe" -ErrorAction SilentlyContinue |
         Sort-Object { [version](($_.Directory.Name -replace '[^\d.]', '') + '.0') } -Descending
    if ($c) { return $c[0].FullName }
    foreach ($p in "E:\Blender\blender.exe", "D:\Blender\blender.exe", "C:\Blender\blender.exe") { if (Test-Path $p) { return $p } }
    $p = (Read-Host "Не знайшов Blender. Перетягни сюди blender.exe і натисни Enter").Trim('"')
    if (Test-Path $p) { return $p }
    throw "Blender не знайдено"
}

Write-Host ""
Write-Host "=== Hrebeniuk Tools: $Mode ===" -ForegroundColor Cyan
$bl = Find-Blender
Write-Host "Blender:     $bl"
Write-Host "Репозиторій: $Repo"

while (-not $env:HRB_NO_WAIT -and (Get-Process blender -ErrorAction SilentlyContinue)) {
    Write-Host "Blender відкритий — закрий його (збережи роботу) і натисни Enter..." -ForegroundColor Yellow
    [void](Read-Host)
}

if ($Mode -eq "install") {
    $a = @("-b", "--python", "$PSScriptRoot\hrb_setup.py", "--", $Repo)
    if ($Personal) { $a += @("--personal", $Personal) }
    $out = & $bl @a 2>&1
    $out | Select-String "^HRB" | ForEach-Object { Write-Host ("  " + ($_.Line -replace '^HRB\s+', '')) }
    $ids = (($out | Select-String "^HRB  IDS (.*)").Matches | Select-Object -First 1).Groups[1].Value
    if (-not $ids) { Write-Host "Не вдалось прочитати список аддонів — перевір інтернет" -ForegroundColor Red; exit 1 }
    Write-Host ""
    Write-Host "Встановлюю: $ids"
    & $bl --command extension install $ids --sync --enable 2>&1 | Select-String -NotMatch $skip |
        Select-String "Installed|Reinstalled|rror|not found|already" | ForEach-Object { Write-Host "  $_" }
} else {
    & $bl --command extension update --sync 2>&1 | Select-String -NotMatch $skip |
        Select-String "Installed|Reinstalled|rror|up to date|Nothing" | ForEach-Object { Write-Host "  $_" }
}

Write-Host ""
Write-Host "Стан:" -ForegroundColor Cyan
& $bl --command extension list 2>&1 | Select-String "Hrebeniuk|\[installed\]" | ForEach-Object { Write-Host "  $_" }
Write-Host ""
Write-Host "Готово. Відкривай Blender: N-панель -> вкладка Hrebeniuk." -ForegroundColor Green
Write-Host "Далі оновлення приходять самі при запуску Blender (у хабі кнопка «Оновити все»)."

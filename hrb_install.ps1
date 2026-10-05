param(
    [ValidateSet("install", "update")] [string]$Mode = "install",
    [string]$Repo = "https://grebenukevgen41-web.github.io/hrebeniuk-tools/",   # сайт або папка
    [string]$Personal = "",         # тільки для ПК автора: папка особистого репозиторію
    [switch]$List                   # тільки показати знайдені Blender, нічого не ставити
)
$ErrorActionPreference = "Continue"
$skip = "blendkit|WireColor|history step|PROGRESS|^\s*$|Read blend|Blender quit"

function Find-AllBlenders {
    # УСІ Blender на ПК: у кожної версії свої налаштування (%APPDATA%\Blender Foundation\Blender\X.Y),
    # тому ставимо в кожну — інакше колега відкриє «не ту» версію і аддонів там нема.
    $c = New-Object System.Collections.Generic.List[string]
    if ($env:HRB_BLENDER -and (Test-Path $env:HRB_BLENDER)) { $c.Add($env:HRB_BLENDER) }
    Get-ChildItem "C:\Program Files\Blender Foundation\Blender*\blender.exe", "D:\Program Files\Blender Foundation\Blender*\blender.exe" -ErrorAction SilentlyContinue |
        ForEach-Object { $c.Add($_.FullName) }
    # Steam: усі бібліотеки з libraryfolders.vdf
    $steam = (Get-ItemProperty "HKCU:\Software\Valve\Steam" -ErrorAction SilentlyContinue).SteamPath
    if ($steam) {
        $libs = @($steam)
        $vdf = Join-Path $steam "steamapps\libraryfolders.vdf"
        if (Test-Path $vdf) { $libs += (Select-String -Path $vdf -Pattern '"path"\s+"(.+)"').Matches | ForEach-Object { $_.Groups[1].Value -replace '\\', '\' } }
        foreach ($l in $libs) { $p = Join-Path $l "steamapps\common\Blender\blender.exe"; if (Test-Path $p) { $c.Add($p) } }
    }
    # чим відкриваються .blend файли (портативний / нестандартна папка)
    $prog = (Get-ItemProperty "Registry::HKEY_CLASSES_ROOT\.blend" -ErrorAction SilentlyContinue).'(default)'
    if ($prog) {
        $cmd = (Get-ItemProperty "Registry::HKEY_CLASSES_ROOT\$prog\shell\open\command" -ErrorAction SilentlyContinue).'(default)'
        if ($cmd -match '^"?([^"]+?blender(-launcher)?\.exe)') {
            $p = $Matches[1] -replace 'blender-launcher\.exe$', 'blender.exe'
            if (Test-Path $p) { $c.Add($p) }
        }
    }
    # портативні копії: blender.exe на 1-2 рівні від кореня дисків (E:\Blender, D:\Soft\Blender 5.1 ...)
    foreach ($d in (Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue | Where-Object { $_.Used })) {
        Get-ChildItem (Join-Path $d.Root "*\blender.exe"), (Join-Path $d.Root "*\*\blender.exe") -ErrorAction SilentlyContinue |
            ForEach-Object { $c.Add($_.FullName) }
    }
    if ($c.Count -eq 0) {
        $p = (Read-Host "Не знайшов Blender. Перетягни сюди blender.exe і натисни Enter").Trim('"')
        if (Test-Path $p) { $c.Add($p) } else { throw "Blender не знайдено" }
    }
    # без повторів; одна версія X.Y = одні налаштування -> ставимо раз
    $seen = @{}; $vers = @{}; $res = @()
    foreach ($p in $c) {
        $full = (Resolve-Path $p).Path
        if ($seen.ContainsKey($full.ToLower())) { continue }
        $seen[$full.ToLower()] = 1
        $v = ((& $full --version 2>$null | Select-String '^Blender (\d+\.\d+)' | Select-Object -First 1).Matches.Groups[1].Value)
        if (-not $v) { Write-Host "  пропускаю (не відповідає): $full" -ForegroundColor DarkGray; continue }
        if ([version]$v -lt [version]"4.2") { Write-Host "  пропускаю Blender $v (аддони-розширення з 4.2): $full" -ForegroundColor DarkGray; continue }
        if ($vers.ContainsKey($v)) { Write-Host "  Blender $v уже є ($($vers[$v])), ця копія ділить ті самі налаштування: $full" -ForegroundColor DarkGray; continue }
        $vers[$v] = $full
        $res += [pscustomobject]@{ Exe = $full; Ver = $v }
    }
    return $res
}

Write-Host ""
Write-Host "=== Hrebeniuk Tools: $Mode ===" -ForegroundColor Cyan
$all = @(Find-AllBlenders)
Write-Host "Знайдено Blender: $($all.Count)"
$all | ForEach-Object { Write-Host ("  {0,-6} {1}" -f $_.Ver, $_.Exe) }
Write-Host "Репозиторій: $Repo"
if ($List) { exit 0 }
if ($all.Count -eq 0) { Write-Host "Нема куди ставити (потрібен Blender 4.2 або новіший)" -ForegroundColor Red; exit 1 }
if ($all.Count -gt 1 -and -not $env:HRB_ALL) {
    Write-Host ""
    for ($i = 0; $i -lt $all.Count; $i++) { Write-Host ("  [{0}] Blender {1}   {2}" -f ($i + 1), $all[$i].Ver, $all[$i].Exe) }
    $ans = Read-Host "Куди ставити? Enter = в усі (радимо); або номери через кому, напр. 1 чи 1,2"
    if ($ans.Trim()) {
        $pick = @($ans -split '[,; ]+' | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ - 1 } |
                  Where-Object { $_ -ge 0 -and $_ -lt $all.Count } | Sort-Object -Unique)
        if ($pick.Count) { $all = @($pick | ForEach-Object { $all[$_] }) }
        else { Write-Host "Не зрозумів відповідь — ставлю в усі." -ForegroundColor Yellow }
    }
    Write-Host ("Ставлю в: Blender " + (($all | ForEach-Object { $_.Ver }) -join ", "))
}

while (-not $env:HRB_NO_WAIT -and (Get-Process blender -ErrorAction SilentlyContinue)) {
    Write-Host "Blender відкритий — закрий його (збережи роботу) і натисни Enter..." -ForegroundColor Yellow
    [void](Read-Host)
}

$fail = 0
foreach ($b in $all) {
    $bl = $b.Exe
    Write-Host ""
    Write-Host "--- Blender $($b.Ver): $bl ---" -ForegroundColor Cyan
    if ($Mode -eq "install") {
        $a = @("-b", "--python", "$PSScriptRoot\hrb_setup.py", "--", $Repo)
        if ($Personal) { $a += @("--personal", $Personal) }
        $out = & $bl @a 2>&1
        $out | Select-String "^HRB" | ForEach-Object { Write-Host ("  " + ($_.Line -replace '^HRB\s+', '')) }
        $ids = (($out | Select-String "^HRB  IDS (.*)").Matches | Select-Object -First 1).Groups[1].Value
        if (-not $ids) { Write-Host "  Не вдалось прочитати список аддонів — перевір інтернет" -ForegroundColor Red; $fail++; continue }
        Write-Host "  Встановлюю: $ids"
        & $bl --command extension install $ids --sync --enable 2>&1 | Select-String -NotMatch $skip |
            Select-String "Installed|Reinstalled|rror|not found|already" | ForEach-Object { Write-Host "    $_" }
    } else {
        & $bl --command extension update --sync 2>&1 | Select-String -NotMatch $skip |
            Select-String "Installed|Reinstalled|rror|up to date|Nothing" | ForEach-Object { Write-Host "    $_" }
    }
    Write-Host "  Стан:"
    & $bl --command extension list 2>&1 | Select-String "Hrebeniuk|\[installed\]" | ForEach-Object { Write-Host "    $_" }
}

Write-Host ""
if ($fail) { Write-Host "Готово з помилками ($fail) — див. вище." -ForegroundColor Yellow }
else { Write-Host ("Готово: Blender " + (($all | ForEach-Object { $_.Ver }) -join ", ") + ". Відкривай Blender: N-панель -> вкладка Hrebeniuk.") -ForegroundColor Green }
Write-Host "Далі оновлення приходять самі при запуску Blender (у хабі кнопка «Оновити все»)."
Write-Host "Поставив новий Blender (інша версія)? Просто запусти ВСТАНОВИТИ.bat ще раз."

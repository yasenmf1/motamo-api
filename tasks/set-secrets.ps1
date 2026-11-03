# Качва 3-те ключа от компютъра в GitHub secrets (еднократно). Стойностите не се печатат.
$gh = "C:\Program Files\GitHub CLI\gh.exe"
$envFile = Join-Path $env:USERPROFILE ".claude\motamo-tokens.env"
foreach ($k in "PEEK_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_OWNER_CHAT_ID") {
    $line = Get-Content $envFile -Encoding UTF8 | Where-Object { $_ -like "$k=*" } | Select-Object -First 1
    $v = if ($line) { $line.Substring($k.Length + 1).Trim() } else { "" }
    if (-not $v) { Write-Host "$k - липсва в файла"; continue }
    $out = & $gh secret set $k --repo yasenmf1/motamo-api --body $v 2>&1
    if ($LASTEXITCODE -eq 0) { Write-Host "$k - качен" } else { Write-Host "$k - ГРЕШКА: $out" }
}

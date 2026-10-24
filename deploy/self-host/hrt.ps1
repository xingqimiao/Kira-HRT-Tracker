param([Parameter(Position=0)][string]$Command = 'help', [Parameter(Position=1)][string]$Value)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
function Dc {
    & docker compose -f compose.yaml @args
    if ($LASTEXITCODE -ne 0) { throw "Docker Compose failed ($LASTEXITCODE)" }
}
function Tool {
    # The management model intentionally omits the three running app services.
    $previous = $env:COMPOSE_IGNORE_ORPHANS
    try {
        $env:COMPOSE_IGNORE_ORPHANS = 'true'
        & docker compose -f tools.yaml run --rm tools @args
        if ($LASTEXITCODE -ne 0) { throw "Management command failed ($LASTEXITCODE)" }
    } finally {
        if ($null -eq $previous) { Remove-Item Env:COMPOSE_IGNORE_ORPHANS -ErrorAction SilentlyContinue }
        else { $env:COMPOSE_IGNORE_ORPHANS = $previous }
    }
}
function Backup {
    $backupName = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
    Dc stop web api
    try {
        Tool backup-prepare $backupName
        Dc exec -T db pg_dump -U hrt -d hrt -Fc -f /tmp/hrt-backup.dump
        Dc cp 'db:/tmp/hrt-backup.dump' "backups/$backupName/database.dump"
        Dc exec -T db rm /tmp/hrt-backup.dump
        Tool backup-finish $backupName
    } finally { Dc start api web }
}
switch ($Command) {
    'install' {
        if (!$Value) { throw 'Supply https://domain or https://fixed-IP' }
        & docker info *> $null
        if ($LASTEXITCODE -ne 0) { throw 'Docker is not running or this user cannot access it. See README.md.' }
        & docker compose version
        if ($LASTEXITCODE -ne 0) { throw 'Docker Compose v2 is required. See README.md.' }
        Write-Output '[1/3] Creating configuration and encryption key...'
        Tool init $Value
        Write-Output '[2/3] Downloading images and starting services (first run may take several minutes)...'
        Dc up -d --wait --wait-timeout 180
        Write-Output '[3/3] Preparing your access instructions...'
        Tool installed
    }
    'init' { if (!$Value) { throw 'Supply https://domain or https://fixed-IP' }; Tool init $Value }
    'start' { Dc up -d --wait --wait-timeout 180 }
    'stop' { Dc stop }
    'status' { Dc ps --all }
    'check' {
        Dc up -d --wait --wait-timeout 180
        Dc exec -T api node -e "fetch('http://127.0.0.1:8788/health').then(async r=>{if(!r.ok)process.exit(1);console.log(await r.text())}).catch(()=>process.exit(1))"
    }
    'logs' { Dc logs --tail 100 -f }
    'cert' { Tool cert }
    'backup' { Backup }
    'restore' {
        if (!$Value) { throw 'Supply backup directory name' }
        Tool backup-verify $Value
        Tool restore-files $Value
        Tool restore-ca $Value
        Dc up -d db --wait --wait-timeout 120
        $count = Dc exec -T db psql -U hrt -d hrt -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public'"
        if (($count | Out-String).Trim() -ne '0') { throw 'Database is not empty; restore refused' }
        Dc cp "backups/$Value/database.dump" 'db:/tmp/hrt-restore.dump'
        Dc exec -T db pg_restore -U hrt -d hrt --exit-on-error --single-transaction --no-owner /tmp/hrt-restore.dump
        Dc exec -T db rm /tmp/hrt-restore.dump
        Dc up -d --wait --wait-timeout 180
    }
    'upgrade' {
        if ($Value -notmatch '^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$') { throw 'Supply an explicit version, for example 2.2.0' }
        $previous = $env:HRT_VERSION
        try { $env:HRT_VERSION = $Value; Dc pull } finally {
            if ($null -eq $previous) { Remove-Item Env:HRT_VERSION -ErrorAction SilentlyContinue } else { $env:HRT_VERSION = $previous }
        }
        Backup
        Tool version $Value
        Dc up -d --wait --wait-timeout 180
        Write-Output "Upgrade healthy: $Value"
    }
    'build' {
        & docker compose -f compose.yaml -f compose.build.yaml build
        if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
    }
    'help' {
        Write-Output 'First installation: ./hrt.ps1 install https://YOUR-DOMAIN-OR-IP'
        Write-Output 'Maintenance: ./hrt.ps1 start | stop | status | check | logs | cert | backup | restore NAME | upgrade VERSION'
        Write-Output 'Advanced: ./hrt.ps1 init URL | build'
    }
    default { throw 'Unknown command. Run: ./hrt.ps1 help' }
}

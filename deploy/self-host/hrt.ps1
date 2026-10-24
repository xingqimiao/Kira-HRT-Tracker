param([Parameter(Position=0)][string]$Command = 'help', [Parameter(Position=1)][string]$Value)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
function Dc {
    & docker compose -f compose.yaml @args
    if ($LASTEXITCODE -ne 0) { throw "Docker Compose failed ($LASTEXITCODE)" }
}
function Tool {
    & docker compose -f tools.yaml run --rm tools @args
    if ($LASTEXITCODE -ne 0) { throw "Management command failed ($LASTEXITCODE)" }
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
    default { throw 'Usage: ./hrt.ps1 init URL | start | stop | status | check | logs | cert | backup | restore NAME | upgrade VERSION | build' }
}

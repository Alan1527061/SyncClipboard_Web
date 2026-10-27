param(
    [ValidateSet('Start', 'Stop', 'EnableStartup', 'DisableStartup')]
    [string]$Action = 'Start'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$runtimeRoot = Join-Path $projectRoot '.runtime'
$nginxPath = Join-Path $runtimeRoot 'nginx-1.30.6\nginx.exe'
$prefix = $projectRoot.Replace('\', '/') + '/'
$startupPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'ClipWeb.lnk'

if ($Action -eq 'EnableStartup') {
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($startupPath)
    $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $shortcut.Arguments = '"' + (Join-Path $PSScriptRoot 'start-hidden.vbs') + '"'
    $shortcut.WorkingDirectory = $projectRoot
    $shortcut.Save()
    Write-Output 'ClipWeb will start in the background at user sign-in.'
    return
}
if ($Action -eq 'DisableStartup') {
    if (Test-Path -LiteralPath $startupPath) {
        Remove-Item -LiteralPath $startupPath
    }
    return
}
if ($Action -eq 'Stop') {
    if (Test-Path -LiteralPath (Join-Path $runtimeRoot 'nginx.pid')) {
        & $nginxPath -p $prefix -e .runtime/error.log -c deploy/nginx.windows.conf -s quit
        if ($LASTEXITCODE -ne 0) { throw 'Could not stop ClipWeb.' }
    }
    return
}
if (-not (Test-Path -LiteralPath $nginxPath)) {
    New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
    $archivePath = Join-Path $runtimeRoot 'nginx-1.30.6.zip'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://nginx.org/download/nginx-1.30.6.zip' -OutFile $archivePath
    Expand-Archive -LiteralPath $archivePath -DestinationPath $runtimeRoot -Force
}
& $nginxPath -p $prefix -e .runtime/error.log -c deploy/nginx.windows.conf -t
if ($LASTEXITCODE -ne 0) { throw 'Invalid ClipWeb nginx configuration.' }
$pidPath = Join-Path $runtimeRoot 'nginx.pid'
if (Test-Path -LiteralPath $pidPath) {
    $nginxProcess = Get-Process -Id ([int](Get-Content -LiteralPath $pidPath)) -ErrorAction SilentlyContinue
    if ($nginxProcess -and $nginxProcess.Path -eq $nginxPath) {
        Write-Output 'ClipWeb is already running.'
        return
    }
}
$listener = Get-NetTCPConnection -State Listen -LocalPort 5034 -ErrorAction SilentlyContinue
if ($listener) { throw 'Port 5034 is already in use.' }
Start-Process -FilePath $nginxPath -ArgumentList @('-p', ('"' + $prefix + '"'), '-e', '.runtime/error.log', '-c', 'deploy/nginx.windows.conf') -WorkingDirectory $projectRoot -WindowStyle Hidden
Start-Sleep -Seconds 1
if (-not (Get-NetTCPConnection -State Listen -LocalPort 5034 -ErrorAction SilentlyContinue)) {
    throw 'ClipWeb did not start. See .runtime/error.log.'
}
Write-Output 'ClipWeb is running at http://localhost:5034/ (LAN: http://<PC-IP>:5034/).'

<#
.SYNOPSIS
  Deploy TestThisinh to Raspberry Pi via SSH (scp + ssh)
.DESCRIPTION
  Copies project files to pi8, installs dependencies, starts services.
  Requires: OpenSSH client (built into Windows 10+)
.PARAMETER PiHost
  SSH host (default: pi8)
.PARAMETER PiUser
  SSH user (default: pi8)
#>
param(
    [string]$PiHost = "pi8",
    [string]$PiUser = "pi8",
    [string]$RemoteDir = "/home/pi8/testthisinh"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = $PSScriptRoot

Write-Host "=== Deploy TestThisinh to $PiUser@$PiHost ===" -ForegroundColor Cyan
Write-Host "Remote directory: $RemoteDir"

# Step 1: Create remote directory structure
Write-Host "`n[1/5] Creating remote directories..." -ForegroundColor Yellow
ssh "${PiUser}@${PiHost}" "mkdir -p $RemoteDir/src/routes $RemoteDir/src/services $RemoteDir/src/middleware $RemoteDir/public/js $RemoteDir/hardware $RemoteDir/data"

# Step 2: Copy files via scp (exclude node_modules, data/*.db)
Write-Host "[2/5] Copying project files..." -ForegroundColor Yellow

# Core files
scp "$ProjectRoot\package.json" "$ProjectRoot\package-lock.json" "$ProjectRoot\server.js" "$ProjectRoot\.env" "${PiUser}@${PiHost}:${RemoteDir}/"

# Source files
scp "$ProjectRoot\src\db.js" "$ProjectRoot\src\socket.js" "${PiUser}@${PiHost}:${RemoteDir}/src/"
scp $ProjectRoot\src\middleware\*.js "${PiUser}@${PiHost}:${RemoteDir}/src/middleware/"
scp $ProjectRoot\src\routes\*.js "${PiUser}@${PiHost}:${RemoteDir}/src/routes/"
scp $ProjectRoot\src\services\*.js "${PiUser}@${PiHost}:${RemoteDir}/src/services/"

# Public (frontend)
scp "$ProjectRoot\public\index.html" "${PiUser}@${PiHost}:${RemoteDir}/public/"
scp $ProjectRoot\public\js\*.js "${PiUser}@${PiHost}:${RemoteDir}/public/js/"

# Hardware daemon
scp $ProjectRoot\hardware\*.py $ProjectRoot\hardware\*.json $ProjectRoot\hardware\requirements.txt "${PiUser}@${PiHost}:${RemoteDir}/hardware/"

# Step 3: Install Node.js dependencies on Pi
Write-Host "[3/5] Installing Node.js dependencies..." -ForegroundColor Yellow
ssh "${PiUser}@${PiHost}" "cd $RemoteDir && npm install --production"

# Step 4: Install Python dependencies on Pi
Write-Host "[4/5] Installing Python dependencies..." -ForegroundColor Yellow
ssh "${PiUser}@${PiHost}" "cd $RemoteDir/hardware && pip3 install -r requirements.txt --break-system-packages 2>/dev/null || pip3 install -r requirements.txt"

# Step 5: Create systemd services
Write-Host "[5/5] Creating systemd services..." -ForegroundColor Yellow

$nodeService = @"
[Unit]
Description=TestThisinh Node.js Server
After=network.target

[Service]
Type=simple
User=$PiUser
WorkingDirectory=$RemoteDir
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
"@

$hardwareService = @"
[Unit]
Description=TestThisinh Hardware Daemon (includes camera)
After=network.target testthisinh-node.service
Requires=testthisinh-node.service

[Service]
Type=simple
User=$PiUser
WorkingDirectory=$RemoteDir/hardware
ExecStart=/usr/bin/python3 daemon.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
"@

# Write service files to temp and copy
$nodeService | Set-Content "$env:TEMP\testthisinh-node.service" -Encoding UTF8 -NoNewline
$hardwareService | Set-Content "$env:TEMP\testthisinh-hardware.service" -Encoding UTF8 -NoNewline

scp "$env:TEMP\testthisinh-node.service" "$env:TEMP\testthisinh-hardware.service" "${PiUser}@${PiHost}:/tmp/"

ssh "${PiUser}@${PiHost}" @"
sudo systemctl stop testthisinh-camera 2>/dev/null; sudo systemctl disable testthisinh-camera 2>/dev/null; sudo rm -f /etc/systemd/system/testthisinh-camera.service
sudo cp /tmp/testthisinh-node.service /etc/systemd/system/
sudo cp /tmp/testthisinh-hardware.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable testthisinh-node testthisinh-hardware
sudo systemctl restart testthisinh-node testthisinh-hardware
"@

Write-Host "`n=== Deployment complete! ===" -ForegroundColor Green
Write-Host "  Node.js:  http://${PiHost}:3000"
Write-Host "  Hardware: http://${PiHost}:8765 (camera auto-managed)"
Write-Host ""
Write-Host "Check status:"
Write-Host "  ssh ${PiUser}@${PiHost} 'sudo systemctl status testthisinh-node testthisinh-hardware'"

# MiMo-Code Windows Installer
# Run this script to install the MiMo-Code CLI binary

param(
    [string]$InstallPath = "$env:LOCALAPPDATA\MiMo-Code",
    [switch]$AddToPath = $true,
    [switch]$CreateShortcut = $true
)

$ErrorActionPreference = "Stop"

# Colors
$Green = [System.ConsoleColor]::Green
$Yellow = [System.ConsoleColor]::Yellow
$Red = [System.ConsoleColor]::Red

function Write-Color {
    param($Color, $Text)
    Write-Host $Text -ForegroundColor $Color
}

Write-Color $Green "========================================"
Write-Color $Green "  MiMo-Code Windows Installer"
Write-Color $Green "========================================"
Write-Host ""

# Find the binary
$BinaryName = "mimo.exe"
$SearchPaths = @(
    "$PSScriptRoot\..\packages\opencode\dist\mimocode-windows-x64\bin\$BinaryName",
    "$PSScriptRoot\..\dist\mimocode-windows-x64\bin\$BinaryName"
)

$BinaryPath = $null
foreach ($p in $SearchPaths) {
    $resolved = Resolve-Path $p -ErrorAction SilentlyContinue
    if ($resolved) {
        $BinaryPath = $resolved.Path
        break
    }
}

if (-not $BinaryPath) {
    Write-Color $Red "Error: $BinaryName not found."
    Write-Host "Please build the binary first:"
    Write-Host "  cd packages/opencode && bun run build:dev"
    exit 1
}

Write-Color $Yellow "Found binary: $BinaryPath"
Write-Host ""

# Create installation directory
Write-Host "Creating installation directory..."
New-Item -ItemType Directory -Force -Path $InstallPath | Out-Null
Write-Color $Green "  ✓ $InstallPath"

# Copy binary
Write-Host "Copying binary..."
Copy-Item -Path $BinaryPath -Destination "$InstallPath\$BinaryName" -Force
Write-Color $Green "  ✓ $InstallPath\$BinaryName ($([math]::Round((Get-Item "$InstallPath\$BinaryName").Length / 1MB, 1)) MB)"

# Copy README
$ReadmePath = "$PSScriptRoot\..\packages\opencode\dist\mimocode-windows-x64\README.md"
if (Test-Path $ReadmePath) {
    Copy-Item -Path $ReadmePath -Destination "$InstallPath\README.md" -Force
    Write-Color $Green "  ✓ README.md"
}

# Add to PATH
if ($AddToPath) {
    Write-Host "Adding to PATH..."
    $currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($currentPath -notlike "*$InstallPath*") {
        [Environment]::SetEnvironmentVariable("Path", "$currentPath;$InstallPath", "User")
        Write-Color $Green "  ✓ Added to user PATH"
    } else {
        Write-Color $Yellow "  Already in PATH"
    }
}

# Create Start Menu shortcut
if ($CreateShortcut) {
    Write-Host "Creating Start Menu shortcut..."
    $ShortcutDir = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\MiMo-Code"
    New-Item -ItemType Directory -Force -Path $ShortcutDir | Out-Null
    
    $WshShell = New-Object -ComObject WScript.Shell
    $Shortcut = $WshShell.CreateShortcut("$ShortcutDir\MiMo-Code CLI.lnk")
    $Shortcut.TargetPath = "$InstallPath\$BinaryName"
    $Shortcut.WorkingDirectory = "%USERPROFILE%"
    $Shortcut.Description = "MiMo-Code - AI-powered development tool"
    $Shortcut.Save()
    Write-Color $Green "  ✓ Start Menu shortcut created"
}

Write-Host ""
Write-Color $Green "========================================"
Write-Color $Green "  Installation complete!"
Write-Color $Green "========================================"
Write-Host ""
Write-Host "To start using MiMo-Code:"
Write-Host "  1. Open a new terminal"
Write-Host "  2. Run: mimo"
Write-Host ""
Write-Host "To uninstall, delete the directory:"
Write-Host "  $InstallPath"
Write-Host "  And remove it from your PATH environment variable."
Write-Host ""
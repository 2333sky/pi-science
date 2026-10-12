<#
.SYNOPSIS
    Command-line launcher for a Pi-Science checkout on Windows.

.DESCRIPTION
    Supports start, stop, status, and help. The run.state file is written by
    start.ps1 after both services are healthy, so stop can target the exact
    processes started by this checkout. Missing or stale identity never permits
    terminating a process solely because it occupies a configured port.
#>

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir ".."))
$RuntimeDir = Join-Path $ProjectDir ".runtime\pi-science"
$StateFile = Join-Path $RuntimeDir "run.state"

function Get-PositivePort {
    param([string]$EnvironmentName, [int]$Default)

    $raw = [Environment]::GetEnvironmentVariable($EnvironmentName, "Process")
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return $Default
    }
    $value = 0
    if (-not [int]::TryParse($raw, [ref]$value) -or $value -lt 1 -or $value -gt 65535) {
        throw "$EnvironmentName must be an integer between 1 and 65535."
    }
    return $value
}

function Read-RunState {
    if (-not (Test-Path -LiteralPath $StateFile -PathType Leaf)) {
        return $null
    }
    try {
        return (Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Test-PortListening {
    param([int]$Port)

    $client = $null
    try {
        $client = [System.Net.Sockets.TcpClient]::new()
        $client.Connect("127.0.0.1", $Port)
        return $true
    } catch {
        return $false
    } finally {
        if ($null -ne $client) {
            $client.Close()
        }
    }
}

. (Join-Path $ScriptDir "process-identity.ps1")

function Remove-RunState {
    if (Test-Path -LiteralPath $StateFile -PathType Leaf) {
        Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
    }
}

function Stop-PiScience {
    param([int]$ControlPlanePort, [int]$FrontendPort)

    $state = Read-RunState
    $stopped = $false
    if ($null -ne $state) {
        foreach ($role in @("frontend", "control")) {
            if (Stop-OwnedPiProcess -State $state -Role $role -Checkout $ProjectDir) {
                $stopped = $true
            }
        }
        Remove-RunState
    }
    if (-not $stopped -and ((Test-PortListening $ControlPlanePort) -or (Test-PortListening $FrontendPort))) {
        Write-Output "Ports are occupied by unverified processes; no process was stopped."
        return
    }

    if ($stopped) {
        Write-Output "Pi-Science stopped."
    } else {
        Write-Output "Pi-Science is not running."
    }
}

function Show-PiStatus {
    param([int]$ControlPlanePort, [int]$FrontendPort)

    $state = Read-RunState
    $controlReady = Test-PortListening -Port $ControlPlanePort
    $frontendReady = Test-PortListening -Port $FrontendPort
    $stateProcess = $false
    if ($null -ne $state) {
        foreach ($property in @("control_pid", "frontend_pid")) {
            $processId = 0
            if (Test-OwnedPiProcess -State $state -Role ($property -replace "_pid$", "") -Checkout $ProjectDir) {
                $stateProcess = $true
            }
        }
    }

    if ($stateProcess) {
        Write-Output "Pi-Science: RUNNING"
    } else {
        Write-Output "Pi-Science: stopped"
    }
    if ($controlReady) {
        Write-Output "Node control plane: ready on port $ControlPlanePort"
    } else {
        Write-Output "Node control plane: not responding on port $ControlPlanePort"
    }
    if ($frontendReady) {
        Write-Output "Frontend: ready on port $FrontendPort"
    } else {
        Write-Output "Frontend: not responding on port $FrontendPort"
    }
    if ($null -ne $state) {
        Write-Output "State: $StateFile"
    }
    Write-Output "Checkout: $ProjectDir"
}

function Show-PiHelp {
    Write-Output @"
pi-science - Scientific AI Workbench

Usage:
  pi-science [start]       Start the control plane and frontend
  pi-science stop          Stop services started from this checkout
  pi-science status        Report what is currently running
  pi-science help          Show this message
"@
}

$command = "start"
$remaining = @()
if ($args.Count -gt 0) {
    $command = [string]$args[0]
    if ($args.Count -gt 1) {
        $remaining = @($args[1..($args.Count - 1)])
    }
}

switch ($command.ToLowerInvariant()) {
    "start" {
        $startScript = Join-Path $ScriptDir "start.ps1"
        if ($remaining.Count -gt 0) {
            & $startScript @remaining
        } else {
            & $startScript
        }
        exit $LASTEXITCODE
    }
    "stop" {
        $controlPort = Get-PositivePort -EnvironmentName "PI_SCIENCE_CONTROL_PLANE_PORT" -Default 8787
        $frontendPort = Get-PositivePort -EnvironmentName "PI_SCIENCE_FRONTEND_PORT" -Default 5173
        Stop-PiScience -ControlPlanePort $controlPort -FrontendPort $frontendPort
        exit 0
    }
    "status" {
        $controlPort = Get-PositivePort -EnvironmentName "PI_SCIENCE_CONTROL_PLANE_PORT" -Default 8787
        $frontendPort = Get-PositivePort -EnvironmentName "PI_SCIENCE_FRONTEND_PORT" -Default 5173
        Show-PiStatus -ControlPlanePort $controlPort -FrontendPort $frontendPort
        exit 0
    }
    "help" { Show-PiHelp; exit 0 }
    "-h" { Show-PiHelp; exit 0 }
    "--help" { Show-PiHelp; exit 0 }
    default {
        Write-Error "Unknown command: $command"
        Show-PiHelp
        exit 2
    }
}

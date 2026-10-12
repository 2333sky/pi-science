# Credential-free ownership regression tests; mocks CIM so they also run on POSIX.
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "process-identity.ps1")
$checkout = Join-Path ([System.IO.Path]::GetTempPath()) "pi science checkout"
$entry = Join-Path $checkout "apps/server/dist/app/main.js"
$token = "a" * 32
$created = [datetime]::UtcNow
$script:stops = 0
$script:process = [pscustomobject]@{ StartTime = $created; Path = "node.exe" }
$script:process | Add-Member -MemberType ScriptMethod -Name Kill -Value { $script:stops++ }
$script:command = 'node.exe "' + (Join-Path $checkout 'scripts/run-service.mjs') + '" --launch-token ' + $token + ' "' + $entry + '"'
function Get-Process { param($Id, $ErrorAction); return $script:process }
function Get-CimInstance { param($ClassName, $Filter, $ErrorAction); return [pscustomobject]@{ ProcessId = 123; ParentProcessId = 0; CreationDate = $created; CommandLine = $script:command } }
$state = [pscustomobject]@{ checkout = $checkout; mode = "production"; launch_token = $token; control_pid = 123; control_started = $created.ToUniversalTime().Ticks.ToString(); control_executable = "node.exe" }
function Assert-True { param($Value, $Message); if (-not $Value) { throw $Message } }
Assert-True (Test-OwnedPiProcess $state "control" $checkout) "Valid owned process rejected"
$state.control_started = "0"
Assert-True (-not (Stop-OwnedPiProcess $state "control" $checkout)) "Reused PID was stopped"
$state.control_started = $created.ToUniversalTime().Ticks.ToString()
Assert-True (-not (Stop-OwnedPiProcess $state "control" ($checkout + "-other"))) "Different checkout was stopped"
$state.control_executable = "other-node.exe"
Assert-True (-not (Stop-OwnedPiProcess $state "control" $checkout)) "Different executable was stopped"
$state.control_executable = "node.exe"
$script:command = 'node.exe "' + (Join-Path $checkout 'scripts/run-service.mjs') + '" --launch-token ' + $token + ' "' + $entry + '.other"'
Assert-True (-not (Stop-OwnedPiProcess $state "control" $checkout)) "Different entry point was stopped"
$script:command = 'node.exe "' + (Join-Path $checkout 'scripts/run-service.mjs') + '" --launch-token ' + ("b" * 32) + ' "' + $entry + '"'
Assert-True (-not (Stop-OwnedPiProcess $state "control" $checkout)) "Different launch token was stopped"
Assert-True (-not (Stop-OwnedPiProcess $null "control" $checkout)) "Missing state was accepted"
Assert-True ($script:stops -eq 0) "An unverified process was killed"
$script:command = 'node.exe "' + (Join-Path $checkout 'scripts/run-service.mjs') + '" --launch-token ' + $token + ' "' + $entry + '"'
Assert-True (Stop-OwnedPiProcess $state "control" $checkout) "Valid process could not be stopped"
Assert-True ($script:stops -eq 1) "Valid process was not killed exactly once"
Write-Output "Windows process ownership tests passed."

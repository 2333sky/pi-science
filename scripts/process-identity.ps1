# Shared Windows process ownership checks. A PID or port alone is never identity.
function Test-OwnedPiProcess {
    param($State, [string]$Role, [string]$Checkout)
    try {
        if ($null -eq $State -or $State.checkout -ine $Checkout -or $State.launch_token -notmatch '^[a-f0-9]{32}$') { return $false }
        $processId = [int]$State.($Role + "_pid")
        if ($processId -le 0) { return $false }
        $process = Get-Process -Id $processId -ErrorAction Stop
        if ($process.StartTime.ToUniversalTime().Ticks.ToString() -ne $State.($Role + "_started")) { return $false }
        $entry = if ($Role -eq "frontend") { "frontend\node_modules\vite\bin\vite.js" } elseif ($State.mode -eq "production") { "apps\server\dist\app\main.js" } elseif ($State.mode -eq "dev") { "apps\server\src\app\main.ts" } else { return $false }
        if ($process.Path -ine $State.($Role + "_executable")) { return $false }
        $command = (Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop).CommandLine
        return ($command.IndexOf(('"' + (Join-Path $Checkout $entry) + '"'), [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $command.Contains("--launch-token " + $State.launch_token + " ") -and $command.IndexOf(('"' + (Join-Path $Checkout "scripts/run-service.mjs") + '"'), [StringComparison]::OrdinalIgnoreCase) -ge 0)
    } catch { return $false }
}

function Stop-OwnedPiProcess {
    param($State, [string]$Role, [string]$Checkout)
    if (-not (Test-OwnedPiProcess -State $State -Role $Role -Checkout $Checkout)) { return $false }
    $root = [int]$State.($Role + "_pid")
    # Snapshot descendants while the verified root is alive, then fence each
    # termination with creation time so a reused PID cannot target another app.
    $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $ids = @($root)
    do {
        $previousCount = $ids.Count
        foreach ($item in $all) {
            if ($ids -contains [int]$item.ParentProcessId -and $ids -notcontains [int]$item.ProcessId) { $ids += [int]$item.ProcessId }
        }
    } while ($ids.Count -gt $previousCount)
    if (-not (Test-OwnedPiProcess -State $State -Role $Role -Checkout $Checkout)) { return $false }
    [array]::Reverse($ids)
    foreach ($processId in $ids) {
        $snapshot = $all | Where-Object { [int]$_.ProcessId -eq $processId } | Select-Object -First 1
        $current = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($null -ne $current -and $null -ne $snapshot -and [Math]::Abs($current.StartTime.ToUniversalTime().Ticks - $snapshot.CreationDate.ToUniversalTime().Ticks) -lt 10) {
            try { $current.Kill() } catch { }
        }
    }
    return $true
}

[CmdletBinding()]
param(
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$nativeSource = Join-Path $repoRoot 'native-mvp\engine-cpp'
$nativeBuild = Join-Path $repoRoot 'native-mvp\build'
$nativeHost = Join-Path $nativeBuild 'native_bridge_host.exe'
$localStateRoot = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { $env:TEMP }
$runtimeDirectory = Join-Path $localStateRoot 'WebRC505MKII\26_27_WebRC\dev-all'
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null

function Get-CommandPath([string]$Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    return $null
}

function Get-MsvcToolchain {
    $roots = New-Object 'System.Collections.Generic.List[string]'
    if ($env:VSINSTALLDIR) { $roots.Add($env:VSINSTALLDIR.TrimEnd('\')) }

    $vswhereCandidates = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'),
        (Join-Path $env:ProgramFiles 'Microsoft Visual Studio\Installer\vswhere.exe')
    )
    foreach ($vswhere in $vswhereCandidates) {
        if (Test-Path -LiteralPath $vswhere -PathType Leaf) {
            $discovered = & $vswhere -all -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
            foreach ($root in $discovered) {
                if ($root) { $roots.Add(([string]$root).TrimEnd('\')) }
            }
            break
        }
    }
    $roots.Add('D:\Applications\VisualStudio')

    $valid = @()
    $seen = @{}
    foreach ($root in $roots) {
        if (-not $root -or $seen.ContainsKey($root.ToLowerInvariant())) { continue }
        $seen[$root.ToLowerInvariant()] = $true
        $devCommand = Join-Path $root 'Common7\Tools\VsDevCmd.bat'
        $ninja = Join-Path $root 'Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe'
        $toolRoot = Join-Path $root 'VC\Tools\MSVC'
        if (-not (Test-Path -LiteralPath $devCommand -PathType Leaf) -or
            -not (Test-Path -LiteralPath $ninja -PathType Leaf) -or
            -not (Test-Path -LiteralPath $toolRoot -PathType Container)) { continue }

        foreach ($toolset in Get-ChildItem -LiteralPath $toolRoot -Directory -ErrorAction SilentlyContinue) {
            $compiler = Join-Path $toolset.FullName 'bin\Hostx64\x64\cl.exe'
            if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { continue }
            try { $version = [version]$toolset.Name } catch { $version = [version]'0.0' }
            $valid += [pscustomobject]@{
                Root = $root
                DevCommand = $devCommand
                Ninja = $ninja
                Compiler = $compiler
                Version = $version
                IsEnvironmentChoice = ($env:VSINSTALLDIR -and $root -ieq $env:VSINSTALLDIR.TrimEnd('\'))
            }
        }
    }

    $explicitChoice = $valid | Where-Object IsEnvironmentChoice | Sort-Object Version -Descending | Select-Object -First 1
    if ($explicitChoice) { return $explicitChoice }
    $selected = $valid | Sort-Object Version -Descending | Select-Object -First 1
    if (-not $selected) {
        throw 'No usable MSVC plus Ninja installation was found through VSINSTALLDIR, vswhere, or D:\Applications\VisualStudio.'
    }
    return $selected
}

function Import-MsvcEnvironment($Toolchain) {
    $command = 'call "' + $Toolchain.DevCommand + '" -arch=x64 -host_arch=x64 >nul && set'
    $environmentLines = & $env:ComSpec /d /s /c $command
    if ($LASTEXITCODE -ne 0) { throw "Could not initialize the MSVC environment using $($Toolchain.DevCommand)." }

    foreach ($line in $environmentLines) {
        $separator = ([string]$line).IndexOf('=')
        if ($separator -le 0) { continue }
        $name = ([string]$line).Substring(0, $separator)
        if ($name -match '^[A-Za-z_][A-Za-z0-9_]*$') {
            [Environment]::SetEnvironmentVariable($name, ([string]$line).Substring($separator + 1), 'Process')
        }
    }
    if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
        throw 'VsDevCmd completed, but cl.exe is not available in the selected x64 environment.'
    }
}

function Get-PortListener([int]$Port) {
    try {
        $connection = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($connection) {
            return [pscustomobject]@{ Port = $Port; ProcessId = [int]$connection.OwningProcess }
        }
    } catch {
        # Fall back to netstat on Windows installations without the NetTCPIP cmdlets.
    }

    $netstat = Get-CommandPath 'netstat.exe'
    if ($netstat) {
        $match = & $netstat -ano -p tcp 2>$null | Select-String (':{0}\s+.*LISTENING\s+(\d+)\s*$' -f $Port) | Select-Object -First 1
        if ($match -and $match.Matches[0].Groups[1].Value) {
            return [pscustomobject]@{ Port = $Port; ProcessId = [int]$match.Matches[0].Groups[1].Value }
        }
    }
    return $null
}

function Get-ProcessDetails([int]$ProcessId) {
    try {
        return Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    } catch {
        return $null
    }
}

function Test-NativeBridgeHealth {
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:17755/health' -Method Get -TimeoutSec 2
        return ($health.ok -eq $true)
    } catch {
        return $false
    }
}

function Test-ProjectUi([int]$Port) {
    try {
        $response = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/" -f $Port) -UseBasicParsing -TimeoutSec 2
        return ($response.StatusCode -eq 200 -and $response.Content -match '<title>\s*WebRC-505MKII v2\s*</title>')
    } catch {
        return $false
    }
}

function Test-PortCanBind([int]$Port) {
    $listener = $null
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
        $listener.Start()
        return $true
    } catch {
        return $false
    } finally {
        if ($listener) { $listener.Stop() }
    }
}

function Write-PidFile([string]$Name, [int]$ProcessId) {
    $pidPath = Join-Path $runtimeDirectory $Name
    Set-Content -LiteralPath $pidPath -Value $ProcessId -Encoding ASCII
    Write-Host ("PID {0} saved to {1}" -f $ProcessId, $pidPath)
}

function Read-LogTail([string]$Path) {
    if (Test-Path -LiteralPath $Path) {
        Get-Content -LiteralPath $Path -Tail 30 -ErrorAction SilentlyContinue
    }
}

$npmCommand = Get-CommandPath 'npm.cmd'
$nodeCommand = Get-CommandPath 'node.exe'
if (-not $npmCommand -or -not $nodeCommand) {
    throw 'Node.js and npm are required. Install a supported Node.js LTS release and rerun npm run dev:all.'
}
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'package-lock.json') -PathType Leaf)) {
    throw 'package-lock.json is required before this launcher can run npm ci.'
}

$existingNative = Get-PortListener 17755
$nativeProcess = $null
$reuseNative = $false
if ($existingNative) {
    $nativeProcess = Get-ProcessDetails $existingNative.ProcessId
    $nativeLeaf = if ($nativeProcess -and $nativeProcess.ExecutablePath) { [IO.Path]::GetFileName($nativeProcess.ExecutablePath) } else { '' }
    if ($nativeLeaf -eq 'native_bridge_host_simulation.exe') {
        throw "Port 17755 is owned by the no-audio simulation host (PID $($existingNative.ProcessId)). It was left running; stop that specific test host before retrying."
    }
    if ($nativeLeaf -ne 'native_bridge_host.exe' -or -not (Test-NativeBridgeHealth)) {
        throw "Port 17755 is occupied by an unverified process (PID $($existingNative.ProcessId)). It was left untouched; inspect it before retrying."
    }
    $reuseNative = $true
    Write-Host "Reusing regular Native bridge PID $($existingNative.ProcessId) at http://127.0.0.1:17755/health."
    Write-PidFile 'native_bridge_host.pid' $existingNative.ProcessId
}

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules') -PathType Container)) {
    Write-Host 'node_modules is missing; installing the locked JavaScript dependencies with npm ci.'
    Push-Location $repoRoot
    try {
        & $npmCommand ci
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }
    } finally {
        Pop-Location
    }
}

if (-not $reuseNative) {
    if ($SkipBuild) {
        if (-not (Test-Path -LiteralPath $nativeHost -PathType Leaf)) {
            throw "-SkipBuild was requested, but the regular Native host does not exist at $nativeHost."
        }
    } else {
        $cmakeCommand = Get-CommandPath 'cmake.exe'
        if (-not $cmakeCommand) {
            foreach ($candidate in @(
                'C:\Program Files\CMake\bin\cmake.exe',
                'D:\Applications\VisualStudio\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
            )) {
                if (Test-Path -LiteralPath $candidate -PathType Leaf) { $cmakeCommand = $candidate; break }
            }
        }
        if (-not $cmakeCommand) { throw 'CMake was not found on PATH or in the known Visual Studio installations.' }

        $toolchain = Get-MsvcToolchain
        Write-Host ("Using MSVC {0} from {1}" -f $toolchain.Version, $toolchain.Root)
        Write-Host ("Using Ninja at {0}" -f $toolchain.Ninja)
        Import-MsvcEnvironment $toolchain

        Push-Location $repoRoot
        try {
            & $cmakeCommand -S $nativeSource -B $nativeBuild -G Ninja `
                ("-DCMAKE_MAKE_PROGRAM:FILEPATH={0}" -f $toolchain.Ninja) `
                '-DCMAKE_BUILD_TYPE:STRING=Release' `
                '-DENABLE_ASIO:BOOL=OFF' `
                '-DNATIVE_PORTABLE_TESTS_ONLY:BOOL=OFF' `
                '-DNATIVE_BRIDGE_SIMULATION_ONLY:BOOL=OFF' `
                '-DNATIVE_ENABLE_RUBBERBAND_HQ:BOOL=OFF'
            if ($LASTEXITCODE -ne 0) { throw "Native CMake configure failed with exit code $LASTEXITCODE." }

            & $cmakeCommand --build $nativeBuild --config Release --target native_bridge_host --parallel
            if ($LASTEXITCODE -ne 0) { throw "Native host build failed with exit code $LASTEXITCODE." }
        } finally {
            Pop-Location
        }
    }

    if (-not (Test-Path -LiteralPath $nativeHost -PathType Leaf)) {
        throw "The regular Native host executable was not produced: $nativeHost"
    }

    $nativeStdout = Join-Path $runtimeDirectory 'native_bridge_host.stdout.log'
    $nativeStderr = Join-Path $runtimeDirectory 'native_bridge_host.stderr.log'
    $nativeProcess = Start-Process -FilePath $nativeHost -WorkingDirectory $nativeBuild -WindowStyle Hidden `
        -RedirectStandardOutput $nativeStdout -RedirectStandardError $nativeStderr -PassThru
    Write-PidFile 'native_bridge_host.pid' $nativeProcess.Id

    $nativeReady = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if (Test-NativeBridgeHealth) { $nativeReady = $true; break }
        $nativeProcess.Refresh()
        if ($nativeProcess.HasExited) { break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $nativeReady) {
        $nativeProcess.Refresh()
        if (-not $nativeProcess.HasExited) { Stop-Process -Id $nativeProcess.Id -Force -ErrorAction SilentlyContinue }
        Write-Host 'Native host startup logs:'
        Read-LogTail $nativeStdout
        Read-LogTail $nativeStderr
        throw 'The regular Native host did not become healthy at http://127.0.0.1:17755/health.'
    }
}

$viteCli = Join-Path $repoRoot 'node_modules\vite\bin\vite.js'
if (-not (Test-Path -LiteralPath $viteCli -PathType Leaf)) { throw "Vite was not found at $viteCli." }
$vitePort = $null
$viteProcessId = $null
foreach ($port in @(5173, 4173)) {
    $listener = Get-PortListener $port
    if ($listener) {
        if (Test-ProjectUi $port) {
            $vitePort = $port
            $viteProcessId = $listener.ProcessId
            Write-Host "Reusing the WebRC Vite UI already listening on port $port."
            break
        }
        Write-Host "Port $port belongs to another listener (PID $($listener.ProcessId)); leaving it untouched and trying the next allowed port."
        continue
    }
    if (-not (Test-PortCanBind $port)) {
        Write-Host "Port $port cannot be bound on this Windows host; trying the next allowed port."
        continue
    }

    $viteStdout = Join-Path $runtimeDirectory ("vite-{0}.stdout.log" -f $port)
    $viteStderr = Join-Path $runtimeDirectory ("vite-{0}.stderr.log" -f $port)
    $viteArguments = @('"' + $viteCli + '"', '--host', '127.0.0.1', '--port', [string]$port, '--strictPort')
    $viteProcess = Start-Process -FilePath $nodeCommand -ArgumentList $viteArguments -WorkingDirectory $repoRoot `
        -WindowStyle Hidden -RedirectStandardOutput $viteStdout -RedirectStandardError $viteStderr -PassThru

    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if (Test-ProjectUi $port) {
            $vitePort = $port
            $viteProcessId = $viteProcess.Id
            Write-Host "Started WebRC Vite UI on port $port."
            break
        }
        $viteProcess.Refresh()
        if ($viteProcess.HasExited) { break }
        Start-Sleep -Milliseconds 400
    }
    if ($vitePort) { break }

    $viteProcess.Refresh()
    if (-not $viteProcess.HasExited) { Stop-Process -Id $viteProcess.Id -Force -ErrorAction SilentlyContinue }
    Write-Host "Vite could not start on port $port. Logs: $viteStdout and $viteStderr"
}

if (-not $vitePort) { throw 'Vite could not start on port 5173 or 4173. Existing listeners were left untouched.' }
Write-PidFile ("vite-{0}.pid" -f $vitePort) $viteProcessId

Write-Host ''
Write-Host "Browser runtime: http://127.0.0.1:$vitePort/?audio=browser"
Write-Host "Native runtime:  http://127.0.0.1:$vitePort/?audio=native"
Write-Host 'Native bridge:   http://127.0.0.1:17755/health'
Write-Host ("Logs and PID files: {0}" -f $runtimeDirectory)
Write-Host 'Browser mode asks for microphone access after START AUDIO. Native mode connects to the regular WASAPI host.'

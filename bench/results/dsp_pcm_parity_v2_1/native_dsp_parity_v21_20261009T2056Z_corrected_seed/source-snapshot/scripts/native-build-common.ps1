function Resolve-NativeToolchain {
    [CmdletBinding()]
    param(
        [string]$VsInstallPath,
        [string]$VsWherePath,
        [string]$ToolsetVersion
    )

    $rootCandidates = New-Object 'System.Collections.Generic.List[object]'
    $vswhere = $null
    $explicitInstall = -not [string]::IsNullOrWhiteSpace($VsInstallPath)
    if ($explicitInstall) {
        Add-NativeVsRootCandidate -List $rootCandidates -Path $VsInstallPath -Source 'explicit parameter'
    } else {
        if (-not [string]::IsNullOrWhiteSpace($env:VSINSTALLDIR)) {
            Add-NativeVsRootCandidate -List $rootCandidates -Path $env:VSINSTALLDIR -Source 'VSINSTALLDIR environment'
        }
        if ($env:VCToolsInstallDir -match '^(?<root>.*?)[\\/]VC[\\/]Tools[\\/]MSVC[\\/](?<version>[^\\/]+)[\\/]?$') {
            Add-NativeVsRootCandidate -List $rootCandidates -Path $Matches.root -Source 'VCToolsInstallDir environment'
        }

        $vswhere = Resolve-NativeVsWhere -RequestedPath $VsWherePath
        if ($vswhere) {
            $installations = @(& $vswhere -all -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null)
            foreach ($installation in $installations) {
                Add-NativeVsRootCandidate -List $rootCandidates -Path ([string]$installation).Trim() -Source 'vswhere'
            }
        }

        foreach ($registryPath in @(
            'HKLM:\SOFTWARE\Microsoft\VisualStudio\SxS\VS7',
            'HKLM:\SOFTWARE\WOW6432Node\Microsoft\VisualStudio\SxS\VS7'
        )) {
            $registered = Get-ItemProperty -LiteralPath $registryPath -ErrorAction SilentlyContinue
            if ($registered) {
                foreach ($property in $registered.PSObject.Properties) {
                    if ($property.Name -notlike 'PS*' -and $property.Value -is [string]) {
                        Add-NativeVsRootCandidate -List $rootCandidates -Path $property.Value -Source 'Visual Studio registry'
                    }
                }
            }
        }
    }

    $matches = New-Object 'System.Collections.Generic.List[object]'
    foreach ($candidate in $rootCandidates) {
        $msvcRoot = Join-Path $candidate.Path 'VC\Tools\MSVC'
        if (-not (Test-Path -LiteralPath $msvcRoot -PathType Container)) { continue }
        foreach ($directory in (Get-ChildItem -LiteralPath $msvcRoot -Directory -ErrorAction SilentlyContinue)) {
            if (-not (Test-NativeToolsetVersion -InstalledVersion $directory.Name -RequestedVersion $ToolsetVersion)) { continue }
            $nmake = Join-Path $directory.FullName 'bin\Hostx64\x64\nmake.exe'
            $vcvars = Join-Path $candidate.Path 'VC\Auxiliary\Build\vcvarsall.bat'
            if (-not (Test-Path -LiteralPath $nmake -PathType Leaf) -or -not (Test-Path -LiteralPath $vcvars -PathType Leaf)) { continue }
            $versionObject = $null
            try { $versionObject = [version]$directory.Name } catch { continue }
            $versionPrefix = Get-NativeVcvarsVersionPrefix $directory.Name
            $matches.Add([pscustomobject]@{
                VsInstallPath = $candidate.Path
                VsWherePath = $vswhere
                ToolsetVersion = $directory.Name
                VcvarsVersion = $versionPrefix
                VcvarsPath = $vcvars
                NMakePath = $nmake
                Source = $candidate.Source
                SortVersion = $versionObject
                UsesCurrentEnvironment = $false
            })
        }
    }

    if ($matches.Count -gt 0) {
        return $matches | Sort-Object -Property SortVersion -Descending | Select-Object -First 1
    }

    if (-not $explicitInstall) {
        $clCommand = Get-Command cl.exe -ErrorAction SilentlyContinue | Select-Object -First 1
        $nmakeCommand = Get-Command nmake.exe -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($clCommand -and $nmakeCommand -and (-not [string]::IsNullOrWhiteSpace($env:INCLUDE) -or -not [string]::IsNullOrWhiteSpace($env:VCToolsInstallDir))) {
            $activeVersion = 'active-developer-environment'
            if ($clCommand.Source -match '[\\/]VC[\\/]Tools[\\/]MSVC[\\/](?<version>[^\\/]+)[\\/]bin[\\/]') {
                $activeVersion = $Matches.version
            }
            if (Test-NativeToolsetVersion -InstalledVersion $activeVersion -RequestedVersion $ToolsetVersion) {
                return [pscustomobject]@{
                    VsInstallPath = $env:VSINSTALLDIR
                    VsWherePath = $null
                    ToolsetVersion = $activeVersion
                    VcvarsVersion = $null
                    VcvarsPath = $null
                    NMakePath = $nmakeCommand.Source
                    Source = 'active developer environment on PATH'
                    SortVersion = $null
                    UsesCurrentEnvironment = $true
                }
            }
        }
    }

    $details = if ($ToolsetVersion) { " for toolset '$ToolsetVersion'" } else { '' }
    if ($explicitInstall) {
        throw "No usable x64 MSVC toolset$details was found under explicit Visual Studio path '$VsInstallPath'. Check -VsInstallPath and -ToolsetVersion."
    }
    throw "No usable x64 MSVC toolset$details was discovered. Pass -VsInstallPath, -VsWherePath, and/or -ToolsetVersion, or run from a configured VS developer prompt. No toolchain was downloaded or installed."
}

function Add-NativeVsRootCandidate {
    param(
        [System.Collections.Generic.List[object]]$List,
        [string]$Path,
        [string]$Source
    )
    if ([string]::IsNullOrWhiteSpace($Path)) { return }
    $fullPath = [System.IO.Path]::GetFullPath($Path.Trim().TrimEnd('\', '/'))
    foreach ($candidate in $List) {
        if ([string]::Equals($candidate.Path, $fullPath, [System.StringComparison]::OrdinalIgnoreCase)) { return }
    }
    $List.Add([pscustomobject]@{ Path = $fullPath; Source = $Source })
}

function Resolve-NativeVsWhere {
    param([string]$RequestedPath)
    if (-not [string]::IsNullOrWhiteSpace($RequestedPath)) {
        if (-not (Test-Path -LiteralPath $RequestedPath -PathType Leaf)) { throw "The specified vswhere executable was not found: $RequestedPath" }
        return [System.IO.Path]::GetFullPath($RequestedPath)
    }
    $command = Get-Command vswhere.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    $defaultPath = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path -LiteralPath $defaultPath -PathType Leaf) { return $defaultPath }
    return $null
}

function Test-NativeToolsetVersion {
    param([string]$InstalledVersion, [string]$RequestedVersion)
    if ([string]::IsNullOrWhiteSpace($RequestedVersion)) { return $true }
    return [string]::Equals($InstalledVersion, $RequestedVersion, [System.StringComparison]::OrdinalIgnoreCase) -or
        $InstalledVersion.StartsWith($RequestedVersion + '.', [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-NativeVcvarsVersionPrefix {
    param([string]$Version)
    if ($Version -match '^(?<major>\d+)\.(?<minor>\d+)(?:\.|$)') {
        return "$($Matches.major).$($Matches.minor)"
    }
    return $null
}

function Get-NativeFetchContentConfiguration {
    param(
        [string]$CachedDependencyRoot,
        [string]$FetchContentBaseDir
    )
    $entries = @(
        @{ Name = 'RTAUDIO_SRC'; Directory = 'rtaudio_src-src' },
        @{ Name = 'HTTPLIB_SRC'; Directory = 'httplib_src-src' },
        @{ Name = 'JSON_SRC'; Directory = 'json_src-src' }
    )
    $arguments = @("-DFETCHCONTENT_BASE_DIR=$FetchContentBaseDir")
    $used = @()
    $missing = @()
    foreach ($entry in $entries) {
        $sourcePath = if ([string]::IsNullOrWhiteSpace($CachedDependencyRoot)) { $null } else { Join-Path $CachedDependencyRoot $entry.Directory }
        if ($sourcePath -and (Test-Path -LiteralPath (Join-Path $sourcePath 'CMakeLists.txt') -PathType Leaf)) {
            $arguments += "-DFETCHCONTENT_SOURCE_DIR_$($entry.Name)=$([System.IO.Path]::GetFullPath($sourcePath))"
            $used += $entry.Directory
        } else {
            $missing += $entry.Directory
        }
    }
    if ($missing.Count -eq 0) {
        $arguments += '-DFETCHCONTENT_FULLY_DISCONNECTED=ON'
    } else {
        # Missing sources can be populated by normal CMake FetchContent under FetchContentBaseDir in TEMP.
        $arguments += '-DFETCHCONTENT_FULLY_DISCONNECTED=OFF'
    }
    return [pscustomobject]@{ Arguments = $arguments; CachedDependenciesUsed = $used; DependenciesFetchedIfNeeded = $missing }
}

function ConvertTo-NativeCmdArguments {
    param([string[]]$Arguments)
    return (($Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' ')
}

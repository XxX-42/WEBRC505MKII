param()
$ErrorActionPreference = 'Stop'
$archive = $PSScriptRoot
$sourceRoot = Join-Path $archive 'source'
$buildRoot = Join-Path $archive 'build'
function Get-SourceHashMap([string]$root) {
    $map = [ordered]@{}
    $files = Get-ChildItem -LiteralPath $root -Recurse -File | Sort-Object { $_.FullName.Substring($root.Length + 1) }
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($root.Length + 1).Replace('\', '/')
        $map[$relative] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    return $map
}
$started = [DateTime]::UtcNow.ToString('o')
$before = Get-SourceHashMap $sourceRoot
$before | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $buildRoot 'source-hashes-before.json') -Encoding utf8
& cmd.exe /d /c (Join-Path $archive 'build_release.cmd')
$buildExit = $LASTEXITCODE
$ended = [DateTime]::UtcNow.ToString('o')
$after = Get-SourceHashMap $sourceRoot
$after | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $buildRoot 'source-hashes-after.json') -Encoding utf8
$changes = @()
foreach ($key in $before.Keys) {
    if (!$after.Contains($key) -or $before[$key] -ne $after[$key]) { $changes += $key }
}
foreach ($key in $after.Keys) { if (!$before.Contains($key)) { $changes += $key } }
$result = [ordered]@{
    schemaVersion = 1
    command = 'build_release.cmd'
    startedUtc = $started
    endedUtc = $ended
    buildExitCode = $buildExit
    sourceHashCount = $before.Count
    sourceChangedDuringBuild = @($changes | Sort-Object -Unique)
    sourceHashesBefore = $before
    sourceHashesAfter = $after
}
$result | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $archive 'capture-result.json') -Encoding utf8
if ($buildExit -ne 0) { throw "Build failed with exit $buildExit" }
if ($changes.Count -ne 0) { throw "Compiler input changed during capture: $($changes -join ', ')" }

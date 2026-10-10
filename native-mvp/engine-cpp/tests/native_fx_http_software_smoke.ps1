param(
    [Parameter(Mandatory = $true)]
    [string]$ServerPath,
    [string]$ArtifactDirectory,
    [string]$BuildCommand = 'not recorded'
)

$ErrorActionPreference = 'Stop'
$serverPath = (Resolve-Path -LiteralPath $ServerPath).Path
$baseUrl = 'http://127.0.0.1:17755'
$script:httpLog = [System.Collections.Generic.List[object]]::new()
$script:scenario = 'Native software-only HTTP FX smoke; software mode skips RtAudio device enumeration and refuses physical-device configuration/start.'
$listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 17755 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    throw 'Port 17755 is already in use; refusing to connect to or stop an unrelated process.'
}

function Invoke-NativeJsonRequest {
    param(
        [Parameter(Mandatory = $true)][string]$Method,
        [Parameter(Mandatory = $true)][string]$Path,
        [AllowNull()][object]$Body
    )

    $request = [System.Net.HttpWebRequest]::Create("$baseUrl$Path")
    $request.Method = $Method
    $request.ContentType = 'application/json'
    $request.Timeout = 3000
    $requestJson = $null
    if ($null -ne $Body) {
        $requestJson = $Body | ConvertTo-Json -Depth 12 -Compress
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($requestJson)
        $request.ContentLength = $bytes.Length
        $stream = $request.GetRequestStream()
        try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
    }

    $response = $null
    try {
        $response = [System.Net.HttpWebResponse]$request.GetResponse()
    } catch [System.Net.WebException] {
        if ($null -eq $_.Exception.Response) { throw }
        $response = [System.Net.HttpWebResponse]$_.Exception.Response
    }
    try {
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
        try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
        $result = [pscustomobject]@{
            StatusCode = [int]$response.StatusCode
            Body = if ([string]::IsNullOrWhiteSpace($text)) { $null } else { $text | ConvertFrom-Json }
        }
        $script:httpLog.Add([pscustomobject]@{
            method = $Method
            path = $Path
            requestJson = $requestJson
            statusCode = $result.StatusCode
            responseText = $text
        })
        return $result
    } finally {
        $response.Dispose()
    }
}

function Get-MaxPcmDelta([object[]]$left, [object[]]$right) {
    if ($left.Count -ne $right.Count) { throw "PCM arrays differ in size ($($left.Count) vs $($right.Count))." }
    $maximum = 0.0
    for ($index = 0; $index -lt $left.Count; $index += 1) {
        $maximum = [Math]::Max($maximum, [Math]::Abs([double]$left[$index] - [double]$right[$index]))
    }
    return $maximum
}

$process = Start-Process -FilePath $serverPath -ArgumentList '--software-fx-test-host' -WindowStyle Hidden -PassThru
try {
    $ready = $false
    for ($attempt = 0; $attempt -lt 80; $attempt += 1) {
        if ($process.HasExited) { throw "Native bridge exited with code $($process.ExitCode)." }
        try {
            $probe = Invoke-NativeJsonRequest -Method GET -Path '/v2/fx/catalog' -Body $null
            if ($probe.StatusCode -eq 200 -and $probe.Body.ok) { $ready = $true; break }
        } catch {
            Start-Sleep -Milliseconds 100
        }
    }
    if (-not $ready) { throw 'Native FX HTTP endpoint did not become ready.' }

    $health = Invoke-NativeJsonRequest -Method GET -Path '/health' -Body $null
    $devices = Invoke-NativeJsonRequest -Method GET -Path '/v1/devices' -Body $null
    $initialStatus = Invoke-NativeJsonRequest -Method GET -Path '/v1/status' -Body $null
    if ($health.StatusCode -ne 200 -or -not $health.Body.softwareOnly -or
        @($health.Body.backends).Count -ne 0 -or
        $devices.StatusCode -ne 200 -or @($devices.Body.backends).Count -ne 0 -or
        $initialStatus.StatusCode -ne 200 -or -not $initialStatus.Body.softwareOnly -or
        $initialStatus.Body.engineRunning -or $initialStatus.Body.fxDspFaultCount -ne 0 -or
        $initialStatus.Body.lastFxDspFault -ne 'Ok') {
        throw 'Software-only mode must skip physical backend enumeration and publish clean software/DSP status.'
    }

    $hardwareConfig = [ordered]@{
        backend = 'WASAPI'; inputDeviceId = ''; outputDeviceId = '';
        sampleRate = 48000; bufferFrames = 128; monitoringEnabled = $false
    }
    $applyHardware = Invoke-NativeJsonRequest -Method POST -Path '/v1/config/apply' -Body $hardwareConfig
    $startHardware = Invoke-NativeJsonRequest -Method POST -Path '/v1/engine/start' -Body ([ordered]@{})
    $afterHardwareRequests = Invoke-NativeJsonRequest -Method GET -Path '/v1/status' -Body $null
    if ($applyHardware.StatusCode -ne 400 -or $applyHardware.Body.error -notmatch 'software-only' -or
        $startHardware.StatusCode -ne 400 -or $startHardware.Body.error -notmatch 'software-only' -or
        $afterHardwareRequests.Body.engineRunning -or -not $afterHardwareRequests.Body.softwareOnly) {
        throw 'Software-only mode must reject physical configuration/start and remain stopped.'
    }

    $catalog = $probe.Body.entries
    $radio = $catalog | Where-Object { $_.ordinal -eq 8 } | Select-Object -First 1
    if (-not $radio -or -not $radio.hostRouteable) { throw 'Radio is missing from the routeable Native FX catalog.' }
    $highPassId = ($radio.parameters | Where-Object { $_.name -eq 'highPassHz' } | Select-Object -First 1).id
    $lowPassId = ($radio.parameters | Where-Object { $_.name -eq 'lowPassHz' } | Select-Object -First 1).id
    if (-not $highPassId -or -not $lowPassId) { throw 'Radio coupling controls are missing from the real HTTP catalog.' }

    $initial = Invoke-NativeJsonRequest -Method GET -Path '/v2/fx/bank' -Body $null
    if ($initial.StatusCode -ne 200 -or $initial.Body.configured) { throw 'A fresh software FX host must start with an unconfigured bank.' }

    $emptySlot = [ordered]@{ enabled = $false; ordinal = 0; mix = 1; smoothingMs = 5; parameters = @() }
    $emptySlots = @($emptySlot, $emptySlot, $emptySlot, $emptySlot)
    $buses = @()
    $inputSlots = @($emptySlots)
    $inputSlots[0] = [ordered]@{ enabled = $true; ordinal = 8; mix = 1; smoothingMs = 5; parameters = @() }
    $buses += [ordered]@{ kind = 'input'; slots = $inputSlots }
    for ($trackIndex = 0; $trackIndex -lt 5; $trackIndex += 1) {
        $buses += [ordered]@{ kind = 'track'; trackIndex = $trackIndex; slots = @($emptySlots) }
    }
    $buses += [ordered]@{ kind = 'send'; slots = @($emptySlots) }
    $buses += [ordered]@{ kind = 'master'; slots = @($emptySlots) }
    $configuration = [ordered]@{ sampleRateHz = 48000; channels = 2; maxBlockFrames = 64; buses = $buses }

    $badShape = [ordered]@{ sampleRateHz = 48000; channels = 2; maxBlockFrames = 64; buses = @($buses | Select-Object -First 7) }
    $badPut = Invoke-NativeJsonRequest -Method PUT -Path '/v2/fx/bank' -Body $badShape
    $afterBadPut = Invoke-NativeJsonRequest -Method GET -Path '/v2/fx/bank' -Body $null
    if ($badPut.StatusCode -ne 400 -or $afterBadPut.Body.configured) {
        throw 'Malformed PUT must return an error without configuring the bank.'
    }

    $staged = Invoke-NativeJsonRequest -Method PUT -Path '/v2/fx/bank' -Body $configuration
    if ($staged.StatusCode -ne 200 -or -not $staged.Body.stageAccepted -or $staged.Body.adopted) {
        throw 'Valid PUT must report a staged but not callback-adopted software graph.'
    }
    $generation = $staged.Body.producerGeneration

    $invalidPair = [ordered]@{ events = @(
        [ordered]@{ absoluteFrame = 0; busIndex = 0; slotIndex = 0; parameterId = $highPassId; value = 5000 },
        [ordered]@{ absoluteFrame = 0; busIndex = 0; slotIndex = 0; parameterId = $lowPassId; value = 3000 }
    ) }
    $invalidPost = Invoke-NativeJsonRequest -Method POST -Path '/v2/fx/parameters' -Body $invalidPair
    $afterInvalidPost = Invoke-NativeJsonRequest -Method GET -Path '/v2/fx/bank' -Body $null
    $radioSlotAfterInvalid = $afterInvalidPost.Body.configuration.buses[0].slots[0]
    if ($invalidPost.StatusCode -ne 400 -or $radioSlotAfterInvalid.parameters.Count -ne 0 -or
        $afterInvalidPost.Body.producerGeneration -ne $generation) {
        throw 'Invalid coupled POST must preserve the accepted bank snapshot and graph generation.'
    }

    $validPair = [ordered]@{ events = @(
        [ordered]@{ absoluteFrame = 0; busIndex = 0; slotIndex = 0; parameterId = $highPassId; value = 1000 },
        [ordered]@{ absoluteFrame = 0; busIndex = 0; slotIndex = 0; parameterId = $lowPassId; value = 3000 }
    ) }
    $validPost = Invoke-NativeJsonRequest -Method POST -Path '/v2/fx/parameters' -Body $validPair
    $afterValidPost = Invoke-NativeJsonRequest -Method GET -Path '/v2/fx/bank' -Body $null
    $accepted = $afterValidPost.Body.configuration.buses[0].slots[0].parameters
    $acceptedHigh = $accepted | Where-Object { $_.id -eq $highPassId } | Select-Object -First 1
    $acceptedLow = $accepted | Where-Object { $_.id -eq $lowPassId } | Select-Object -First 1
    if ($validPost.StatusCode -ne 200 -or $acceptedHigh.value -ne 1000 -or $acceptedLow.value -ne 3000 -or
        $afterValidPost.Body.producerGeneration -ne $generation -or $afterValidPost.Body.adopted) {
        throw 'Valid compound POST must update the accepted target while keeping producer/adopted state distinct.'
    }

    $monitor = Invoke-NativeJsonRequest -Method POST -Path '/v1/monitoring' -Body ([ordered]@{ enabled = $true })
    if ($monitor.StatusCode -ne 200 -or -not $monitor.Body.monitoringEnabled) {
        throw 'The software-only host must be able to monitor its deterministic input blocks.'
    }

    $inputPcm = New-Object double[] (2048 * 2)
    for ($frame = 0; $frame -lt 2048; $frame += 1) {
        $inputPcm[$frame * 2] = 0.20
        $inputPcm[$frame * 2 + 1] = 0.05
    }
    function New-ManualPanConfiguration([double]$pan) {
        $manualPan = [ordered]@{
            enabled = $true; ordinal = 30; mix = 1; smoothingMs = 0;
            parameters = @(
                [ordered]@{ id = 48; value = 1 },
                [ordered]@{ id = 56; value = $pan }
            )
        }
        $emptyA = [ordered]@{ enabled = $false; ordinal = 0; mix = 1; smoothingMs = 5; parameters = @() }
        $busesForPan = [System.Collections.Generic.List[object]]::new()
        [void]$busesForPan.Add([ordered]@{ kind = 'input'; slots = @($manualPan, $emptyA, $emptyA, $emptyA) })
        for ($trackIndex = 0; $trackIndex -lt 5; $trackIndex += 1) {
            [void]$busesForPan.Add([ordered]@{ kind = 'track'; trackIndex = $trackIndex; slots = @($emptyA, $emptyA, $emptyA, $emptyA) })
        }
        [void]$busesForPan.Add([ordered]@{ kind = 'send'; slots = @($emptyA, $emptyA, $emptyA, $emptyA) })
        [void]$busesForPan.Add([ordered]@{ kind = 'master'; slots = @($emptyA, $emptyA, $emptyA, $emptyA) })
        return [ordered]@{ sampleRateHz = 48000; channels = 2; maxBlockFrames = 64; buses = $busesForPan.ToArray() }
    }
    function Invoke-ManualPanRender([double]$pan) {
        $put = Invoke-NativeJsonRequest -Method PUT -Path '/v2/fx/bank' -Body (New-ManualPanConfiguration $pan)
        if ($put.StatusCode -ne 200 -or -not $put.Body.stageAccepted -or $put.Body.adopted) {
            throw "Manual Pan $pan bank must report staged-but-not-yet-adopted before rendering."
        }
        $firstBlock = Invoke-NativeJsonRequest -Method POST -Path '/v2/software/render' -Body ([ordered]@{ inputStereo = $inputPcm })
        $snapshot = Invoke-NativeJsonRequest -Method GET -Path '/v2/fx/bank' -Body $null
        if ($firstBlock.StatusCode -ne 200 -or -not $firstBlock.Body.fxGraphAdopted -or
            $snapshot.StatusCode -ne 200 -or -not $snapshot.Body.adopted -or
            $snapshot.Body.activeGeneration -ne $put.Body.producerGeneration) {
            throw "Manual Pan $pan graph did not become callback-adopted after software blocks."
        }
        $measured = Invoke-NativeJsonRequest -Method POST -Path '/v2/software/render' -Body ([ordered]@{ inputStereo = $inputPcm })
        if ($measured.StatusCode -ne 200 -or $measured.Body.frames -ne 2048 -or
            $measured.Body.lastFxDspFault -ne 'Ok') {
            throw "Manual Pan $pan software render failed or reported a DSP fault."
        }
        return ,$measured.Body.outputStereo
    }
    $panA1 = Invoke-ManualPanRender -pan -1
    $panB = Invoke-ManualPanRender -pan 1
    $panA2 = Invoke-ManualPanRender -pan -1
    $maxPanDelta = Get-MaxPcmDelta -left $panA1 -right $panB
    $maxPanRepeatDelta = Get-MaxPcmDelta -left $panA1 -right $panA2
    if ($maxPanDelta -lt 0.02 -or $maxPanRepeatDelta -gt 0.000001) {
        throw "Software pump did not produce repeatable A/B/A PCM (max A/B=$maxPanDelta, A/A=$maxPanRepeatDelta)."
    }
    $panClock = Invoke-NativeJsonRequest -Method GET -Path '/v1/status' -Body $null
    if ($panClock.Body.nextAudioFrame -ne (3 * 4096) -or $panClock.Body.fxDspFaultCount -ne 0 -or
        $panClock.Body.lastFxDspFault -ne 'Ok' -or $null -eq $panClock.Body.lastFxDspFaultFrame -or
        $null -eq $panClock.Body.lastFxDspFaultCode) {
        throw 'Software render status must expose the advanced audio clock and DSP fault telemetry.'
    }

    function New-OscVocConfiguration {
        $osc = [ordered]@{
            enabled = $true; ordinal = 21; mix = 1; smoothingMs = 0;
            parameters = @(
                [ordered]@{ id = 48; value = 1 },
                [ordered]@{ id = 3; value = 1 },
                [ordered]@{ id = 91; value = 0 },
                [ordered]@{ id = 12; value = 8 },
                [ordered]@{ id = 13; value = 90 },
                [ordered]@{ id = 60; value = 0 }
            )
        }
        $emptyB = [ordered]@{ enabled = $false; ordinal = 0; mix = 1; smoothingMs = 5; parameters = @() }
        $midiBuses = [System.Collections.Generic.List[object]]::new()
        [void]$midiBuses.Add([ordered]@{ kind = 'input'; slots = @($osc, $emptyB, $emptyB, $emptyB) })
        for ($trackIndex = 0; $trackIndex -lt 5; $trackIndex += 1) {
            [void]$midiBuses.Add([ordered]@{ kind = 'track'; trackIndex = $trackIndex; slots = @($emptyB, $emptyB, $emptyB, $emptyB) })
        }
        [void]$midiBuses.Add([ordered]@{ kind = 'send'; slots = @($emptyB, $emptyB, $emptyB, $emptyB) })
        [void]$midiBuses.Add([ordered]@{ kind = 'master'; slots = @($emptyB, $emptyB, $emptyB, $emptyB) })
        return [ordered]@{ sampleRateHz = 48000; channels = 2; maxBlockFrames = 64; buses = $midiBuses.ToArray() }
    }
    $oscStaged = Invoke-NativeJsonRequest -Method PUT -Path '/v2/fx/bank' -Body (New-OscVocConfiguration)
    if ($oscStaged.StatusCode -ne 200 -or -not $oscStaged.Body.stageAccepted) {
        throw 'Typed-MIDI OSC VOC must be stageable on the software host.'
    }
    $oscWarm = Invoke-NativeJsonRequest -Method POST -Path '/v2/software/render' -Body ([ordered]@{ inputStereo = $inputPcm })
    $noMidiBaseline = Invoke-NativeJsonRequest -Method POST -Path '/v2/software/render' -Body ([ordered]@{ inputStereo = $inputPcm })
    if ($oscWarm.StatusCode -ne 200 -or $noMidiBaseline.StatusCode -ne 200) {
        throw 'OSC VOC must adopt and render before MIDI boundary comparisons.'
    }
    $midiStatus = Invoke-NativeJsonRequest -Method GET -Path '/v1/status' -Body $null
    $invalidStart = [uint64]$midiStatus.Body.nextAudioFrame
    $bankBeforeInvalidMidi = Invoke-NativeJsonRequest -Method GET -Path '/v2/fx/bank' -Body $null
    $badMidi = [ordered]@{ events = @(
        [ordered]@{ kind = 'midi'; absoluteFrame = ($invalidStart + 7); busIndex = 0; slotIndex = 0; midiType = 'NoteOn'; channel = 0; note = 60; velocity = 100 },
        [ordered]@{ kind = 'midi'; absoluteFrame = ($invalidStart + 8); busIndex = 0; slotIndex = 0; midiType = 'NoteOn'; channel = 0; note = 60; velocity = 128 }
    ) }
    $midiRejected = Invoke-NativeJsonRequest -Method POST -Path '/v2/fx/parameters' -Body $badMidi
    $bankAfterInvalidMidi = Invoke-NativeJsonRequest -Method GET -Path '/v2/fx/bank' -Body $null
    $invalidMidiRender = Invoke-NativeJsonRequest -Method POST -Path '/v2/software/render' -Body ([ordered]@{ inputStereo = $inputPcm })
    $invalidMidiPcmDelta = Get-MaxPcmDelta -left $noMidiBaseline.Body.outputStereo -right $invalidMidiRender.Body.outputStereo
    if ($midiRejected.StatusCode -ne 400 -or $invalidMidiRender.StatusCode -ne 200 -or
        $bankBeforeInvalidMidi.Body.producerGeneration -ne $bankAfterInvalidMidi.Body.producerGeneration -or
        $invalidMidiPcmDelta -gt 0.000001) {
        throw "Invalid typed MIDI batch changed the accepted generation or rendered PCM (delta=$invalidMidiPcmDelta)."
    }

    $midiStatus = Invoke-NativeJsonRequest -Method GET -Path '/v1/status' -Body $null
    $midiStart = [uint64]$midiStatus.Body.nextAudioFrame
    $midiBatch = [ordered]@{ events = @(
        [ordered]@{ kind = 'midi'; absoluteFrame = ($midiStart + 7); busIndex = 0; slotIndex = 0; midiType = 'NoteOn'; channel = 0; note = 60; velocity = 100 },
        [ordered]@{ kind = 'midi'; absoluteFrame = ($midiStart + 151); busIndex = 0; slotIndex = 0; midiType = 'NoteOff'; channel = 0; note = 60; velocity = 0 }
    ) }
    $midiPosted = Invoke-NativeJsonRequest -Method POST -Path '/v2/fx/parameters' -Body $midiBatch
    $midiRender = Invoke-NativeJsonRequest -Method POST -Path '/v2/software/render' -Body ([ordered]@{ inputStereo = $inputPcm })
    $midiPcmDelta = Get-MaxPcmDelta -left $noMidiBaseline.Body.outputStereo -right $midiRender.Body.outputStereo
    $midiFinal = Invoke-NativeJsonRequest -Method GET -Path '/v1/status' -Body $null
    if ($midiPosted.StatusCode -ne 200 -or $midiRender.StatusCode -ne 200 -or $midiPcmDelta -lt 0.00001 -or
        $midiFinal.Body.lastFxDspFault -ne 'Ok' -or $midiFinal.Body.fxDspFaultCount -ne 0) {
        throw "Typed MIDI event did not alter rendered stereo PCM or fault telemetry changed (PCM delta=$midiPcmDelta)."
    }

    $passText = "Native software HTTP FX smoke passed: no-enumeration software mode, hardware-operation rejection, callback fault status, strict bank schema and coupled-event rollback, real 64-frame software pumping with A/B/A adoption and PCM (A/B=$maxPanDelta, A/A=$maxPanRepeatDelta), typed MIDI rollback/render comparison (invalid delta=$invalidMidiPcmDelta, note delta=$midiPcmDelta)."
    if (-not [string]::IsNullOrWhiteSpace($ArtifactDirectory)) {
        $artifactPath = [System.IO.Path]::GetFullPath($ArtifactDirectory)
        if (Test-Path -LiteralPath $artifactPath) {
            throw "Artifact directory already exists; refusing to overwrite evidence: $artifactPath"
        }
        New-Item -ItemType Directory -Path $artifactPath | Out-Null

        $repoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
        $relativeInputs = @(
            'native-mvp/engine-cpp/include/native_audio_core.hpp',
            'native-mvp/engine-cpp/src/native_audio_core.cpp',
            'native-mvp/engine-cpp/src/native_bridge_host.cpp',
            'native-mvp/engine-cpp/include/native_fx_control.hpp',
            'native-mvp/engine-cpp/src/native_fx_control.cpp',
            'native-mvp/engine-cpp/include/native_fx_graph.hpp',
            'native-mvp/engine-cpp/src/native_fx_graph.cpp',
            'native-mvp/engine-cpp/include/native_track_host.hpp',
            'native-mvp/engine-cpp/src/native_track_host.cpp',
            'shared/dsp/include/webrc/dsp/fx_registry.hpp',
            'shared/dsp/src/fx_registry.cpp'
        )
        $sourceHashes = @(
            foreach ($relativePath in $relativeInputs) {
                $fullPath = Join-Path $repoRoot $relativePath
                if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
                    throw "Missing source input needed for HTTP smoke provenance: $relativePath"
                }
                [pscustomobject]@{
                    path = $relativePath.Replace('\\', '/')
                    sha256 = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
                }
            }
        )
        $scriptPath = (Resolve-Path -LiteralPath $PSCommandPath).Path
        $serverHash = (Get-FileHash -LiteralPath $serverPath -Algorithm SHA256).Hash.ToLowerInvariant()
        Copy-Item -LiteralPath $scriptPath -Destination (Join-Path $artifactPath 'native_fx_http_software_smoke.ps1')
        Copy-Item -LiteralPath $serverPath -Destination (Join-Path $artifactPath 'native_bridge_host.exe')
        $manifest = [ordered]@{
            schemaVersion = 1
            result = 'pass'
            capturedAtUtc = [DateTime]::UtcNow.ToString('o')
            scope = $script:scenario
            command = "powershell -ExecutionPolicy Bypass -File `"$scriptPath`" -ServerPath `"$serverPath`" -ArtifactDirectory `"$artifactPath`" -BuildCommand `"$BuildCommand`""
            buildCommand = $BuildCommand
            serverExecutable = [ordered]@{ path = 'native_bridge_host.exe'; sha256 = $serverHash }
            sourceInputs = $sourceHashes
            smokeScript = [ordered]@{
                path = 'native_fx_http_software_smoke.ps1'
                sha256 = (Get-FileHash -LiteralPath $scriptPath -Algorithm SHA256).Hash.ToLowerInvariant()
            }
            verificationBoundary = 'The process prepared a software-only NativeTrackHost and exercised the real HTTP server. `/v2/software/render` calls the same NativeTrackHost routing used by the production callback and processes in bounded 64-frame chunks. The smoke advances software audio frames and verifies graph adoption/PCM, but does not start a physical audio device, run a long-duration callback benchmark or qualify realtime performance.'
            httpRequests = @($script:httpLog)
        }
        $manifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $artifactPath 'manifest.json') -Encoding UTF8
        Set-Content -LiteralPath (Join-Path $artifactPath 'run.log') -Value @(
            "result: pass",
            "scope: $script:scenario",
            "build command: $BuildCommand",
            "server path: $serverPath",
            "server SHA256: $serverHash",
            $passText
        ) -Encoding UTF8
        $hashLines = @(
            Get-ChildItem -LiteralPath $artifactPath -File | Sort-Object Name | ForEach-Object {
                $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
                "$hash  $($_.Name)"
            }
        )
        Set-Content -LiteralPath (Join-Path $artifactPath 'SHA256SUMS') -Value $hashLines -Encoding ASCII
        Write-Output "$passText Artifact: $artifactPath"
    } else {
        Write-Output $passText
    }
} finally {
    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force
        $process.WaitForExit(3000) | Out-Null
    }
}

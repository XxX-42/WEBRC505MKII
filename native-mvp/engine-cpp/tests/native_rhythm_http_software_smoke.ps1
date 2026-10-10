param(
    [Parameter(Mandatory = $true)]
    [string]$ServerPath
)

$ErrorActionPreference = 'Stop'
$serverPath = (Resolve-Path -LiteralPath $ServerPath).Path
$baseUrl = 'http://127.0.0.1:17755'
$listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 17755 -State Listen -ErrorAction SilentlyContinue
if ($listener) { throw 'Port 17755 is already in use; refusing to connect to or stop an unrelated process.' }

function Invoke-NativeJsonRequest {
    param([string]$Method, [string]$Path, [AllowNull()][object]$Body)
    $request = [System.Net.HttpWebRequest]::Create("$baseUrl$Path")
    $request.Method = $Method
    $request.ContentType = 'application/json'
    $request.Timeout = 10000
    if ($null -ne $Body) {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 12 -Compress))
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
        return [pscustomobject]@{
            StatusCode = [int]$response.StatusCode
            Body = if ([string]::IsNullOrWhiteSpace($text)) { $null } else { $text | ConvertFrom-Json }
        }
    } finally { $response.Dispose() }
}

$process = Start-Process -FilePath $serverPath -ArgumentList '--software-fx-test-host' -WindowStyle Hidden -PassThru
try {
    $ready = $false
    for ($attempt = 0; $attempt -lt 80; $attempt += 1) {
        if ($process.HasExited) { throw "Native bridge exited with code $($process.ExitCode)." }
        try {
            $health = Invoke-NativeJsonRequest GET '/health' $null
            if ($health.StatusCode -eq 200 -and $health.Body.softwareOnly -and -not $health.Body.engineRunning) {
                $ready = $true
                break
            }
        } catch { Start-Sleep -Milliseconds 100 }
    }
    if (-not $ready) { throw 'Software-only Native bridge did not become ready.' }

    $initial = Invoke-NativeJsonRequest GET '/v2/rhythm/status' $null
    if ($initial.StatusCode -ne 200 -or -not $initial.Body.rhythm.prepared -or
        $initial.Body.rhythm.playing -or $initial.Body.rhythm.effectiveBpm -ne 120 -or
        $initial.Body.rhythm.effectiveVolume -ne 1) {
        throw 'Prepared rhythm status did not report its callback-published defaults.'
    }

    $malformed = Invoke-NativeJsonRequest POST '/v2/rhythm/volume' ([ordered]@{ volume = 0.5; surprise = $true })
    if ($malformed.StatusCode -ne 400) { throw 'Rhythm routes must reject unknown JSON fields strictly.' }

    $pattern = Invoke-NativeJsonRequest POST '/v2/rhythm/pattern-kit' ([ordered]@{
        absoluteFrame = 0; patternIndex = 0; kitIndex = 7
    })
    if ($pattern.StatusCode -ne 200 -or -not $pattern.Body.accepted -or $pattern.Body.acceptedFrame -ne 0) {
        throw 'Clean-room pattern/kit selection was not accepted at the requested sample frame.'
    }
    $start = Invoke-NativeJsonRequest POST '/v2/rhythm/start' ([ordered]@{
        absoluteFrame = 37; playIntro = $false
    })
    $tempo = Invoke-NativeJsonRequest POST '/v2/rhythm/tempo' ([ordered]@{
        absoluteFrame = 64; bpm = 300
    })
    $volume = Invoke-NativeJsonRequest POST '/v2/rhythm/volume' ([ordered]@{
        absoluteFrame = 128; volume = 0.25
    })
    $variation = Invoke-NativeJsonRequest POST '/v2/rhythm/variation' ([ordered]@{
        absoluteFrame = 256; variation = 1
    })
    $fill = Invoke-NativeJsonRequest POST '/v2/rhythm/fill' ([ordered]@{ absoluteFrame = 320 })
    $ending = Invoke-NativeJsonRequest POST '/v2/rhythm/ending' ([ordered]@{ absoluteFrame = 384 })
    $stop = Invoke-NativeJsonRequest POST '/v2/rhythm/stop' ([ordered]@{ absoluteFrame = 448 })
    foreach ($result in @($start, $tempo, $volume, $variation, $fill, $ending, $stop)) {
        if ($result.StatusCode -ne 200 -or -not $result.Body.accepted) {
            throw 'A typed rhythm command was rejected before rendering.'
        }
    }
    if ($start.Body.acceptedFrame -ne 37 -or $tempo.Body.acceptedFrame -ne 64 -or
        $volume.Body.acceptedFrame -ne 128 -or $tempo.Body.rhythm.loopTempoPolicy -ne 'sample-locked-no-tempo-resampling') {
        throw 'Rhythm command responses lost exact frame or shared-tempo policy metadata.'
    }

    $record = Invoke-NativeJsonRequest POST '/v2/tracks/1/record' ([ordered]@{})
    if ($record.StatusCode -ne 200) { throw 'Software-only Native track recording command was not accepted.' }

    # 120 BPM's opening 4/4 bar lasts 96,000 frames at 48 kHz. The @64
    # tempo event is intentionally bar-quantized and @448 stop is consumed at
    # a later bar boundary, so render through that transition while remaining
    # inside the software host's preallocated 3-second recording history.
    $totalFrames = 143000
    $chunkFrames = 2048
    $sumSquares = 0.0
    $peak = 0.0
    $rendered = 0
    while ($rendered -lt $totalFrames) {
        $frames = [Math]::Min($chunkFrames, $totalFrames - $rendered)
        $input = [double[]]::new($frames * 2)
        for ($index = 0; $index -lt $input.Length; $index += 2) {
            $input[$index] = 0.02
            $input[$index + 1] = -0.01
        }
        $render = Invoke-NativeJsonRequest POST '/v2/software/render' ([ordered]@{ inputStereo = $input })
        if ($render.StatusCode -ne 200 -or $render.Body.frames -ne $frames -or
            $render.Body.lastFxDspFault -ne 'Ok') {
            throw "Software rhythm render failed at frame $rendered."
        }
        foreach ($sample in $render.Body.outputStereo) {
            $value = [double]$sample
            $sumSquares += $value * $value
            $peak = [Math]::Max($peak, [Math]::Abs($value))
        }
        $rendered += $frames
    }

    $stopRecording = Invoke-NativeJsonRequest POST '/v2/tracks/1/stop' ([ordered]@{})
    if ($stopRecording.StatusCode -ne 200) { throw 'Software-only Native recording stop was not accepted.' }
    $drain = Invoke-NativeJsonRequest POST '/v2/software/render' ([ordered]@{
        inputStereo = [double[]]::new(128 * 2)
    })
    $final = Invoke-NativeJsonRequest GET '/v2/rhythm/status' $null
    $global = Invoke-NativeJsonRequest GET '/v1/status' $null
    $rms = [Math]::Sqrt($sumSquares / [double]($totalFrames * 2))
    if ($drain.StatusCode -ne 200 -or $final.StatusCode -ne 200 -or
        $final.Body.rhythm.playing -or $final.Body.rhythm.effectiveBpm -ne 300 -or
        $final.Body.rhythm.tempoPending -or $final.Body.rhythm.effectiveVolume -ne 0.25 -or
        $final.Body.rhythm.volumePending -or $final.Body.rhythm.triggerCount -le 0 -or
        $final.Body.rhythm.faultCount -ne 0 -or $global.Body.tracks[0].recordedFrames -lt 119000 -or
        $global.Body.tracks[0].state -ne 'Stopped' -or $rms -lt 0.0001 -or $peak -lt 0.001) {
        throw "Rhythm/recording HTTP PCM verification failed (playing=$($final.Body.rhythm.playing), bpm=$($final.Body.rhythm.effectiveBpm), volume=$($final.Body.rhythm.effectiveVolume), recorded=$($global.Body.tracks[0].recordedFrames), RMS=$rms, peak=$peak)."
    }
    Write-Output "Native software rhythm HTTP smoke passed: start@37, shared tempo@64→300 BPM on bar, volume@128→0.25 over10ms, stop@448, real stereo PCM RMS=$rms peak=$peak, simultaneous track1 recording=$($global.Body.tracks[0].recordedFrames) frames; no hardware opened."
} finally {
    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force
        $process.WaitForExit(3000) | Out-Null
    }
}

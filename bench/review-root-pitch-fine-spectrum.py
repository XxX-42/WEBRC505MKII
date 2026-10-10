"""Estimate the dominant pitch peak from preserved PCM; not a quality verdict."""
import hashlib
import json
from pathlib import Path
import sys

import numpy as np

folder = Path(sys.argv[1])
metadata = json.loads((folder / 'measurements.json').read_bytes())
raw = (folder / metadata['pcm']['file']).read_bytes()
digest = hashlib.sha256(raw).hexdigest()
assert digest == metadata['pcm']['sha256']
assert len(raw) == metadata['capturedFrames'] * 2 * 4
audio = np.frombuffer(raw, dtype='<f4').reshape(-1, 2)
audio = audio[metadata['analysisStartFrame']:].astype('float64')
assert len(audio) >= 4 and np.isfinite(audio).all()
sample_rate = metadata['sampleRateHz']
fft_size = 2 ** int(np.ceil(np.log2(len(audio) * 16)))
window = np.hanning(len(audio))
results = []
for channel in range(2):
    expected = metadata['measurements'][channel]['expectedFrequencyHz']
    magnitude = np.abs(np.fft.rfft(audio[:, channel] * window, n=fft_size))
    low = max(1, int(expected * .98 * fft_size / sample_rate))
    high = min(len(magnitude) - 1, int(expected * 1.02 * fft_size / sample_rate))
    assert high > low
    peak = low + int(np.argmax(magnitude[low:high]))
    values = np.log(np.maximum(magnitude[peak - 1:peak + 2], 1e-100))
    curvature = values[0] - 2 * values[1] + values[2]
    assert curvature < 0
    fraction = .5 * (values[0] - values[2]) / curvature
    frequency = (peak + fraction) * sample_rate / fft_size
    results.append({
        'channel': channel,
        'expectedFrequencyHz': expected,
        'dominantPeakInterpolatedHz': float(frequency),
        'dominantPeakCentsFromExpected': float(1200 * np.log2(frequency / expected)),
    })
report = {
    'scope': 'Offline preserved tone PCM diagnostic; not a current-module quality gate',
    'method': 'At least 16x zero-padded Hann FFT with local log-magnitude parabolic interpolation; strongest peak within +/-2 percent. Zero padding interpolates the spectrum, not independent spectral resolution.',
    'pcmSha256': digest,
    'fftSize': fft_size,
    'analysisFrames': len(audio),
    'results': results,
}
(folder / 'independent-fine-spectrum.json').write_bytes(
    (json.dumps(report, indent=2) + '\n').encode('utf-8'))
print(json.dumps(report, indent=2))

# Third-party notice: Native Signalsmith Stretch

The Native `LIVE_POLY` adapter vendors the official Signalsmith C++ headers so the build is offline and does not add a package-manager dependency.

- Signalsmith Stretch 1.3.2, upstream repository `https://github.com/Signalsmith-Audio/signalsmith-stretch`, source commit `a670068d9aeb64913331d5cc29337b19a457a7df`; header `include/signalsmith-stretch/signalsmith-stretch.h` SHA-256 `1188667959ac19dd40c0a6abbce694e44705615ec4f0e8db8af0f1cfb4c5dea7`.
- Signalsmith Linear 0.6.4, upstream repository `https://github.com/Signalsmith-Audio/linear`, source commit `de55e6a50ffcf6f8f43f649692d94691c7025151`. Active headers are copied into `include/signalsmith-linear/`: `stft.h` SHA-256 `7422ff5ddc2a017dc0587dcce99ce5ba30a2414bc2996081f6b00d56905d9b8c`, `fft.h` SHA-256 `fb55f69ac14cdbac66b9c76053069ff63bc36d18af20d8c028b9acc0aad6516a`; `approx.h` and `linear.h` are also included as dependencies.
- Both upstream projects declare the MIT License. Their full license texts are included as `SIGNALSMITH_STRETCH_LICENSE.txt` and `SIGNALSMITH_LINEAR_LICENSE.txt`.

The upstream source SHA-256 values at the pinned commits are: Stretch `signalsmith-stretch.h` `1188667959ac19dd40c0a6abbce694e44705615ec4f0e8db8af0f1cfb4c5dea7`; Linear `stft.h` `7422ff5ddc2a017dc0587dcce99ce5ba30a2414bc2996081f6b00d56905d9b8c`; and Linear `fft.h` `fb55f69ac14cdbac66b9c76053069ff63bc36d18af20d8c028b9acc0aad6516a`. The vendored Native copies differ only by removed leading indentation whitespace (and one whitespace-only space in Stretch): local `signalsmith-stretch.h` SHA-256 `ed7b282f3a8b8bcd62afd7668b8f2b9967c55a9b3d8ad1ec18d4f68e2d386315`, Linear `stft.h` `615f4e018d79b5d9943a9ab9b7e056a4e46f50ccdbb6f7eda5e4510ef8863193`, and Linear `fft.h` `490ba0f103e7fadee8ea5ffb2d5a748aa2e2b1fd50356edeb728da3cda5fb687`. Line-by-line comparison found no code-token or functional changes.

The adapter configures `SignalsmithStretch<float>` with `presetCheaper(2, sampleRate, true)`, the same split-computation preset used by Browser `LIVE_POLY`. No optional accelerator backend is enabled.

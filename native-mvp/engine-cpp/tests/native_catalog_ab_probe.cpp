// Deterministic catalog PCM across automation, bypass, reset and block boundaries.
#include "native_fx_catalog.hpp"
#include <cmath>
#include <cstdio>
#include <string_view>
#include <vector>
using namespace webrc::native;
int main() {
    for (unsigned rate : {44100U, 48000U}) {
        for (unsigned channels : {1U, 2U, 3U}) {
            for (std::string_view id : {"preamp", "dist", "reverb"}) {
                auto effect = createNativeEffectProcessor(id);
                if (!effect || !effect->prepare(rate)) return 1;
                std::vector<float> pcm(5001U * channels);
                for (unsigned block = 0; block < 48; ++block) {
                    if (block % 5 == 0) {
                        bool okay = true;
                        if (id == "preamp") {
                            okay = effect->setParameter("model", (block / 5) % 5, 113) &&
                                effect->setParameter("gain", (block * 13) % 101, 73);
                        } else if (id == "dist") {
                            okay = effect->setParameter("drive_db", block % 37, 113) &&
                                effect->setParameter("mix_percent", (block * 7) % 101, 73);
                        } else {
                            okay = effect->setParameter("decay_seconds", 0.5f + (block % 8), 113) &&
                                effect->setParameter("wet_mix", (block % 10) * 0.1f, 73);
                        }
                        if (!okay) return 2;
                        effect->setBypassed((block / 5) % 2 == 1, 97);
                    }
                    if (block == 27) effect->resetState();
                    const unsigned frames = block % 11 == 0 ? 5001 : 1 + (block * 37) % 257;
                    for (unsigned f = 0; f < frames; ++f) {
                        for (unsigned ch = 0; ch < channels; ++ch) {
                            pcm[f * channels + ch] = block % 4 == 0 ? 0.0f :
                                0.17f * std::sin((block * 5001 + f) * (0.037f + ch * 0.029f));
                        }
                    }
                    (void)effect->processInPlace(pcm.data(), frames, channels);
                    if (effect->processingFaulted()) return 3;
                    for (unsigned i = 0; i < frames * channels; ++i) if (!std::isfinite(pcm[i])) return 4;
                    if (std::fwrite(pcm.data(), sizeof(float), frames * channels, stdout) != frames * channels) return 5;
                }
            }
        }
    }
}

from pathlib import Path
import sys
s=Path(sys.argv[1]).read_text()
s=s.replace('''    unsigned int historyIndex = state.cabinetWrite;
    for (unsigned int tap = 0U; tap < kCabinetIrTaps; ++tap) {
        cabinetOutput += parameters.cabinetCoefficients[tap] * state.cabinetHistory[historyIndex];
        if (historyIndex == 0U) historyIndex = kCabinetIrTaps - 1U;
        else --historyIndex;
    }''','''    const unsigned int firstCount = state.cabinetWrite + 1U;
    for (unsigned int tap = 0U; tap < firstCount; ++tap)
        cabinetOutput += parameters.cabinetCoefficients[tap] * state.cabinetHistory[state.cabinetWrite - tap];
    for (unsigned int tap = firstCount; tap < kCabinetIrTaps; ++tap)
        cabinetOutput += parameters.cabinetCoefficients[tap] * state.cabinetHistory[kCabinetIrTaps + state.cabinetWrite - tap];''')
s=s.replace('''    unsigned int historyIndex = state.inputWrite;
    float sum = 0.0f;
    for (unsigned int tap = phase; tap < kFirTaps; tap += kOversampling) {
        sum += interpolationTaps_[tap] * state.inputHistory[historyIndex];
        if (historyIndex == 0U) historyIndex = kPolyphaseTaps - 1U;
        else --historyIndex;
    }''','''    float sum = 0.0f;
    const unsigned int count = (kFirTaps - phase + kOversampling - 1U) / kOversampling;
    const unsigned int firstCount = std::min(state.inputWrite + 1U, count);
    for (unsigned int index = 0U; index < firstCount; ++index)
        sum += interpolationTaps_[phase + index * kOversampling] * state.inputHistory[state.inputWrite - index];
    for (unsigned int index = firstCount; index < count; ++index)
        sum += interpolationTaps_[phase + index * kOversampling] * state.inputHistory[kPolyphaseTaps + state.inputWrite - index];''')
s=s.replace('''        unsigned int historyIndex = state.reconstructionWrite;
        for (unsigned int tap = 0U; tap < kFirTaps; ++tap) {
            sum += reconstructionTaps_[tap] * state.reconstructionHistory[historyIndex];
            if (historyIndex == 0U) historyIndex = kFirTaps - 1U;
            else --historyIndex;
        }''','''        const unsigned int firstCount = state.reconstructionWrite + 1U;
        for (unsigned int tap = 0U; tap < firstCount; ++tap)
            sum += reconstructionTaps_[tap] * state.reconstructionHistory[state.reconstructionWrite - tap];
        for (unsigned int tap = firstCount; tap < kFirTaps; ++tap)
            sum += reconstructionTaps_[tap] * state.reconstructionHistory[kFirTaps + state.reconstructionWrite - tap];''')
Path(sys.argv[2]).write_text(s)

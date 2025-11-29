// phaser.ts
export function createPhaser(context: AudioContext, lfoFrequency: number, modDepth: number) {
    const input = context.createGain();
    const output = context.createGain();
    // 指定数组类型为 BiquadFilterNode[]
    const allpassFilters: BiquadFilterNode[] = [];
    const numFilters = 4;

    for (let i = 0; i < numFilters; i++) {
        const allpass = context.createBiquadFilter();
        allpass.type = 'allpass';
        allpass.frequency.value = 1000 + i * 100;
        allpassFilters.push(allpass);
    }

    // 建立滤波器链
    input.connect(allpassFilters[0]);
    for (let i = 0; i < numFilters - 1; i++) {
        allpassFilters[i].connect(allpassFilters[i + 1]);
    }
    allpassFilters[numFilters - 1].connect(output);

    // LFO 调制
    const lfo = context.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = lfoFrequency;
    const lfoGain = context.createGain();
    lfoGain.gain.value = modDepth;
    lfo.connect(lfoGain);
    // 将 lfoGain 连接到每个滤波器的 frequency 参数上
    allpassFilters.forEach(filter => {
        // 由于 filter.frequency 的类型是 AudioParam，没有 connect 方法，
        // 我们通过类型断言绕过 TS 检查
        (lfoGain as any).connect(filter.frequency);
    });
    lfo.start();

    return { input, output, lfo, lfoGain, filters: allpassFilters };
}

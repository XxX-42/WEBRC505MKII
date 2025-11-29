/**
 * Phaser 效果器示例
 *
 * 通过多个全通滤波器（Allpass Filters）与 LFO 调制实现移相效果，
 * 使得输入的音频信号获得“嗖嗖”的相移效果。
 *
 * 参数说明（均为 0~100 数值）：
 * - RATE：调制速度。示例中映射为 LFO 频率 [0.1Hz ~ 5Hz]。
 * - DEPTH：调制深度。示例中映射为 LFO 的增益，决定扫频范围（如 0~1500Hz）。
 * - RESONANCE：滤波器 Q 值，映射为 [0.5 ~ 20]，值越高效果越明显。
 * - MANUAL：中心频率。示例中映射为 [300Hz ~ 2000Hz]，作为各全通滤波器频率的基准。
 * - STEP RATE：步进速率。示例中，当值大于 0 时，LFO 改为方波以模拟步进效果，否则为正弦波。
 * - D.LEVEL：直达声电平。映射为干声增益（0~1）。
 * - E.LEVEL：效果声电平。映射为湿声增益（0~1）。
 * - STAGE：滤波器级数，可选 4、8、12 或 'BI-PHASE'（示例中将 'BI-PHASE' 视为 8 阶）。
 *
 * 使用示例：
 *   const audioCtx = new AudioContext();
 *   const phaser = new Phaser(audioCtx, {
 *     rate: 50,        // RATE = 50
 *     depth: 50,       // DEPTH = 50
 *     resonance: 50,   // RESONANCE = 50
 *     manual: 50,      // MANUAL = 50
 *     stepRate: 0,     // STEP RATE = 0（连续调制）
 *     dLevel: 100,     // 干声全开
 *     eLevel: 50,      // 湿声一半
 *     stage: '4'       // 4 阶滤波器
 *   });
 *
 *   // 将音源连接到 Phaser 输入，然后将 Phaser 输出连接到 destination
 *   sourceNode.connect(phaser.input);
 *   phaser.output.connect(audioCtx.destination);
 *
 *   // 后续实时调节参数，例如：
 *   phaser.setRate(80);
 *   phaser.setDepth(100);
 *   phaser.setStage('12');
 */

class Phaser {
    /**
     * @param {AudioContext} audioContext
     * @param {object} options
     * @param {number} [options.rate=50]        - RATE, 0~100
     * @param {number} [options.depth=50]       - DEPTH, 0~100
     * @param {number} [options.resonance=50]   - RESONANCE, 0~100
     * @param {number} [options.manual=50]      - MANUAL, 0~100
     * @param {number} [options.stepRate=0]     - STEP RATE, 0~100 (0 表示 OFF)
     * @param {number} [options.dLevel=100]     - D.LEVEL, 0~100
     * @param {number} [options.eLevel=50]      - E.LEVEL, 0~100
     * @param {string|number} [options.stage=4] - STAGE, 可选 4, 8, 12 或 'BI-PHASE'
     */
    constructor(audioContext, options = {}) {
        this.audioContext = audioContext;

        // 保存初始参数
        this.params = {
            rate:       options.rate       ?? 50,
            depth:      options.depth      ?? 50,
            resonance:  options.resonance  ?? 50,
            manual:     options.manual     ?? 50,
            stepRate:   options.stepRate   ?? 0,
            dLevel:     options.dLevel     ?? 100,
            eLevel:     options.eLevel     ?? 50,
            stage:      options.stage      ?? 4,
        };

        // 创建输入、输出、干/湿混合 Gain 节点
        this.input = audioContext.createGain();
        this.output = audioContext.createGain();
        this.dryGain = audioContext.createGain();
        this.wetGain = audioContext.createGain();

        // 干声通道： input -> dryGain -> output
        this.input.connect(this.dryGain);
        this.dryGain.connect(this.output);

        // 创建全通滤波器链，用于湿声通道
        this.allpassFilters = [];
        this._rebuildAllpassFilters();

        // LFO 用于调制全通滤波器的频率
        this.lfoOsc = audioContext.createOscillator();
        this.lfoGain = audioContext.createGain();
        this.lfoOsc.connect(this.lfoGain);
        // 连接 LFO 输出到所有全通滤波器的 frequency 参数
        this.allpassFilters.forEach(filter => {
            this.lfoGain.connect(filter.frequency);
        });
        this.lfoOsc.start();

        // 构建湿声通道： input -> wetChainInput -> (allpass chain) -> wetGain -> output
        this.wetChainInput = audioContext.createGain();
        this.input.connect(this.wetChainInput);
        if (this.allpassFilters.length > 0) {
            this.wetChainInput.connect(this.allpassFilters[0]);
            this.allpassFilters[this.allpassFilters.length - 1].connect(this.wetGain);
        } else {
            // 若无全通滤波器，直接传递
            this.wetChainInput.connect(this.wetGain);
        }
        this.wetGain.connect(this.output);

        // 根据初始参数更新各项
        this._updateRate();
        this._updateDepth();
        this._updateResonance();
        this._updateManual();
        this._updateStepRate();
        this._updateDLevel();
        this._updateELevel();
    }

    // ----- 公共接口，供外部设置参数 ----- //

    setRate(value) {
        this.params.rate = value;
        this._updateRate();
    }
    setDepth(value) {
        this.params.depth = value;
        this._updateDepth();
    }
    setResonance(value) {
        this.params.resonance = value;
        this._updateResonance();
    }
    setManual(value) {
        this.params.manual = value;
        this._updateManual();
    }
    setStepRate(value) {
        this.params.stepRate = value;
        this._updateStepRate();
    }
    setDLevel(value) {
        this.params.dLevel = value;
        this._updateDLevel();
    }
    setELevel(value) {
        this.params.eLevel = value;
        this._updateELevel();
    }
    setStage(stage) {
        this.params.stage = stage;
        this._rebuildAllpassFilters();
        // 重新连接 LFO 到各滤波器，并更新 Q 值
        this.allpassFilters.forEach(filter => {
            this.lfoGain.connect(filter.frequency);
            filter.Q.value = this._mapResonance(this.params.resonance);
        });
    }

    // ----- 内部更新方法 ----- //

    _updateRate() {
        // 将 0~100 映射为 LFO 频率范围 [0.1Hz ~ 5Hz]
        const minHz = 0.1, maxHz = 5;
        const normalized = this.params.rate / 100;
        const freq = minHz + (maxHz - minHz) * normalized;
        this.lfoOsc.frequency.value = freq;
    }

    _updateDepth() {
        // 将 0~100 映射为 LFO 增益，控制扫频范围（例如最大范围设为 1500Hz）
        const maxSweep = 1500;
        const sweep = (this.params.depth / 100) * maxSweep;
        this.lfoGain.gain.value = sweep;
    }

    _updateResonance() {
        // 将 0~100 映射为 Q 值 [0.5 ~ 20]
        const qValue = this._mapResonance(this.params.resonance);
        this.allpassFilters.forEach(filter => {
            filter.Q.value = qValue;
        });
    }
    _mapResonance(x) {
        const minQ = 0.5, maxQ = 20;
        const normalized = x / 100;
        return minQ + (maxQ - minQ) * normalized;
    }

    _updateManual() {
        // 将 0~100 映射为中心频率 [300Hz ~ 2000Hz]，并为各滤波器添加偏移
        const minF = 300, maxF = 2000;
        const baseFreq = minF + (maxF - minF) * (this.params.manual / 100);
        this.allpassFilters.forEach((filter, i) => {
            const offset = i * 50;
            filter.frequency.value = baseFreq + offset;
        });
    }

    _updateStepRate() {
        // STEP RATE 大于 0 则用方波模拟步进调制，否则使用正弦波
        if (this.params.stepRate > 0) {
            this.lfoOsc.type = 'square';
        } else {
            this.lfoOsc.type = 'sine';
        }
    }

    _updateDLevel() {
        // 将干声电平 0~100 映射为 0.0~1.0
        this.dryGain.gain.value = this.params.dLevel / 100;
    }

    _updateELevel() {
        // 将湿声电平 0~100 映射为 0.0~1.0
        this.wetGain.gain.value = this.params.eLevel / 100;
    }

    // 重新创建全通滤波器链，用于改变 STAGE 参数
    _rebuildAllpassFilters() {
        // 断开旧滤波器的连接
        if (this.allpassFilters && this.allpassFilters.length > 0) {
            this.allpassFilters.forEach(filter => {
                filter.disconnect();
            });
        }
        this.allpassFilters = [];

        let stageCount;
        const stageOpt = this.params.stage;
        if (stageOpt === 'BI-PHASE') {
            // 示例中将 'BI-PHASE' 简单处理为 8 阶
            stageCount = 8;
        } else {
            stageCount = parseInt(stageOpt, 10) || 4;
        }

        // 创建并串联全通滤波器
        for (let i = 0; i < stageCount; i++) {
            const ap = this.audioContext.createBiquadFilter();
            ap.type = 'allpass';
            ap.frequency.value = 1000 + i * 50;
            ap.Q.value = 1;
            // 若前一个滤波器存在，则连接到当前滤波器
            if (i > 0) {
                this.allpassFilters[i - 1].connect(ap);
            }
            this.allpassFilters.push(ap);
        }
        // 将新创建的滤波器链末端连接到 wetGain
        if (this.allpassFilters.length > 0) {
            this.allpassFilters[this.allpassFilters.length - 1].disconnect();
            this.allpassFilters[this.allpassFilters.length - 1].connect(this.wetGain);
        }
    }
}

export { Phaser };

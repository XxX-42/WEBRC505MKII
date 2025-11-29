import { ref, onUnmounted, onMounted } from 'vue'

/**
 * 提供音频录制功能，并实时获取录音音量数据
 * @param trackState 外部传入的状态对象，用于更新录音状态、存储录音音频数据和实时音量电平
 *
 * trackState: {
 *   isRecording: boolean,
 *   audioBuffer: Blob | null,       // 第一次录音保存的音频
 *   overlayAudioBuffer?: Blob | null, // 叠录时保存的新音频 (可选)
 *   volume: number,                 // 实时音量电平
 * }
 */
export function useAudioRecorder(trackState: any) {
    // ============ 核心录音相关引用 ============
    const mediaRecorder = ref<MediaRecorder | null>(null)
    const audioChunks = ref<Blob[]>([])
    const audioContext = ref<AudioContext | null>(null)
    const analyserNode = ref<AnalyserNode | null>(null)
    const volumeData = ref<Uint8Array | null>(null)

    // ============ 全局麦克风流引用 (一次性获取) ============
    const globalStream = ref<MediaStream | null>(null)

    // ============ 用于叠录时播放旧音频 ============
    let playbackAudio: HTMLAudioElement | null = null

    /**
     * 组件/组合式函数挂载时：
     * 1. 一次性请求麦克风权限
     * 2. 将返回的 MediaStream 存在 globalStream 中
     */
    onMounted(async () => {
        try {
            // 若尚未获取过麦克风流，则请求一次权限并存储
            if (!globalStream.value) {
                globalStream.value = await navigator.mediaDevices.getUserMedia({ audio: true })
                console.log('Microphone permission granted, globalStream is ready.')
            }
        } catch (err) {
            console.error('Error requesting microphone permission on mount:', err)
        }
    })

    /**
     * 开始录音：使用 globalStream 创建 MediaRecorder 并进行叠录逻辑
     */
    const startRecording = async () => {
        try {
            // 如果已有已录制的音频 (第一次录音完成)，进入叠录模式：播放旧音频
            if (trackState.audioBuffer) {
                playbackAudio = new Audio(URL.createObjectURL(trackState.audioBuffer))
                playbackAudio.loop = true
                playbackAudio.volume = 1.0
                playbackAudio.play().catch(err => {
                    console.error('Error playing old track for overdub:', err)
                })
            }

            // ============ 关键改动：不再请求 getUserMedia，而是直接使用 globalStream ============
            if (!globalStream.value) {
                console.warn('No globalStream available. Did you forget to grant microphone permission?')
                return
            }

            // 使用已经获取的全局麦克风流
            mediaRecorder.value = new MediaRecorder(globalStream.value)

            // 初始化音频上下文及分析节点
            audioContext.value = new (window.AudioContext || window.webkitAudioContext)()
            analyserNode.value = audioContext.value.createAnalyser()
            analyserNode.value.fftSize = 256

            // 将麦克风流连接到 AnalyserNode，用于计算音量
            const microphone = audioContext.value.createMediaStreamSource(globalStream.value)
            microphone.connect(analyserNode.value)

            // 创建频谱数据数组，用于实时计算音量
            volumeData.value = new Uint8Array(analyserNode.value.frequencyBinCount)

            // 清空之前的音频数据
            audioChunks.value = []

            // 监听录音数据
            mediaRecorder.value.ondataavailable = (e: BlobEvent) => {
                audioChunks.value.push(e.data)
            }

            // 开始录音
            mediaRecorder.value.start()
            trackState.isRecording = true

            // 录音停止后，将音频数据保存到 trackState
            mediaRecorder.value.onstop = () => {
                const audioBlob = new Blob(audioChunks.value, { type: 'audio/wav' })

                if (!trackState.audioBuffer) {
                    // 第一次录音：保存到 audioBuffer
                    trackState.audioBuffer = audioBlob
                } else {
                    // 后续录音：保存到 overlayAudioBuffer (叠录)
                    trackState.overlayAudioBuffer = audioBlob
                    // 可在此处进行合并逻辑
                }

                audioChunks.value = []

                // 停止播放旧音频
                if (playbackAudio) {
                    playbackAudio.pause()
                    playbackAudio = null
                }
            }

            // 开始实时更新音量数据
            updateVolume()
        } catch (error) {
            console.error('Error starting recording:', error)
        }
    }

    /**
     * 停止录音
     */
    const stopRecording = () => {
        if (mediaRecorder.value) {
            mediaRecorder.value.stop()
            trackState.isRecording = false
        }
    }

    /**
     * 切换录音状态（开始/停止）
     */
    const toggleRecording = () => {
        if (trackState.isRecording) {
            stopRecording()
        } else {
            startRecording()
        }
    }

    /**
     * 实时更新音量数据，用于显示音量电平
     */
    const updateVolume = () => {
        if (analyserNode.value && volumeData.value) {
            // 获取当前频谱数据
            analyserNode.value.getByteFrequencyData(volumeData.value)
            // 从频谱数据中计算当前的最大音量值 (0~255)
            const volume = Math.max(...volumeData.value)
            // 归一化音量值（0~1）
            trackState.volume = volume / 256
        }

        // 若仍在录音，则持续实时更新
        if (trackState.isRecording) {
            requestAnimationFrame(updateVolume)
        }
    }

    /**
     * 组件卸载时清理音频上下文，防止内存泄漏
     */
    onUnmounted(() => {
        if (audioContext.value) {
            audioContext.value.close().catch(e => console.error(e))
        }
        if (playbackAudio) {
            playbackAudio.pause()
            playbackAudio = null
        }
    })

    return { toggleRecording }
}

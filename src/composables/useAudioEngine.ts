import { AudioEngine } from '@/audio/core/AudioEngine';

export function useAudioEngine() {
    const engine = AudioEngine.getInstance();

    const initAudio = async () => {
        try {
            await engine.init();
        } catch (error) {
            console.error('Failed to initialize Audio Engine:', error);
        }
    };

    return {
        engine,
        initAudio
    };
}

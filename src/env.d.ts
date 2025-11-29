declare module '*.vue' {
    import { DefineComponent } from "vue"
    const component: DefineComponent<{}, {}, any>
    export default component
}
declare module 'vue-knob-control' {
    import { DefineComponent } from 'vue';
    const VueKnobControl: DefineComponent<{}, {}, any>;
    export default VueKnobControl;
}


// src/env.d.ts
export {}

declare global {
    interface Window {
        globalEventBus: EventTarget
        myGlobalState: {
            bpm: number
            tracks: any[]
            updateBpm: (newBpm: number) => void
            updateTrack: (index: number, newState: object) => void
        }
    }
}

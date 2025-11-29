// src/main.ts
import { createApp } from 'vue'
import App from './App.vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';


const app = createApp(App)
const pinia = createPinia()
app.use(pinia)

// ✅ 确保 `window.globalEventBus` 存在
if (!window.globalEventBus) {
    window.globalEventBus = new EventTarget()
}

// ✅ 确保 `window.myGlobalState` 存在
if (!window.myGlobalState) {
    window.myGlobalState = {
        //定义默认bpm
        bpm: 130,
        tracks: [],
        updateBpm(newBpm: number) {
            this.bpm = newBpm
            window.globalEventBus.dispatchEvent(new CustomEvent('bpmUpdate', { detail: this.bpm }))
        },
        updateTrack(index: number, newState: object) {
            if (!this.tracks[index]) {
                this.tracks[index] = {}
            }
            Object.assign(this.tracks[index], newState)
            window.globalEventBus.dispatchEvent(new CustomEvent('trackUpdate', { detail: { index, newState } }))
        }
    }
}

app.use(ElementPlus);
app.mount('#app')

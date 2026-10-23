#include "native_audio_core.hpp"
#include "native_alloc_tracker.hpp"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <fstream>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <vector>

namespace webrc::native {
struct NativeAudioCoreTestAccess {
    template<class T> static T& object(T& value) { return value; }
    template<class T> static T& object(std::unique_ptr<T>& value) { return *value; }
    static void prepare(NativeAudioCore& core, unsigned int rate) {
        EngineConfig config; config.sampleRate = rate; config.bufferFrames = 128U;
        core.currentConfig_ = config; core.inputChannels_ = 2U;
        if (!core.looper_.prepare(rate, 1U, 2U)) throw std::runtime_error("prepare loop");
        for (auto& loop : core.additionalLoopers_) if (!loop.prepare(rate, 1U, 2U)) throw std::runtime_error("prepare loop");
        if (!object(core.outputStage_).prepare(rate) || !core.nativeInputFxBank_.prepare(rate) ||
            !object(core.nativePitchProcessor_).prepare(rate, 70, 1200) || !object(core.nativePolyPitchProcessor_).prepare(rate) ||
            !core.nativeRhythmEngine_.prepare(rate) || !core.nativeRhythmEngine_.setConfig(core.nativeRhythmConfig_, 0)) throw std::runtime_error("prepare DSP");
        core.looper_.applyCommand({CommandType::SetMonitoring, true});
    }
    static int callback(NativeAudioCore& core, const float* input, float* output, unsigned int frames) {
        return NativeAudioCore::audioCallback(output, const_cast<float*>(input), frames, 0, 0, &core);
    }
    static void command(NativeAudioCore& core, CommandType type, std::uint8_t track=0U) { if (!core.commandQueue_.push({type, false, track})) throw std::runtime_error("command queue"); }
    static void setRunning(NativeAudioCore& core) { core.engineRunning_.store(true); }
    static bool populatedEffectsHealthy(NativeAudioCore& core) {
        for(auto& bank:core.nativePerTrackFxBanks_) for(unsigned int slot=0;slot<2U;++slot) {
            auto* effect=bank.processor(static_cast<NativeEffectSlot>(slot));
            if(!effect || effect->isBypassed() || effect->processingFaulted()) return false;
        }
        return core.nativeInputFxBank_.hasEffects() && object(core.outputStage_).trackFxBank().hasEffects();
    }
    static std::size_t activeRhythmVoices(NativeAudioCore& core) { return core.nativeRhythmEngine_.activeVoiceCount(); }
    static void callbackWithCoreLocksHeld(NativeAudioCore& core, const float* input, float* output) {
        // A callback that tries any of these locks cannot return. Parent timeout is mandatory.
        std::atomic<bool> held{false}, release{false};
        std::thread holder([&] {
            std::scoped_lock locks(core.controlMutex_, core.loopSnapshotMutex_, core.commandProducerMutex_);
            held.store(true,std::memory_order_release);
            while (!release.load(std::memory_order_acquire)) std::this_thread::yield();
        });
        while (!held.load(std::memory_order_acquire)) std::this_thread::yield();
        test_alloc::beginTracking();
        const int result=callback(core, input, output, 128U);
        test_alloc::endTracking();
        release.store(true,std::memory_order_release);holder.join();
        if (result) throw std::runtime_error("lock probe callback");
    }
};
}
using namespace webrc::native;

int main(int argc, char** argv) {
    try {
        if (argc < 2) throw std::runtime_error("render input.f32 output.f32 rate dry|lpf OR perf callbacks scenario");
        const std::string command = argv[1];
        NativeAudioCore core;
        const unsigned int rate = command == "render" && argc > 4 ? static_cast<unsigned int>(std::stoul(argv[4])) : 48000U;
        NativeAudioCoreTestAccess::prepare(core, rate);
        if (command == "render") {
            if (argc != 6 || (std::string(argv[5]) != "dry" && std::string(argv[5]) != "lpf")) throw std::runtime_error("render arguments");
            if (std::string(argv[5]) == "lpf") {
                std::string error;
                if (!core.setNativeCatalogSlot(NativeEffectSlot::A, "filter.lpf", {{"cutoff_hz",1200.0f}, {"resonance_percent",15.0f}}, false, error, NativeCatalogFxPath::Input, 0U)) throw std::runtime_error(error);
            }
            std::ifstream input(argv[2], std::ios::binary | std::ios::ate);
            if (!input) throw std::runtime_error("open input");
            const auto bytes = input.tellg();
            if (bytes <= 0 || bytes % 8 != 0) throw std::runtime_error("expected stereo Float32LE");
            std::vector<float> samples(static_cast<std::size_t>(bytes) / sizeof(float)); input.seekg(0); input.read(reinterpret_cast<char*>(samples.data()), bytes);
            std::vector<float> output(samples.size());
            for (std::size_t frame = 0; frame < samples.size()/2U; frame += 128U) {
                const auto count = static_cast<unsigned int>(std::min<std::size_t>(128U, samples.size()/2U-frame));
                if (NativeAudioCoreTestAccess::callback(core, samples.data()+frame*2U, output.data()+frame*2U, count)) throw std::runtime_error("callback failed");
            }
            for (float sample : output) if (!std::isfinite(sample)) throw std::runtime_error("non-finite callback output");
            std::ofstream target(argv[3], std::ios::binary); target.write(reinterpret_cast<const char*>(output.data()), static_cast<std::streamsize>(output.size()*sizeof(float)));
            if (!target) throw std::runtime_error("write output");
            std::cout << "{\"status\":\"SOFTWARE_BASELINE\",\"renderer\":\"production-NativeAudioCore-audioCallback\",\"hardwareCapture\":false,\"frames\":" << output.size()/2U << "}\n";
            return 0;
        }
        if (command != "perf" || argc != 4) throw std::runtime_error("perf arguments");
        const unsigned int count = static_cast<unsigned int>(std::stoul(argv[2])); const std::string scenario = argv[3];
        if (count < 10000U || count > 1000000U || (scenario != "gate-meter" && scenario != "meter" && scenario != "mark-retained")) throw std::runtime_error("perf count/scenario (minimum 10000 callbacks)");
        std::vector<float> input(256U), output(256U); std::vector<double> times(count);
        for(unsigned int frame=0;frame<128U;++frame) { input[2U*frame]=0.03f*std::sin(static_cast<float>(frame)*6.28318530718f/128.0f);input[2U*frame+1U]=0.025f*std::sin(static_cast<float>(frame)*12.56637061436f/128.0f); }
        for(std::uint8_t track=0;track<5U;++track) {
            NativeAudioCoreTestAccess::command(core, CommandType::Record,track);
            for (unsigned int i=0; i<375U; ++i) NativeAudioCoreTestAccess::callback(core,input.data(),output.data(),128U);
            NativeAudioCoreTestAccess::command(core, CommandType::StopRecordOrPlayback,track); NativeAudioCoreTestAccess::callback(core,nullptr,output.data(),128U);
            NativeAudioCoreTestAccess::command(core, CommandType::Play,track); NativeAudioCoreTestAccess::callback(core,nullptr,output.data(),128U);
        }
        std::string configError;
        for(std::uint8_t track=1U;track<=5U;++track) {
            if(!core.setNativeCatalogSlot(NativeEffectSlot::A,"chorus",{},false,configError,NativeCatalogFxPath::Track,track) ||
               !core.setNativeCatalogSlot(NativeEffectSlot::B,"manual_pan",{},false,configError,NativeCatalogFxPath::Track,track)) throw std::runtime_error(configError);
        }
        if(!core.setNativeCatalogSlot(NativeEffectSlot::A,"filter.lpf",{{"cutoff_hz",1200.0f}},false,configError,NativeCatalogFxPath::Input,0U) ||
           !core.setNativeCatalogSlot(NativeEffectSlot::A,"reverb",{},false,configError,NativeCatalogFxPath::Track,0U)) throw std::runtime_error(configError);
        NativeRhythmConfig rhythm;rhythm.enabled=true;rhythm.volume=20U;
        if(!core.setNativeRhythmConfig(rhythm,configError)) throw std::runtime_error(configError);
        NativePitchConfig pitch;pitch.enabled=true;pitch.trackId=1U;pitch.semitones=3.0f;pitch.mode=NativePitchMode::LiveMonoKeepPitch;
        if(!core.setNativePitchConfig(pitch,configError)) throw std::runtime_error(configError);
        NativeAudioCoreTestAccess::setRunning(core);
        {
            const auto controlWithCallbackPump = [&](auto operation) {
                std::atomic<bool> done{false}; bool ok=false; std::string error;
                std::thread control([&] { ok=operation(error); done.store(true,std::memory_order_release); });
                while (!done.load(std::memory_order_acquire)) {
                    NativeAudioCoreTestAccess::callback(core,input.data(),output.data(),128U);
                    std::this_thread::sleep_for(std::chrono::microseconds(50));
                }
                control.join(); if(!ok) throw std::runtime_error(error);
            };
            controlWithCallbackPump([&](std::string& error) {return core.toggleTrackOverdub(0U,error);});
            NativeAudioCoreTestAccess::callback(core,input.data(),output.data(),128U);
            NativeAudioCoreTestAccess::command(core,CommandType::StopRecordOrPlayback);
            NativeAudioCoreTestAccess::callback(core,nullptr,output.data(),128U);
            NativeAudioCoreTestAccess::command(core,CommandType::Play);
            NativeAudioCoreTestAccess::callback(core,nullptr,output.data(),128U);
            if (scenario == "mark-retained") {
                controlWithCallbackPump([&](std::string& error) {return core.setTrackMark(0U,1U,error);});
                if(!core.getStatus().nativeTrackMarks[0U].exists) throw std::runtime_error("MARK snapshot missing");
            }
        }
        std::size_t rhythmVoicesObserved=0U;
        for (unsigned int i=0; i<1000U; ++i) { NativeAudioCoreTestAccess::callback(core,input.data(),output.data(),128U);rhythmVoicesObserved=std::max(rhythmVoicesObserved,NativeAudioCoreTestAccess::activeRhythmVoices(core)); }
        const auto accepted=core.getStatus();
        if(!accepted.nativeRhythmEnabled || !rhythmVoicesObserved || !accepted.nativePitchActive || !NativeAudioCoreTestAccess::populatedEffectsHealthy(core)) throw std::runtime_error("Integrated workload not active");
        for(auto state:accepted.nativeTrackStates) if(state!=LooperState::Playing) throw std::runtime_error("Five playing tracks required");
        NativeAudioCoreTestAccess::callbackWithCoreLocksHeld(core,input.data(),output.data());
        double peak=0; unsigned int deadlines=0; const double budget=1e9*128.0/48000.0;
        for (unsigned int i=0; i<count; ++i) {
            if (scenario == "gate-meter") { std::uint64_t revision=0; std::string error; if (!core.setNativeTrackFxApply(1U, i%2U != 0U, revision, error)) throw std::runtime_error(error); }
            test_alloc::beginTracking(); const auto start=std::chrono::steady_clock::now();
            const int code=NativeAudioCoreTestAccess::callback(core,input.data(),output.data(),128U);
            times[i]=std::chrono::duration<double,std::nano>(std::chrono::steady_clock::now()-start).count(); test_alloc::endTracking();
            if (code) throw std::runtime_error("perf callback");
            deadlines += times[i]>budget ? 1U : 0U;
            for(float sample:output) { if(!std::isfinite(sample)) throw std::runtime_error("nonfinite"); peak=std::max(peak,std::fabs(static_cast<double>(sample))); }
        }
        std::sort(times.begin(),times.end());
        const auto percentile=[&](double fraction) {return times[std::min<std::size_t>(count-1U,static_cast<std::size_t>(std::ceil(count*fraction))-1U)];};
        std::cout << "{\"status\":\"SOFTWARE_BASELINE\",\"scenario\":\""<<scenario<<"\",\"callbacks\":"<<count<<",\"warmupCallbacks\":1000,\"fivePlayingLoops\":true,\"perTrackFxSlots\":10,\"inputFxSlots\":1,\"sharedFxSlots\":1,\"pitchActive\":true,\"rhythmActive\":true,\"rhythmVoicesObserved\":"<<rhythmVoicesObserved<<",\"p50Ns\":"<<percentile(.5)<<",\"p99Ns\":"<<percentile(.99)<<",\"p999Ns\":"<<percentile(.999)<<",\"tailResolutionFraction\":"<<1.0/count<<",\"maxNs\":"<<times.back()<<",\"budgetNs\":"<<budget<<",\"deadlineExceedances\":"<<deadlines<<",\"peak\":"<<peak<<",\"callbackNewAllocations\":"<<test_alloc::count()<<",\"coreMutexesHeldDuringCompletedCallback\":3,\"globalMutexAcquisitions\":null,\"hardwareXruns\":null}\n";
        return test_alloc::count()==0U && peak>0 ? 0 : 2;
    } catch(const std::exception& error) { test_alloc::endTracking(); std::cerr<<error.what()<<"\n"; return 1; }
}

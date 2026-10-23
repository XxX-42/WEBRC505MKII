#include "native_audio_core.hpp"
#include <array>
#include <atomic>
#include <cassert>
#include <cmath>
#include <cstdlib>
#include <limits>
#include <iostream>
#include <new>
#include <string>
#include <thread>
#include <vector>

namespace {
thread_local bool inCallback=false;
thread_local std::size_t callbackAllocations=0U,callbackDeallocations=0U;
thread_local std::size_t callbacksObserved=0U;
}
void* operator new(std::size_t bytes) {
    if(inCallback) ++callbackAllocations;
    if(void* value=std::malloc(bytes ? bytes : 1U)) return value;
    throw std::bad_alloc();
}
void* operator new[](std::size_t bytes) {return ::operator new(bytes);}
void operator delete(void* value) noexcept {if(inCallback && value) ++callbackDeallocations;std::free(value);}
void operator delete[](void* value) noexcept {::operator delete(value);}
void operator delete(void* value,std::size_t) noexcept {::operator delete(value);}
void operator delete[](void* value,std::size_t) noexcept {::operator delete(value);}

namespace webrc::native {
struct NativeAudioCoreTestAccess {
    static void prepare(NativeAudioCore& core) {
        EngineConfig config;config.sampleRate=48000U;config.bufferFrames=128U;
        core.currentConfig_=config;core.inputChannels_=2U;
        assert(core.looper_.prepare(48000U,1U,2U));
        for(auto& loop:core.additionalLoopers_) assert(loop.prepare(48000U,1U,2U));
        assert(core.outputStage_->prepare(48000U));assert(core.nativeInputFxBank_.prepare(48000U));
        assert(core.nativePitchProcessor_->prepare(48000U,70.0f,1200.0f));
        assert(core.nativePolyPitchProcessor_->prepare(48000U));assert(core.nativeRhythmEngine_.prepare(48000U));
        assert(core.nativeRhythmEngine_.setConfig(core.nativeRhythmConfig_,0U));
    }
    static void run(NativeAudioCore& core,unsigned int kind,void* output,void* input,unsigned int frames=128U,unsigned int flags=0U) {
        inCallback=true;
        const int result=kind==0U ? NativeAudioCore::audioCallback(output,input,frames,0.0,flags,&core)
            : kind==1U ? NativeAudioCore::inputAudioCallback(nullptr,input,frames,0.0,flags,&core)
            : NativeAudioCore::outputAudioCallback(output,nullptr,frames,0.0,flags,&core);
        inCallback=false;
        ++callbacksObserved;
        assert(result==0);assert(callbackAllocations==0U);assert(callbackDeallocations==0U);
    }
    static void reset(NativeAudioCore& core) {core.resetRuntimeStateLocked();}
    static void running(NativeAudioCore& core,bool value) {core.engineRunning_.store(value);}
    static void fillAudioQueue(NativeAudioCore& core,bool nonFinite=false) {
        NativeAudioCore::AudioBlock block;block.frames=128U;block.samples.fill(0.25f);
        if(nonFinite) block.samples[0U]=std::numeric_limits<float>::quiet_NaN();
        while(core.outputQueue_.push(block)) {}
    }
    static void clearAndPrime(NativeAudioCore& core) {core.outputQueue_.clear();core.renderPrimed_.store(true);}
    static void prime(NativeAudioCore& core) {core.renderPrimed_.store(true);}
    static void duration(NativeAudioCore& core,std::uint64_t ns) {core.recordCallbackDuration(0U,128U,48000U,ns);}
    static void command(NativeAudioCore& core,CommandType type) {assert(core.commandQueue_.push({type,false,0U}));}
    static void hardwareOpenForProvenanceTest(NativeAudioCore& core) {core.markHardwareStreamOpened();}
    static void proveCoreLocksNotAcquired(NativeAudioCore& core,void* output,void* input) {
        std::atomic<bool> held{false},release{false};
        std::thread holder([&] {
            std::scoped_lock guard(core.controlMutex_,core.loopSnapshotMutex_,core.commandProducerMutex_);
            held.store(true,std::memory_order_release);
            while(!release.load(std::memory_order_acquire)) std::this_thread::yield();
        });
        while(!held.load(std::memory_order_acquire)) std::this_thread::yield();
        run(core,0U,output,input);
        release.store(true,std::memory_order_release);holder.join();
    }
};
}
using namespace webrc::native;

void testSeparateFlagsAndLifetimeReset() {
    NativeAudioCore core;NativeAudioCoreTestAccess::prepare(core);
    assert(!core.getStatus().callbackTelemetry.observed);
    std::array<float,256U> output{};
    for(unsigned int flag: {1U,2U,4U}) NativeAudioCoreTestAccess::run(core,0U,output.data(),nullptr,128U,flag);
    auto value=core.getStatus();
    assert(value.callbackTelemetry.callbackCount==3U);
    assert(value.callbackTelemetry.timingSamples==3U);
    assert((value.callbackTelemetry.statusFlags==std::array<std::uint64_t,3U>({1U,1U,1U})));
    assert(value.callbackTelemetry.hardwareCallbackCount==0U); // engineRunning is never provenance.
    assert(value.callbackTelemetry.audioQueueOverflow==0U && value.callbackTelemetry.audioQueueUnderflow==0U);
    assert(value.xrunsOrDropouts==3U);
    NativeAudioCoreTestAccess::reset(core);
    value=core.getStatus();
    assert(value.xrunsOrDropouts==0U);
    assert(value.callbackTelemetry.statusFlags[0U]==1U);
    assert(value.callbackTelemetry.callbackCount==3U && value.callbackTelemetry.runtimeResetCount==1U);
#if defined(NATIVE_CALLBACK_NO_HARDWARE)
    NativeAudioCoreTestAccess::hardwareOpenForProvenanceTest(core);
    NativeAudioCoreTestAccess::run(core,0U,output.data(),nullptr,128U,1U);
    assert(core.getStatus().callbackTelemetry.hardwareCallbackCount==0U);
#endif
}

void testEarlyReturnsAndOversizeAreTimed() {
    NativeAudioCore core;NativeAudioCoreTestAccess::prepare(core);
    std::array<float,256U> output{};
    NativeAudioCoreTestAccess::run(core,2U,nullptr,nullptr);
    NativeAudioCoreTestAccess::run(core,2U,output.data(),nullptr); // unprimed queue, not a dropout.
    NativeAudioCoreTestAccess::run(core,1U,nullptr,nullptr,4097U);
    NativeAudioCoreTestAccess::run(core,0U,nullptr,nullptr,4097U);
    NativeAudioCoreTestAccess::run(core,2U,nullptr,nullptr,4097U);
    const auto value=core.getStatus().callbackTelemetry;
    assert(value.callbackCount==5U && value.timingSamples==5U);
    assert(value.oversizeCallback==3U);
    assert(value.audioQueueUnderflow==0U && value.audioQueueOverflow==0U);
    assert((value.statusFlags==std::array<std::uint64_t,3U>{}));
    assert(value.callbacksByKind[2U]==3U);
}

void testAudioAndControlQueueCausesAreIndependent() {
    NativeAudioCore core;NativeAudioCoreTestAccess::prepare(core);
    std::array<float,256U> input{},output{};
    NativeAudioCoreTestAccess::fillAudioQueue(core);
    NativeAudioCoreTestAccess::run(core,1U,nullptr,input.data());
    auto value=core.getStatus().callbackTelemetry;
    assert(value.audioQueueOverflow==1U && value.audioQueueUnderflow==0U && value.controlQueueReject==0U);
    NativeAudioCoreTestAccess::clearAndPrime(core);
    NativeAudioCoreTestAccess::run(core,2U,output.data(),nullptr);
    value=core.getStatus().callbackTelemetry;
    assert(value.audioQueueOverflow==1U && value.audioQueueUnderflow==1U);
    assert((value.statusFlags==std::array<std::uint64_t,3U>{}));
    NativeAudioCoreTestAccess::running(core,true);
    std::string error;unsigned int rejected=0U;
    for(unsigned int index=0U;index<40U;++index) if(!core.setOutputLowPassEnabled(index%2U!=0U,error)) ++rejected;
    value=core.getStatus().callbackTelemetry;
    assert(rejected>0U && value.controlQueueReject==rejected);
    assert(value.audioQueueOverflow==1U && value.audioQueueUnderflow==1U);
    assert(core.getStatus().xrunsOrDropouts==2U); // control rejection is not an audio XRUN.
    NativeAudioCoreTestAccess::running(core,false);
}

void testNonFiniteInputAndOutputAreIndependent() {
    NativeAudioCore inputCore;NativeAudioCoreTestAccess::prepare(inputCore);
    std::array<float,256U> input{},output{};input[0U]=std::numeric_limits<float>::quiet_NaN();
    NativeAudioCoreTestAccess::run(inputCore,0U,nullptr,input.data());
    const auto in=inputCore.getStatus().callbackTelemetry;
    assert(in.nonFiniteInput==1U && in.nonFiniteOutput==0U);
    NativeAudioCore outputCore;NativeAudioCoreTestAccess::prepare(outputCore);
    NativeAudioCoreTestAccess::fillAudioQueue(outputCore,true);NativeAudioCoreTestAccess::prime(outputCore);
    NativeAudioCoreTestAccess::run(outputCore,2U,output.data(),nullptr);
    const auto out=outputCore.getStatus().callbackTelemetry;
    assert(out.nonFiniteInput==0U && out.nonFiniteOutput==1U);
    assert(out.statusFlags[0U]==0U && out.statusFlags[1U]==0U);
    assert(outputCore.getStatus().xrunsOrDropouts==0U);
}

void testDeterministicHistogramAndDeadlineClassification() {
    NativeAudioCore core;NativeAudioCoreTestAccess::prepare(core);
    NativeAudioCoreTestAccess::run(core,2U,nullptr,nullptr,0U);
    // Inject durations into the production sampler, not invented hardware timing.
    for(unsigned int index=0U;index<990U;++index) NativeAudioCoreTestAccess::duration(core,100000U);
    for(unsigned int index=0U;index<10U;++index) NativeAudioCoreTestAccess::duration(core,10000000U);
    auto value=core.getStatus().callbackTelemetry;
    assert(value.timingSamples==1001U && value.deadlineMiss==10U && value.deadlineEvaluatedCallbacks==1000U);
    assert(value.p99UpperBoundNs==150000U && value.p999UpperBoundNs==10050000U);
    assert(value.maximumDurationNs>=10000000U);
    for(unsigned int index=0U;index<10U;++index) NativeAudioCoreTestAccess::duration(core,30000000U);
    value=core.getStatus().callbackTelemetry;
    assert(value.durationHistogram.back()==10U && !value.p999UpperBoundNs);
    assert(value.audioQueueOverflow==0U && value.statusFlags[0U]==0U && value.statusFlags[1U]==0U);
}

void testGateMeterAndRealMarkCallbacksStayHeapFree() {
    NativeAudioCore core;NativeAudioCoreTestAccess::prepare(core);
    std::array<float,256U> input{},output{};input.fill(0.2f);
    NativeAudioCoreTestAccess::command(core,CommandType::Record);
    NativeAudioCoreTestAccess::run(core,0U,output.data(),input.data());
    NativeAudioCoreTestAccess::command(core,CommandType::StopRecordOrPlayback);
    NativeAudioCoreTestAccess::run(core,0U,output.data(),nullptr);
    NativeAudioCoreTestAccess::command(core,CommandType::Play);
    NativeAudioCoreTestAccess::run(core,0U,output.data(),nullptr);
    NativeAudioCoreTestAccess::running(core,true);
    std::uint64_t revision=0U;std::string error;
    assert(core.setNativeTrackFxApply(1U,false,revision,error));
    NativeAudioCoreTestAccess::run(core,0U,output.data(),nullptr);
    assert(core.getStatus().nativeTrackFxApply[0U].peak>0.1f);
    const auto controlWithPump=[&](auto operation) {
        std::atomic<bool> done{false};bool ok=false;std::string failure;
        std::thread control([&] {ok=operation(failure);done.store(true,std::memory_order_release);});
        while(!done.load(std::memory_order_acquire)) {NativeAudioCoreTestAccess::run(core,0U,output.data(),input.data());std::this_thread::yield();}
        control.join();assert(ok);
    };
    controlWithPump([&](std::string& failure) {return core.toggleTrackOverdub(0U,failure);});
    NativeAudioCoreTestAccess::run(core,0U,output.data(),input.data());
    assert(core.stopTrack(0U,error));NativeAudioCoreTestAccess::run(core,0U,output.data(),nullptr);
    assert(core.playTrack(0U,error));NativeAudioCoreTestAccess::run(core,0U,output.data(),nullptr);
    controlWithPump([&](std::string& failure) {return core.setTrackMark(0U,1U,failure);});
    assert(core.getStatus().nativeTrackMarks[0U].exists);
    NativeAudioCoreTestAccess::proveCoreLocksNotAcquired(core,output.data(),nullptr);
    const auto value=core.getStatus().callbackTelemetry;
    assert(value.observed && value.timingSamples==value.callbackCount);
    assert(value.hardwareCallbackCount==0U && callbackAllocations==0U && callbackDeallocations==0U);
    NativeAudioCoreTestAccess::running(core,false);
}

int main() {
    testSeparateFlagsAndLifetimeReset();testEarlyReturnsAndOversizeAreTimed();
    testAudioAndControlQueueCausesAreIndependent();testNonFiniteInputAndOutputAreIndependent();
    testDeterministicHistogramAndDeadlineClassification();testGateMeterAndRealMarkCallbacksStayHeapFree();
    std::cout<<"{\"testCases\":6,\"callbacksObserved\":"<<callbacksObserved
        <<",\"callbackCppNewAllocations\":"<<callbackAllocations<<",\"callbackCppDeallocations\":"<<callbackDeallocations
        <<",\"coreMutexHeldProbeCompleted\":true,\"hardwareValidated\":false}\n";
}

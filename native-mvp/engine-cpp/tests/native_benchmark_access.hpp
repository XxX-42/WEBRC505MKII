#pragma once
#include "native_audio_core.hpp"
#include <algorithm>
#include <cmath>
namespace webrc::native {
struct NativeAudioCoreTestAccess {
 static bool prepare(NativeAudioCore& c, unsigned rate, unsigned frames, unsigned inputChannels = 2, unsigned capacitySeconds = 1) {
  EngineConfig cfg; cfg.sampleRate=rate; cfg.bufferFrames=frames; c.currentConfig_=cfg; c.inputChannels_=inputChannels;
  if(!c.looper_.prepare(rate,capacitySeconds,2)) return false;
  for(auto& t:c.additionalLoopers_) if(!t.prepare(rate,capacitySeconds,2)) return false;
  c.nativeLooperMaxRecordSeconds_=capacitySeconds;
  return c.outputStage_->prepare(rate) && c.nativeInputFxBank_.prepare(rate) && c.nativePitchProcessor_->prepare(rate,70,1200) && c.nativePolyPitchProcessor_->prepare(rate) && c.nativeRhythmEngine_.prepare(rate) && c.nativeRhythmEngine_.setConfig(c.nativeRhythmConfig_,0);
 }
 static bool command(NativeAudioCore& c,CommandType t,unsigned track) {return c.commandQueue_.push({t,false,static_cast<std::uint8_t>(track)});}
 static int run(NativeAudioCore& c,const float* in,float* out,unsigned n){return NativeAudioCore::audioCallback(out,const_cast<float*>(in),n,0,0,&c);}
 static bool extraRoutesHealthy(const NativeAudioCore& c) {
  for(const auto* bank:{&c.nativeInputFxBank_,&c.outputStage_->trackFxBank()})for(unsigned s=0;s<4;++s){auto* p=bank->processor(static_cast<NativeEffectSlot>(s));if(!p||p->isBypassed()||p->processingFaulted())return false;}
  return c.nativeRhythmEngine_.enabled();
 }
 static std::size_t activeVoices(const NativeAudioCore& c){return c.nativeRhythmEngine_.activeVoiceCount();}
 static float inputFxPeak(const NativeAudioCore& c,unsigned frames){float p=0;for(unsigned i=0;i<frames*2;++i)p=std::max(p,std::fabs(c.nativeInputFxScratch_[i]));return p;}
 static std::size_t recordedFrames(const NativeAudioCore& c,unsigned track){return c.looperForTrack(track).metadata().recordedFrames;}
 static bool healthy(const NativeAudioCore& c,unsigned tracks) {
  for(unsigned t=0;t<tracks;++t) for(unsigned s=0;s<4;++s) {
   auto* p=c.nativePerTrackFxBanks_[t].processor(static_cast<NativeEffectSlot>(s));
   if(!p||p->isBypassed()||p->processingFaulted()) return false;
  }
  return true;
 }
};
}

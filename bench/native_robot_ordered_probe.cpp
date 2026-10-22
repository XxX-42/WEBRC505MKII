#include "native_robot_core.hpp"
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdint>
using webrc::native::NativeRobotCore;
template<class T> bool emit(T value){return std::fwrite(&value,sizeof value,1,stdout)==1;}
int main(){
 for(unsigned rate:{44100U,48000U,96000U})for(unsigned channels:{1U,2U})for(unsigned policy=0;policy<3;++policy){
  NativeRobotCore p;NativeRobotCore::Config c;c.sampleRate=rate;c.channels=channels;c.formantPolicy=static_cast<NativeRobotCore::FormantPolicy>(policy);
  if(!p.prepare(c))return 1;std::array<float,1024> a{};unsigned time=0;std::uint32_t rng=17;
  for(unsigned block=0;block<320;++block){
   if(block==170)p.reset();
   if(block%47==0&&(!p.setPitchSemitones(static_cast<float>(block%25)-12)||!p.setPitchMode(block%2?NativeRobotCore::PitchMode::FixedShift:NativeRobotCore::PitchMode::NearestSemitone)))return 2;
   const unsigned frames=1+(block*37)%511;
   for(unsigned f=0;f<frames;++f)for(unsigned ch=0;ch<channels;++ch){
    rng=rng*1664525U+1013904223U;
    const double phase=(time+f)*6.283185307179586/rate;
    a[f*channels+ch]=block<30?0:block<140?.14f*std::sin(phase*(220+ch*110)):block<200?(float(int(rng>>16)-32768)/32768.f)*.08f:.1f*(std::sin(phase*173)+std::sin(phase*281));
   }
   if(!p.processInterleaved(a.data(),frames,channels))return 3;
   for(unsigned i=0;i<frames*channels;++i)if(!std::isfinite(a[i]))return 4;
   if(std::fwrite(a.data(),sizeof(float),frames*channels,stdout)!=frames*channels)return 5;
   if(!emit(p.sourceFrequencyHz())||!emit(p.sourceConfidence())||!emit(p.sourceVoiced())||!emit(p.processingMode())||!emit(p.fallbackReason())||!emit(p.appliedPitchSemitones())||!emit(p.latencyFrames()))return 6;
   time+=frames;
  }
 }
}

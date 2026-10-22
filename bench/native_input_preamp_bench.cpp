// Device-free callback benchmark: CPU deadlines are not hardware XRUNs.
#include "native_audio_core.hpp"
#include "native_alloc_tracker.hpp"
#if defined(__linux__)
#include <sys/resource.h>
#endif
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <iostream>
#include <vector>
using namespace webrc::native;
#include "native_benchmark_access.hpp"
int main(int argc,char** argv){
 const unsigned rate=argc>1?std::stoul(argv[1]):48000, frames=argc>2?std::stoul(argv[2]):64, tracks=argc>3?std::stoul(argv[3]):5;
 const unsigned fxMode=argc>4?std::stoul(argv[4]):1; const bool fx=fxMode!=0;
 const std::string transport=argc>6?argv[6]:"playback";
 const unsigned channels=argc>7?std::stoul(argv[7]):2;
 const std::string supplement=argc>8?argv[8]:"none";
 const bool extras=supplement!="none";
 const unsigned count=argc>5?std::stoul(argv[5]):3000;
 if((rate!=44100&&rate!=48000)||(frames!=64&&frames!=128&&frames!=256)||(tracks!=1&&tracks!=5)||!count||channels<1||channels>2||fxMode>2||(transport!="playback"&&transport!="record"&&transport!="overdub")) return 1;
 NativeAudioCore core; if(!NativeAudioCoreTestAccess::prepare(core,rate,frames,channels,transport=="record"?60:1))return 2;
 std::vector<float> input(frames*2),output(frames*2);
 for(unsigned t=0;t<tracks;++t){
  if(!NativeAudioCoreTestAccess::command(core,CommandType::Record,t))return 3;
  for(unsigned b=0;b<rate/frames;++b){
   for(unsigned f=0;f<frames;++f){input[channels*f]=.08f*std::sin((b*frames+f)*(110.+t*31.)*6.28318530718/rate);if(channels==2)input[2*f+1]=.07f*std::cos((b*frames+f)*(173.+t*43.)*6.28318530718/rate);}
   if(NativeAudioCoreTestAccess::run(core,input.data(),output.data(),frames))return 3;
  }
  NativeAudioCoreTestAccess::command(core,CommandType::StopRecordOrPlayback,t);NativeAudioCoreTestAccess::run(core,nullptr,output.data(),frames);
  NativeAudioCoreTestAccess::command(core,CommandType::Play,t);NativeAudioCoreTestAccess::run(core,nullptr,output.data(),frames);
 }
 // Stress every track with four active expensive slots; not a claim of global worst-case.
 const char* heavyIds[]={"preamp","dist","robot","reverb"};
 const char* realisticIds[]={"chorus","fractional_delay","dynamics","reverb"};
 const char** ids=fxMode==2?realisticIds:heavyIds;
 if(fx) for(unsigned t=0;t<tracks;++t)for(unsigned s=0;s<4;++s){std::string err;if(!core.setNativeCatalogSlot(static_cast<NativeEffectSlot>(s),ids[s],{},false,err,NativeCatalogFxPath::Track,t+1)){std::cerr<<err;return 4;}}
 if(extras && supplement=="input-preamp-only") {
  std::string error; if(!core.setNativeCatalogSlot(NativeEffectSlot::A,"preamp",{},false,error,NativeCatalogFxPath::Input,0))return 14;
 } else if(extras){
  const char* inIds[]={"filter.lpf","manual_pan","dynamics","radio"};const char* sharedIds[]={"chorus","reverb","tape_echo","stereo_enhance"};std::string error;
  for(unsigned s=0;s<4;++s){if(!core.setNativeCatalogSlot(static_cast<NativeEffectSlot>(s),inIds[s],{},false,error,NativeCatalogFxPath::Input,0)||!core.setNativeCatalogSlot(static_cast<NativeEffectSlot>(s),sharedIds[s],{},false,error,NativeCatalogFxPath::Track,0))return 14;}
  NativeRhythmConfig rhythm;rhythm.enabled=true;if(!core.setNativeRhythmConfig(rhythm,error))return 14;
  if(supplement=="live-mono"||supplement=="live-poly"){NativePitchConfig pitch;pitch.enabled=true;pitch.trackId=1;pitch.semitones=7;pitch.mode=supplement=="live-poly"?NativePitchMode::LivePolyPhaseVocoder:NativePitchMode::LiveMonoKeepPitch;if(!core.setNativePitchConfig(pitch,error))return 14;}
 }
 float inputFxPeak=0;std::size_t rhythmVoices=0;
 for(unsigned b=0;b<1000;++b){if(NativeAudioCoreTestAccess::run(core,extras?input.data():nullptr,output.data(),frames))return 5;if(extras){inputFxPeak=std::max(inputFxPeak,NativeAudioCoreTestAccess::inputFxPeak(core,frames));rhythmVoices=std::max(rhythmVoices,NativeAudioCoreTestAccess::activeVoices(core));}}
 if(extras&&inputFxPeak<=0)return 15;
 if(extras&&supplement!="input-preamp-only"&&(!NativeAudioCoreTestAccess::extraRoutesHealthy(core)||!rhythmVoices))return 15;
 if(fx&&!NativeAudioCoreTestAccess::healthy(core,tracks))return 6;
 if(transport=="record")for(unsigned t=0;t<tracks;++t)if(!NativeAudioCoreTestAccess::command(core,CommandType::Clear,t))return 11;
 if(transport!="playback")for(unsigned t=0;t<tracks;++t)if(!NativeAudioCoreTestAccess::command(core,transport=="record"?CommandType::Record:CommandType::ToggleOverdub,t))return 11;
 std::vector<double> ns;ns.reserve(count);std::uint64_t hash=14695981039346656037ULL;double peak=0,sum=0;unsigned over=0;bool stereo=false;
 const double budget=1e9*frames/rate;
 for(unsigned b=0;b<count;++b){
  test_alloc::beginTracking();auto start=std::chrono::steady_clock::now();if(NativeAudioCoreTestAccess::run(core,(transport=="playback"&&!extras)?nullptr:input.data(),output.data(),frames))return 7;
  double elapsed=std::chrono::duration<double,std::nano>(std::chrono::steady_clock::now()-start).count();test_alloc::endTracking();ns.push_back(elapsed);sum+=elapsed;over+=elapsed>budget;
  for(unsigned f=0;f<frames;++f)stereo|=output[2*f]!=output[2*f+1];
  for(float v:output){if(!std::isfinite(v))return 8;peak=std::max(peak,std::abs(double(v)));std::uint32_t bits;std::memcpy(&bits,&v,4);hash^=bits;hash*=1099511628211ULL;}
 }
 if(fx&&!NativeAudioCoreTestAccess::healthy(core,tracks))return 9;
 const auto status=core.getStatus();
 if(extras&&supplement!="input-preamp-only"&&(!NativeAudioCoreTestAccess::extraRoutesHealthy(core)||!status.nativeRhythmEnabled))return 15;
 if((supplement=="live-mono"||supplement=="live-poly")&&!status.nativePitchActive)return 16;
 const auto expected=transport=="record"?LooperState::Recording:transport=="overdub"?LooperState::Overdubbing:LooperState::Playing;
 for(unsigned t=0;t<tracks;++t){if(status.nativeTrackStates[t]!=expected)return 12;if(transport=="record"&&NativeAudioCoreTestAccess::recordedFrames(core,t)!=static_cast<std::size_t>(count)*frames)return 13;}
 std::uint64_t peakRssKiB=0;
#if defined(__linux__)
 rusage usage{};if(getrusage(RUSAGE_SELF,&usage)==0)peakRssKiB=usage.ru_maxrss;
#endif
 std::sort(ns.begin(),ns.end());auto q=[&](double p){return ns[std::min(ns.size()-1,static_cast<size_t>(std::ceil(p*ns.size())-1))];};
 std::cout<<"{\"sampleRate\":"<<rate<<",\"supplement\":\""<<supplement<<"\",\"inputFxPeak\":"<<inputFxPeak<<",\"rhythmVoicesObserved\":"<<rhythmVoices<<",\"frames\":"<<frames<<",\"tracks\":"<<tracks<<",\"inputChannels\":"<<channels<<",\"transport\":\""<<transport<<"\",\"fxMode\":"<<fxMode<<",\"fx\":"<<(fx?"true":"false")<<",\"callbacks\":"<<count<<",\"meanNs\":"<<sum/count<<",\"p50Ns\":"<<q(.5)<<",\"p95Ns\":"<<q(.95)<<",\"p99Ns\":"<<q(.99)<<",\"maxNs\":"<<ns.back()<<",\"cpuBudgetExceedances\":"<<over<<",\"budgetNs\":"<<budget<<",\"peak\":"<<peak<<",\"peakRssKiB\":"<<peakRssKiB<<",\"callbackAllocations\":"<<test_alloc::count()<<",\"stereoDistinct\":"<<(stereo?"true":"false")<<",\"hash\":\""<<hash<<"\",\"hardwareStatus\":\"HARDWARE_BLOCKED\"}\n";
 return !test_alloc::count()&&(transport=="record"||((channels==1||stereo)&&peak>0))?0:10;
}

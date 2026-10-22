#include "native_benchmark_access.hpp"
#include "native_alloc_tracker.hpp"
#include <chrono>
#include <ctime>
#include <array>
#include <algorithm>
#include <cmath>
#include <fstream>
#include <iostream>
#include <thread>
#include <vector>
#if defined(__linux__)
#include <unistd.h>
#endif
using namespace webrc::native;
std::size_t rss(){
#if defined(__linux__)
std::ifstream f("/proc/self/statm");std::size_t total=0,resident=0;f>>total>>resident;return resident*sysconf(_SC_PAGESIZE);
#else
return 0;
#endif
}
int main(int argc,char**argv){
 const unsigned seconds=argc>1?std::stoul(argv[1]):600,rate=48000,frames=128;
 NativeAudioCore core;if(!NativeAudioCoreTestAccess::prepare(core,rate,frames))return 1;
 for(unsigned t=1;t<=5;++t){std::string err;if(!core.setNativeCatalogSlot(NativeEffectSlot::A,"preamp",{},false,err,NativeCatalogFxPath::Track,t))return 2;}
 std::vector<float> in(frames*2),out(frames*2);std::uint64_t callbacks=0,commands=0,rejected=0,nonfinite=0,stereo=0,budgetExceedances=0,stateErrors=0,fxChanges=0;double maxNs=0,totalNs=0;unsigned phase=999;
 std::array<std::uint64_t, 20001> histogram{};
 std::vector<std::pair<unsigned,double>> cpuSamples;cpuSamples.reserve(seconds/10+2);
 std::vector<std::pair<unsigned,std::size_t>> memorySamples;memorySamples.reserve(seconds/10+2);unsigned nextMemorySample=0;
 bool checkpointWritten=false;
 const auto cpuStart=std::clock();
 auto start=std::chrono::steady_clock::now(),next=start;std::size_t initialRss=rss(),maxRss=initialRss,settledRss=0,finalRss=0;
 const CommandType cycle[]={CommandType::Clear,CommandType::Record,CommandType::StopRecordOrPlayback,CommandType::Play,CommandType::ToggleOverdub,CommandType::ToggleOverdub,CommandType::StopRecordOrPlayback,CommandType::Play};
 while(std::chrono::steady_clock::now()-start<std::chrono::seconds(seconds)){
  const auto elapsed=std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count();
  if(argc>2&&!checkpointWritten&&elapsed>=600){
   std::ofstream checkpoint(argv[2]);
   checkpoint<<"{\"wallSeconds\":"<<elapsed<<",\"callbacks\":"<<callbacks<<",\"commands\":"<<commands<<",\"fxChanges\":"<<fxChanges<<",\"queueRejected\":"<<rejected<<",\"stateErrors\":"<<stateErrors<<",\"nonfiniteFrames\":"<<nonfinite<<",\"stereoDistinctFrames\":"<<stereo<<",\"callbackAllocations\":"<<test_alloc::count()<<",\"rssBytes\":"<<rss()<<",\"functionalGate\":\""<<(rejected||stateErrors||nonfinite||test_alloc::count()||!stereo?"FAIL":"PASS")<<"\",\"scope\":\"600-second checkpoint in continuing co-loaded device-free soak\"}\n";
   checkpointWritten=true;
  }
  if(elapsed>=nextMemorySample){memorySamples.emplace_back(static_cast<unsigned>(elapsed),rss());cpuSamples.emplace_back(static_cast<unsigned>(elapsed),double(std::clock()-cpuStart)/CLOCKS_PER_SEC);nextMemorySample+=10;}
  const unsigned p=static_cast<unsigned>(elapsed*2)%8;
  const bool changed=p!=phase;
  if(changed){phase=p;
   if(p==0){for(unsigned track=1;track<=5;++track){std::string error;const char* effect=(static_cast<unsigned>(elapsed)/4)%2==0?"preamp":"chorus";if(!core.setNativeCatalogSlot(NativeEffectSlot::A,effect,{},false,error,NativeCatalogFxPath::Track,track))return 5;++fxChanges;}}
   for(unsigned t=0;t<5;++t){++commands;if(!NativeAudioCoreTestAccess::command(core,cycle[p],t))++rejected;}const auto status=core.getStatus();(void)status;finalRss=rss();maxRss=std::max(maxRss,finalRss);if(elapsed>=30&&settledRss==0)settledRss=finalRss;}
  for(unsigned f=0;f<frames;++f){in[f*2]=.02f*std::sin((callbacks*frames+f)*.031);in[f*2+1]=.017f*std::cos((callbacks*frames+f)*.047);}
  test_alloc::beginTracking();const auto begin=std::chrono::steady_clock::now();const int result=NativeAudioCoreTestAccess::run(core,in.data(),out.data(),frames);const auto end=std::chrono::steady_clock::now();test_alloc::endTracking();if(result)return 3;
  if(changed){const auto state=core.getStatus();const LooperState expected[]={LooperState::Empty,LooperState::Recording,LooperState::Stopped,LooperState::Playing,LooperState::Overdubbing,LooperState::Playing,LooperState::Stopped,LooperState::Playing};for(auto st:state.nativeTrackStates)stateErrors+=st!=expected[p];}
  double ns=std::chrono::duration<double,std::nano>(end-begin).count();histogram[std::min<std::size_t>(20000,static_cast<std::size_t>(ns/1000))]++;maxNs=std::max(maxNs,ns);totalNs+=ns;budgetExceedances+=ns>1e9*frames/rate;
  for(unsigned f=0;f<frames;++f){nonfinite+=!std::isfinite(out[f*2])||!std::isfinite(out[f*2+1]);stereo+=out[f*2]!=out[f*2+1];}
  ++callbacks;next+=std::chrono::nanoseconds(1000000000ULL*frames/rate);std::this_thread::sleep_until(next);
 }
 const auto status=core.getStatus();finalRss=rss();double wall=std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count();
 const double cpuSeconds=double(std::clock()-cpuStart)/CLOCKS_PER_SEC;
 const auto percentileUs=[&](double q){std::uint64_t n=0;for(std::size_t i=0;i<histogram.size();++i){n+=histogram[i];if(n>=static_cast<std::uint64_t>(std::ceil(callbacks*q)))return i;}return histogram.size()-1;};
 std::cout<<"{\"wallSeconds\":"<<wall<<",\"processCpuSeconds\":"<<cpuSeconds<<",\"processCpuPercent\":"<<100*cpuSeconds/wall<<",\"callbacks\":"<<callbacks<<",\"simulatedSeconds\":"<<double(callbacks)*frames/rate<<",\"commands\":"<<commands<<",\"fxChanges\":"<<fxChanges<<",\"queueRejected\":"<<rejected<<",\"stateErrors\":"<<stateErrors<<",\"nonfiniteFrames\":"<<nonfinite<<",\"stereoDistinctFrames\":"<<stereo<<",\"callbackAllocations\":"<<test_alloc::count()<<",\"meanNs\":"<<totalNs/callbacks<<",\"maxNs\":"<<maxNs<<",\"p50ApproxUs\":"<<percentileUs(.5)<<",\"p95ApproxUs\":"<<percentileUs(.95)<<",\"p99ApproxUs\":"<<percentileUs(.99)<<",\"cpuBudgetExceedances\":"<<budgetExceedances<<",\"rssInitialBytes\":"<<initialRss<<",\"rssSettledBytes\":"<<settledRss<<",\"rssFinalBytes\":"<<finalRss<<",\"rssMaxBytes\":"<<maxRss<<",\"hardwareStatus\":\"HARDWARE_BLOCKED\",\"reverse\":\"UNSUPPORTED_NATIVE_TRANSPORT\",\"bridge\":\"getStatus control polling, not HTTP\",\"memorySamples\":[";
 for(std::size_t i=0;i<memorySamples.size();++i){if(i)std::cout<<",";std::cout<<"["<<memorySamples[i].first<<","<<memorySamples[i].second<<"]";}
 std::cout<<"],\"cpuSamplesSeconds\":[";
 for(std::size_t i=0;i<cpuSamples.size();++i){if(i)std::cout<<",";std::cout<<"["<<cpuSamples[i].first<<","<<cpuSamples[i].second<<"]";}
 std::cout<<"]}\n";
 return rejected||stateErrors||nonfinite||test_alloc::count()||!stereo?4:0;
}

// Emit deterministic stereo PCM for exact baseline/candidate comparison.
#include "native_preamp_processor.hpp"
#include <array>
#include <cmath>
#include <cstdio>
using namespace webrc::native;
int main(){
 for(unsigned rate:{44100U,48000U}){
  NativePreampProcessor p;if(!p.prepare(rate))return 1;
  std::array<float,514> pcm{};
  for(unsigned b=0;b<500;++b){
   if(b%17==0){NativePreampConfig cfg;cfg.model=(b/17)%5;cfg.gainPercent=(b*13)%101;cfg.bassDb=float(b%25)-12;cfg.middleDb=float((b*3)%25)-12;cfg.trebleDb=float((b*7)%25)-12;cfg.levelDb=-6;if(!p.setConfig(cfg,b%3==0?0:113))return 2;}
   if(b==250)p.reset();
   unsigned frames=1+(b*37)%257;
   for(unsigned f=0;f<frames;++f){pcm[2*f]=.2f*std::sin((b*257+f)*.071f);pcm[2*f+1]=.17f*std::cos((b*257+f)*.123f);
    if(b>=400){pcm[2*f]=(b%4==0?0.0f:b%4==1?0.00001f:b%4==2?0.3f:(f==0?1.0f:0.0f));pcm[2*f+1]=-pcm[2*f]*.37f;}}
   (void)p.processInPlace(pcm.data(),frames,2);
   if(std::fwrite(pcm.data(),sizeof(float),frames*2,stdout)!=frames*2)return 3;
  }
 }
}

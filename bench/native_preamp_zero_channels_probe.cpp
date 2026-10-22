#include "native_preamp_processor.hpp"
#include <array>
#include <cmath>
#include <cstdio>
#include <limits>
// Full raw PCM comparison, including reset, mono/stereo transitions, first
// nonzero right input after arbitrary zero-state ring positions and automation.
int main(){
 for(unsigned rate:{8000U,44100U,48000U,96000U,192000U}) for(unsigned model=0;model<5;++model) for(unsigned scenario=0;scenario<4;++scenario){
  webrc::native::NativePreampProcessor p;if(!p.prepare(rate))return 1;
  std::array<float,1024>a{};unsigned time=0;
  for(unsigned block=0;block<250;++block){
   if(block==125)p.reset();
   webrc::native::NativePreampConfig c;c.model=model;c.gainPercent=(block%3)*50;
   c.bassDb=(block%3)*12-12.f;c.middleDb=12.f-(block%3)*12;c.trebleDb=-c.bassDb;c.levelDb=(block%4)*12-24.f;
   if(!p.setConfig(c,block%5?113:0))return 2;
   const unsigned channels=block<40?1:block<110?2:block<160?1:block<200?4:2;
   const unsigned frames=1+(block*31)%255;
   for(unsigned f=0;f<frames;++f){
    a[channels*f]=scenario==3&&block<110?0.0f:.11f*std::sin((time+f)*.043f);
    if(channels>1){
     float right=0;
     if(scenario!=2&&(block==54||block==181))right=f==0?.08f:0;
     if(scenario!=2&&block>=65&&block<90)right=.13f*std::cos((time+f)*.071f);
     if(scenario==0&&block==45)right=std::numeric_limits<float>::quiet_NaN();
     if(scenario==0&&block==46)right=std::numeric_limits<float>::infinity();
     if(scenario==0&&block==47)right=-std::numeric_limits<float>::infinity();
     if(scenario==0&&block==50)right=-0.f;
     if(scenario==0&&block==170)right=std::numeric_limits<float>::denorm_min();
     a[channels*f+1]=right;
     for(unsigned ch=2;ch<channels;++ch)a[channels*f+ch]=ch*.1f;
    }
   }
   float peak=p.processInPlace(a.data(),frames,channels);
   if(!std::isfinite(peak))return 3;
   for(unsigned i=0;i<frames*channels;++i)if(!std::isfinite(a[i]))return 4;
   if(std::fwrite(a.data(),sizeof(float),frames*channels,stdout)!=frames*channels)return 5;
   time+=frames;
  }
 }
}

#include "native_preamp_processor.hpp"
#include <array>
#include <cmath>
#include <cstdio>
#include <limits>
int main(){for(unsigned rate:{44100U,48000U})for(unsigned model=0;model<5;++model){webrc::native::NativePreampProcessor p;if(!p.prepare(rate))return 1;webrc::native::NativePreampConfig cfg;cfg.model=model;if(!p.setConfig(cfg,0))return 2;std::array<float,128> a{};for(unsigned b=0;b<96;++b){if(b==48)p.reset();if(b==72){cfg.gainPercent=87;if(!p.setConfig(cfg,111))return 3;}for(unsigned f=0;f<64;++f){const float v=.13f*std::sin((b*64+f)*.043f);const float special[]={0.0f,-0.0f,std::numeric_limits<float>::quiet_NaN(),std::numeric_limits<float>::infinity(),-std::numeric_limits<float>::infinity(),v};a[2*f]=b<24?special[b%6]:b%2?v:0.0f;a[2*f+1]=b<24?special[(b+1)%6]:b%2?-0.0f:v;} (void)p.processInPlace(a.data(),64,2);for(float x:a)if(!std::isfinite(x))return 4;if(std::fwrite(a.data(),sizeof(float),a.size(),stdout)!=a.size())return 5;}}}

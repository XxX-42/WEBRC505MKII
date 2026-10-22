#include "native_preamp_processor.hpp"
#include <array>
#include <cmath>
#include <cstdio>
int main(){for(unsigned rate:{44100U,48000U}){webrc::native::NativePreampProcessor p;if(!p.prepare(rate))return 1;std::array<float,128>a{};for(unsigned b=0;b<2000;++b){if(b%601==0)p.reset();webrc::native::NativePreampConfig cfg;cfg.model=(b/350)%5;cfg.gainPercent=10+(b%200)*.4f;cfg.bassDb=-8+(b%100)*.16f;cfg.middleDb=6-(b%80)*.15f;cfg.trebleDb=-4+(b%60)*.12f;cfg.levelDb=-12+(b%120)*.15f;if(!p.setConfig(cfg,113))return 2;for(unsigned f=0;f<64;++f){a[2*f]=.08f*std::sin((b*64+f)*.027f);a[2*f+1]=.07f*std::cos((b*64+f)*.053f);} (void)p.processInPlace(a.data(),64,2);for(float x:a)if(!std::isfinite(x))return 3;if(std::fwrite(a.data(),sizeof(float),a.size(),stdout)!=a.size())return 4;}}}

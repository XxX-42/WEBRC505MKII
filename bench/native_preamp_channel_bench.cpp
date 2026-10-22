#include "native_preamp_processor.hpp"
#include <array>
#include <chrono>
#include <cmath>
#include <cstring>
#include <iostream>
#include <string_view>
#ifndef NATIVE_BENCH_CALLBACKS
#define NATIVE_BENCH_CALLBACKS 6000U
#endif
int main(int argc,char**argv){const bool silence=argc>1&&std::string_view(argv[1])=="silence";const bool automation=argc>1&&std::string_view(argv[1])=="automation";const unsigned channels=argc>2&&std::string_view(argv[2])=="mono"?1:2;webrc::native::NativePreampProcessor p;if(!p.prepare(48000))return 1;std::array<float,128>a{};double ns=0;std::uint64_t hash=14695981039346656037ULL;for(unsigned b=0;b<NATIVE_BENCH_CALLBACKS;++b){if(automation){webrc::native::NativePreampConfig cfg;cfg.gainPercent=20+(b%200)*.3f;cfg.bassDb=-6+(b%100)*.12f;cfg.middleDb=3;cfg.trebleDb=-2;if(!p.setConfig(cfg,64))return 2;}for(unsigned f=0;f<64;++f){a[channels*f]=silence?0:.08f*std::sin((b*64+f)*110.*6.28318530718/48000);if(channels==2)a[2*f+1]=silence?0:.07f*std::cos((b*64+f)*173.*6.28318530718/48000);}auto t=std::chrono::steady_clock::now();(void)p.processInPlace(a.data(),64,channels);auto end=std::chrono::steady_clock::now();if(b>=1000){ns+=std::chrono::duration<double,std::nano>(end-t).count();for(unsigned i=0;i<64*channels;++i){float x=a[i];std::uint32_t bits;std::memcpy(&bits,&x,4);hash^=bits;hash*=1099511628211ULL;}}}std::cout<<"{\"meanNs\":"<<ns/(NATIVE_BENCH_CALLBACKS-1000)<<",\"hash\":\""<<hash<<"\",\"signal\":\""<<(silence?"silence":automation?"automation":"sine")<<"\"}\n";}

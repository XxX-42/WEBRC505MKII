#include "native_preamp_processor.hpp"
#include <array>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <vector>
#include <algorithm>
#include <cstdlib>
using namespace webrc::native;
constexpr double pi = 3.141592653589793238462643383279502884;
constexpr unsigned int preroll = 1024U, analysis = 2048U;
void runTone(std::ofstream& raw, std::ofstream& meta, unsigned sr, unsigned model, float gain, unsigned bin, float amp, float dc) {
  NativePreampProcessor p; if (!p.prepare(sr) || !p.setConfig({static_cast<float>(model),gain,0,0,0,0},0)) std::exit(2);
  std::vector<float> x(preroll+analysis);
  const double f=static_cast<double>(sr)*bin/analysis; // integer-cycle tone over analyzed window
  for(unsigned i=0;i<x.size();++i) x[i]=dc+amp*static_cast<float>(std::sin(2*pi*f*i/sr));
  constexpr std::array<unsigned,4> chunks{64,31,127,257};
  unsigned off=0, j=0; while(off<x.size()) { auto n=std::min<unsigned>(chunks[j++%chunks.size()],static_cast<unsigned>(x.size()-off)); (void)p.processInPlace(x.data()+off,n,1); off+=n; }
  // Metadata carries exact frequency and analysis length so analyzer can use FFT bins.
  raw.write(reinterpret_cast<const char*>(x.data()+preroll),analysis*sizeof(float));
  meta << "tone\t"<<sr<<'\t'<<model<<'\t'<<gain<<'\t'<<bin<<'\t'<<amp<<'\t'<<dc<<'\t'<<analysis<<'\n';
}
void runEdge(std::ofstream& raw, std::ofstream& meta, unsigned sr, unsigned model, float gain, int kind) {
  NativePreampProcessor p; if (!p.prepare(sr) || !p.setConfig({static_cast<float>(model),gain,0,0,0,0},0)) std::exit(3);
  constexpr unsigned n=4096; std::vector<float>x(n);
  if(kind==0) { // repeated tiny, threshold-adjacent sample changes around several operating points
    const std::array<float,14> steps{{0.0f,1e-8f,0.0f,1e-5f,0.0f,5e-5f,0.0f,9.9e-5f,0.0f,1.01e-4f,0.0f,1.5e-4f,0.0f,1e-3f}};
    for(unsigned i=0;i<n;++i) x[i]=steps[i%steps.size()] * ((i/steps.size())%2 ? 1.0f : -1.0f);
  } else if(kind==1) { // input clamp and polarity-transition stress, no non-finite samples
    const std::array<float,12> v{{15.9f,15.99f,16.0f,16.0f,15.99f,15.9f,-15.9f,-15.99f,-16.0f,-16.0f,-15.99f,-15.9f}};
    for(unsigned i=0;i<n;++i)x[i]=v[i%v.size()];
  } else { // low-amplitude DC and step offset; a DC-preservation diagnostic, not a fidelity claim
    for(unsigned i=0;i<n;++i)x[i]=(i<1024?0.0f:(i<3072?1e-6f:1e-4f));
  }
  constexpr std::array<unsigned,4> chunks{1,31,64,255}; unsigned off=0,j=0;
  while(off<n){auto k=std::min<unsigned>(chunks[j++%chunks.size()],n-off);(void)p.processInPlace(x.data()+off,k,1);off+=k;}
  raw.write(reinterpret_cast<const char*>(x.data()+1024), (n-1024)*sizeof(float));
  meta<<"edge\t"<<sr<<'\t'<<model<<'\t'<<gain<<'\t'<<kind<<"\t0\t0\t"<<(n-1024)<<'\n';
}
void runDynamic(std::ofstream& raw,std::ofstream& meta,unsigned sr){
  NativePreampProcessor p; if(!p.prepare(sr)||!p.setConfig({0,35,0,0,0,0},0))std::exit(4);
  constexpr unsigned n=8192;std::vector<float>x(n);
  for(unsigned i=0;i<n;++i)x[i]=0.7f*static_cast<float>(std::sin(2*pi*440*i/sr)+0.3*std::sin(2*pi*997*i/sr));
  constexpr std::array<unsigned,5> chunks{64,17,1,127,255};
  constexpr std::array<unsigned,5> controls{1024,2048,4096,6144,n};
  constexpr std::array<NativePreampConfig,4> configs{{{3,100,0,0,0,0},{1,70,0,0,0,0},{4,0,0,0,0,0},{2,90,0,0,0,0}}};
  constexpr std::array<unsigned,4> ramps{256,0,128,512};
  unsigned off=0,j=0,control=0;
  while(off<n){
    if(control<4 && off==controls[control]) { if(!p.setConfig(configs[control],ramps[control]))std::exit(7); ++control; }
    const unsigned boundary=control<4?controls[control]:n;
    auto k=std::min<unsigned>(chunks[j++%chunks.size()],std::min<unsigned>(n-off,boundary-off));
    (void)p.processInPlace(x.data()+off,k,1);off+=k;
  }
  raw.write(reinterpret_cast<const char*>(x.data()+1024),(n-1024)*sizeof(float));
  meta<<"dynamic\t"<<sr<<"\tall\tsequence\t0\t0\t0\t"<<(n-1024)<<'\n';
}
int main(int argc,char**argv){if(argc!=3)return 1;std::ofstream raw(argv[1],std::ios::binary);std::ofstream meta(argv[2]);if(!raw||!meta)return 5;
  constexpr std::array<unsigned,6> rates{8000,22050,44100,48000,96000,192000};
  constexpr std::array<unsigned,4> bins{7,61,377,903};
  constexpr std::array<float,5> amps{1e-6f,1e-3f,0.05f,0.4f,0.95f};
  constexpr std::array<float,3> gains{0,35,100};
  for(auto sr:rates) for(unsigned model=0;model<5;++model) for(auto gain:gains) for(auto bin:bins) for(auto amp:amps) runTone(raw,meta,sr,model,gain,bin,amp,0.0f);
  for(auto sr:rates) for(unsigned model: {0U,3U}) for(auto gain: {0.0f,100.0f}) for(auto dc: {-0.75f,0.0f,0.75f}) for(auto amp: {1e-5f,0.05f,0.5f}) runTone(raw,meta,sr,model,gain,61,amp,dc);
  for(auto sr:rates) for(unsigned model: {0U,3U}) for(auto gain: {0.0f,100.0f}) for(int kind=0;kind<3;++kind) runEdge(raw,meta,sr,model,gain,kind);
  for(auto sr:rates)runDynamic(raw,meta,sr);
  std::cout<<"rates=6 models=5 gains=3 frequencies=4 amplitudes=5 plus DC, edge/clamp and dynamic cases; saved analysis frames="<<analysis<<" per tone\n";
}

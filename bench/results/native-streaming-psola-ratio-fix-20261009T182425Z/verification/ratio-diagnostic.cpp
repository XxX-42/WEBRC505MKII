#include "webrc/dsp/pitch.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <iomanip>
#include <iostream>
#include <vector>

namespace {
constexpr double pi = 3.1415926535897932384626433832795;
constexpr double sr = 48000.0;
float crossingHz(const std::vector<float>& x, std::uint32_t first, std::uint32_t last) {
  std::vector<double> crossings;
  for (std::uint32_t i=first+1; i<last; ++i) {
    if (x[i-1] <= 0.0f && x[i] > 0.0f) {
      const double den=static_cast<double>(x[i])-x[i-1];
      if (den > 1.0e-15) crossings.push_back(i-1.0-static_cast<double>(x[i-1])/den);
    }
  }
  if (crossings.size()<2) return 0.0f;
  double sum=0.0;
  for(std::size_t i=1;i<crossings.size();++i) sum+=crossings[i]-crossings[i-1];
  return static_cast<float>(sr*static_cast<double>(crossings.size()-1)/sum);
}
double amplitudeAt(const std::vector<float>& x, std::uint32_t first, std::uint32_t frames, double hz) {
  double c=0.0,s=0.0;
  for(std::uint32_t j=0;j<frames;++j){const double phase=2.0*pi*hz*(first+j)/sr;c+=x[first+j]*std::cos(phase);s+=x[first+j]*std::sin(phase);}
  return 2.0*std::hypot(c,s)/frames;
}
}
int main(){
  constexpr std::uint32_t frames=48000, block=128;
  const std::array<float,6> ratios{0.5f,0.75f,1.0f,1.25f,1.5f,2.0f};
  const std::array<double,2> phases{0.37,0.37+pi};
  std::cout<<std::setprecision(12)<<"{\"schema\":\"streaming-psola-ratio-measurement-v1\",\"sampleRate\":48000,\"inputFrames\":48000,\"blockFrames\":128,\"inputHz\":220,\"inputPeak\":0.3,\"warmWindow\":[10409,44000],\"cases\":[";
  bool first=true;
  for(float ratio:ratios) for(double phase:phases){
    webrc::dsp::StreamingTdPsolaPitchShifter psola;
    const webrc::dsp::ProcessSpec spec{48000.0f,128U,1U};
    const webrc::dsp::PitchEstimate estimate{220.0f,48000.0f/220.0f,0.99f,0.3f,true};
    if(!psola.prepare(spec,739U)||!psola.setPitchEstimate(estimate,ratio)) return 2;
    std::vector<float> input(frames),output(frames);
    for(std::uint32_t i=0;i<frames;++i) input[i]=0.3f*std::sin(static_cast<float>(2.0*pi*220.0*i/sr+phase));
    for(std::uint32_t offset=0;offset<frames;offset+=block) if(!psola.processBlock(input.data()+offset,output.data()+offset,block)) return 3;
    const std::uint32_t firstFrame=std::min<std::uint32_t>(psola.latencySamples()+8192U,frames-12000U);
    const std::uint32_t count=12000U;
    double energy=0.0; for(std::uint32_t i=firstFrame;i<firstFrame+count;++i) energy+=static_cast<double>(output[i])*output[i];
    const double rms=std::sqrt(energy/count); const double target=220.0*ratio;
    const double projected=amplitudeAt(output,firstFrame,count,target); const float crossing=crossingHz(output,firstFrame,firstFrame+count);
    if(!first) std::cout<<','; first=false;
    std::cout<<"{\"ratio\":"<<ratio<<",\"phaseRad\":"<<phase<<",\"latencySamples\":"<<psola.latencySamples()<<",\"expectedHz\":"<<target<<",\"positiveCrossingHz\":"<<crossing<<",\"targetProjectionPeak\":"<<projected<<",\"warmRms\":"<<rms<<"}";
  }
  std::cout<<"]}\n";
  return 0;
}
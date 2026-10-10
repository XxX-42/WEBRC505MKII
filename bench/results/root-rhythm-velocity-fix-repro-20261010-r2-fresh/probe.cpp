#include "webrc/dsp/rhythm.hpp"
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>
using namespace webrc::dsp;
struct Render { std::vector<float> l, r; bool ok = false; };
Render render(unsigned kit, RhythmInstrument instrument, unsigned velocity) {
    Render out{std::vector<float>(8192),std::vector<float>(8192),false};
    const RhythmEvent event{0,instrument,static_cast<std::uint8_t>(velocity),false,0};
    RhythmPatternView pattern{}; for(auto& v:pattern.variations) v={&event,1};
    pattern.intro={&event,1};pattern.fill={&event,1};pattern.ending={&event,1};
    RhythmRenderer renderer;
    if(!renderer.prepare({48000.0f,64,2},120.0) || !renderer.setPattern(&pattern) || !renderer.setKit(kit) || !renderer.startAtFrame(0,false)) return out;
    for(unsigned frame=0;frame<8192;frame+=64)
        if(!renderer.processBlock(frame,out.l.data()+frame,out.r.data()+frame,64)) return out;
    out.ok=renderer.triggeredEvents()==1;
    return out;
}
void writePcm(const Render& r, const std::string& path) {
    std::ofstream f(path,std::ios::binary);
    for(unsigned i=0;i<r.l.size();++i) {const float stereo[2]={r.l[i],r.r[i]};f.write(reinterpret_cast<const char*>(stereo),sizeof(stereo));}
}
int main(int argc,char**argv) {
    const RhythmInstrument instruments[]={RhythmInstrument::Kick,RhythmInstrument::Snare,RhythmInstrument::ClosedHat,RhythmInstrument::TomLow};
    bool allGainOnly=true;
    std::cout<<"{\n\"scope\":\"software shared RhythmRenderer velocity gain-removal probe\",\n\"sampleRateHz\":48000,\"blockFrames\":64,\"framesPerHit\":8192,\"cases\":[\n";
    unsigned count=0;
    for(unsigned kit=0;kit<cleanRoomKitCount();++kit) for(auto instrument:instruments) {
        const auto a=render(kit,instrument,32),b=render(kit,instrument,112);
        if(!a.ok||!b.ok)return 2;
        double aa=0,bb=0,ab=0;
        for(unsigned i=0;i<8192;++i) {if(!std::isfinite(a.l[i])||!std::isfinite(a.r[i])||!std::isfinite(b.l[i])||!std::isfinite(b.r[i]))return 2;aa+=double(a.l[i])*a.l[i]+double(a.r[i])*a.r[i];bb+=double(b.l[i])*b.l[i]+double(b.r[i])*b.r[i];ab+=double(a.l[i])*b.l[i]+double(a.r[i])*b.r[i];}
        if(aa<=0||bb<=0)return 2;
        const double gain=ab/aa;double error=0;
        for(unsigned i=0;i<8192;++i){const double l=b.l[i]-gain*a.l[i],r=b.r[i]-gain*a.r[i];error+=l*l+r*r;}
        const double relativeResidual=std::sqrt(error/bb);
        const bool gainOnly=relativeResidual<1e-5;
        allGainOnly &= gainOnly;
        if(count++)std::cout<<",\n";
        std::cout<<"{\"kitIndex\":"<<kit<<",\"instrument\":"<<unsigned(instrument)<<",\"lowVelocity\":32,\"highVelocity\":112,\"fittedGain\":"<<gain<<",\"relativeGainRemovedRmsResidual\":"<<relativeResidual<<",\"gainOnlyWithinFloatTolerance\":"<<(gainOnly?"true":"false")<<"}";
        if(kit==0 && argc==2){const std::string stem=std::string(argv[1])+"/kit0-instrument"+std::to_string(unsigned(instrument));writePcm(a,stem+"-v32.f32stereo");writePcm(b,stem+"-v112.f32stereo");}
    }
    std::cout<<"\n],\"allTestedVelocitiesOnlyChangeGain\":"<<(allGainOnly?"true":"false")<<"}\n";
    return allGainOnly?0:1;
}

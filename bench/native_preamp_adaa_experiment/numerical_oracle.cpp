#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <limits>
#include <vector>
float logCoshF(float v){double a=std::min(std::fabs((double)v),32.0);return (float)(a+std::log1p(std::exp(-2*a))-std::log(2.0));}
double logCoshD(double v){double a=std::min(std::fabs(v),32.0);return a+std::log1p(std::exp(-2*a))-std::log(2.0);}
float oldFx(float x,float p,float s,float b){float d=x-p;auto F=[s,b](float v){float sh=std::clamp(s*(v+b),-16.f,16.f);float ba=std::clamp(s*b,-16.f,16.f);return (logCoshF(sh)-logCoshF(ba))/s-std::tanh(ba)*v;};float r=(F(x)-F(p))/d;return std::isfinite(r)?std::clamp(r,-2.f,2.f):0.f;}
float newFx(float x,float p,float s,float b){float d=x-p;float sh=std::clamp(s*(x+b),-16.f,16.f),sp=std::clamp(s*(p+b),-16.f,16.f),ba=std::clamp(s*b,-16.f,16.f);float ld=logCoshF(sh)-logCoshF(sp);float r=(ld/s-std::tanh(ba)*d)/d;return std::isfinite(r)?std::clamp(r,-2.f,2.f):0.f;}
double oracle(float x,float p,float sf,float bf){double s=sf,b=bf,d=(double)x-p;double ba=std::clamp(s*b,-16.0,16.0);auto F=[&](double v){double sh=std::clamp(s*(v+b),-16.0,16.0);return (logCoshD(sh)-logCoshD(ba))/s-std::tanh(ba)*v;};return (F(x)-F(p))/d;}
struct Stats{std::vector<double> eOld,eNew,diff;double maxOld=0,maxNew=0,maxDiff=0;float mx=0,mp=0,ms=0,mb=0;};
int main(){constexpr uint64_t n=2000000;uint32_t r=0x53746162; auto rnd=[&](){r^=r<<13;r^=r>>17;r^=r<<5;return r;};std::array<float,5>slopeModel{.9f,1.05f,1.18f,1.28f,.78f};std::array<float,4>stageSlope{.94f,1.04f,.91f,1.12f};std::array<float,5>biasModel{0.f,.12f,.045f,.16f,.025f};Stats a,b;
for(uint64_t i=0;i<n;++i){unsigned m=rnd()%5,st=rnd()%4;float slope=slopeModel[m]*stageSlope[st],bias=biasModel[m]*(.72f+.17f*st);float x,p;
 if(i%2==0){x=((float)(rnd()&0xffffff)/8388607.5f-1.f)*16.f;p=((float)(rnd()&0xffffff)/8388607.5f-1.f)*16.f;if(std::fabs(x-p)<1.2e-4f)x=std::min(16.f,p+0.001f);}
 else {p=((float)(rnd()&0xffffff)/8388607.5f-1.f)*16.f;float mult=1.0f+((rnd()%1000000)/1000000.0f)*30.0f;float delta=1e-4f*mult; x=std::clamp(p+delta,-16.f,16.f); if(x-p<1e-4f)x=std::clamp(p-delta,-16.f,16.f); if(std::fabs(x-p)<1e-4f)continue;}
 float old=oldFx(x,p,slope,bias),nw=newFx(x,p,slope,bias);double ref=oracle(x,p,slope,bias);double eo=std::fabs((double)old-ref),en=std::fabs((double)nw-ref),df=std::fabs((double)nw-old);a.eOld.push_back(eo);a.eNew.push_back(en);a.diff.push_back(df);if(eo>a.maxOld)a.maxOld=eo;if(en>a.maxNew)a.maxNew=en;if(df>a.maxDiff){a.maxDiff=df;a.mx=x;a.mp=p;a.ms=slope;a.mb=bias;}}
a.eOld.shrink_to_fit();a.eNew.shrink_to_fit();a.diff.shrink_to_fit(); auto report=[](const char*name,std::vector<double>v,double max){std::sort(v.begin(),v.end());double rms=0;for(double x:v)rms+=x*x;rms=std::sqrt(rms/v.size());std::cout<<name<<" n="<<v.size()<<" rms_error="<<rms<<" p99="<<v[(size_t)(.99*(v.size()-1))]<<" p999="<<v[(size_t)(.999*(v.size()-1))]<<" max="<<max<<"\n";};report("baseline_error",a.eOld,a.maxOld);report("candidate_error",a.eNew,a.maxNew);report("baseline_candidate_absdiff",a.diff,a.maxDiff);std::cout<<"largest_difference_input="<<a.mx<<" previous="<<a.mp<<" slope="<<a.ms<<" bias="<<a.mb<<"\n";}

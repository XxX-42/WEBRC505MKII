#include <algorithm>
#include <array>
#include <cmath>
#include <iostream>
#include <limits>
#include <vector>
float lc(float v){double a=std::min(std::fabs((double)v),32.0);return (float)(a+std::log1p(std::exp(-2*a))-std::log(2.0));}
double lcd(double v){double a=std::min(std::fabs(v),32.0);return a+std::log1p(std::exp(-2*a))-std::log(2.0);}
float oldf(float x,float p,float s,float b){float d=x-p;if(std::fabs(d)<1e-4f)return std::tanh(s*(.5f*(x+p)+b))-std::tanh(s*b);auto F=[&](float v){float sh=std::clamp(s*(v+b),-16.f,16.f),ba=std::clamp(s*b,-16.f,16.f);return (lc(sh)-lc(ba))/s-std::tanh(ba)*v;};return std::clamp((F(x)-F(p))/d,-2.f,2.f);}
float newf(float x,float p,float s,float b){float d=x-p;if(std::fabs(d)<1e-4f)return std::tanh(s*(.5f*(x+p)+b))-std::tanh(s*b);float sh=std::clamp(s*(x+b),-16.f,16.f),sp=std::clamp(s*(p+b),-16.f,16.f),ba=std::clamp(s*b,-16.f,16.f);return std::clamp(((lc(sh)-lc(sp))/s-std::tanh(ba)*d)/d,-2.f,2.f);}
double refd(float x,float p,float sf,float bf){double s=sf,b=bf,d=(double)x-p,ba=std::clamp(s*b,-16.0,16.0);auto F=[&](double v){return (lcd(std::clamp(s*(v+b),-16.0,16.0))-lcd(ba))/s-std::tanh(ba)*v;};return (F(x)-F(p))/d;}
int main(){std::array<float,5> ms{.9f,1.05f,1.18f,1.28f,.78f},mb{0,.12f,.045f,.16f,.025f};std::array<float,4> ss{.94f,1.04f,.91f,1.12f};std::array<float,7> points{-16.f,-8.f,-1.f,-1e-3f,0.f,1.f,16.f};float th=1e-4f;std::array<float,6>deltas{std::nextafter(th,0.f),th,std::nextafter(th,std::numeric_limits<float>::infinity()),1.001e-4f,1.01e-4f,1.1e-4f};double maxOld=0,maxNew=0,maxDiff=0;unsigned n=0;float mx=0,mp=0,md=0;for(unsigned m=0;m<5;++m)for(unsigned st=0;st<4;++st){float s=ms[m]*ss[st],b=mb[m]*(.72f+.17f*st);for(float p0:points)for(float dd:deltas)for(int dir:{-1,1}){float p=p0,x=std::clamp(p0+dir*dd,-16.f,16.f);float d=x-p;if(std::fabs(d)<1e-4f)continue;float o=oldf(x,p,s,b),c=newf(x,p,s,b);double r=refd(x,p,s,b);double eo=std::abs(o-r),ec=std::abs(c-r),ef=std::abs((double)c-o);maxOld=std::max(maxOld,eo);maxNew=std::max(maxNew,ec);if(ef>maxDiff){maxDiff=ef;mx=x;mp=p;md=d;}++n;}}
std::cout<<"near_threshold_clamped_grid_pairs="<<n<<" max_old_vs_double="<<maxOld<<" max_candidate_vs_double="<<maxNew<<" max_candidate_baseline_delta="<<maxDiff<<" at x="<<mx<<" prev="<<mp<<" delta="<<md<<"\n";
}

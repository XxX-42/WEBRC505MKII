// Short signal sanity metrics, not an acoustic-quality or exhaustive-tail proof.
#include "native_fx_catalog.hpp"
#include <algorithm>
#include <cmath>
#include <iostream>
#include <vector>
using namespace webrc::native;
int main(int argc,char**){
 const bool legalFreezeOnly=argc>1;
 std::size_t count=0;const auto* catalog=nativeEffectCatalog(count);unsigned failures=0;
 for(unsigned rate:{44100U,48000U})for(std::size_t index=0;index<count;++index)for(unsigned controls=0;controls<3;++controls)for(unsigned signal=0;signal<6;++signal){
  const auto& d=catalog[index];if(legalFreezeOnly&&(d.id!="freeze"||controls!=2))continue;auto fx=createNativeEffectProcessor(d.id);if(!fx||!fx->prepare(rate))return 2;
  unsigned rejected=0;for(std::size_t p=0;p<d.parameterCount;++p){const auto& v=d.parameters[p];const float value=legalFreezeOnly&&v.discreteValueCount?*std::max_element(v.discreteValues,v.discreteValues+v.discreteValueCount):controls==0?v.defaultValue:controls==1?v.minimum:v.maximum;rejected+=!fx->setParameter(v.id,value,0);}
  constexpr unsigned frames=4096;std::vector<float> input(frames*2),output;
  for(unsigned f=0;f<frames;++f){const float a=.1f*std::sin(6.28318530718*440*f/rate),b=.07f*std::cos(6.28318530718*731*f/rate);input[2*f]=signal==0?0:signal==1?(f==0?.1f:0):signal==4?0:a;input[2*f+1]=signal==0?0:signal==1?(f==0?-.07f:0):signal==3?0:signal==5?b:a;}
  if(d.id=="freeze"){(void)fx->setParameter("freeze",0,0);std::vector<float> warm(rate*4);for(unsigned i=0;i<rate*4;++i)warm[i]=.1f*std::sin(i*.031);(void)fx->processInPlace(warm.data(),rate*2,2);(void)fx->setParameter("freeze",controls==2?1:0,0);}
  output=input;(void)fx->processInPlace(output.data(),frames,2);
  double peak=0,sum=0,squares=0,l=0,r=0,ll=0,rr=0,lr=0;unsigned nonfinite=0;
  for(unsigned f=0;f<frames;++f){double a=output[2*f],b=output[2*f+1];if(!std::isfinite(a)||!std::isfinite(b)){++nonfinite;continue;}peak=std::max({peak,std::abs(a),std::abs(b)});sum+=a+b;squares+=a*a+b*b;l+=a;r+=b;ll+=a*a;rr+=b*b;lr+=a*b;}
  const double denominator=std::sqrt(std::max(0.0,(ll-l*l/frames)*(rr-r*r/frames)));const double correlation=denominator>0?(lr-l*r/frames)/denominator:0;
  const bool processingFault=fx->processingFaulted();fx->setBypassed(true,0);fx->resetState();output=input;(void)fx->processInPlace(output.data(),frames,2);bool bypass=true;const unsigned latency=fx->reportedLatencySamples();for(unsigned f=0;f<frames;++f)for(unsigned ch=0;ch<2;++ch)bypass&=output[2*f+ch]==(f<latency?0:input[2*(f-latency)+ch]);
  const bool passed=!rejected&&!nonfinite&&!processingFault&&bypass;failures+=!nonfinite&&!processingFault&&bypass?0:1;
  std::cout<<"{\"effect\":\""<<d.id<<"\",\"sourceIndex\":"<<d.sourceIndex<<",\"sampleRate\":"<<rate<<",\"parameterVector\":"<<controls<<",\"signal\":"<<signal<<",\"signalSeconds\":"<<double(frames)/rate<<",\"frames\":"<<frames<<",\"rejectedParameters\":"<<rejected<<",\"processingFault\":"<<(processingFault?"true":"false")<<",\"nonfiniteFrames\":"<<nonfinite<<",\"peak\":"<<peak<<",\"rms\":"<<std::sqrt(squares/(frames*2))<<",\"dc\":"<<sum/(frames*2)<<",\"lrCorrelation\":"<<correlation<<",\"correlationDefined\":"<<(denominator>0?"true":"false")<<",\"declaredLatencyFrames\":"<<fx->reportedLatencySamples()<<",\"bypassExact\":"<<(bypass?"true":"false")<<",\"functionalGate\":\""<<((nonfinite||processingFault||!bypass)?"FAIL":rejected?"PARAMETER_REJECTED":passed?"PASS":"FAIL")<<"\",\"activationCoverage\":\"parameter API; FREEZE prewarmed 2s; external MIDI/source transport UNEXERCISED_ACTIVE_PATH\"}\n";
 }
 return failures?1:0;
}

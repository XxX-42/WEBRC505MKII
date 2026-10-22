#include "native_preamp_processor.hpp"
#include <cmath>
#include <array>
int main(int argc,char**){webrc::native::NativePreampProcessor p;if(!p.prepare(48000))return 1;std::array<float,128> a{};for(unsigned b=0;b<5000;++b){for(unsigned f=0;f<64;++f){a[2*f]=argc>1?0:.08f*std::sin((b*64+f)*110.*6.28318530718/48000);a[2*f+1]=argc>1?0:.07f*std::cos((b*64+f)*173.*6.28318530718/48000);} (void)p.processInPlace(a.data(),64,2);} }

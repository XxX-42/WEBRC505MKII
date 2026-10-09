#include "RubberBandStretcher.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <new>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
#ifdef _MSC_VER
#include <malloc.h>
#endif

namespace {
thread_local bool g_track = false;
thread_local std::uint64_t g_new = 0, g_delete = 0;
constexpr std::uint32_t kRate = 48000;
constexpr std::size_t kFrames = 144000;
constexpr double kPi = 3.1415926535897932384626433832795;

struct Call {
    std::size_t index, inputStart, frames, required, outputAfter;
    std::uint64_t ns, budget, newOps, deleteOps;
    bool final;
    const char *phase;
};
struct Fit { double hz = 0, bestAmp = 0, targetAmp = 0; std::size_t start = 0, frames = 0; };
struct Timing { double p50 = 0, p99 = 0, p999 = 0, max = 0; std::uint64_t over60 = 0, over80 = 0, over100 = 0; };
struct Config {
    std::string scene, kind, engine;
    int engineVersion = 2;
    std::size_t block = 64;
    double scale = 1, leftHz = 0, rightHz = 0;
    bool tone = false, impulse = false;
};
struct Result {
    std::string id;
    std::size_t inFrames = 0, pad = 0, delay = 0, latency = 0, required = 0;
    std::size_t rawFrames = 0, alignedFrames = 0;
    std::int64_t durationError = 0, impulseOnset = 0, impulsePeak = 0;
    std::size_t firstRaw = 0, peakFrame = 0, calls = 0;
    double peak = 0, leftTarget = 0, rightTarget = 0;
    Fit left, right;
    double rms = 0, alignedPeak = 0, identityDifference = 0, identityCorrelation = 0;
    std::uint64_t nonFinite = 0, overOne = 0, newOps = 0, deleteOps = 0, newCallbacks = 0, deleteCallbacks = 0;
    Timing timing;
};

std::vector<float> readPcm(const std::filesystem::path &p) {
    std::ifstream f(p, std::ios::binary | std::ios::ate);
    if (!f) throw std::runtime_error("cannot open PCM " + p.string());
    const auto n = f.tellg();
    if (n < 0 || static_cast<std::uint64_t>(n) % 8 != 0) throw std::runtime_error("not stereo f32le " + p.string());
    std::vector<float> v(static_cast<std::size_t>(n) / 4);
    f.seekg(0); f.read(reinterpret_cast<char *>(v.data()), n);
    if (!f) throw std::runtime_error("short PCM read " + p.string());
    return v;
}
void writePcm(const std::filesystem::path &p, const std::vector<float> &v) {
    std::ofstream f(p, std::ios::binary | std::ios::trunc);
    if (!f) throw std::runtime_error("cannot write PCM " + p.string());
    f.write(reinterpret_cast<const char *>(v.data()), static_cast<std::streamsize>(v.size() * sizeof(float)));
    if (!f) throw std::runtime_error("PCM write failed " + p.string());
}
void writePcm(const std::filesystem::path &p, const std::vector<float> &l, const std::vector<float> &r, std::size_t n) {
    if (n > l.size() || n > r.size()) throw std::runtime_error("PCM output overrun");
    std::vector<float> interleaved(n * 2);
    for (std::size_t i = 0; i < n; ++i) { interleaved[2*i] = l[i]; interleaved[2*i+1] = r[i]; }
    std::ofstream f(p, std::ios::binary | std::ios::trunc);
    if (!f) throw std::runtime_error("cannot write PCM " + p.string());
    f.write(reinterpret_cast<const char *>(interleaved.data()), static_cast<std::streamsize>(interleaved.size() * sizeof(float)));
    if (!f) throw std::runtime_error("PCM write failed " + p.string());
}
std::vector<double> hann(std::size_t n) {
    std::vector<double> w(n);
    for (std::size_t i = 0; i < n; ++i) w[i] = n < 2 ? 1.0 : 0.5 - 0.5 * std::cos(2 * kPi * i / (n - 1));
    return w;
}
double projection(const std::vector<float> &x, std::size_t first, const std::vector<double> &w, double hz) {
    if (first + w.size() > x.size() || w.empty()) return 0;
    const double c1 = std::cos(2 * kPi * hz / kRate), s1 = std::sin(2 * kPi * hz / kRate);
    double c = 1, s = 0, re = 0, im = 0, sum = 0;
    for (std::size_t i = 0; i < w.size(); ++i) {
        const double a = static_cast<double>(x[first + i]) * w[i];
        re += a * c; im -= a * s; sum += w[i];
        const double nc = c * c1 - s * s1; s = s * c1 + c * s1; c = nc;
    }
    return sum > 0 ? 2 * std::hypot(re, im) / sum : 0;
}
Fit fit(const std::vector<float> &x, std::size_t first, std::size_t n, double target) {
    Fit r;
    if (first >= x.size() || target <= 0) return r;
    n = std::min(n, x.size() - first); r.start = first; r.frames = n;
    if (n < kRate / 4) return r;
    const auto w = hann(n);
    const double range = std::max(5.0, target * 0.22), low = std::max(2.0, target - range), high = target + range;
    double best = -1, bestHz = target;
    for (double hz = low; hz <= high + 1e-9; hz += 0.25) {
        const double a = projection(x, first, w, hz);
        if (a > best) { best = a; bestHz = hz; }
    }
    const double coarse = bestHz; best = -1;
    for (double hz = std::max(low, coarse - 0.30); hz <= std::min(high, coarse + 0.30) + 1e-9; hz += 0.02) {
        const double a = projection(x, first, w, hz);
        if (a > best) { best = a; bestHz = hz; }
    }
    r.hz = bestHz; r.bestAmp = best; r.targetAmp = projection(x, first, w, target);
    return r;
}
double percentile(std::vector<std::uint64_t> v, double p) {
    if (v.empty()) return 0;
    std::sort(v.begin(), v.end());
    const auto i = static_cast<std::size_t>(std::ceil(p * v.size())) - 1;
    return static_cast<double>(v[std::min(i, v.size() - 1)]);
}
Timing summarize(const std::vector<Call> &calls) {
    Timing t; std::vector<std::uint64_t> v; v.reserve(calls.size());
    for (const auto &c : calls) {
        v.push_back(c.ns);
        if (c.ns > c.budget * 60 / 100) ++t.over60;
        if (c.ns > c.budget * 80 / 100) ++t.over80;
        if (c.ns > c.budget) ++t.over100;
    }
    t.p50 = percentile(v, .50); t.p99 = percentile(v, .99); t.p999 = percentile(v, .999);
    for (auto n : v) t.max = std::max(t.max, static_cast<double>(n));
    return t;
}
double rms(const std::vector<float> &x, std::size_t a, const std::vector<float> &y, std::size_t b, std::size_t n) {
    n = std::min(n, x.size() > a ? x.size() - a : 0); n = std::min(n, y.size() > b ? y.size() - b : 0);
    double s = 0; for (std::size_t i = 0; i < n; ++i) { const double d = x[a+i] - y[b+i]; s += d*d; }
    return n ? std::sqrt(s / n) : 0;
}
double corr(const std::vector<float> &x, std::size_t a, const std::vector<float> &y, std::size_t b, std::size_t n) {
    n = std::min(n, x.size() > a ? x.size() - a : 0); n = std::min(n, y.size() > b ? y.size() - b : 0);
    double xx=0, yy=0, xy=0; for (std::size_t i=0;i<n;++i) { const double u=x[a+i],v=y[b+i]; xx+=u*u; yy+=v*v; xy+=u*v; }
    return xx*yy > 1e-24 ? xy/std::sqrt(xx*yy) : 0;
}
std::vector<float> makeImpulse() {
    std::vector<float> x(kFrames*2, 0); x[2*9600]=.9f; x[2*9600+1]=-.35f; return x;
}
std::vector<float> makeGate() {
    std::vector<float> x(kFrames*2,0); std::uint32_t rng=0x51a7c0deU; double pl=0,pr=0;
    for (std::size_t n=0;n<kFrames;++n) {
        const double t=static_cast<double>(n)/kRate; const bool a=t>=.25&&t<.85,b=t>=1.25&&t<1.90;
        pl+=2*kPi*(a?220:440)/kRate; pr+=2*kPi*(a?330:660)/kRate;
        double click=0;
        for (std::size_t e : {std::size_t(12000),std::size_t(60000),std::size_t(105600)}) if(n>=e&&n<e+64) {
            rng^=rng<<13; rng^=rng>>17; rng^=rng<<5;
            const double noise=static_cast<double>(rng&0xffffU)/32767.5-1;
            click+=.42*noise*std::exp(-static_cast<double>(n-e)/13);
        }
        const double g=(a||b)?1:0;
        x[2*n]=static_cast<float>(g*.58*std::sin(pl)+click);
        x[2*n+1]=static_cast<float>(g*.46*std::sin(pr+.31)-click*.63);
    }
    return x;
}
std::string idFor(const Config &c) {
    std::ostringstream s; s<<c.engine<<"-b"<<c.block<<"-"<<c.scene<<"-p"<<std::fixed<<std::setprecision(2)<<c.scale; return s.str();
}
void appendJson(const std::filesystem::path &outDir, const Config &c, const Result &r) {
    std::ofstream o(outDir/"results.jsonl",std::ios::app); o<<std::setprecision(12);
    o<<"{\"id\":\""<<r.id<<"\",\"scene\":\""<<c.scene<<"\",\"sceneKind\":\""<<c.kind<<"\",\"engine\":\""<<c.engine
     <<"\",\"requestedEngine\":"<<c.engineVersion<<",\"blockFrames\":"<<c.block<<",\"sampleRate\":"<<kRate
     <<",\"pitchScale\":"<<c.scale<<",\"inputFrames\":"<<r.inFrames<<",\"preferredStartPad\":"<<r.pad
     <<",\"reportedStartDelay\":"<<r.delay<<",\"getLatencyAlias\":"<<r.latency<<",\"initialSamplesRequired\":"<<r.required
     <<",\"rawOutputFrames\":"<<r.rawFrames<<",\"alignedOutputFrames\":"<<r.alignedFrames<<",\"alignedDurationErrorFrames\":"<<r.durationError
     <<",\"leftTargetHz\":"<<c.leftHz*c.scale<<",\"rightTargetHz\":"<<c.rightHz*c.scale
     <<",\"leftMeasuredHz\":"<<r.left.hz<<",\"rightMeasuredHz\":"<<r.right.hz
     <<",\"leftTargetAmplitude\":"<<r.left.targetAmp<<",\"rightTargetAmplitude\":"<<r.right.targetAmp
     <<",\"leftBestAmplitude\":"<<r.left.bestAmp<<",\"rightBestAmplitude\":"<<r.right.bestAmp
     <<",\"frequencyWindow\":{\"rawFirstFrame\":"<<r.left.start<<",\"frames\":"<<r.left.frames<<"}"
     <<",\"alignedRms\":"<<r.rms<<",\"alignedPeak\":"<<r.alignedPeak<<",\"nonFiniteSamples\":"<<r.nonFinite<<",\"samplesAboveOne\":"<<r.overOne
     <<",\"impulseOnsetOffsetAfterPad\":"<<r.impulseOnset<<",\"impulsePeakOffsetAfterPadAndStartDelay\":"<<r.impulsePeak
     <<",\"firstRawAboveThreshold\":"<<r.firstRaw<<",\"peakRawFrame\":"<<r.peakFrame<<",\"peakAbs\":"<<r.peak
     <<",\"identityRmsDifference\":"<<r.identityDifference<<",\"identityZeroLagCorrelation\":"<<r.identityCorrelation
     <<",\"callbackCount\":"<<r.calls<<",\"callbackP50Ns\":"<<r.timing.p50<<",\"callbackP99Ns\":"<<r.timing.p99
     <<",\"callbackP999Ns\":"<<r.timing.p999<<",\"callbackMaxNs\":"<<r.timing.max
     <<",\"over60PercentBudget\":"<<r.timing.over60<<",\"over80PercentBudget\":"<<r.timing.over80<<",\"over100PercentBudget\":"<<r.timing.over100
     <<",\"cppNewCallsInCallbacks\":"<<r.newOps<<",\"cppDeleteCallsInCallbacks\":"<<r.deleteOps
     <<",\"callbacksWithCppNew\":"<<r.newCallbacks<<",\"callbacksWithCppDelete\":"<<r.deleteCallbacks
     <<",\"allocationProbe\":\"global C++ new/delete operators on calling thread; malloc/OS heap and locks are not intercepted\"}\n";
    if(!o) throw std::runtime_error("failed writing result JSONL");
}
Result run(const Config &c, const std::vector<float> &input, const std::filesystem::path &dataDir, const std::filesystem::path &outDir) {
    using RB=RubberBand::RubberBandStretcher;
    const int engineFlag=c.engineVersion==3?RB::OptionEngineFiner:RB::OptionEngineFaster;
    const int opts=RB::OptionProcessRealTime|RB::OptionThreadingNever|RB::OptionTransientsMixed|RB::OptionDetectorCompound|
        RB::OptionPhaseLaminar|RB::OptionWindowStandard|RB::OptionPitchHighQuality|RB::OptionChannelsApart|engineFlag;
    RB stretcher(kRate,2,opts,1.0,c.scale); stretcher.setMaxProcessSize(c.block);
    const int actual=stretcher.getEngineVersion();
    const std::size_t pad=stretcher.getPreferredStartPad(),delay=stretcher.getStartDelay(),alias=stretcher.getLatency();
    const std::size_t initialRequired=stretcher.getSamplesRequired(),n=input.size()/2;
    if(input.empty()||input.size()%2) throw std::runtime_error("invalid input PCM");
    if(actual!=c.engineVersion) throw std::runtime_error("engine selection mismatch");
    const std::size_t total=pad+n,capacity=total+2*kRate;
    std::vector<float> inL(c.block),inR(c.block),wetL(capacity),wetR(capacity);
    std::vector<float> scratchL(std::max<std::size_t>(c.block,4096)),scratchR(std::max<std::size_t>(c.block,4096));
    std::vector<Call> calls; calls.reserve((total+c.block-1)/c.block);
    std::size_t outFrames=0,pos=0,firstRaw=capacity,peakAt=0; double rawPeak=0;
    std::uint64_t news=0,deletes=0,newCallbacks=0,deleteCallbacks=0;
    while(pos<total) {
        const std::size_t frames=std::min(c.block,total-pos);
        for(std::size_t i=0;i<frames;++i) {
            const std::size_t f=pos+i;
            if(f<pad){inL[i]=0;inR[i]=0;} else {inL[i]=input[2*(f-pad)];inR[i]=input[2*(f-pad)+1];}
        }
        const float *ip[2]={inL.data(),inR.data()};
        const std::size_t required=stretcher.getSamplesRequired();
        g_new=0;g_delete=0;const auto t0=std::chrono::steady_clock::now();g_track=true;
        const bool final=pos+frames==total;
        try {
            stretcher.process(ip,frames,final);
            while(stretcher.available()>0) {
                const std::size_t avail=static_cast<std::size_t>(stretcher.available());
                if(outFrames>=capacity) throw std::runtime_error("Rubber Band output exceeded preallocated capacity");
                const std::size_t ask=std::min(avail,capacity-outFrames);
                float *op[2]={wetL.data()+outFrames,wetR.data()+outFrames};
                const std::size_t got=stretcher.retrieve(op,ask); if(!got)break;
                for(std::size_t i=0;i<got;++i) {
                    const double a=std::abs(static_cast<double>(wetL[outFrames+i])),b=std::abs(static_cast<double>(wetR[outFrames+i]));
                    const double v=std::max(a,b); if(v>rawPeak){rawPeak=v;peakAt=outFrames+i;}
                    if(firstRaw==capacity&&v>=1e-6)firstRaw=outFrames+i;
                }
                outFrames+=got;
            }
        } catch(...) {g_track=false;throw;}
        g_track=false;const auto t1=std::chrono::steady_clock::now();
        const std::uint64_t elapsed=static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(t1-t0).count());
        news+=g_new;deletes+=g_delete;newCallbacks+=g_new!=0;deleteCallbacks+=g_delete!=0;
        const std::uint64_t budget=static_cast<std::uint64_t>(static_cast<long double>(frames)*1e9L/kRate);
        const char *phase=outFrames==0?"startup_no_output":(pos<pad+kRate/2?"warmup_first_500ms":"steady");
        calls.push_back({calls.size(),pos,frames,required,outFrames,elapsed,budget,g_new,g_delete,final,phase});
        pos+=frames;
    }
    if(outFrames>capacity)throw std::runtime_error("output frame capacity overflow");
    wetL.resize(outFrames);wetR.resize(outFrames);
    const std::string id=idFor(c);
    writePcm(outDir/(id+"-raw.f32le"),wetL,wetR,outFrames);
    Result r;r.id=id;r.inFrames=n;r.pad=pad;r.delay=delay;r.latency=alias;r.required=initialRequired;r.rawFrames=outFrames;
    r.alignedFrames=outFrames>delay?outFrames-delay:0;r.durationError=static_cast<std::int64_t>(r.alignedFrames)-static_cast<std::int64_t>(n);
    r.firstRaw=firstRaw;r.peakFrame=peakAt;r.peak=rawPeak;r.leftTarget=c.leftHz*c.scale;r.rightTarget=c.rightHz*c.scale;
    r.timing=summarize(calls);r.calls=calls.size();r.newOps=news;r.deleteOps=deletes;r.newCallbacks=newCallbacks;r.deleteCallbacks=deleteCallbacks;
    const std::size_t alignedStart=std::min(delay,outFrames);
    double sum=0,peak=0;std::uint64_t finite=0,over=0;
    for(std::size_t i=alignedStart;i<outFrames;++i)for(float v:{wetL[i],wetR[i]}) {
        if(!std::isfinite(v)){++finite;continue;}sum+=static_cast<double>(v)*v;peak=std::max(peak,std::abs(static_cast<double>(v)));if(std::abs(v)>1)++over;
    }
    const std::size_t count=outFrames-alignedStart;
    r.rms=count?std::sqrt(sum/(2.0*count)):0;r.alignedPeak=peak;r.nonFinite=finite;r.overOne=over;
    if(c.tone&&r.alignedFrames>kRate) {
        const std::size_t start=kRate,frames=std::min<std::size_t>(kRate*3/2,r.alignedFrames-start);
        r.left=fit(wetL,delay+start,frames,r.leftTarget);r.right=fit(wetR,delay+start,frames,r.rightTarget);
    }
    if(c.impulse) {
        const std::size_t inputImpulse=9600,rawStart=std::min(outFrames,delay+inputImpulse>8192?delay+inputImpulse-8192:0);
        const std::size_t rawEnd=std::min(outFrames,delay+inputImpulse+8192);
        double local=0;for(std::size_t i=rawStart;i<rawEnd;++i)local=std::max(local,std::abs(static_cast<double>(wetL[i])));
        const double threshold=std::max(1e-7,local*.01);std::size_t onset=rawEnd,localPeak=rawStart;double p=0;
        for(std::size_t i=rawStart;i<rawEnd;++i){if(onset==rawEnd&&std::abs(static_cast<double>(wetL[i]))>=threshold)onset=i;const double a=std::abs(static_cast<double>(wetL[i]));if(a>p){p=a;localPeak=i;}}
        r.firstRaw=onset;r.peakFrame=localPeak;r.peak=p;
        r.impulseOnset=static_cast<std::int64_t>(onset)-static_cast<std::int64_t>(pad)-static_cast<std::int64_t>(inputImpulse);
        r.impulsePeak=static_cast<std::int64_t>(localPeak)-static_cast<std::int64_t>(delay)-static_cast<std::int64_t>(pad)-static_cast<std::int64_t>(inputImpulse);
    }
    if(c.scale==1.0&&c.tone&&r.alignedFrames>=n) {
        std::vector<float> il(n),ir(n);for(std::size_t i=0;i<n;++i){il[i]=input[2*i];ir[i]=input[2*i+1];}
        const std::size_t frames=std::min<std::size_t>(kRate,n-kRate),outStart=delay+kRate;
        r.identityDifference=.5*(rms(il,kRate,wetL,outStart,frames)+rms(ir,kRate,wetR,outStart,frames));
        r.identityCorrelation=.5*(corr(il,kRate,wetL,outStart,frames)+corr(ir,kRate,wetR,outStart,frames));
    }
    std::ofstream timing(outDir/"callback-timing.csv",std::ios::app);
    for(const auto &s:calls)timing<<id<<','<<s.index<<','<<s.inputStart<<','<<s.frames<<','<<s.required<<','<<s.outputAfter<<','<<s.ns<<','<<s.budget<<','<<s.newOps<<','<<s.deleteOps<<','<<(s.final?1:0)<<','<<s.phase<<'\n';
    appendJson(outDir,c,r);
    std::ofstream summary(outDir/"run-summary.csv",std::ios::app);
    summary<<id<<','<<c.kind<<','<<c.engine<<','<<c.block<<','<<c.scale<<','<<n<<','<<pad<<','<<delay<<','<<outFrames<<','<<r.alignedFrames<<','<<r.durationError<<','<<r.leftTarget<<','<<r.left.hz<<','<<r.rightTarget<<','<<r.right.hz<<','<<r.left.targetAmp<<','<<r.right.targetAmp<<','<<r.rms<<','<<r.alignedPeak<<','<<r.timing.p50<<','<<r.timing.p99<<','<<r.timing.p999<<','<<r.timing.max<<','<<r.timing.over60<<','<<r.timing.over80<<','<<r.timing.over100<<','<<news<<','<<deletes<<','<<r.impulseOnset<<','<<r.impulsePeak<<','<<r.identityDifference<<','<<r.identityCorrelation<<'\n';
    std::cout<<"RUN "<<id<<" out="<<r.alignedFrames<<" delay="<<delay<<" pad="<<pad<<" p99_us="<<r.timing.p99/1000<<" p999_us="<<r.timing.p999/1000<<" max_us="<<r.timing.max/1000<<" >budget="<<r.timing.over100<<" new="<<news<<'\n';
    return r;
}
void testEstimator() {
    std::vector<float> x(kRate);for(std::size_t i=0;i<x.size();++i)x[i]=static_cast<float>(.63*std::sin(2*kPi*440*i/kRate));
    const auto f=fit(x,0,x.size(),440);if(std::abs(f.hz-440)>.03||std::abs(f.bestAmp-.63)>.002)throw std::runtime_error("analysis self-test failed");
    if(percentile({1,2,3,4,5,6,7,8,9,10,100},.99)!=100)throw std::runtime_error("percentile self-test failed");
}
void referenceMetrics(const std::filesystem::path &data,const std::filesystem::path &out) {
    std::ofstream f(out/"signalsmith-reference-metrics.jsonl",std::ios::trunc);
    for(int hz:{55,110,220,880}) {
        const auto root=data/"signalsmith-reference";const auto in=readPcm(root/("input-"+std::to_string(hz)+"Hz.f32le"));
        const auto pcm=readPcm(root/("output-"+std::to_string(hz)+"Hz-down1.f32le"));
        if(in.size()!=pcm.size())throw std::runtime_error("Signalsmith input/output size mismatch");
        std::vector<float> l(pcm.size()/2),r(pcm.size()/2),il(in.size()/2),ir(in.size()/2);
        for(std::size_t i=0;i<l.size();++i){l[i]=pcm[2*i];r[i]=pcm[2*i+1];il[i]=in[2*i];ir[i]=in[2*i+1];}
        const auto a=fit(l,kRate,std::min<std::size_t>(kRate*3/2,l.size()-kRate),hz*.5);
        const auto b=fit(r,kRate,std::min<std::size_t>(kRate*3/2,r.size()-kRate),hz*1.25*.5);
        const auto ai=fit(il,kRate,kRate,hz),bi=fit(ir,kRate,kRate,hz*1.25);
        f<<std::setprecision(12)<<"{\"engine\":\"Signalsmith-pinned-archive\",\"scene\":\"tone"<<hz
         <<"\",\"pitchScale\":0.5,\"leftInputMeasuredHz\":"<<ai.hz<<",\"rightInputMeasuredHz\":"<<bi.hz
         <<",\"leftTargetHz\":"<<hz*.5<<",\"rightTargetHz\":"<<hz*.625
         <<",\"leftMeasuredHz\":"<<a.hz<<",\"rightMeasuredHz\":"<<b.hz
         <<",\"leftTargetAmplitude\":"<<a.targetAmp<<",\"rightTargetAmplitude\":"<<b.targetAmp<<"}\n";
    }
}
} // namespace

void *operator new(std::size_t n){if(g_track)++g_new;if(void*p=std::malloc(n?n:1))return p;throw std::bad_alloc();}
void *operator new[](std::size_t n){if(g_track)++g_new;if(void*p=std::malloc(n?n:1))return p;throw std::bad_alloc();}
void operator delete(void*p)noexcept{if(g_track&&p)++g_delete;std::free(p);}
void operator delete[](void*p)noexcept{if(g_track&&p)++g_delete;std::free(p);}
void operator delete(void*p,std::size_t)noexcept{if(g_track&&p)++g_delete;std::free(p);}
void operator delete[](void*p,std::size_t)noexcept{if(g_track&&p)++g_delete;std::free(p);}
void *operator new(std::size_t n,const std::nothrow_t&)noexcept{try{return ::operator new(n);}catch(...){return nullptr;}}
void *operator new[](std::size_t n,const std::nothrow_t&)noexcept{try{return ::operator new[](n);}catch(...){return nullptr;}}
void operator delete(void*p,const std::nothrow_t&)noexcept{::operator delete(p);}
void operator delete[](void*p,const std::nothrow_t&)noexcept{::operator delete[](p);}
#ifdef _MSC_VER
void *operator new(std::size_t n,std::align_val_t a){if(g_track)++g_new;if(void*p=_aligned_malloc(n?n:1,static_cast<std::size_t>(a)))return p;throw std::bad_alloc();}
void *operator new[](std::size_t n,std::align_val_t a){if(g_track)++g_new;if(void*p=_aligned_malloc(n?n:1,static_cast<std::size_t>(a)))return p;throw std::bad_alloc();}
void operator delete(void*p,std::align_val_t)noexcept{if(g_track&&p)++g_delete;_aligned_free(p);}
void operator delete[](void*p,std::align_val_t)noexcept{if(g_track&&p)++g_delete;_aligned_free(p);}
void operator delete(void*p,std::size_t,std::align_val_t)noexcept{if(g_track&&p)++g_delete;_aligned_free(p);}
void operator delete[](void*p,std::size_t,std::align_val_t)noexcept{if(g_track&&p)++g_delete;_aligned_free(p);}
#endif

int main(int argc,char**argv){
    try {
        if(argc!=3){std::cerr<<"usage: rubberband_r2r3_eval.exe <data-root> <output-root>\n";return 2;}
        testEstimator();const std::filesystem::path data(argv[1]),out(argv[2]);std::filesystem::create_directories(out);
        {std::ofstream f(out/"callback-timing.csv");f<<"runId,callbackIndex,inputStartFrame,inputFrames,samplesRequired,outputFramesAfter,elapsedNs,budgetNs,cppNewCalls,cppDeleteCalls,finalInput,phase\n";}
        {std::ofstream f(out/"run-summary.csv");f<<"id,kind,engine,block,scale,inputFrames,startPad,startDelay,rawFrames,alignedFrames,durationError,leftTarget,leftMeasured,rightTarget,rightMeasured,leftTargetAmp,rightTargetAmp,rms,peak,p50Ns,p99Ns,p999Ns,maxNs,over60,over80,over100,cppNew,cppDelete,impulseOnsetOffset,impulsePeakOffset,identityRmsDiff,identityCorrelation\n";}
        {std::ofstream f(out/"results.jsonl",std::ios::trunc);}
        referenceMetrics(data,out);
        std::vector<std::pair<int,std::vector<float>>> tones;for(int hz:{55,110,220,880})tones.emplace_back(hz,readPcm(data/"signalsmith-reference"/("input-"+std::to_string(hz)+"Hz.f32le")));
        const auto gate=makeGate(),impulse=makeImpulse();writePcm(data/"input-gated-transient-3s.f32le",gate);writePcm(data/"input-impulse-3s.f32le",impulse);
        std::uint64_t runs=0;const std::size_t blocks[]={64,128,256};
        for(const auto &tone:tones)for(int eng:{2,3})for(auto block:blocks)for(double scale:{.5,.25}){
            Config c;c.scene="tone"+std::to_string(tone.first);c.kind="stereo_independent_tones";c.engine=eng==2?"R2":"R3";c.engineVersion=eng;c.block=block;c.scale=scale;c.leftHz=tone.first;c.rightHz=tone.first*1.25;c.tone=true;run(c,tone.second,data,out);++runs;
        }
        for(int eng:{2,3})for(auto block:blocks){Config c;c.scene="tone220";c.kind="identity_stereo_tone";c.engine=eng==2?"R2":"R3";c.engineVersion=eng;c.block=block;c.scale=1;c.leftHz=220;c.rightHz=275;c.tone=true;run(c,tones[2].second,data,out);++runs;}
        for(int eng:{2,3})for(auto block:blocks){Config c;c.scene="impulse-offset-9600";c.kind="stereo_impulse_identity_latency";c.engine=eng==2?"R2":"R3";c.engineVersion=eng;c.block=block;c.scale=1;c.impulse=true;run(c,impulse,data,out);++runs;}
        for(int eng:{2,3})for(auto block:blocks)for(double scale:{.5,.25}){Config c;c.scene="gated-transient-3s";c.kind="gated_tones_and_transients";c.engine=eng==2?"R2":"R3";c.engineVersion=eng;c.block=block;c.scale=scale;run(c,gate,data,out);++runs;}
        std::cout<<"SELF_TESTS_PASS=1\nRUNS="<<runs<<"\n";return 0;
    }catch(const std::exception&e){std::cerr<<"EVALUATOR_FAILURE: "<<e.what()<<'\n';return 1;}
}

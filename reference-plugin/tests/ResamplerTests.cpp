// The standalone app's clock bridge between the loopback input and the
// headphone output.

#include "TestFramework.h"

#include "ref/dsp/DriftCompensatedFifo.h"
#include "ref/dsp/FFT.h"

#include <algorithm>
#include <cmath>
#include <random>
#include <vector>

using namespace ref::dsp;

namespace
{
constexpr double kPi = 3.14159265358979323846;

struct SimResult
{
    std::vector<float> out;
    uint32_t underruns = 0, overruns = 0;
    double ppm = 0.0, meanPpm = 0.0; // final, and averaged after the first minute
};

// Simulates two free-running device clocks feeding and draining the FIFO.
SimResult simulate (double inRate, double outRate, double driftPpm, int inBlock, int outBlock, double seconds, double toneHz,
                    double jitterSeconds = 0.0)
{
    std::mt19937 rng (17);
    std::uniform_real_distribution<double> late (0.0, jitterSeconds);
    DriftCompensatedFifo fifo;
    fifo.prepare (2, inRate, outRate, inBlock, outBlock);

    const double trueInRate = inRate * (1.0 + driftPpm * 1e-6);
    std::vector<float> inL ((size_t) inBlock), inR ((size_t) inBlock), outL ((size_t) outBlock), outR ((size_t) outBlock);
    SimResult res;
    res.out.reserve ((size_t) (seconds * outRate) + (size_t) outBlock);

    // Each device delivers or requests a block at the end of its own period;
    // events are processed in time order.
    double nextPush = inBlock / trueInRate, nextPull = 0.0;
    int64_t inFrames = 0;
    while (nextPull < seconds)
    {
        if (nextPush <= nextPull)
        {
            for (int i = 0; i < inBlock; ++i)
            {
                // The tone is defined on the input device's own clock.
                const double t = (double) (inFrames + i) / inRate;
                inL[(size_t) i] = inR[(size_t) i] = (float) (0.5 * std::sin (2.0 * kPi * toneHz * t));
            }
            const float* in[2] = { inL.data(), inR.data() };
            fifo.push (in, 2, inBlock, nextPush + late (rng));
            inFrames += inBlock;
            nextPush += inBlock / trueInRate;
        }
        else
        {
            float* out[2] = { outL.data(), outR.data() };
            fifo.pull (out, 2, outBlock, nextPull + late (rng));
            res.out.insert (res.out.end(), outL.begin(), outL.end());
            nextPull += outBlock / outRate;
        }
    }
    res.underruns = fifo.underruns();
    res.overruns = fifo.overruns();
    res.ppm = fifo.ratioCorrectionPpm();
    return res;
}

// Delivery the way PulseAudio's ALSA plugin hands capture audio over: input
// blocks arrive in pairs, and every `stepSeconds` the plugin shifts its own
// buffering by one block (alternately later and earlier). Measured on a real
// PulseAudio server: the old controller dropped out every 15-35 s.
SimResult simulateBursty (double driftPpm, int block, double seconds, double stepSeconds)
{
    DriftCompensatedFifo fifo;
    fifo.prepare (2, 48000.0, 48000.0, block, block);
    const double trueInRate = 48000.0 * (1.0 + driftPpm * 1e-6);
    const double period = block / trueInRate;
    std::vector<float> in ((size_t) block), outL ((size_t) block), outR ((size_t) block);
    SimResult res;
    res.out.reserve ((size_t) (seconds * 48000.0) + (size_t) block);

    int64_t k = 0, inFrames = 0, ppmCount = 0;
    double nextPull = 0.0, ppmSum = 0.0;
    auto deliveryTime = [&] (int64_t blockIndex)
    {
        const int64_t pairEnd = blockIndex | 1; // both blocks of a pair arrive with the second
        const double captured = (double) (pairEnd + 1) * period;
        const bool shifted = stepSeconds > 0.0 && ((int64_t) (captured / stepSeconds) % 2) == 1;
        return captured + 0.004 + (shifted ? period : 0.0);
    };
    double nextPush = deliveryTime (0);
    while (nextPull < seconds)
    {
        if (nextPush <= nextPull)
        {
            for (int i = 0; i < block; ++i)
                in[(size_t) i] = (float) (0.5 * std::sin (2.0 * kPi * 1000.0 * (double) (inFrames + i) / 48000.0));
            const float* p[2] = { in.data(), in.data() };
            fifo.push (p, 2, block, nextPush);
            inFrames += block;
            ++k;
            nextPush = std::max (nextPush, deliveryTime (k));
        }
        else
        {
            float* p[2] = { outL.data(), outR.data() };
            fifo.pull (p, 2, block, nextPull);
            res.out.insert (res.out.end(), outL.begin(), outL.end());
            nextPull += block / 48000.0;
            if (nextPull > 60.0)
            {
                ppmSum += fifo.ratioCorrectionPpm();
                ++ppmCount;
            }
        }
    }
    res.underruns = fifo.underruns();
    res.overruns = fifo.overruns();
    res.ppm = fifo.ratioCorrectionPpm();
    res.meanPpm = ppmCount > 0 ? ppmSum / ppmCount : 0.0;
    return res;
}

// Ratio of energy away from the strongest spectral peak (Blackman-Harris).
double spuriousDb (const std::vector<float>& x, size_t from, int n, double& peakHz, double fs)
{
    std::vector<std::complex<double>> b ((size_t) n);
    for (int i = 0; i < n; ++i)
    {
        const double r = (double) i / (n - 1);
        const double w = 0.35875 - 0.48829 * std::cos (2 * kPi * r) + 0.14128 * std::cos (4 * kPi * r) - 0.01168 * std::cos (6 * kPi * r);
        b[(size_t) i] = x[from + (size_t) i] * w;
    }
    FFT (n).forward (b.data());
    int peak = 1;
    for (int k = 1; k < n / 2; ++k)
        if (std::abs (b[(size_t) k]) > std::abs (b[(size_t) peak]))
            peak = k;
    peakHz = peak * fs / n;
    double sig = 0.0, rest = 0.0;
    for (int k = 1; k < n / 2; ++k)
    {
        const double e = std::norm (b[(size_t) k]);
        (std::abs (k - peak) <= 8 ? sig : rest) += e;
    }
    return 10.0 * std::log10 (rest / sig);
}
} // namespace

TEST_CASE ("bridge: absorbs +80 ppm clock drift with no dropouts over 10 minutes")
{
    const auto r = simulate (48000.0, 48000.0, 80.0, 480, 256, 600.0, 1000.0);
    CHECK_MSG (r.underruns == 0, std::to_string (r.underruns) + " underruns");
    CHECK_MSG (r.overruns == 0, std::to_string (r.overruns) + " overruns");
    CHECK_MSG (std::abs (r.ppm - 80.0) < 10.0, "settled at " + std::to_string (r.ppm) + " ppm");
}

TEST_CASE ("bridge: absorbs -150 ppm drift with mismatched block sizes")
{
    const auto r = simulate (48000.0, 48000.0, -150.0, 1024, 64, 300.0, 1000.0);
    CHECK (r.underruns == 0 && r.overruns == 0);
    CHECK_NEAR (r.ppm, -150.0, 15.0);
}

TEST_CASE ("bridge: resampling stays clean (spurious < -90 dB) while tracking drift")
{
    const auto r = simulate (48000.0, 48000.0, 60.0, 480, 256, 40.0, 997.0);
    double peakHz = 0.0;
    const double spur = spuriousDb (r.out, (size_t) (30 * 48000), 1 << 16, peakHz, 48000.0);
    CHECK_MSG (spur < -90.0, "spurious " + std::to_string (spur) + " dB");
    CHECK_NEAR (peakHz, 997.0 * (1.0 + 60e-6), 1.0);
}

TEST_CASE ("bridge: tolerates up to 2 ms of callback timing jitter")
{
    const auto r = simulate (48000.0, 48000.0, 40.0, 480, 480, 300.0, 1000.0, 0.002);
    CHECK (r.underruns == 0 && r.overruns == 0);
    CHECK_NEAR (r.ppm, 40.0, 15.0); // wanders a few ppm under heavy jitter: inaudible
    double peakHz = 0.0;
    const double spur = spuriousDb (r.out, (size_t) (200 * 48000), 1 << 16, peakHz, 48000.0);
    CHECK_MSG (spur < -85.0, "spurious " + std::to_string (spur) + " dB");
}

TEST_CASE ("bridge: converts 44.1 kHz input to a 48 kHz output")
{
    const auto r = simulate (44100.0, 48000.0, 0.0, 441, 480, 20.0, 1000.0);
    CHECK (r.underruns == 0);
    double peakHz = 0.0;
    const double spur = spuriousDb (r.out, (size_t) (10 * 48000), 1 << 16, peakHz, 48000.0);
    CHECK_NEAR (peakHz, 1000.0, 1.0);
    CHECK (spur < -80.0);
}

TEST_CASE ("bridge: recovers after the input stalls")
{
    DriftCompensatedFifo fifo;
    fifo.prepare (2, 48000.0, 48000.0, 256, 256);
    std::vector<float> buf (256, 0.25f), out (256);
    const float* in[2] = { buf.data(), buf.data() };
    float* o[2] = { out.data(), out.data() };
    for (int i = 0; i < 100; ++i)
    {
        fifo.push (in, 2, 256);
        fifo.pull (o, 2, 256);
    }
    for (int i = 0; i < 10; ++i)
        fifo.pull (o, 2, 256); // input stopped: silence, one underrun
    CHECK (out[255] == 0.0f);
    for (int i = 0; i < 100; ++i)
    {
        fifo.push (in, 2, 256);
        fifo.pull (o, 2, 256);
    }
    CHECK_NEAR (out[128], 0.25, 1e-3);
}

TEST_CASE ("bridge: paired deliveries and buffering shifts cause no dropouts (PulseAudio pattern)")
{
    for (int block : { 256, 512 })
    {
        const auto r = simulateBursty (0.0, block, 600.0, 20.0);
        CHECK_MSG (r.underruns == 0 && r.overruns == 0, std::to_string (block) + ": " + std::to_string (r.underruns) + " underruns, "
                                                            + std::to_string (r.overruns) + " overruns");
        // Each shift moves the read rate briefly (a fraction of a cent); on
        // average it must not.
        CHECK_MSG (std::abs (r.meanPpm) < 25.0, std::to_string (block) + ": mean correction " + std::to_string (r.meanPpm) + " ppm with no drift");
    }
}

TEST_CASE ("bridge: tracks drift without bias under paired deliveries")
{
    for (double drift : { 120.0, -250.0 })
    {
        const auto r = simulateBursty (drift, 480, 600.0, 0.0);
        CHECK (r.underruns == 0 && r.overruns == 0);
        CHECK_NEAR (r.ppm, drift, 15.0);
    }
}

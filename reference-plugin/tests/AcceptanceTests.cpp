// Spec Section 12, the rows that need no host: filter accuracy, bypass,
// Amount 0%, level match, latency, real-time safety, robustness, smoothing
// and CPU. State, render safety and host rows are covered in the plugin
// tests and the manual host run.

#include "AllocationGuard.h"
#include "TestData.h"
#include "TestFramework.h"

#include "ref/dsp/Engine.h"
#include "ref/dsp/FFT.h"
#include "ref/dsp/FilterSet.h"
#include "ref/dsp/Grid.h"
#include "ref/dsp/Loudness.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <limits>
#include <random>

using namespace ref::dsp;

// Under Clang's RealtimeSanitizer (REF_RTSAN, CI) the audio-thread calls run
// inside a [[clang::nonblocking]] function, so any allocation, lock or
// blocking call reached from process() aborts the test.
#if defined(REF_RTSAN) && REF_RTSAN
 #define REF_REALTIME [[clang::nonblocking]]
#else
 #define REF_REALTIME
#endif

namespace
{
void processRealtime (Engine& e, float* const* ch, int n, const EngineParams& p) noexcept REF_REALTIME
{
    e.process (ch, 2, n, p);
}

std::vector<double> impulseResponse (FilterSet& set, int length)
{
    std::vector<double> l ((size_t) length, 0.0), r ((size_t) length, 0.0);
    l[0] = r[0] = 1.0;
    set.reset();
    for (int off = 0; off < length; off += 512)
    {
        double* ch[2] = { l.data() + off, r.data() + off };
        set.process (ch, 2, std::min (512, length - off), nullptr, set.linearAmount());
    }
    return l;
}

// Magnitude (dB) of a response at the FFT bin nearest each probe frequency.
struct Spectrum
{
    std::vector<std::complex<double>> bins;
    double fs;
    int n;

    Spectrum (const std::vector<double>& x, double sampleRate) : fs (sampleRate)
    {
        n = nextPowerOfTwo ((int) x.size());
        bins.assign ((size_t) n, {});
        for (size_t i = 0; i < x.size(); ++i)
            bins[i] = x[i];
        FFT (n).forward (bins.data());
    }

    double binHz (double hz) const { return std::round (hz * n / fs) * fs / n; }
    double db (double hz) const { return 20.0 * std::log10 (std::abs (bins[(size_t) std::lround (hz * n / fs)])); }
};

struct Signal
{
    std::vector<float> l, r;
    explicit Signal (size_t n) : l (n, 0.0f), r (n, 0.0f) {}
};

Signal noise (size_t n, float level, unsigned seed = 1)
{
    Signal s (n);
    std::mt19937 rng (seed);
    std::uniform_real_distribution<float> d (-level, level);
    for (size_t i = 0; i < n; ++i)
    {
        s.l[i] = d (rng);
        s.r[i] = d (rng);
    }
    return s;
}

// Paul Kellet's pink filter on white noise.
Signal pinkNoise (size_t n, float level, unsigned seed = 7)
{
    Signal s (n);
    std::mt19937 rng (seed);
    std::normal_distribution<double> d (0.0, 1.0);
    for (int ch = 0; ch < 2; ++ch)
    {
        double b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        auto& out = ch == 0 ? s.l : s.r;
        for (size_t i = 0; i < n; ++i)
        {
            const double w = d (rng);
            b0 = 0.99886 * b0 + w * 0.0555179;
            b1 = 0.99332 * b1 + w * 0.0750759;
            b2 = 0.96900 * b2 + w * 0.1538520;
            b3 = 0.86650 * b3 + w * 0.3104856;
            b4 = 0.55000 * b4 + w * 0.5329522;
            b5 = -0.7616 * b5 - w * 0.0168980;
            out[i] = (float) (level * 0.11 * (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362));
            b6 = w * 0.115926;
        }
    }
    return s;
}

// Runs a whole signal through an engine in host-sized blocks.
void run (Engine& e, Signal& s, const EngineParams& p, int block, bool markAudioThread = false)
{
    for (size_t off = 0; off < s.l.size(); off += (size_t) block)
    {
        float* ch[2] = { s.l.data() + off, s.r.data() + off };
        const int n = (int) std::min ((size_t) block, s.l.size() - off);
        if (markAudioThread)
        {
            reftest::ScopedAudioThread audio;
            e.process (ch, 2, n, p);
        }
        else
        {
            e.process (ch, 2, n, p);
        }
    }
}

void prepareWith (Engine& e, double fs, int block, const FilterSetConfig& cfg)
{
    e.prepare (fs, block, 2);
    e.submit (FilterSet::build (cfg));
}

CorrectionResult mm500Neutral()
{
    return generateCorrection (reftest::loadProfile ("audeze_mm500"), reftest::loadTarget ("neutral@1.csv"));
}
} // namespace

//==============================================================================
TEST_CASE ("acceptance: filter accuracy, every mode at every supported rate (within 0.1 dB, 20 Hz-20 kHz)")
{
    const CorrectionResult corrections[] = { reftest::mm520Studio(), mm500Neutral() };
    for (const auto& corr : corrections)
    {
        for (double fs : kSupportedSampleRates)
        {
            for (auto mode : { FilterMode::minimumPhase, FilterMode::linearPhase })
            {
                const auto cfg = reftest::configFor (corr, mode, fs);
                auto set = FilterSet::build (cfg);
                const auto ir = impulseResponse (*set, nextPowerOfTwo ((int) (2.0 * fs)));
                const Spectrum spec (ir, fs);

                double worst = 0.0, worstHz = 0.0;
                for (int i = 0; i < 300; ++i)
                {
                    const double hz = spec.binHz (20.0 * std::pow (1000.0, i / 299.0));
                    const double designed = mode == FilterMode::minimumPhase
                                              ? analogCascadeDb (cfg.calibration.data(), (int) cfg.calibration.size(), hz)
                                              : sampleCorrectionExtended (cfg.correction, hz, -12.0, 6.0);
                    const double err = std::abs (spec.db (hz) - designed);
                    if (err > worst)
                    {
                        worst = err;
                        worstHz = hz;
                    }
                }
                char msg[160];
                std::snprintf (msg, sizeof (msg), "%s at %.1f kHz: %.3f dB off at %.0f Hz",
                               mode == FilterMode::minimumPhase ? "Min Phase" : "Linear Phase", fs / 1000.0, worst, worstHz);
                CHECK_MSG (worst <= 0.1, msg);
            }
        }
    }
}

TEST_CASE ("acceptance: Minimum Phase stays accurate with high-frequency overlay nodes at 44.1 kHz")
{
    auto cfg = reftest::configFor (reftest::mm520Studio(), FilterMode::minimumPhase, 44100.0);
    cfg.overlay = { { FilterType::bell, 14000.0, 4.0, 2.5 }, { FilterType::highShelf, 11000.0, -3.0, 0.7071 }, { FilterType::lowPass, 19000.0, 0.0, 0.7071 } };
    auto set = FilterSet::build (cfg);
    const auto ir = impulseResponse (*set, 1 << 17);
    const Spectrum spec (ir, 44100.0);
    double worst = 0.0;
    for (int i = 0; i < 300; ++i)
    {
        const double hz = spec.binHz (20.0 * std::pow (1000.0, i / 299.0));
        const double designed = analogCascadeDb (cfg.calibration.data(), (int) cfg.calibration.size(), hz)
                              + analogCascadeDb (cfg.overlay.data(), (int) cfg.overlay.size(), hz);
        worst = std::max (worst, std::abs (spec.db (hz) - designed));
    }
    CHECK_MSG (worst <= 0.1, "overlay cascade off by " + std::to_string (worst) + " dB");
}

TEST_CASE ("acceptance: bypass is bit-exact (Linear Phase: after the reported delay)")
{
    for (auto mode : { FilterMode::minimumPhase, FilterMode::linearPhase })
    {
        Engine e;
        prepareWith (e, 48000.0, 512, reftest::configFor (reftest::mm520Studio(), mode, 48000.0));
        const auto input = noise (48000, 0.9f);
        auto s = input;
        EngineParams p;
        p.bypass = true;
        // Uneven block sizes, as some hosts deliver.
        size_t off = 0;
        std::mt19937 rng (3);
        while (off < s.l.size())
        {
            const int n = (int) std::min<size_t> (1 + rng() % 511, s.l.size() - off);
            float* ch[2] = { s.l.data() + off, s.r.data() + off };
            e.process (ch, 2, n, p);
            off += (size_t) n;
        }
        const int L = mode == FilterMode::linearPhase ? linearPhaseSizing (48000.0).latencySamples : 0;
        bool exact = true;
        for (size_t i = (size_t) L; i < s.l.size() && exact; ++i)
            exact = s.l[i] == input.l[i - (size_t) L] && s.r[i] == input.r[i - (size_t) L];
        CHECK_MSG (exact, mode == FilterMode::linearPhase ? "Linear Phase bypass not bit-exact" : "Min Phase bypass not bit-exact");
    }
}

TEST_CASE ("acceptance: Amount 0% nulls against bypass below -120 dBFS")
{
    for (auto mode : { FilterMode::minimumPhase, FilterMode::linearPhase })
    {
        Engine a, b;
        prepareWith (a, 48000.0, 256, reftest::configFor (reftest::mm520Studio(), mode, 48000.0, 0.0));
        prepareWith (b, 48000.0, 256, reftest::configFor (reftest::mm520Studio(), mode, 48000.0, 0.0));
        const auto input = noise (48000 * 2, 0.5f, 11);
        auto sa = input, sb = input;
        EngineParams pa;
        pa.amount = 0.0;
        EngineParams pb = pa;
        pb.bypass = true;
        run (a, sa, pa, 256);
        run (b, sb, pb, 256);
        double worst = 0.0;
        for (size_t i = 0; i < input.l.size(); ++i)
            worst = std::max ({ worst, (double) std::abs (sa.l[i] - sb.l[i]), (double) std::abs (sa.r[i] - sb.r[i]) });
        const double db = 20.0 * std::log10 (std::max (worst, 1e-20));
        CHECK_MSG (db < -120.0, "residual " + std::to_string (db) + " dBFS");
    }
}

TEST_CASE ("acceptance: level match, pink noise A vs B within 0.3 dB (BS.1770)")
{
    const double fs = 48000.0;
    const CorrectionResult corrections[] = { reftest::mm520Studio(), mm500Neutral(),
                                             generateCorrection (reftest::loadProfile ("audeze_mm520"), reftest::loadTarget ("neutral@1.csv")) };
    const auto pink = pinkNoise ((size_t) (fs * 12), 0.25f);
    for (const auto& corr : corrections)
    {
        for (auto mode : { FilterMode::minimumPhase, FilterMode::linearPhase })
        {
            for (double amount : { 1.0, 0.5 })
            {
                double loud[2];
                for (int side = 0; side < 2; ++side)
                {
                    Engine e;
                    prepareWith (e, fs, 512, reftest::configFor (corr, mode, fs, amount));
                    auto s = pink;
                    EngineParams p;
                    p.amount = amount;
                    p.calibrated = side == 1;
                    p.protection = false;
                    run (e, s, p, 512);
                    // Skip the first second (settling and latency).
                    const float* ch[2] = { s.l.data() + (size_t) fs, s.r.data() + (size_t) fs };
                    loud[side] = measureLoudnessDb (ch, 2, (int) (s.l.size() - (size_t) fs), fs);
                }
                char msg[128];
                std::snprintf (msg, sizeof (msg), "%s amount %.0f%%: RAW %.2f vs CAL %.2f LUFS",
                               mode == FilterMode::minimumPhase ? "Min Phase" : "Linear Phase", amount * 100, loud[0], loud[1]);
                CHECK_MSG (std::abs (loud[0] - loud[1]) <= 0.3, msg);
            }
        }
    }
}

TEST_CASE ("acceptance: measured latency equals reported latency")
{
    for (double fs : { 44100.0, 48000.0, 96000.0, 192000.0 })
    {
        for (auto mode : { FilterMode::minimumPhase, FilterMode::linearPhase })
        {
            const int reported = mode == FilterMode::linearPhase ? linearPhaseSizing (fs).latencySamples : 0;
            for (bool calibrated : { false, true })
            {
                Engine e;
                prepareWith (e, fs, 128, reftest::configFor (reftest::mm520Studio(), mode, fs));
                Signal s ((size_t) (reported + fs * 0.5));
                const size_t at = 1000;
                s.l[at] = s.r[at] = 0.25f;
                EngineParams p;
                p.calibrated = calibrated;
                p.autoGain = false;
                run (e, s, p, 128);
                CHECK (e.activeLatency() == reported);

                if (! calibrated || mode == FilterMode::linearPhase)
                {
                    size_t peak = 0;
                    for (size_t i = 0; i < s.l.size(); ++i)
                        if (std::abs (s.l[i]) > std::abs (s.l[peak]))
                            peak = i;
                    CHECK_MSG ((int) (peak - at) == reported,
                               "peak at +" + std::to_string ((int) peak - (int) at) + ", reported " + std::to_string (reported));
                }
                if (calibrated && mode == FilterMode::linearPhase)
                {
                    // Linear phase: symmetric about the reported delay.
                    double asym = 0.0;
                    for (int k = 1; k < 2000; ++k)
                        asym = std::max (asym, (double) std::abs (s.l[at + (size_t) reported + (size_t) k] - s.l[at + (size_t) reported - (size_t) k]));
                    CHECK (asym < 1e-6);
                }
            }
        }
    }
}

TEST_CASE ("acceptance: real-time safety, no allocations in process across every transition")
{
    const double fs = 48000.0;
    Engine e;
    e.prepare (fs, 64, 2);
    e.submit (FilterSet::build (reftest::configFor (reftest::mm520Studio(), FilterMode::minimumPhase, fs)));
    auto s = noise ((size_t) fs * 4, 0.3f);
    EngineParams p;

    reftest::audioAllocations.store (0);
    auto step = [&] (size_t from, size_t to)
    {
        for (size_t off = from; off < to; off += 64)
        {
            float* ch[2] = { s.l.data() + off, s.r.data() + off };
            reftest::ScopedAudioThread audio;
            processRealtime (e, ch, 64, p);
        }
        e.collectGarbage();
    };

    step (0, 9600);
    p.amount = 0.3; // per-sample Amount ramp
    step (9600, 19200);
    p.calibrated = false; // A/B crossfade
    step (19200, 28800);
    p.calibrated = true;
    p.bypass = true; // bypass crossfade
    step (28800, 38400);
    p.bypass = false;
    // New set, same latency: warm-up and crossfade.
    e.submit (FilterSet::build (reftest::configFor (mm500Neutral(), FilterMode::minimumPhase, fs)));
    step (38400, 57600);
    // Latency change: dip, swap, warm-up.
    e.submit (FilterSet::build (reftest::configFor (mm500Neutral(), FilterMode::linearPhase, fs, 0.3)));
    step (57600, 96000);
    // Linear Phase Amount rebuild: state hand-over and crossfade.
    e.submit (FilterSet::build (reftest::configFor (mm500Neutral(), FilterMode::linearPhase, fs, 0.8)));
    step (96000, 134400);
    p.renderBypass = true;
    step (134400, 144000);
    p.renderBypass = false;
    step (144000, 192000);

    CHECK_MSG (reftest::audioAllocations.load() == 0, std::to_string (reftest::audioAllocations.load()) + " allocations on the audio thread");
    CHECK (e.activeLatency() == linearPhaseSizing (fs).latencySamples);
}

TEST_CASE ("acceptance: robustness, NaN/Inf/denormal/full-scale input")
{
    for (auto mode : { FilterMode::minimumPhase, FilterMode::linearPhase })
    {
        for (bool protection : { true, false })
        {
            Engine e, ref;
            const auto cfg = reftest::configFor (reftest::mm520Studio(), mode, 48000.0);
            prepareWith (e, 48000.0, 256, cfg);
            prepareWith (ref, 48000.0, 256, cfg);
            EngineParams p;
            p.protection = protection;

            auto s = noise (48000, 0.5f, 5);
            // Block 20: NaN, 21: Inf, 22: denormals, 23: full scale, 24: absurd level.
            for (int i = 0; i < 256; ++i)
            {
                s.l[20 * 256 + (size_t) i] = std::numeric_limits<float>::quiet_NaN();
                s.r[21 * 256 + (size_t) i] = std::numeric_limits<float>::infinity();
                s.l[22 * 256 + (size_t) i] = s.r[22 * 256 + (size_t) i] = 1e-40f;
                s.l[23 * 256 + (size_t) i] = s.r[23 * 256 + (size_t) i] = (i & 1) ? 1.0f : -1.0f;
                s.l[24 * 256 + (size_t) i] = 1e30f;
            }
            // The reference sees what the processing path sees.
            auto sanitized = s;
            for (auto* v : { &sanitized.l, &sanitized.r })
                for (auto& x : *v)
                    x = std::isfinite (x) ? std::clamp (x, -1e4f, 1e4f) : 0.0f;

            run (e, s, p, 256);
            run (ref, sanitized, p, 256);

            bool finite = true, recovered = true;
            for (size_t i = 0; i < s.l.size(); ++i)
            {
                finite = finite && std::isfinite (s.l[i]) && std::isfinite (s.r[i]);
                if (i >= 26 * 256)
                    recovered = recovered && s.l[i] == sanitized.l[i] && s.r[i] == sanitized.r[i];
            }
            CHECK (finite);
            CHECK (recovered);
            if (protection)
            {
                float peak = 0.0f;
                for (size_t i = 0; i < s.l.size(); ++i)
                    peak = std::max ({ peak, std::abs (s.l[i]), std::abs (s.r[i]) });
                CHECK (peak <= 0.98856f);
            }
        }
    }
}

TEST_CASE ("acceptance: smoothing, Amount and Output swept in 10 ms leave no discontinuity above -80 dBFS")
{
    for (auto mode : { FilterMode::minimumPhase, FilterMode::linearPhase })
    {
        const double fs = 48000.0;
        Engine e;
        prepareWith (e, fs, 32, reftest::configFor (reftest::mm520Studio(), mode, fs));
        Signal s ((size_t) fs);
        for (size_t i = 0; i < s.l.size(); ++i)
            s.l[i] = s.r[i] = (float) (0.1 * std::sin (2.0 * 3.14159265358979 * 100.0 * i / fs));

        // Sweep in 15 blocks of 32 samples = 10 ms, from 0% / -24 dB to 100% / +12 dB.
        EngineParams p;
        p.amount = 0.0;
        p.outputGainDb = -24.0;
        for (size_t off = 0; off < s.l.size(); off += 32)
        {
            const size_t block = off / 32;
            if (block >= 300 && block < 315)
            {
                const double t = (block - 299) / 15.0;
                p.amount = t;
                p.outputGainDb = -24.0 + 36.0 * t;
            }
            float* ch[2] = { s.l.data() + off, s.r.data() + off };
            e.process (ch, 2, 32, p);
        }

        // Cubic-prediction residual: a smooth signal is predicted almost
        // exactly from its neighbours, a click is not.
        double worst = 0.0;
        for (size_t i = 9000; i + 2 < 20000; ++i)
        {
            const double pred = (-s.l[i - 2] + 4.0 * s.l[i - 1] + 4.0 * s.l[i + 1] - s.l[i + 2]) / 6.0;
            worst = std::max (worst, std::abs ((double) s.l[i] - pred));
        }
        const double db = 20.0 * std::log10 (std::max (worst, 1e-20));
        CHECK_MSG (db < -80.0, std::string (mode == FilterMode::minimumPhase ? "Min" : "Linear") + " Phase: " + std::to_string (db) + " dBFS");
    }
}

TEST_CASE ("acceptance: CPU at 48 kHz, 64-sample buffer")
{
    for (auto mode : { FilterMode::minimumPhase, FilterMode::linearPhase })
    {
        const double fs = 48000.0;
        Engine e;
        prepareWith (e, fs, 64, reftest::configFor (reftest::mm520Studio(), mode, fs));
        auto s = noise ((size_t) fs * 10, 0.3f);
        EngineParams p;
        const auto t0 = std::chrono::steady_clock::now();
        run (e, s, p, 64);
        const double secs = std::chrono::duration<double> (std::chrono::steady_clock::now() - t0).count();
        const double percent = 100.0 * secs / 10.0;
        std::printf ("    %s Phase: %.2f%% of one core\n", mode == FilterMode::minimumPhase ? "Min" : "Linear", percent);
#ifdef NDEBUG
        CHECK (percent < (mode == FilterMode::minimumPhase ? 1.0 : 3.0));
#endif
    }
}

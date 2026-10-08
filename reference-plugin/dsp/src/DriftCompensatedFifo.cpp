#include "ref/dsp/DriftCompensatedFifo.h"

#include "ref/dsp/FFT.h"

#include <algorithm>
#include <chrono>
#include <cmath>

namespace ref::dsp
{

namespace
{
double besselI0 (double x)
{
    double sum = 1.0, term = 1.0;
    for (int k = 1; k < 60; ++k)
    {
        term *= (x / (2.0 * k)) * (x / (2.0 * k));
        sum += term;
    }
    return sum;
}

constexpr double kCutoff = 0.94;      // of the lower Nyquist: flat to ~20.7 kHz at 48 kHz
constexpr double kKaiserBeta = 8.0;   // about -80 dB stopband
constexpr double kMaxCorrection = 0.002; // +-2000 ppm, far beyond real clock drift

// PI loop on the fill error in seconds. The plant is an integrator
// (fill' = drift - correction), so the closed loop is s^2 + Kp s + Ki:
// critically damped at w = 0.05 rad/s (about 40 s to settle). Slow enough
// that the read rate never audibly wobbles, fast enough to track drift.
constexpr double kLoopOmega = 0.05;
constexpr double kKp = 2.0 * kLoopOmega;
constexpr double kKi = kLoopOmega * kLoopOmega;
constexpr double kFillSmoothingSeconds = 2.0;
constexpr double kRatioSmoothingSeconds = 2.0; // callback jitter must not reach the read rate

double nowSeconds() noexcept
{
    return std::chrono::duration<double> (std::chrono::steady_clock::now().time_since_epoch()).count();
}
} // namespace

void DriftCompensatedFifo::prepare (int numChannels, double inputRate, double outputRate, int maxInputBlock, int maxOutputBlock)
{
    channels = std::max (1, numChannels);
    inRate = inputRate;
    outRate = outputRate;
    nominalRatio = inRate / outRate;

    const double scale = std::max (1.0, nominalRatio);
    const double halfTaps = std::ceil (kTaps / 2 * scale);
    const double jitter = maxInputBlock + maxOutputBlock * nominalRatio;
    target = 1.5 * jitter + halfTaps + 32.0;

    capacity = nextPowerOfTwo ((int) (4.0 * target + 4.0 * jitter + 8192.0));
    mask = capacity - 1;
    ring.assign ((size_t) channels, std::vector<float> ((size_t) capacity, 0.0f));

    const int half = kTaps / 2;
    table.assign ((size_t) (kTaps * kOversample + 2), 0.0f);
    for (int i = 0; i <= kTaps * kOversample; ++i)
    {
        const double x = (double) i / kOversample - half;
        const double t = kCutoff * x;
        const double sinc = std::abs (t) < 1e-12 ? 1.0 : std::sin (3.14159265358979323846 * t) / (3.14159265358979323846 * t);
        const double r = x / half;
        const double w = std::abs (r) <= 1.0 ? besselI0 (kKaiserBeta * std::sqrt (1.0 - r * r)) / besselI0 (kKaiserBeta) : 0.0;
        table[(size_t) i] = (float) (kCutoff * sinc * w);
    }
    reset();
}

void DriftCompensatedFifo::reset() noexcept
{
    for (auto& r : ring)
        std::fill (r.begin(), r.end(), 0.0f);
    written.store (0);
    released.store (0);
    readBase = 0;
    readFrac = 0.0;
    primed = false;
    integral = 0.0;
    smoothedFill = target;
    ratio = nominalRatio;
    corr = 0.0;
    correctionPpm.store (0.0);
    fillShown.store (0.0);
}

double DriftCompensatedFifo::kernel (double x) const noexcept
{
    const double pos = (x + kTaps / 2) * kOversample;
    if (pos < 0.0 || pos >= (double) (kTaps * kOversample))
        return 0.0;
    const int i = (int) pos;
    const double t = pos - i;
    return table[(size_t) i] + (table[(size_t) i + 1] - table[(size_t) i]) * t;
}

void DriftCompensatedFifo::push (const float* const* input, int numChannels, int numFrames, double timestamp) noexcept
{
    if (capacity == 0 || numFrames <= 0)
        return;

    const int64_t w = written.load (std::memory_order_relaxed);
    const int64_t r = released.load (std::memory_order_acquire);
    const int64_t space = capacity - (w - r);
    int n = numFrames;
    if (n > space)
    {
        overrunCount.fetch_add (1, std::memory_order_relaxed);
        n = (int) std::max<int64_t> (0, space);
    }

    bool signal = false;
    for (int c = 0; c < channels; ++c)
    {
        const float* src = numChannels > 0 ? input[std::min (c, numChannels - 1)] : nullptr;
        auto& dst = ring[(size_t) c];
        for (int i = 0; i < n; ++i)
        {
            const float v = src != nullptr && std::isfinite (src[i]) ? src[i] : 0.0f;
            signal = signal || std::abs (v) > 1e-6f;
            dst[(size_t) ((w + i) & mask)] = v;
        }
    }
    if (signal)
        receiving.store (true, std::memory_order_relaxed);
    written.store (w + n, std::memory_order_release);

    const auto seq = pushSeq.load (std::memory_order_relaxed);
    pushSeq.store (seq + 1, std::memory_order_release);
    std::atomic_thread_fence (std::memory_order_release);
    pushFrames.store (w + n, std::memory_order_relaxed);
    pushTime.store (timestamp >= 0.0 ? timestamp : nowSeconds(), std::memory_order_relaxed);
    pushSeq.store (seq + 2, std::memory_order_release);
}

void DriftCompensatedFifo::pull (float* const* output, int numChannels, int numFrames, double timestamp) noexcept
{
    const double now = timestamp >= 0.0 ? timestamp : nowSeconds();

    auto silence = [&] (int from)
    {
        for (int c = 0; c < numChannels; ++c)
            std::fill (output[c] + from, output[c] + numFrames, 0.0f);
    };

    if (capacity == 0)
    {
        silence (0);
        return;
    }

    const double scale = std::max (1.0, nominalRatio);
    const int half = (int) std::ceil (kTaps / 2 * scale);
    const int64_t w = written.load (std::memory_order_acquire);

    // Start, or restart after an underrun or a stalled output, at the target
    // fill. The read position only ever moves forward.
    const bool stalled = primed && (double) (w - readBase) > 3.0 * target + 2048.0;
    if (! primed || stalled)
    {
        if (stalled)
            overrunCount.fetch_add (1, std::memory_order_relaxed);
        if ((double) (w - readBase) < target + half + 1)
        {
            silence (0);
            return;
        }
        readBase = w - (int64_t) target;
        readFrac = 0.0;
        integral = 0.0;
        smoothedFill = target;
        primed = true;
    }

    const double startPos = (double) readBase + readFrac;
    const double invScale = 1.0 / scale;
    int j = 0;
    for (; j < numFrames; ++j)
    {
        if (readBase + half + 1 >= w)
        {
            underrunCount.fetch_add (1, std::memory_order_relaxed);
            primed = false;
            break;
        }

        for (int c = 0; c < numChannels; ++c)
        {
            const auto& src = ring[(size_t) std::min (c, channels - 1)];
            double acc = 0.0;
            for (int k = -half + 1; k <= half; ++k)
                acc += src[(size_t) ((readBase + k) & mask)] * kernel ((k - readFrac) * invScale);
            output[c][j] = (float) (acc * invScale);
        }

        readFrac += ratio;
        const double adv = std::floor (readFrac);
        readBase += (int64_t) adv;
        readFrac -= adv;
    }
    if (j < numFrames)
        silence (j);

    released.store (readBase - half - 1, std::memory_order_release);

    // Producer position now, extrapolated from its last push.
    int64_t frames = w;
    double at = now;
    for (int attempt = 0; attempt < 4; ++attempt)
    {
        const auto s1 = pushSeq.load (std::memory_order_acquire);
        if (s1 & 1u)
            continue;
        const auto f = pushFrames.load (std::memory_order_relaxed);
        const auto t = pushTime.load (std::memory_order_relaxed);
        std::atomic_thread_fence (std::memory_order_acquire);
        if (pushSeq.load (std::memory_order_relaxed) == s1)
        {
            frames = f;
            at = t;
            break;
        }
    }
    const double producerPos = (double) frames + std::clamp (now - at, 0.0, 0.25) * inRate;

    // Hold the fill at the target with a slow PI loop on the read rate. The
    // fill is taken at the start of each pull, a fixed point in the
    // consumer's own cycle.
    const double fill = producerPos - startPos;
    const double dt = numFrames / outRate;
    const double alpha = 1.0 - std::exp (-dt / kFillSmoothingSeconds);
    smoothedFill += alpha * (fill - smoothedFill);
    const double err = (smoothedFill - target) / inRate;
    integral = std::clamp (integral + err * dt, -kMaxCorrection / kKi, kMaxCorrection / kKi);
    const double wanted = std::clamp (kKp * err + kKi * integral, -kMaxCorrection, kMaxCorrection);
    corr += (1.0 - std::exp (-dt / kRatioSmoothingSeconds)) * (wanted - corr);
    ratio = nominalRatio * (1.0 + corr);

    correctionPpm.store (corr * 1e6, std::memory_order_relaxed);
    fillShown.store (fill, std::memory_order_relaxed);
}

} // namespace ref::dsp

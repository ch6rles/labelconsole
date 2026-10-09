#include "ref/dsp/DriftCompensatedFifo.h"

#include "ref/dsp/FFT.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <limits>

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

constexpr double kCutoff = 0.94;         // of the lower Nyquist: flat to ~20.7 kHz at 48 kHz
constexpr double kKaiserBeta = 8.0;      // about -80 dB stopband
constexpr double kMaxCorrection = 0.002; // +-2000 ppm, far beyond any real pair of clocks

// PI loop on the fill error in seconds, updated once per window with the
// window's average. The plant is an integrator (fill' = drift - correction),
// so the closed loop is s^2 + Kp s + Ki: critically damped at w = 0.03 rad/s
// (about a minute to settle). Slow enough that a device shifting its
// buffering by a block moves the read rate by only a few hundred ppm.
constexpr double kLoopOmega = 0.03;
constexpr double kKp = 2.0 * kLoopOmega;
constexpr double kKi = kLoopOmega * kLoopOmega;
constexpr double kWindowSeconds = 1.0;
constexpr double kRatioSmoothingSeconds = 2.0; // window steps must not reach the read rate
constexpr double kFillSmoothingSeconds = 2.0;  // shown latency only
constexpr double kLeadReleaseSeconds = 60.0;   // how long a long gap keeps the target raised
constexpr double kMaxHeadroomSeconds = 0.25;

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
    half = (int) std::ceil (kTaps / 2 * scale);
    inBlock = std::max (1, maxInputBlock);
    outBlockIn = std::max (1, maxOutputBlock) * nominalRatio;

    // Keep an input block of delivered audio in hand beyond what the next
    // pull needs, so a device shifting its buffering by a block does not
    // drop out; more is learned from near misses.
    baseHeadroom = inBlock + 32.0;
    maxHeadroom = std::max (baseHeadroom, kMaxHeadroomSeconds * inRate);
    // A lead beyond this is a stalled device, not jitter.
    maxLead = 4.0 * inBlock + outBlockIn;

    capacity = nextPowerOfTwo ((int) (2.0 * (maxHeadroom + maxLead + outBlockIn + half) + 8192.0));
    mask = capacity - 1;
    ring.assign ((size_t) channels, std::vector<float> ((size_t) capacity, 0.0f));

    const int h = kTaps / 2;
    table.assign ((size_t) (kTaps * kOversample + 2), 0.0f);
    for (int i = 0; i <= kTaps * kOversample; ++i)
    {
        const double x = (double) i / kOversample - h;
        const double t = kCutoff * x;
        const double sinc = std::abs (t) < 1e-12 ? 1.0 : std::sin (3.14159265358979323846 * t) / (3.14159265358979323846 * t);
        const double r = x / h;
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
    pushFrames.store (0);
    pushTime.store (0.0);
    lastPushAt = -1.0;
    overflowing = false;
    longestGap.store (0.0);
    readBase = 0;
    readFrac = 0.0;
    primed = false;
    headroom = baseHeadroom;
    lead = inBlock;
    integral = 0.0;
    wanted = 0.0;
    ratio = nominalRatio;
    corr = 0.0;
    smoothedFill = 0.0;
    startWindow();
    correctionPpm.store (0.0);
    fillShown.store (0.0);
    targetShown.store (outBlockIn + half + 1 + headroom + lead);
}

void DriftCompensatedFifo::startWindow() noexcept
{
    windowSum = 0.0;
    windowTime = 0.0;
    windowLowest = std::numeric_limits<double>::max();
    windowValid = true;
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
        // The output stopped reading; count the episode, not every block.
        if (! overflowing)
            overrunCount.fetch_add (1, std::memory_order_relaxed);
        n = (int) std::max<int64_t> (0, space);
    }
    overflowing = n < numFrames;

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

    const double now = timestamp >= 0.0 ? timestamp : nowSeconds();
    if (lastPushAt >= 0.0)
    {
        // The extrapolation can run this far ahead of delivered audio. A
        // gap past the stall limit is a stalled device, not jitter.
        const double gap = (now - lastPushAt) * inRate;
        if (gap < maxLead && gap > longestGap.load (std::memory_order_relaxed))
            longestGap.store (gap, std::memory_order_relaxed);
    }
    lastPushAt = now;

    const auto seq = pushSeq.load (std::memory_order_relaxed);
    pushSeq.store (seq + 1, std::memory_order_release);
    std::atomic_thread_fence (std::memory_order_release);
    pushFrames.store (w + n, std::memory_order_relaxed);
    pushTime.store (now, std::memory_order_relaxed);
    pushSeq.store (seq + 2, std::memory_order_release);
}

void DriftCompensatedFifo::prime (int64_t w) noexcept
{
    // Delivered audio covering the target, so the extrapolated fill starts
    // at or above it; the loop trims the rest.
    readBase = w - (int64_t) std::ceil (outBlockIn + half + 1 + headroom + lead);
    readFrac = 0.0;
    smoothedFill = (double) (w - readBase);
    startWindow();
    primed = true;
}

void DriftCompensatedFifo::pull (float* const* output, int numChannels, int numFrames, double timestamp) noexcept
{
    auto silence = [&] (int from)
    {
        for (int c = 0; c < numChannels; ++c)
            std::fill (output[c] + from, output[c] + numFrames, 0.0f);
    };

    if (capacity == 0 || numFrames <= 0)
    {
        if (numFrames > 0)
            silence (0);
        return;
    }

    const double now = timestamp >= 0.0 ? timestamp : nowSeconds();
    const int64_t w = written.load (std::memory_order_acquire);
    const double need = numFrames * ratio + half + 1;

    // The output stalled while the input kept going: skip ahead rather than
    // carry the extra delay.
    if (primed && (double) (w - readBase) > outBlockIn + half + 1 + headroom + 2.0 * maxLead + 0.1 * inRate)
    {
        overrunCount.fetch_add (1, std::memory_order_relaxed);
        prime (w);
    }

    // Start, or restart after an underrun, once there is enough to play.
    // The read position only ever moves forward.
    if (! primed)
    {
        if ((double) (w - readBase) < outBlockIn + half + 1 + headroom + lead)
        {
            silence (0);
            return;
        }
        prime (w);
    }

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
    const double ahead = std::clamp ((now - at) * inRate, 0.0, maxLead);
    const double startPos = (double) readBase + readFrac;
    const double delivered = (double) w - startPos;
    const double extrapolated = (double) frames + ahead - startPos;

    windowSum += extrapolated * numFrames;
    windowLowest = std::min (windowLowest, delivered - need);
    if (ahead >= maxLead)
        windowValid = false; // the input stalled; not jitter to plan for

    const double scale = std::max (1.0, nominalRatio);
    const double invScale = 1.0 / scale;
    int j = 0;
    for (; j < numFrames; ++j)
    {
        if (readBase + half + 1 > w)
        {
            underrunCount.fetch_add (1, std::memory_order_relaxed);
            primed = false;
            // The device is burstier than allowed for: keep more in hand.
            headroom = std::min (maxHeadroom, headroom + inBlock);
            windowValid = false;
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

    const double dt = numFrames / outRate;
    smoothedFill += (1.0 - std::exp (-dt / kFillSmoothingSeconds)) * (delivered - smoothedFill);

    windowTime += dt;
    if (windowTime >= kWindowSeconds)
    {
        const double gap = longestGap.exchange (0.0, std::memory_order_relaxed);
        if (windowValid && primed)
        {
            // Plan for the longest recent gap between deliveries (at least a
            // block), decaying slowly once long gaps stop.
            lead = std::max ({ gap, inBlock, lead * std::exp (-windowTime / kLeadReleaseSeconds) });
            // A near miss earns a little more headroom before it becomes a dropout.
            if (windowLowest < 0.25 * headroom)
                headroom = std::min (maxHeadroom, headroom + 0.25 * inBlock);

            const double target = outBlockIn + half + 1 + headroom + lead;
            const double average = windowSum / (windowTime * outRate);
            const double err = (average - target) / inRate;
            const double next = std::clamp (integral + err * windowTime, -kMaxCorrection / kKi, kMaxCorrection / kKi);
            const double unclamped = kKp * err + kKi * next;
            // Conditional integration: no wind-up while the output is limited.
            if (std::abs (unclamped) <= kMaxCorrection || (unclamped > 0.0) != (err > 0.0))
                integral = next;
            wanted = std::clamp (kKp * err + kKi * integral, -kMaxCorrection, kMaxCorrection);
            targetShown.store (target, std::memory_order_relaxed);
        }
        startWindow();
    }
    corr += (1.0 - std::exp (-dt / kRatioSmoothingSeconds)) * (wanted - corr);
    ratio = nominalRatio * (1.0 + corr);

    correctionPpm.store (corr * 1e6, std::memory_order_relaxed);
    fillShown.store (smoothedFill, std::memory_order_relaxed);
}

} // namespace ref::dsp

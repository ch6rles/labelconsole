#pragma once

#include <atomic>
#include <cstdint>
#include <vector>

namespace ref::dsp
{

// Carries audio from one device clock to another: the loopback device that
// receives system audio, and the headphone output. A lock-free ring
// decouples the two callbacks; a windowed-sinc resampler reads it at a rate
// a slow PI controller trims to hold the fill level, so clock drift never
// builds into dropouts. Also converts between nominal rates.
//
// The controller regulates the producer's position extrapolated from its
// last block (which has no block-size sawtooth, so it measures drift without
// bias) averaged over one-second windows. Real devices do not deliver
// evenly, though: PulseAudio, for one, hands over capture blocks in pairs and
// now and then shifts its buffering by a block. The extrapolation runs ahead
// of delivered audio by up to the longest gap between deliveries, so the
// target is the headroom to keep plus the recent longest gap, and the
// headroom grows after a near miss or a dropout.
//
// push() runs on the input device thread, pull() on the output device
// thread; neither allocates or locks.
class DriftCompensatedFifo
{
public:
    void prepare (int numChannels, double inputRate, double outputRate, int maxInputBlock, int maxOutputBlock);
    void reset() noexcept;

    // Timestamps are seconds on a shared monotonic clock; pass a negative
    // value to use std::chrono::steady_clock (tests pass simulated time).
    void push (const float* const* input, int numChannels, int numFrames, double timestamp = -1.0) noexcept;
    void pull (float* const* output, int numChannels, int numFrames, double timestamp = -1.0) noexcept;

    // Diagnostics (any thread).
    double ratioCorrectionPpm() const noexcept { return correctionPpm.load (std::memory_order_relaxed); }
    double fillFrames() const noexcept { return fillShown.load (std::memory_order_relaxed); }
    double targetFillFrames() const noexcept { return targetShown.load (std::memory_order_relaxed); }
    double latencySeconds() const noexcept { return fillFrames() / inRate; }
    uint32_t underruns() const noexcept { return underrunCount.load (std::memory_order_relaxed); }
    uint32_t overruns() const noexcept { return overrunCount.load (std::memory_order_relaxed); }
    // True if any non-silent input arrived since the last call.
    bool takeSignalFlag() noexcept { return receiving.exchange (false, std::memory_order_relaxed); }

    static constexpr int kTaps = 64;

private:
    double kernel (double x) const noexcept;
    void prime (int64_t written) noexcept;
    void startWindow() noexcept;

    int channels = 0, capacity = 0, mask = 0, half = 0;
    double inRate = 48000.0, outRate = 48000.0, nominalRatio = 1.0;
    double inBlock = 0.0, outBlockIn = 0.0; // largest blocks, in input frames
    double baseHeadroom = 0.0, maxHeadroom = 0.0, maxLead = 0.0;
    std::vector<std::vector<float>> ring;
    std::vector<float> table; // windowed sinc, oversampled
    static constexpr int kOversample = 512;

    std::atomic<int64_t> written { 0 }, released { 0 };

    // Last push (frames written, time), published with a sequence lock so
    // the reader sees a consistent pair.
    std::atomic<uint32_t> pushSeq { 0 };
    std::atomic<int64_t> pushFrames { 0 };
    std::atomic<double> pushTime { 0.0 };

    // Longest gap between pushes since the consumer last took it, in input
    // frames (producer writes, consumer exchanges).
    double lastPushAt = -1.0;
    bool overflowing = false; // producer side: counts each overflow once
    std::atomic<double> longestGap { 0.0 };

    // Consumer state.
    int64_t readBase = 0;
    double readFrac = 0.0;
    bool primed = false;
    double headroom = 0.0; // least delivered audio to keep beyond a pull, input frames
    double lead = 0.0;     // recent longest gap between deliveries, input frames
    double windowSum = 0.0, windowTime = 0.0, windowLowest = 0.0;
    bool windowValid = true;
    double integral = 0.0, wanted = 0.0, ratio = 1.0, corr = 0.0, smoothedFill = 0.0;

    std::atomic<double> correctionPpm { 0.0 }, fillShown { 0.0 }, targetShown { 0.0 };
    std::atomic<uint32_t> underrunCount { 0 }, overrunCount { 0 };
    std::atomic<bool> receiving { false };
};

} // namespace ref::dsp

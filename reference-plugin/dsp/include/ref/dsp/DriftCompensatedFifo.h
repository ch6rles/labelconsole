#pragma once

#include <atomic>
#include <cstdint>
#include <vector>

namespace ref::dsp
{

// Carries audio from one device clock to another: the loopback device that
// receives system audio, and the headphone output. A lock-free ring
// decouples the two callbacks; a windowed-sinc resampler reads it at a rate
// a slow PI controller trims (a few ppm) to hold the fill level, so clock
// drift never builds into dropouts. Also converts between nominal rates.
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
    double targetFillFrames() const noexcept { return target; }
    double latencySeconds() const noexcept { return target / inRate; }
    uint32_t underruns() const noexcept { return underrunCount.load (std::memory_order_relaxed); }
    uint32_t overruns() const noexcept { return overrunCount.load (std::memory_order_relaxed); }
    // True if any non-silent input arrived since the last call.
    bool takeSignalFlag() noexcept { return receiving.exchange (false, std::memory_order_relaxed); }

    static constexpr int kTaps = 64;

private:
    double kernel (double x) const noexcept;

    int channels = 0, capacity = 0, mask = 0;
    double inRate = 48000.0, outRate = 48000.0, nominalRatio = 1.0;
    double target = 0.0;
    std::vector<std::vector<float>> ring;
    std::vector<float> table; // windowed sinc, oversampled
    static constexpr int kOversample = 512;

    std::atomic<int64_t> written { 0 }, released { 0 };

    // Last push (frames written, time), published with a sequence lock so
    // the reader sees a consistent pair. Extrapolating from it gives the
    // producer's position between blocks, which removes the block-size
    // sawtooth from the fill estimate.
    std::atomic<uint32_t> pushSeq { 0 };
    std::atomic<int64_t> pushFrames { 0 };
    std::atomic<double> pushTime { 0.0 };

    // Consumer state.
    int64_t readBase = 0;
    double readFrac = 0.0;
    bool primed = false;
    double integral = 0.0, smoothedFill = 0.0, ratio = 1.0, corr = 0.0;

    std::atomic<double> correctionPpm { 0.0 }, fillShown { 0.0 };
    std::atomic<uint32_t> underrunCount { 0 }, overrunCount { 0 };
    std::atomic<bool> receiving { false };
};

} // namespace ref::dsp

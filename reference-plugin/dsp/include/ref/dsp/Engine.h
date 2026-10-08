#pragma once

#include "FilterSet.h"
#include "RealtimeUtils.h"

#include <atomic>
#include <memory>
#include <vector>

namespace ref::dsp
{

// Control values the host or UI sets; read once per block.
struct EngineParams
{
    double amount = 1.0;      // Calibration Amount, 0..1
    double outputGainDb = 0.0; // -24 .. +12
    double balanceDb = 0.0;    // -6 .. +6; positive moves the image right by trimming left
    bool calibrated = true;    // A/B: true = CAL, false = RAW
    bool bypass = false;       // global bypass
    bool autoGain = true;      // level match + headroom
    bool protection = true;    // Monitor Protection
    bool renderBypass = false; // offline render auto-bypass: bit-exact pass-through, no fades
};

// The real-time chain (spec Section 5):
//   input -> correction EQ -> match + headroom -> balance trim -> output gain
//         -> protection -> output
// with A/B removing only the correction EQ and Bypass sending input straight
// to output (delayed by the Linear Phase latency so timing never shifts).
//
// Threading: prepare() and submit()/collectGarbage() run off the audio
// thread; process() is real-time safe (no allocation, locks, I/O or logging).
class Engine
{
public:
    Engine();
    ~Engine();

    void prepare (double sampleRate, int maxBlockSize, int numChannels);

    // Hands a new filter set to the audio thread (any non-audio thread). A
    // set that was still waiting is replaced and deleted here.
    void submit (std::unique_ptr<FilterSet>);

    // Deletes sets the audio thread has finished with (any non-audio thread).
    void collectGarbage();

    void process (float* const* channels, int numChannels, int numSamples, const EngineParams&) noexcept;

    // Latency of the set currently running (0 until the first set arrives).
    int activeLatency() const noexcept { return activeLatencySamples.load (std::memory_order_relaxed); }

    // Static gains in use, for the header readout.
    double currentMatchDb() const noexcept { return shownMatchDb.load (std::memory_order_relaxed); }
    double currentHeadroomDb() const noexcept { return shownHeadroomDb.load (std::memory_order_relaxed); }

    // Peak since the last call, per channel (linear). Meter reads reset it.
    float takePeak (int channel) noexcept;

    // Incremented whenever Monitor Protection touched a block.
    uint32_t protectionEvents() const noexcept { return protectionCounter.load (std::memory_order_relaxed); }

    static constexpr double kCrossfadeSeconds = 0.020; // A/B and Bypass
    static constexpr double kSetFadeSeconds = 0.030;   // new filter set
    static constexpr double kDipSeconds = 0.010;       // each half of a latency change

private:
    void adoptPending() noexcept;
    void warmUp (FilterSet&) noexcept;
    void startUsing (FilterSet*) noexcept;
    void retire (FilterSet*) noexcept;
    void processChunk (float* const* channels, int numChannels, int offset, int numSamples, const EngineParams&) noexcept;

    double fs = 48000.0;
    int maxBlock = 0, channelsPrepared = 0;

    FilterSet* current = nullptr;
    FilterSet* previous = nullptr; // fading out
    FilterSet* incoming = nullptr; // waiting for the dip to reach silence
    std::atomic<FilterSet*> pending { nullptr };
    SpscPointerQueue<FilterSet, 64> retired;

    // Ring of the exact float input. It feeds Bypass and the RAW side
    // (delayed by the active latency) and warms up new filter sets, so a
    // set never starts from empty state mid-stream.
    std::vector<std::vector<float>> history;
    int historyMask = 0, historyWrite = 0, delaySamples = 0;
    double lastAmount = 1.0;

    std::vector<std::vector<double>> calBuf, prevBuf, rawBuf;
    std::vector<double> amountRamp;

    Smoother2 amountSmoother;
    Smoother2 calGain[2], rawGain[2];
    Crossfade abFade, bypassFade, setFade;

    enum class Dip { none, fadingOut, fadingIn };
    Dip dip = Dip::none;
    double dipGain = 1.0, dipStep = 1.0;

    bool firstBlock = true;

    std::atomic<int> activeLatencySamples { 0 };
    std::atomic<double> shownMatchDb { 0.0 }, shownHeadroomDb { 0.0 };
    std::atomic<float> peaks[2];
    std::atomic<uint32_t> protectionCounter { 0 };
};

} // namespace ref::dsp

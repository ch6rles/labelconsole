#include "ref/dsp/Engine.h"

#include "ref/dsp/FFT.h"

#include <algorithm>
#include <cmath>

namespace ref::dsp
{

namespace
{
// Input to the processing path: non-finite samples and absurd levels
// (beyond +24 dBFS, far past any real over) become silence, so they never
// reach the filter states and the next block plays normally (spec Section
// 12, robustness). Bypass uses the untouched input.
constexpr double kGarbageLevel = 16.0;

inline double sanitize (float x) noexcept
{
    return std::isfinite (x) && std::abs (x) <= kGarbageLevel ? (double) x : 0.0;
}

inline double dbToGain (double db) noexcept { return std::pow (10.0, db / 20.0); }

inline double raisedCosine (double x) noexcept { return 0.5 - 0.5 * std::cos (3.14159265358979323846 * x); }
} // namespace

Engine::Engine()
{
    peaks[0].store (0.0f);
    peaks[1].store (0.0f);
}

Engine::~Engine()
{
    delete current;
    delete previous;
    delete incoming;
    delete pending.exchange (nullptr);
    collectGarbage();
}

void Engine::prepare (double sampleRate, int maxBlockSize, int numChannels)
{
    fs = sampleRate;
    maxBlock = std::max (1, maxBlockSize);
    channelsPrepared = std::clamp (numChannels, 1, 2);

    // The audio thread is stopped here, so sets can be deleted directly.
    delete previous;
    delete incoming;
    delete current;
    previous = incoming = current = nullptr;
    collectGarbage();

    const auto sizing = linearPhaseSizing (fs);
    const int needed = 2 * sizing.latencySamples + 4 * sizing.partitionSize + (int) (0.1 * fs) + maxBlock + 16;
    const int capacity = nextPowerOfTwo (needed);
    history.assign (2, std::vector<float> ((size_t) capacity, 0.0f));
    historyMask = capacity - 1;
    historyWrite = 0;
    delaySamples = 0;

    calBuf.assign (2, std::vector<double> ((size_t) maxBlock, 0.0));
    prevBuf.assign (2, std::vector<double> ((size_t) maxBlock, 0.0));
    rawBuf.assign (2, std::vector<double> ((size_t) maxBlock, 0.0));
    amountRamp.assign ((size_t) maxBlock, 0.0);

    amountSmoother.setTimeConstant (0.006, fs);
    for (int c = 0; c < 2; ++c)
    {
        calGain[c].setTimeConstant (0.008, fs);
        rawGain[c].setTimeConstant (0.008, fs);
    }
    abFade.setDuration (kCrossfadeSeconds, fs);
    bypassFade.setDuration (kCrossfadeSeconds, fs);
    setFade.setDuration (kSetFadeSeconds, fs);
    dipStep = 1.0 / std::max (1.0, kDipSeconds * fs);
    dip = Dip::none;
    dipGain = 1.0;

    firstBlock = true;
    activeLatencySamples.store (0);
    peaks[0].store (0.0f);
    peaks[1].store (0.0f);
}

void Engine::submit (std::unique_ptr<FilterSet> set)
{
    if (auto* old = pending.exchange (set.release(), std::memory_order_acq_rel))
        delete old; // never reached the audio thread
}

void Engine::collectGarbage()
{
    while (auto* s = retired.pop())
        delete s;
}

void Engine::retire (FilterSet* s) noexcept
{
    // If the queue is ever full the set is leaked rather than freed here.
    if (s != nullptr)
        retired.push (s);
}

float Engine::takePeak (int channel) noexcept
{
    return peaks[std::clamp (channel, 0, 1)].exchange (0.0f, std::memory_order_relaxed);
}

void Engine::warmUp (FilterSet& s) noexcept
{
    s.reset();

    int samples;
    if (s.mode() == FilterMode::linearPhase)
    {
        const auto sz = linearPhaseSizing (fs);
        samples = 2 * sz.latencySamples + 2 * sz.partitionSize;
    }
    else
    {
        samples = (int) (0.085 * fs);
    }
    samples = std::min (samples, historyMask - maxBlock);

    const int start = historyWrite - samples;
    double* ptrs[2] = { prevBuf[0].data(), prevBuf[1].data() };
    for (int off = 0; off < samples; off += maxBlock)
    {
        const int len = std::min (maxBlock, samples - off);
        for (int c = 0; c < 2; ++c)
            for (int i = 0; i < len; ++i)
                prevBuf[(size_t) c][(size_t) i] = sanitize (history[(size_t) c][(size_t) ((start + off + i) & historyMask)]);
        s.process (ptrs, 2, len, nullptr, lastAmount);
    }
}

void Engine::startUsing (FilterSet* s) noexcept
{
    if (current == nullptr || ! s->takeStateFrom (*current))
        warmUp (*s);
}

void Engine::adoptPending() noexcept
{
    if (previous != nullptr || dip != Dip::none)
        return; // finish the transition in progress first

    auto* p = pending.exchange (nullptr, std::memory_order_acq_rel);
    if (p == nullptr)
        return;

    if (p->sampleRate() != fs)
    {
        retire (p); // built for a rate we are no longer running at
        return;
    }

    if (current == nullptr)
    {
        warmUp (*p);
        current = p;
        delaySamples = p->latencySamples();
        activeLatencySamples.store (delaySamples, std::memory_order_relaxed);
        return;
    }

    if (p->latencySamples() == current->latencySamples())
    {
        startUsing (p);
        previous = current;
        current = p;
        setFade.snap (false);
        return;
    }

    // Latency changes: dip to silence, swap, come back.
    incoming = p;
    dip = Dip::fadingOut;
}

void Engine::process (float* const* channels, int numChannels, int numSamples, const EngineParams& params) noexcept
{
    if (maxBlock == 0 || numSamples <= 0)
        return;

    ScopedFlushDenormals noDenormals;
    numChannels = std::clamp (numChannels, 1, 2);

    for (int off = 0; off < numSamples; off += maxBlock)
        processChunk (channels, numChannels, off, std::min (maxBlock, numSamples - off), params);

    firstBlock = false;
}

void Engine::processChunk (float* const* ch, int numCh, int off, int len, const EngineParams& p) noexcept
{
    adoptPending();

    const int w0 = historyWrite;
    for (int c = 0; c < 2; ++c)
    {
        const float* src = ch[std::min (c, numCh - 1)] + off;
        auto& h = history[(size_t) c];
        for (int i = 0; i < len; ++i)
            h[(size_t) ((w0 + i) & historyMask)] = src[i];
    }
    historyWrite = (w0 + len) & historyMask;

    auto dry = [this, w0] (int c, int i) noexcept
    {
        return history[(size_t) c][(size_t) ((w0 + i - delaySamples) & historyMask)];
    };

    // Offline render with auto-bypass: bit-exact pass-through, nothing else.
    if (p.renderBypass)
    {
        if (previous != nullptr)
        {
            retire (previous);
            previous = nullptr;
        }
        if (dip != Dip::none && incoming != nullptr)
        {
            retire (current);
            current = incoming;
            incoming = nullptr;
            delaySamples = current->latencySamples();
            activeLatencySamples.store (delaySamples, std::memory_order_relaxed);
        }
        dip = Dip::none;
        dipGain = 1.0;
        for (int c = 0; c < numCh; ++c)
            for (int i = 0; i < len; ++i)
                ch[c][off + i] = dry (c, i);
        bypassFade.snap (true);
        abFade.snap (p.calibrated);
        return;
    }

    // A NaN from a host or a damaged preset must not reach the filters: keep
    // the last good value (std::clamp passes NaN through).
    if (std::isfinite (p.amount))
        goodAmount = std::clamp (p.amount, 0.0, 1.0);
    if (std::isfinite (p.balanceDb))
        goodBalanceDb = std::clamp (p.balanceDb, -6.0, 6.0);
    if (std::isfinite (p.outputGainDb))
        goodOutputDb = std::clamp (p.outputGainDb, -24.0, 12.0);
    const double amountTarget = goodAmount;
    if (firstBlock)
    {
        amountSmoother.reset (amountTarget);
        abFade.snap (p.calibrated);
        bypassFade.snap (p.bypass);
    }

    // Calibration Amount, smoothed per sample.
    const double* ramp = nullptr;
    double amount = amountTarget;
    if (! amountSmoother.settledAt (amountTarget, 1e-7))
    {
        for (int i = 0; i < len; ++i)
            amountRamp[(size_t) i] = amountSmoother.next (amountTarget);
        ramp = amountRamp.data();
        amount = amountRamp[(size_t) len - 1];
    }
    else
    {
        amountSmoother.reset (amountTarget);
    }
    lastAmount = amount;

    // Calibrated side.
    double* calPtr[2] = { calBuf[0].data(), calBuf[1].data() };
    for (int c = 0; c < numCh; ++c)
        for (int i = 0; i < len; ++i)
            calBuf[(size_t) c][(size_t) i] = sanitize (ch[c][off + i]);
    if (current != nullptr)
        current->process (calPtr, numCh, len, ramp, amount);

    if (previous != nullptr)
    {
        double* prevPtr[2] = { prevBuf[0].data(), prevBuf[1].data() };
        for (int c = 0; c < numCh; ++c)
            for (int i = 0; i < len; ++i)
                prevBuf[(size_t) c][(size_t) i] = sanitize (ch[c][off + i]);
        previous->process (prevPtr, numCh, len, ramp, amount);

        for (int i = 0; i < len; ++i)
        {
            const double k = setFade.next (true);
            for (int c = 0; c < numCh; ++c)
            {
                auto& v = calBuf[(size_t) c][(size_t) i];
                v = prevBuf[(size_t) c][(size_t) i] + (v - prevBuf[(size_t) c][(size_t) i]) * k;
            }
        }
        if (setFade.isSettled (true))
        {
            retire (previous);
            previous = nullptr;
        }
    }

    // Raw side: the same input, delayed to line up with the correction.
    for (int c = 0; c < numCh; ++c)
        for (int i = 0; i < len; ++i)
            rawBuf[(size_t) c][(size_t) i] = sanitize (dry (c, i));

    // Static gains (spec Section 7). The calibrated side gets match and
    // headroom, the raw side the same headroom, so A/B compares at equal
    // loudness and neither side clips.
    double matchDb = 0.0, headDb = 0.0;
    if (current != nullptr)
        current->gainsForAmount (current->mode() == FilterMode::linearPhase ? current->linearAmount() : amount, matchDb, headDb);
    if (! p.autoGain)
        matchDb = headDb = 0.0;
    shownMatchDb.store (matchDb, std::memory_order_relaxed);
    shownHeadroomDb.store (headDb, std::memory_order_relaxed);

    const double balance = goodBalanceDb;
    double trim[2] = { balance > 0.0 ? -balance : 0.0, balance < 0.0 ? balance : 0.0 };
    if (numCh == 1)
        trim[0] = trim[1] = 0.0;

    const double outDb = goodOutputDb;
    double calTarget[2], rawTarget[2];
    for (int c = 0; c < 2; ++c)
    {
        calTarget[c] = dbToGain (matchDb + headDb + outDb + trim[c]);
        rawTarget[c] = dbToGain (headDb + outDb + trim[c]);
        if (firstBlock)
        {
            calGain[c].reset (calTarget[c]);
            rawGain[c].reset (rawTarget[c]);
        }
    }

    bool engaged = false;
    float blockPeak[2] = { 0.0f, 0.0f };

    for (int i = 0; i < len; ++i)
    {
        double gc[2], gr[2];
        for (int c = 0; c < numCh; ++c)
        {
            gc[c] = calGain[c].next (calTarget[c]);
            gr[c] = rawGain[c].next (rawTarget[c]);
        }

        const double ka = abFade.next (p.calibrated);
        const double abPos = abFade.position();
        const double kb = bypassFade.next (p.bypass);
        const double bypassPos = bypassFade.position();

        bool dipping = false;
        double dg = 1.0;
        if (dip == Dip::fadingOut)
        {
            dipGain = std::max (0.0, dipGain - dipStep);
            dg = raisedCosine (dipGain);
            dipping = true;
        }
        else if (dip == Dip::fadingIn)
        {
            dipGain = std::min (1.0, dipGain + dipStep);
            dg = raisedCosine (dipGain);
            dipping = true;
            if (dipGain >= 1.0)
                dip = Dip::none;
        }

        for (int c = 0; c < numCh; ++c)
        {
            const double cal = calBuf[(size_t) c][(size_t) i];
            const double raw = rawBuf[(size_t) c][(size_t) i];
            double y;
            if (abPos >= 1.0)
                y = gc[c] * cal;
            else if (abPos <= 0.0)
                y = gr[c] * raw;
            else
                y = ka * gc[c] * cal + (1.0 - ka) * gr[c] * raw;

            if (p.protection)
                y = ProtectionClipper::process (y, engaged);

            float out;
            if (bypassPos >= 1.0)
                out = dry (c, i); // bit-exact
            else if (bypassPos <= 0.0)
                out = (float) y;
            else
                out = (float) (kb * sanitize (dry (c, i)) + (1.0 - kb) * y);

            if (dipping)
                out = (float) (out * dg);

            ch[c][off + i] = out;
            const float a = std::abs (out);
            if (a > blockPeak[c] && std::isfinite (a))
                blockPeak[c] = a;
        }
    }

    for (int c = 0; c < numCh; ++c)
        atomicStoreMax (peaks[c], blockPeak[c]);
    if (engaged)
        protectionCounter.fetch_add (1, std::memory_order_relaxed);

    // At silence, swap to the set with the new latency.
    if (dip == Dip::fadingOut && dipGain <= 0.0 && incoming != nullptr)
    {
        retire (current);
        current = incoming;
        incoming = nullptr;
        warmUp (*current);
        delaySamples = current->latencySamples();
        activeLatencySamples.store (delaySamples, std::memory_order_relaxed);
        dip = Dip::fadingIn;
    }
}

} // namespace ref::dsp

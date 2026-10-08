#pragma once

#include "Biquad.h"
#include "FirDesign.h"
#include "PartitionedConvolver.h"
#include "Types.h"

#include <array>
#include <memory>
#include <vector>

namespace ref::dsp
{

// Everything a filter set is designed from. Built on the message or worker
// thread and handed to FilterSet::build (spec Section 5).
struct FilterSetConfig
{
    FilterMode mode = FilterMode::minimumPhase;
    double sampleRate = 48000.0;

    bool hasCorrection = false;
    GridCurve correction {};             // C(f), used by Linear Phase
    std::vector<FilterSpec> calibration; // parametric fit, used by Minimum Phase
    std::vector<FilterSpec> overlay;     // user nodes (Advanced, V2)

    // Linear Phase bakes Amount into the FIR; the set is rebuilt and
    // crossfaded in when Amount moves (spec Section 4, "Calibration Amount").
    double linearAmount = 1.0;

    double maxBoostDb = 6.0, maxCutDb = -12.0;
};

// An immutable set of filters for one sample rate and mode, plus the static
// gains derived from it. The audio thread takes it through an atomic
// exchange and hands it back for deletion; it owns its processing state so
// adopting it never allocates.
class FilterSet
{
public:
    static constexpr int kAmountSteps = 257; // Minimum Phase coefficient table per filter
    static constexpr int kGainSteps = 65;    // match / headroom table over Amount

    static std::unique_ptr<FilterSet> build (const FilterSetConfig&);

    FilterMode mode() const noexcept { return config.mode; }
    double sampleRate() const noexcept { return config.sampleRate; }
    int latencySamples() const noexcept { return latency; }
    double linearAmount() const noexcept { return config.linearAmount; }
    const FilterSetConfig& getConfig() const noexcept { return config; }

    // Static gains (spec Section 7) for the realised response at an Amount.
    void gainsForAmount (double amount, double& matchDb, double& headroomDb) const noexcept;

    // Realised response of correction + overlay in dB (not real-time).
    double realisedResponseDb (double amount, double hz) const;

    // Worst deviation of the digital Minimum Phase cascade from its analogue
    // design over 20 Hz .. 20 kHz at Amount 100% (for tests and diagnostics).
    double minimumPhaseDesignErrorDb() const;

    // --- audio thread ---------------------------------------------------
    void reset() noexcept;

    // Linear Phase only: continue from another set's input history. Returns
    // false when the sets are not compatible (then warm up from history).
    bool takeStateFrom (const FilterSet& other) noexcept;

    // Processes up to two channels in place. `amountPerSample` may be null,
    // in which case `amount` holds for the block. Linear Phase ignores both.
    void process (double* const* channels, int numChannels, int numSamples,
                  const double* amountPerSample, double amount) noexcept;

private:
    FilterSet() = default;

    void updateCoefficients (double amount) noexcept;

    FilterSetConfig config;
    int latency = 0;

    // Minimum Phase
    int numCal = 0, numOverlay = 0;
    std::vector<FilterSpec> calDigital, overlayDigital; // after per-rate refinement
    std::vector<BiquadCoeffs> calTable;                 // numCal x kAmountSteps
    std::vector<BiquadCoeffs> calCurrent, overlayCoeffs;
    std::vector<BiquadState> states;                    // 2 x (numCal + numOverlay)
    double currentAmount = -1.0;

    // Linear Phase
    PartitionedConvolver convolver;

    std::array<double, kGainSteps> matchTable {}, headroomTable {};
};

// Pulls a digital biquad cascade toward its analogue design across
// 20 Hz .. 20 kHz by adjusting each filter's digital frequency, gain and Q.
// A single matched biquad cannot follow an analogue curve right up to
// 20 kHz at 44.1 kHz; the cascade as a whole can (spec Section 12, filter
// accuracy within 0.1 dB). Returns the refined specs to design digitally.
std::vector<FilterSpec> refineCascadeForRate (const std::vector<FilterSpec>& analogue, double sampleRate);

} // namespace ref::dsp

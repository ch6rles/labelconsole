#pragma once

#include "Grid.h"
#include "Types.h"

#include <string>
#include <utility>
#include <vector>

namespace ref::dsp
{

inline constexpr const char* kGeneratorVersion = "1.0.0";

// Per-profile generator limits (spec Section 4, step 8; all tunable).
struct GeneratorLimits
{
    double maxBoostDb = 6.0;
    double maxCutDb = -12.0;
    double trebleAverageAboveHz = 9000.0;
    double maxSlopeDbPerOctave = 18.0;
    double maxQ = 3.0;
    int maxBells = 10;
    int maxShelves = 2;
    double largeTrebleDb = 3.0; // treble average beyond this raises a warning
};

// A measurement (mean, with per-frequency spread) or a target, tagged with
// the rig it was defined on.
struct CurveSource
{
    std::string rigId;
    RawCurve curve;
};

enum class WarningCode
{
    boostLimited,
    cutLimited,
    largeTreble,
    rigMismatch,
    noMeasurement,
    invalidTarget,
    fitOutOfTolerance
};

struct GeneratorWarning
{
    WarningCode code;
    std::string message; // exact user-facing copy
    std::string detail;  // e.g. the frequency range, shown in mono after the message
    std::vector<std::pair<double, double>> ranges;
};

struct CorrectionResult
{
    // False when the generator refused (invalid measurement, rig mismatch).
    // The curves below are then flat and `filters` is empty.
    bool generated = false;

    GridCurve measured {}; // normalised and smoothed mean
    GridCurve spread {};   // smoothed per-frequency spread (unit + reseat)
    GridCurve target {};   // normalised and smoothed
    GridCurve correction {}; // the clamped correction C(f), dB

    std::vector<FilterSpec> filters; // parametric fit of C(f)
    double largestBoostDb = 0.0;
    double matchGainDb = 0.0; // of C(f) at 100%, for reference
    double trebleAverageDb = 0.0;
    double fitRmsDb = 0.0, fitMaxDb = 0.0;

    std::vector<std::pair<double, double>> boostLimitedRanges;
    std::vector<GeneratorWarning> warnings;
};

// One measurement and one target from the same rig become one bounded
// correction curve plus its parametric realisation. Runs offline only.
CorrectionResult generateCorrection (const CurveSource& measurement, const CurveSource& target,
                                     const GeneratorLimits& = {});

struct FitResult
{
    std::vector<FilterSpec> filters;
    double rmsDb = 0.0; // 50 Hz .. 8 kHz
    double maxDb = 0.0; // 50 Hz .. 8 kHz
};

// Fits at most `maxShelves` shelves and `maxBells` bells (Q <= maxQ) to a
// grid curve (spec Section 4, step 9).
FitResult fitParametric (const GridCurve& curve, const GeneratorLimits&);

// Error statistics of a filter list against a curve over [loHz, hiHz].
void fitError (const std::vector<FilterSpec>&, const GridCurve& curve, double loHz, double hiHz, double& rmsDb, double& maxDb);

// Slope limiter that only ever reduces |C|: wherever neighbouring points
// differ by more than the limit, the larger-magnitude point is pulled in.
void limitSlope (GridCurve&, double maxDbPerOctave);

} // namespace ref::dsp

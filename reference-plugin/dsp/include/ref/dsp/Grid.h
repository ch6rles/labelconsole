#pragma once

#include "Types.h"

#include <optional>
#include <string>
#include <vector>

namespace ref::dsp
{

// Frequency of grid point i (0 .. kGridSize-1).
double gridFrequency (int index);
const GridCurve& gridFrequencies();

// Fractional grid position of a frequency (0 at 20 Hz, kGridSize-1 at 20 kHz).
double gridPosition (double hz);

// Linear interpolation of a grid curve in log frequency; holds the end values
// outside 20 Hz .. 20 kHz.
double sampleGridCurve (const GridCurve&, double hz);

// Samples a correction curve over the whole audio band for filter design.
// Below 20 Hz the curve continues along its 20 Hz slope and eases to flat
// within an octave (a hard corner would smear the FIR's low end); above
// 20 kHz it tapers to 0 dB over half an octave rather than holding its last
// value (spec Section 6). The result is kept inside [minDb, maxDb].
double sampleCorrectionExtended (const GridCurve&, double hz, double minDb, double maxDb);

// A curve as it arrives from a file: unsorted, unvalidated, any spacing.
struct RawCurve
{
    std::vector<double> freqHz;
    std::vector<double> db;
    std::vector<double> spreadDb; // optional; empty or same size as freqHz
};

// Sorts the curve by frequency and validates it (spec Section 4, step 1):
// frequencies strictly increasing, 20 Hz to 20 kHz covered, no NaN, no
// duplicate points. Returns the reason on failure.
std::optional<std::string> sortAndValidate (RawCurve&);

// Resamples onto the grid, linear in log frequency (step 2).
GridCurve resampleToGrid (const std::vector<double>& freqHz, const std::vector<double>& values);

// Mean level of the curve over [loHz, hiHz].
double meanOver (const GridCurve&, double loHz, double hiHz);

// Shifts the curve so its 500 Hz .. 2 kHz average is 0 dB (step 3).
void normaliseMidband (GridCurve&);

// Variable fractional-octave smoothing (step 4): 1/12 octave below 1 kHz,
// widening log-linearly to 1/3 octave at 8 kHz and above.
GridCurve smoothVariable (const GridCurve&);

// Octave width of the smoothing window at a frequency.
double smoothingWidthOctaves (double hz);

} // namespace ref::dsp

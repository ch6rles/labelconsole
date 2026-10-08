#pragma once

#include "Biquad.h"
#include "Types.h"

#include <array>

namespace ref::dsp
{

// ITU-R BS.1770 K-weighting: the 48 kHz pre-filter (high shelf) and RLB
// high-pass. kWeightingCoeffs(fs) re-derives both stages for another rate
// from the 48 kHz analogue equivalents.
std::array<BiquadCoeffs, 2> kWeightingCoeffs (double sampleRate);
double kWeightingPower (double hz); // |K(f)|^2, from the 48 kHz definition

// Static loudness-match gain (spec Section 7): the negative of the
// response's K-weighted power average over log-spaced bands. Log spacing
// gives every band equal pink-noise energy, so the result is the change in
// BS.1770 loudness of pink noise. Uses the whole 20 Hz .. 20 kHz grid; the
// spec suggests 100 Hz .. 10 kHz, but K-weighting already discounts the
// extremes and the full band is what the pink-noise acceptance test hears.
double loudnessMatchGainDb (const GridCurve& responseDb);

// Headroom (spec Section 7): min(0, -max_f [C(f) + G_match]).
double headroomDb (const GridCurve& responseDb, double matchGainDb);

// Integrated loudness of a steady signal (K-weighted mean square, dB),
// without gating. Used by the level-match acceptance test.
double measureLoudnessDb (const float* const* channels, int numChannels, int numSamples, double sampleRate);

} // namespace ref::dsp

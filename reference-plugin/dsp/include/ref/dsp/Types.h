#pragma once

#include <array>
#include <string>
#include <vector>

namespace ref::dsp
{

// Every curve the generator works on lives on one fixed log grid: 480 points,
// 20 Hz to 20 kHz, about 1/48 octave apart (spec Section 4, step 2).
inline constexpr int kGridSize = 480;
inline constexpr double kGridMinHz = 20.0;
inline constexpr double kGridMaxHz = 20000.0;

using GridCurve = std::array<double, kGridSize>;

enum class FilterType
{
    bell,
    lowShelf,
    highShelf,
    lowPass,
    highPass
};

const char* toString (FilterType);
bool filterTypeFromString (const std::string&, FilterType&);

// One parametric filter, defined by its analogue prototype. Digital
// coefficients are derived per sample rate (see BiquadDesign.h).
struct FilterSpec
{
    FilterType type = FilterType::bell;
    double freqHz = 1000.0;
    double gainDb = 0.0;
    double q = 0.7071067811865476;

    bool operator== (const FilterSpec&) const = default;
};

enum class FilterMode
{
    minimumPhase,
    linearPhase
};

// Supported host rates (spec Section 6). Anything else is designed for too,
// but these are the ones the acceptance tests sweep.
inline constexpr std::array<double, 8> kSupportedSampleRates { 44100.0, 48000.0, 88200.0, 96000.0,
                                                               176400.0, 192000.0, 352800.0, 384000.0 };

} // namespace ref::dsp

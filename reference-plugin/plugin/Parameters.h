#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

namespace ref::params
{

// Host parameters (spec Section 9). IDs never change once released; the
// version hint is 1 from the first release.
inline constexpr const char* calAmount = "calAmount";     // 0..100 %
inline constexpr const char* outputGain = "outputGain";   // -24..+12 dB
inline constexpr const char* balance = "balance";         // -6..+6 dB
inline constexpr const char* abSelect = "abSelect";       // Raw / Calibrated
inline constexpr const char* bypass = "bypass";           // host bypass

inline constexpr int kVersionHint = 1;

juce::AudioProcessorValueTreeState::ParameterLayout createLayout();

} // namespace ref::params

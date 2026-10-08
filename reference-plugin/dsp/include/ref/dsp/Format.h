#pragma once

#include <string>

namespace ref::dsp
{

// UTF-8 text helpers shared by warnings and the UI. Negative numbers use a
// true minus sign (U+2212) and ranges an en dash (U+2013), as the design asks.
inline constexpr const char* kMinus = "\xE2\x88\x92";
inline constexpr const char* kEnDash = "\xE2\x80\x93";

// "-1.5" -> "−1.5"; plusSign adds "+" to positive values.
std::string formatNumber (double value, int decimals, bool plusSign = false);

// "−1.5 dB"
std::string formatDb (double value, int decimals = 1, bool plusSign = false);

// Frequency with 3 significant figures: "46 Hz", "1.02 kHz", "12.5 kHz".
std::string formatFrequency (double hz);

// "20–46 Hz", "1.2–2.4 kHz", "800 Hz–1.2 kHz".
std::string formatFrequencyRange (double loHz, double hiHz);

} // namespace ref::dsp

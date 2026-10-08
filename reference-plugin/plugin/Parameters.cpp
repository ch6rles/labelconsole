#include "Parameters.h"

#include "../measurement/TextUtil.h"

namespace ref::params
{

namespace
{
juce::String signedDb (float v)
{
    const float r = std::round (v * 10.0f) / 10.0f;
    if (r < 0.0f)
        return text::minus + juce::String (-r, 1) + " dB";
    return juce::String (r, 1) + " dB";
}

float parseNumber (const juce::String& s)
{
    return s.replace (text::minus, "-").retainCharacters ("-+.0123456789").getFloatValue();
}

// "C · 0.0 dB", "L −1.2 dB": names the side being attenuated.
juce::String balanceText (float v)
{
    const float r = std::round (v * 10.0f) / 10.0f;
    if (r == 0.0f)
        return "C" + text::spacedDot + "0.0 dB";
    // Positive moves the image right by trimming the left channel.
    return (r > 0.0f ? "L " : "R ") + text::minus + juce::String (std::abs (r), 1) + " dB";
}

float parseBalance (const juce::String& s)
{
    const auto t = s.trim().toUpperCase();
    const float magnitude = std::abs (parseNumber (t));
    if (t.startsWithChar ('L'))
        return magnitude;
    if (t.startsWithChar ('R'))
        return -magnitude;
    return parseNumber (t);
}
} // namespace

juce::AudioProcessorValueTreeState::ParameterLayout createLayout()
{
    using namespace juce;
    AudioProcessorValueTreeState::ParameterLayout layout;

    layout.add (std::make_unique<AudioParameterFloat> (
        ParameterID { calAmount, kVersionHint }, "Calibration", NormalisableRange<float> (0.0f, 100.0f, 0.1f), 100.0f,
        AudioParameterFloatAttributes()
            .withLabel ("%")
            .withStringFromValueFunction ([] (float v, int) { return String (std::round (v * 10.0f) / 10.0f, v == std::round (v) ? 0 : 1) + "%"; })
            .withValueFromStringFunction ([] (const String& s) { return parseNumber (s); })));

    layout.add (std::make_unique<AudioParameterFloat> (
        ParameterID { outputGain, kVersionHint }, "Output", NormalisableRange<float> (-24.0f, 12.0f, 0.1f), 0.0f,
        AudioParameterFloatAttributes()
            .withLabel ("dB")
            .withStringFromValueFunction ([] (float v, int) { return signedDb (v); })
            .withValueFromStringFunction ([] (const String& s) { return parseNumber (s); })));

    layout.add (std::make_unique<AudioParameterFloat> (
        ParameterID { balance, kVersionHint }, "Balance", NormalisableRange<float> (-6.0f, 6.0f, 0.1f), 0.0f,
        AudioParameterFloatAttributes()
            .withLabel ("dB")
            .withStringFromValueFunction ([] (float v, int) { return balanceText (v); })
            .withValueFromStringFunction ([] (const String& s) { return parseBalance (s); })));

    layout.add (std::make_unique<AudioParameterChoice> (ParameterID { abSelect, kVersionHint }, "A/B", StringArray { "Raw", "Calibrated" }, 1));

    layout.add (std::make_unique<AudioParameterBool> (ParameterID { bypass, kVersionHint }, "Bypass", false));

    return layout;
}

} // namespace ref::params

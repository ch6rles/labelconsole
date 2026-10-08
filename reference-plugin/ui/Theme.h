#pragma once

#include <juce_gui_basics/juce_gui_basics.h>

namespace ref::ui
{

// Colour tokens from the design handoff. Strictly monochrome: "engaged" is
// inverted (ink fill, bg text); warnings add bold weight and a lamp or "!".
namespace colours
{
inline const juce::Colour bg { 0xff0d0d0d };
inline const juce::Colour field { 0xff111111 };
inline const juce::Colour menu { 0xff121212 };
inline const juce::Colour rowSelected { 0xff1d1d1d };
inline const juce::Colour rowHover { 0xff1a1a1a };
inline const juce::Colour pressed { 0xff161616 };
inline const juce::Colour line { 0xff1f1f1f };
inline const juce::Colour divider { 0xff262626 };
inline const juce::Colour lineSubtle { 0xff1a1a1a };
inline const juce::Colour borderField { 0xff2e2e2e };
inline const juce::Colour borderControl { 0xff3a3a3a };
inline const juce::Colour knobBorder { 0xff2c2c2c };
inline const juce::Colour ink { 0xfff2f2f2 };
inline const juce::Colour ink2 { 0xffd4d4d4 };
inline const juce::Colour ink3 { 0xffc4c4c4 };
inline const juce::Colour ink4 { 0xffbdbdbd };
inline const juce::Colour muted { 0xff8a8a8a };
inline const juce::Colour label { 0xff7d7d7d };
inline const juce::Colour disabled { 0xff747474 };
inline const juce::Colour tickMinor { 0xff4a4a4a };
inline const juce::Colour menuDetail { 0xffa0a0a0 };
inline const juce::Colour hoverBorder { 0xff8a8a8a };

// Graph
inline const juce::Colour frame { 0xff242424 };
inline const juce::Colour gridMajor { 0xff1a1a1a };
inline const juce::Colour gridMinor { 0xff161616 };
inline const juce::Colour gridZero { 0xff383838 };
inline const juce::Colour measured { 0xff9a9a9a };
inline const juce::Colour target { 0xffe8e8e8 };
inline const juce::Colour predicted { 0xffd0d0d0 };
inline const juce::Colour correction { 0xffffffff };
inline const juce::Colour meterTrack { 0xff1c1c1c };
} // namespace colours

enum class Family
{
    sans, // Instrument Sans
    mono  // JetBrains Mono
};

// A font at a CSS pixel size (em) with CSS letter-spacing in em, converted
// to JUCE's height-relative tracking.
juce::Font font (Family, float px, int weight = 400, float trackingEm = 0.0f);

inline juce::Font sans (float px, int weight = 400, float trackingEm = 0.0f) { return font (Family::sans, px, weight, trackingEm); }
inline juce::Font mono (float px, int weight = 400, float trackingEm = 0.0f) { return font (Family::mono, px, weight, trackingEm); }

float textWidth (const juce::Font&, const juce::String&);

// Single-line text, never wrapped (the design's default is nowrap).
void drawText (juce::Graphics&, const juce::String&, juce::Rectangle<float>, const juce::Font&, juce::Colour,
               juce::Justification = juce::Justification::centredLeft);

// Wrapped paragraph; returns the height it needs at `width`.
float drawParagraph (juce::Graphics&, const juce::String&, juce::Rectangle<float>, const juce::Font&, juce::Colour, float lineHeight);
float paragraphHeight (const juce::String&, float width, const juce::Font&, float lineHeight);

// Vector glyphs from the handoff.
juce::Path powerIcon (juce::Rectangle<float> box); // 12 x 12 design units
void drawPowerIcon (juce::Graphics&, juce::Rectangle<float> box, juce::Colour, float strokeInDesignUnits = 1.3f);
void drawChevron (juce::Graphics&, juce::Point<float> centre, float size, juce::Colour, float stroke = 1.25f);
void drawListIcon (juce::Graphics&, juce::Point<float> centre, juce::Colour);

// The design's box-shadow, approximated.
void drawShadow (juce::Graphics&, juce::Rectangle<float>, float cornerRadius, float offsetY, float blur, float alpha);

} // namespace ref::ui

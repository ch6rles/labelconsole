#include "Theme.h"

#include <BinaryData.h>

namespace ref::ui
{

namespace
{
struct Typefaces
{
    juce::Typeface::Ptr sans[4], mono[4]; // 400, 500, 600, 700

    Typefaces()
    {
        auto load = [] (const void* data, int size) { return juce::Typeface::createSystemTypefaceFor (data, (size_t) size); };
        sans[0] = load (BinaryData::InstrumentSansRegular_ttf, BinaryData::InstrumentSansRegular_ttfSize);
        sans[1] = load (BinaryData::InstrumentSansMedium_ttf, BinaryData::InstrumentSansMedium_ttfSize);
        sans[2] = load (BinaryData::InstrumentSansSemiBold_ttf, BinaryData::InstrumentSansSemiBold_ttfSize);
        sans[3] = load (BinaryData::InstrumentSansBold_ttf, BinaryData::InstrumentSansBold_ttfSize);
        mono[0] = load (BinaryData::JetBrainsMonoRegular_ttf, BinaryData::JetBrainsMonoRegular_ttfSize);
        mono[1] = load (BinaryData::JetBrainsMonoMedium_ttf, BinaryData::JetBrainsMonoMedium_ttfSize);
        mono[2] = load (BinaryData::JetBrainsMonoSemiBold_ttf, BinaryData::JetBrainsMonoSemiBold_ttfSize);
        mono[3] = load (BinaryData::JetBrainsMonoBold_ttf, BinaryData::JetBrainsMonoBold_ttfSize);
    }

    static Typefaces& get()
    {
        static Typefaces t;
        return t;
    }
};

int weightIndex (int weight)
{
    if (weight >= 700)
        return 3;
    if (weight >= 600)
        return 2;
    if (weight >= 500)
        return 1;
    return 0;
}
} // namespace

juce::Font font (Family family, float px, int weight, float trackingEm)
{
    auto& t = Typefaces::get();
    auto tf = family == Family::sans ? t.sans[weightIndex (weight)] : t.mono[weightIndex (weight)];
    juce::Font f (juce::FontOptions (tf).withPointHeight (px).withMetricsKind (juce::TypefaceMetricsKind::portable));
    if (trackingEm != 0.0f)
        f = f.withExtraKerningFactor (trackingEm * px / f.getHeight());
    return f;
}

float textWidth (const juce::Font& f, const juce::String& s)
{
    return juce::GlyphArrangement::getStringWidth (f, s);
}

void drawText (juce::Graphics& g, const juce::String& s, juce::Rectangle<float> r, const juce::Font& f, juce::Colour c, juce::Justification j)
{
    g.setFont (f);
    g.setColour (c);
    g.drawText (s, r, j, false);
}

float drawParagraph (juce::Graphics& g, const juce::String& s, juce::Rectangle<float> r, const juce::Font& f, juce::Colour c, float lineHeight)
{
    juce::AttributedString as;
    as.append (s, f, c);
    as.setWordWrap (juce::AttributedString::byWord);
    as.setLineSpacing (juce::jmax (0.0f, lineHeight - f.getHeight()));
    juce::TextLayout layout;
    layout.createLayout (as, r.getWidth());
    layout.draw (g, r.withHeight (layout.getHeight() + 2.0f));
    return layout.getHeight();
}

float paragraphHeight (const juce::String& s, float width, const juce::Font& f, float lineHeight)
{
    juce::AttributedString as;
    as.append (s, f, juce::Colours::white);
    as.setWordWrap (juce::AttributedString::byWord);
    as.setLineSpacing (juce::jmax (0.0f, lineHeight - f.getHeight()));
    juce::TextLayout layout;
    layout.createLayout (as, width);
    return layout.getHeight();
}

juce::Path powerIcon (juce::Rectangle<float> box)
{
    // M3.3 3.2 a4 4 0 1 0 5.4 0  and  M6 1.3 v4.2, in a 12 x 12 viewBox.
    juce::Path p;
    const float s = box.getWidth() / 12.0f;
    auto pt = [&] (float x, float y) { return juce::Point<float> (box.getX() + x * s, box.getY() + y * s); };
    // Arc of radius 4 centred at (6, 6.18) from (3.3, 3.2) round the bottom to (8.7, 3.2).
    const auto c = pt (6.0f, 6.15f);
    const float r = 4.0f * s;
    const float a0 = std::atan2 (pt (3.3f, 3.2f).x - c.x, -(pt (3.3f, 3.2f).y - c.y));
    const float a1 = std::atan2 (pt (8.7f, 3.2f).x - c.x, -(pt (8.7f, 3.2f).y - c.y));
    // The large arc runs clockwise from the upper right, round the bottom,
    // to the upper left.
    p.addCentredArc (c.x, c.y, r, r, 0.0f, a1, a0 + juce::MathConstants<float>::twoPi, true);
    p.startNewSubPath (pt (6.0f, 1.3f));
    p.lineTo (pt (6.0f, 5.5f));
    return p;
}

void drawPowerIcon (juce::Graphics& g, juce::Rectangle<float> box, juce::Colour c, float strokeInDesignUnits)
{
    g.setColour (c);
    g.strokePath (powerIcon (box), juce::PathStrokeType (strokeInDesignUnits * box.getWidth() / 12.0f, juce::PathStrokeType::curved,
                                                         juce::PathStrokeType::rounded));
}

void drawChevron (juce::Graphics& g, juce::Point<float> centre, float size, juce::Colour c, float stroke)
{
    // A size x size box with right and bottom borders, rotated 45 degrees and
    // nudged up 2px: a "v".
    // Border centre lines sit half a stroke inside the box.
    const float half = (size - stroke) * 0.5f * 1.41421356f;
    const float cy = centre.y - 2.0f;
    juce::Path p;
    p.startNewSubPath (centre.x - half, cy);
    p.lineTo (centre.x, cy + half);
    p.lineTo (centre.x + half, cy);
    g.setColour (c);
    g.strokePath (p, juce::PathStrokeType (stroke, juce::PathStrokeType::mitered, juce::PathStrokeType::square));
}

void drawListIcon (juce::Graphics& g, juce::Point<float> centre, juce::Colour c)
{
    g.setColour (c);
    for (int i = -1; i <= 1; ++i)
        g.fillRect (juce::Rectangle<float> (centre.x - 5.5f, centre.y + i * 4.0f - 0.5f, 11.0f, 1.0f));
}

void drawShadow (juce::Graphics& g, juce::Rectangle<float> r, float cornerRadius, float offsetY, float blur, float alpha)
{
    juce::Path p;
    p.addRoundedRectangle (r.translated (0.0f, offsetY), cornerRadius);
    juce::DropShadow (juce::Colours::black.withAlpha (alpha), (int) blur, {}).drawForPath (g, p);
}

} // namespace ref::ui

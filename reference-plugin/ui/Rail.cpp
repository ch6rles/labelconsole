#include "Rail.h"

#include "../measurement/TextUtil.h"
#include "ref/dsp/Format.h"
#include "../plugin/Parameters.h"

namespace ref::ui
{

namespace
{
const juce::Font& labelFont() { static const auto f = mono (9.5f, 400, 0.14f); return f; }

SegmentedControl::Style filterStyle()
{
    SegmentedControl::Style s;
    s.font = sans (10.5f, 600, 0.10f);
    s.subFont = mono (9.5f);
    s.border = colours::borderField;
    s.equalWidths = true;
    return s;
}

double parseNumber (const juce::String& s)
{
    return s.replace (text::minus, "-").retainCharacters ("-+.0123456789").getDoubleValue();
}

juce::String outputText (float v)
{
    const float r = std::round (v * 10.0f) / 10.0f;
    if (r > 0.0f)
        return "+" + juce::String (r, 1) + " dB";
    if (r < 0.0f)
        return text::minus + juce::String (-r, 1) + " dB";
    return "0.0 dB";
}

juce::String balanceText (float v)
{
    const float r = std::round (v * 10.0f) / 10.0f;
    if (r == 0.0f)
        return "C" + text::spacedDot + "0.0 dB";
    // Names the side being attenuated: positive trims the left channel.
    return (r > 0.0f ? "L " : "R ") + text::minus + juce::String (std::abs (r), 1) + " dB";
}

double meterFraction (float db)
{
    return juce::jlimit (0.0, 1.0, (db + 48.0) / 48.0);
}
} // namespace

Rail::Rail (EditorHost& h)
    : host (h),
      calibration (Knob::Kind::calibration, h.model().param (params::calAmount), 0.1, 1.0),
      output (Knob::Kind::output, h.model().param (params::outputGain), 0.1, 0.1),
      balance (Knob::Kind::balance, h.model().param (params::balance), 0.1, 0.1),
      outputField ({}), balanceField ({}),
      filter ({ "MIN PHASE", "LINEAR PHASE" }, filterStyle())
{
    for (auto* c : std::initializer_list<juce::Component*> { &calibration, &output, &balance, &outputField, &balanceField, &filter, &autoGain, &protection })
        addAndMakeVisible (c);

    calibration.setTitle ("Calibration");
    output.setTitle ("Output");
    balance.setTitle ("Balance");
    calibration.setTooltip ("Scales the correction in dB. 50% applies half the correction at every frequency.");
    filter.setTooltip ("Linear Phase keeps the correction phase-neutral, at the cost of latency and possible pre-ringing. "
                       "With gentle corrections the difference is small.");
    autoGain.setTitle ("Auto Gain");
    protection.setTitle ("Monitor Protection");

    auto& m = host.model();
    outputField.onCommit = [&m] (const juce::String& s) { m.setParam (params::outputGain, juce::jlimit (-24.0f, 12.0f, (float) parseNumber (s))); };
    outputField.editText = [&m] { return juce::String (m.outputDb(), 1); };
    balanceField.onCommit = [&m] (const juce::String& s)
    {
        const auto t = s.trim().toUpperCase();
        float v = std::abs ((float) parseNumber (t));
        if (t.startsWithChar ('R'))
            v = -v;
        else if (! t.startsWithChar ('L'))
            v = (float) parseNumber (t);
        m.setParam (params::balance, juce::jlimit (-6.0f, 6.0f, v));
    };
    balanceField.editText = [&m] { return balanceText (m.balanceDb()); };

    filter.onSelect = [&m] (int i) { m.proc.setFilterMode (i == 1 ? dsp::FilterMode::linearPhase : dsp::FilterMode::minimumPhase); };
    autoGain.onToggle = [&m] (bool on) { m.proc.setAutoGain (on); };
    protection.onToggle = [&m] (bool on) { m.proc.setMonitorProtection (on); };

    auto refreshFields = [this]
    {
        outputField.setText (outputText (output.value()));
        balanceField.setText (balanceText (balance.value()));
    };
    output.onValueChange = refreshFields;
    balance.onValueChange = refreshFields;
    refreshFields();

    host.model().addListener (this);
    modelChanged();
}

Rail::~Rail()
{
    host.model().removeListener (this);
}

void Rail::modelChanged()
{
    auto& m = host.model();
    filter.setSelected (m.settings.filterMode == dsp::FilterMode::linearPhase ? 1 : 0);
    filter.setSubLabels ({ "0 ms", m.latencyText (dsp::FilterMode::linearPhase) });
    autoGain.setOn (m.settings.autoGain);
    protection.setOn (m.settings.monitorProtection);
    outputField.setText (outputText (m.outputDb()));
    balanceField.setText (balanceText (m.balanceDb()));
    const bool interactive = ! m.renderActive;
    setInterceptsMouseClicks (interactive, interactive);
    repaint();
}

bool Rail::layoutWith (float s, float gap, bool toggles, bool meterScale, bool apply)
{
    const float W = (float) getWidth();
    const float left = 22.0f, contentW = W - 44.0f;
    const float labelH = labelFont().getHeight();
    float y = 14.0f;

    const float calBox = std::round (156.0f * s);
    const float smallBox = std::round (84.0f * s);
    const float meterH = 14.0f + 6.0f + 25.0f + (meterScale ? 16.0f : 0.0f);
    const float total = 14.0f + (labelH + 4.0f + calBox) + gap + (labelH + 4.0f + smallBox + 10.0f + 22.0f) + gap + meterH + gap
                      + (labelH + 8.0f + 40.0f) + (toggles ? gap + 74.0f : 0.0f) + 14.0f;
    if (total > (float) getHeight() + 0.5f && ! apply)
        return false;
    if (! apply)
        return true;

    showToggles = toggles;
    showMeterScale = meterScale;

    calLabel = { left, y, contentW, labelH };
    y += labelH + 4.0f;
    calibration.setBounds (juce::Rectangle<float> (left + (contentW - calBox) * 0.5f, y, calBox, calBox).toNearestInt());
    y += calBox + gap;

    const float colW = (contentW - 12.0f) * 0.5f;
    outLabel = { left, y, colW, labelH };
    balLabel = { left + colW + 12.0f, y, colW, labelH };
    y += labelH + 4.0f;
    output.setBounds (juce::Rectangle<float> (left + (colW - smallBox) * 0.5f - 8.0f, y, smallBox + 16.0f, smallBox).toNearestInt());
    balance.setBounds (juce::Rectangle<float> (left + colW + 12.0f + (colW - smallBox) * 0.5f - 8.0f, y, smallBox + 16.0f, smallBox).toNearestInt());
    y += smallBox + 10.0f;
    auto placeField = [&] (ValueField& f, float colX)
    {
        const float w = juce::jmax (72.0f, f.preferredWidth());
        f.setBounds (juce::Rectangle<float> (colX + (colW - w) * 0.5f, y, w, 22.0f).toNearestInt());
    };
    placeField (outputField, left);
    placeField (balanceField, left + colW + 12.0f);
    y += 22.0f + gap;

    meterBounds = { left, y, contentW, meterH };
    y += meterH + gap;

    filterLabel = { left, y, contentW, labelH };
    y += labelH + 8.0f;
    filter.setBounds (juce::Rectangle<float> (left, y, contentW, 40.0f).toNearestInt());
    y += 40.0f;

    autoGain.setVisible (toggles);
    protection.setVisible (toggles);
    if (toggles)
    {
        y += gap;
        autoGainRow = { left, y, contentW, 34.0f };
        protectionRow = { left, y + 40.0f, contentW, 34.0f };
        autoGain.setBounds (juce::Rectangle<float> (autoGainRow.getRight() - 30.0f, autoGainRow.getCentreY() - 8.0f, 30.0f, 16.0f).toNearestInt());
        protection.setBounds (juce::Rectangle<float> (protectionRow.getRight() - 30.0f, protectionRow.getCentreY() - 8.0f, 30.0f, 16.0f).toNearestInt());
        const auto hf = mono (9.5f, 700, 0.06f);
        const float hw = 6.0f + 5.0f + 5.0f + textWidth (hf, "HOLD") + 6.0f + 1.0f;
        holdChip = { (float) protection.getX() - 8.0f - hw, protectionRow.getCentreY() - 8.5f, hw, 17.0f };
    }
    return true;
}

void Rail::resized()
{
    // Full layout when it fits; otherwise shrink the knobs and gaps, and
    // as a last resort leave Auto Gain and Monitor Protection to Settings.
    if (layoutWith (1.0f, 12.0f, true, true, false))
    {
        layoutWith (1.0f, 12.0f, true, true, true);
        return;
    }
    for (bool toggles : { true, false })
    {
        for (float s = 0.95f; s >= 0.6f; s -= 0.05f)
        {
            if (layoutWith (s, 8.0f, toggles, toggles, false))
            {
                layoutWith (s, 8.0f, toggles, toggles, true);
                return;
            }
        }
    }
    layoutWith (0.6f, 6.0f, false, false, true);
}

void Rail::paint (juce::Graphics& g)
{
    auto& m = host.model();
    g.setColour (colours::line);
    g.fillRect (0.0f, 0.0f, 1.0f, (float) getHeight());

    drawText (g, "CALIBRATION", calLabel, labelFont(), colours::label, juce::Justification::centredTop);
    drawText (g, "OUTPUT", outLabel, labelFont(), colours::label, juce::Justification::centredTop);
    drawText (g, "BALANCE", balLabel, labelFont(), colours::label, juce::Justification::centredTop);
    drawText (g, "FILTER", filterLabel, labelFont(), colours::label);

    // OUTPUT PEAK meter: linear in dB over -48 .. 0 dBFS.
    {
        const auto r = meterBounds;
        drawText (g, "OUTPUT PEAK", { r.getX(), r.getY(), r.getWidth(), 14.0f }, labelFont(), colours::label);
        auto peakText = [&] (float db)
        {
            if (m.renderActive)
                return text::emDash;
            if (db <= -119.0f)
                return text::minus + juce::String::fromUTF8 ("\xe2\x88\x9e");
            return text::fromStd (dsp::formatNumber (db, 1));
        };
        drawText (g, peakText (m.holdDb[0]) + " / " + peakText (m.holdDb[1]) + " dBFS", { r.getX(), r.getY(), r.getWidth(), 14.0f }, mono (10.5f),
                  colours::ink4, juce::Justification::centredRight);

        const float barX = r.getX() + 14.0f, barW = r.getWidth() - 14.0f;
        for (int c = 0; c < 2; ++c)
        {
            const float rowY = r.getY() + 20.0f + (float) c * 14.0f;
            const float barY = rowY + 3.5f;
            drawText (g, c == 0 ? "L" : "R", { r.getX(), rowY, 8.0f, 11.0f }, mono (8.5f), colours::label);
            g.setColour (colours::meterTrack);
            g.fillRect (barX, barY, barW, 4.0f);
            if (! m.renderActive)
            {
                g.setColour (colours::ink);
                g.fillRect (barX, barY, barW * (float) meterFraction (m.levelDb[c]), 4.0f);
                if (m.holdDb[c] > -48.0f)
                    g.fillRect (barX + barW * (float) meterFraction (m.holdDb[c]) - 0.75f, barY, 1.5f, 4.0f);
            }
            // The -0.1 dBFS protection ceiling.
            g.setColour (colours::muted);
            g.fillRect (barX + barW * 0.998f, barY - 3.0f, 1.0f, 10.0f);
        }
        if (showMeterScale)
        {
            const auto sf = mono (8.5f);
            const float sy = r.getY() + 20.0f + 25.0f + 6.0f;
            drawText (g, text::minus + "48", { barX, sy, 30.0f, 10.0f }, sf, colours::label);
            drawText (g, text::minus + "24", { barX + barW * 0.5f - 15.0f, sy, 30.0f, 10.0f }, sf, colours::label, juce::Justification::centredTop);
            drawText (g, text::minus + "12", { barX + barW * 0.75f - 15.0f, sy, 30.0f, 10.0f }, sf, colours::label, juce::Justification::centredTop);
            drawText (g, "0", { barX + barW - 30.0f, sy, 30.0f, 10.0f }, sf, colours::label, juce::Justification::topRight);
        }
    }

    if (showToggles)
    {
        auto toggleText = [&] (juce::Rectangle<float> row, const juce::String& title, const juce::String& sub, bool monoSub)
        {
            const auto tf = sans (12.5f);
            const auto sf = monoSub ? mono (10.0f) : sans (10.5f);
            const float total = tf.getHeight() + 2.0f + sf.getHeight();
            const float y = row.getCentreY() - total * 0.5f;
            drawText (g, title, { row.getX(), y, row.getWidth() - 40.0f, tf.getHeight() }, tf, colours::ink);
            drawText (g, sub, { row.getX(), y + tf.getHeight() + 2.0f, row.getWidth() - 40.0f, sf.getHeight() }, sf, colours::label);
        };
        toggleText (autoGainRow, "Auto Gain", "Level match + headroom", false);
        toggleText (protectionRow, "Monitor Protection", "Ceiling " + text::minus + "0.1 dBFS", true);

        if (m.protectionHold)
        {
            g.setColour (colours::ink);
            g.fillRoundedRectangle (holdChip, 2.0f);
            g.setColour (colours::bg);
            g.fillRect (holdChip.getX() + 6.0f, holdChip.getCentreY() - 2.5f, 5.0f, 5.0f);
            drawText (g, "HOLD", holdChip.withTrimmedLeft (16.0f), mono (9.5f, 700, 0.06f), colours::bg);
        }
    }
}

void Rail::paintOverChildren (juce::Graphics& g)
{
    if (host.model().renderActive)
    {
        g.setColour (colours::bg.withAlpha (0.74f));
        g.fillRect (getLocalBounds().withTrimmedLeft (1));
    }
}

} // namespace ref::ui

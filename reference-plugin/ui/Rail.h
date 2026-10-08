#pragma once

#include "EditorHost.h"
#include "Widgets.h"

namespace ref::ui
{

// The 268 px control rail: Calibration, Output and Balance knobs, output
// peak meter, filter mode, Auto Gain and Monitor Protection.
class Rail : public juce::Component, private EditorModel::Listener
{
public:
    explicit Rail (EditorHost&);
    ~Rail() override;

    void paint (juce::Graphics&) override;
    void paintOverChildren (juce::Graphics&) override;
    void resized() override;

private:
    void modelChanged() override;
    void metersChanged() override { repaint (meterBounds.toNearestInt().expanded (2)); }
    bool layoutWith (float knobScale, float gap, bool toggles, bool meterScale, bool apply);

    EditorHost& host;
    Knob calibration, output, balance;
    ValueField outputField, balanceField;
    SegmentedControl filter;
    Switch autoGain, protection;

    juce::Rectangle<float> calLabel, outLabel, balLabel, meterBounds, filterLabel, autoGainRow, protectionRow, holdChip;
    bool showToggles = true, showMeterScale = true;
};

} // namespace ref::ui

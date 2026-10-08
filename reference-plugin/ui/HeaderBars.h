#pragma once

#include "EditorHost.h"
#include "Widgets.h"

namespace ref::ui
{

class TabButton : public Clickable
{
public:
    explicit TabButton (juce::String t) : text (std::move (t)) {}
    void setActive (bool a) { active = a; repaint(); }
    float preferredWidth() const;
    void paint (juce::Graphics&) override;

private:
    juce::String text;
    bool active = false;
};

// Preset box: list icon, centred name, previous and next.
class PresetBox : public juce::Component
{
public:
    explicit PresetBox (EditorHost&);
    void setName (const juce::String&, bool modified);
    void setShowArrows (bool);
    void paint (juce::Graphics&) override;
    void resized() override;

    Clickable menuButton, prevButton, nextButton;

private:
    juce::String name;
    bool modified = false, arrows = true;
    EditorHost& host;
};

// Header row 1 (48 px): wordmark, tabs, preset box, protection pill, A/B, Bypass.
class HeaderRow1 : public juce::Component, private EditorModel::Listener
{
public:
    explicit HeaderRow1 (EditorHost&);
    ~HeaderRow1() override;

    void paint (juce::Graphics&) override;
    void resized() override;

private:
    void modelChanged() override;
    void openPresetMenu();

    EditorHost& host;
    TabButton tabs[3] { TabButton ("CALIBRATION"), TabButton ("SETTINGS"), TabButton ("HELP") };
    PresetBox presetBox;
    SegmentedControl ab;
    TextButton bypass;
    juce::Rectangle<float> pillBounds, abLabelBounds;
    float wordmarkWidth = 0.0f;
    bool showPill = false;
};

// Header row 2 (58 px): headphone and target fields, badge, stats.
class HeaderRow2 : public juce::Component, private EditorModel::Listener
{
public:
    explicit HeaderRow2 (EditorHost&);
    ~HeaderRow2() override;

    void paint (juce::Graphics&) override;
    void resized() override;
    void mouseMove (const juce::MouseEvent&) override;

private:
    void modelChanged() override;
    void openHeadphoneMenu();
    void openTargetMenu();

    struct Stat
    {
        juce::String label, value;
        bool dim = false;
        juce::Rectangle<float> bounds;
    };

    EditorHost& host;
    DropdownField headphones, target;
    juce::Rectangle<float> headphonesLabel, targetLabel, badgeBounds;
    std::vector<Stat> stats;
    bool compact = false, showFieldLabels = true;
};

} // namespace ref::ui

#pragma once

#include "Theme.h"

#include <juce_audio_processors/juce_audio_processors.h>

#include <functional>

namespace ref::ui
{

// Base for everything clickable: hover, pressed and keyboard-focus states
// (proposed in the handoff: hover border #8a8a8a, pressed #161616, focus
// ring 1px ink at 2px offset), Enter/Space activation.
class Clickable : public juce::Component
{
public:
    Clickable();

    std::function<void()> onClick;

    bool isHovered() const noexcept { return hovered; }
    bool isPressed() const noexcept { return pressed; }
    void setEnabledLook (bool e) { enabledLook = e; repaint(); }
    bool isEnabledLook() const noexcept { return enabledLook; }

    void mouseEnter (const juce::MouseEvent&) override;
    void mouseExit (const juce::MouseEvent&) override;
    void mouseDown (const juce::MouseEvent&) override;
    void mouseUp (const juce::MouseEvent&) override;
    bool keyPressed (const juce::KeyPress&) override;
    void focusGained (FocusChangeType) override { repaint(); }
    void focusLost (FocusChangeType) override { repaint(); }

protected:
    void drawFocusRing (juce::Graphics&, juce::Rectangle<float>, float radius) const;
    juce::Colour borderFor (juce::Colour normal) const { return hovered && enabledLook ? colours::hoverBorder : normal; }

private:
    bool hovered = false, pressed = false, enabledLook = true;
};

// Segmented control: one engaged segment, drawn inverted.
class SegmentedControl : public Clickable
{
public:
    struct Style
    {
        juce::Font font = sans (11.0f, 600, 0.10f);
        juce::Font subFont = mono (9.5f);
        juce::Colour border = colours::borderControl;
        juce::Colour inactiveText = colours::muted;
        float radius = 4.0f;
        float padX = 10.0f;      // per segment, when sizing to content
        bool equalWidths = false;
        bool boldWhenSelected = false;
    };

    SegmentedControl (juce::StringArray labels, Style);

    void setSubLabels (juce::StringArray);
    void setSelected (int);
    int getSelected() const noexcept { return selected; }
    std::function<void (int)> onSelect;

    float preferredWidth() const;

    void paint (juce::Graphics&) override;
    void mouseUp (const juce::MouseEvent&) override;
    bool keyPressed (const juce::KeyPress&) override;

private:
    juce::Rectangle<float> segmentBounds (int) const;

    juce::StringArray labels, subLabels;
    Style style;
    int selected = 0;
};

// 30 x 16 switch.
class Switch : public Clickable
{
public:
    Switch();
    void setOn (bool);
    bool isOn() const noexcept { return on; }
    std::function<void (bool)> onToggle;
    void paint (juce::Graphics&) override;

private:
    bool on = true;
};

// Outlined text button (optionally with the power icon), inverted when engaged.
class TextButton : public Clickable
{
public:
    struct Style
    {
        juce::Font font = sans (11.0f, 600, 0.10f);
        juce::Font engagedFont = sans (11.0f, 700, 0.10f);
        juce::Colour border = colours::borderControl;
        juce::Colour text = colours::ink;
        float radius = 4.0f;
        float padX = 11.0f;
        bool powerIcon = false;
        float iconGap = 7.0f;
    };

    TextButton (juce::String text, Style);
    void setText (const juce::String&);
    void setEngaged (bool);
    bool isEngaged() const noexcept { return engaged; }
    float preferredWidth() const;
    void paint (juce::Graphics&) override;

private:
    juce::String text;
    Style style;
    bool engaged = false;
};

// Dropdown field: value text and a chevron.
class DropdownField : public Clickable
{
public:
    struct Style
    {
        juce::Font font = sans (13.0f, 500);
        juce::Colour fill = colours::field;
        juce::Colour border = colours::borderField;
        float radius = 4.0f;
        float padX = 12.0f;
        float chevronSize = 5.0f;
        float gap = 8.0f;
        bool chevronAtEnd = true; // false: right after the text
    };

    explicit DropdownField (Style);
    void setText (const juce::String&);
    const juce::String& getText() const noexcept { return text; }
    float preferredWidth() const;
    void paint (juce::Graphics&) override;

private:
    juce::String text;
    Style style;
};

// Typed-entry value field. Accepts bare numbers or numbers with units;
// Enter or blur commits, Esc cancels.
class ValueField : public juce::Component, private juce::TextEditor::Listener
{
public:
    struct Style
    {
        juce::Font font = mono (11.5f);
        juce::Colour fill = colours::field;
        juce::Colour border = colours::borderField;
        float radius = 3.0f;
        float padX = 8.0f;
        bool centred = true;
    };

    explicit ValueField (Style);
    ~ValueField() override;

    void setText (const juce::String&);
    std::function<void (const juce::String&)> onCommit;
    std::function<juce::String()> editText; // text shown when editing starts

    float preferredWidth() const;
    void paint (juce::Graphics&) override;
    void resized() override;
    void mouseUp (const juce::MouseEvent&) override;
    void mouseEnter (const juce::MouseEvent&) override { repaint(); }
    void mouseExit (const juce::MouseEvent&) override { repaint(); }
    bool keyPressed (const juce::KeyPress&) override;
    void focusGained (FocusChangeType) override { repaint(); }
    void focusLost (FocusChangeType) override { repaint(); }

    void beginEditing();
    bool isEditing() const noexcept { return editor != nullptr; }

private:
    void textEditorReturnKeyPressed (juce::TextEditor&) override;
    void textEditorEscapeKeyPressed (juce::TextEditor&) override;
    void textEditorFocusLost (juce::TextEditor&) override;
    void finish (bool commit);

    juce::String text;
    Style style;
    std::unique_ptr<juce::TextEditor> editor;
};

// Rotary knob bound to a host parameter. Vertical drag (about 250 px for
// full travel, Shift for fine), wheel steps, double-click or Alt-click
// resets to default.
class Knob : public juce::Component
{
public:
    enum class Kind
    {
        calibration, // 156 box, unipolar arc, centre value
        output,      // 84 box, bipolar arc from 0 dB at +45 degrees
        balance      // 84 box, bipolar arc from centre
    };

    Knob (Kind, juce::RangedAudioParameter&, double fineStep, double coarseStep);
    ~Knob() override;

    void setCompact (bool);
    float value() const noexcept { return currentValue; }

    void paint (juce::Graphics&) override;
    void mouseDown (const juce::MouseEvent&) override;
    void mouseDrag (const juce::MouseEvent&) override;
    void mouseUp (const juce::MouseEvent&) override;
    void mouseDoubleClick (const juce::MouseEvent&) override;
    void mouseWheelMove (const juce::MouseEvent&, const juce::MouseWheelDetails&) override;
    bool keyPressed (const juce::KeyPress&) override;
    void focusGained (FocusChangeType) override { repaint(); }
    void focusLost (FocusChangeType) override { repaint(); }

    std::function<void()> onValueChange;

private:
    double norm (double v) const;
    void setValue (double v);

    Kind kind;
    juce::RangedAudioParameter& param;
    juce::ParameterAttachment attachment;
    double fine, coarse;
    float currentValue = 0.0f;
    double dragStartValue = 0.0;
    float dragStartY = 0.0f;
    bool dragging = false, dragFine = false;
};

} // namespace ref::ui

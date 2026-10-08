#pragma once

#include "Theme.h"

#include <functional>
#include <vector>

namespace ref::ui
{

struct MenuItem
{
    enum class Kind
    {
        group,   // small-caps heading
        item,    // selectable row
        divider,
        footer,  // small print
        actions  // 3 x 2 grid of commands (preset menu)
    };

    Kind kind = Kind::item;
    juce::String text, detail, description;
    bool selected = false, enabled = true, v2Tag = false;
    std::function<void()> action;
    struct Action
    {
        juce::String text;
        std::function<void()> run;
        bool enabled = true;
    };
    std::vector<Action> actions;

    static MenuItem group (juce::String t) { MenuItem m; m.kind = Kind::group; m.text = std::move (t); return m; }
    static MenuItem divider() { MenuItem m; m.kind = Kind::divider; return m; }
    static MenuItem footer (juce::String t) { MenuItem m; m.kind = Kind::footer; m.text = std::move (t); return m; }
};

struct MenuStyle
{
    float width = 300.0f;
    float rowPadY = 10.0f;
    float groupTopPad = 8.0f;
    float bottomPad = 6.0f;
    bool monoItems = false; // range menu
};

// Popup panel drawn inside the plugin window (#121212, #3a3a3a border,
// radius 5, 0 18px 40px shadow). Closes on selection, Esc or an outside
// click; arrow keys move between enabled rows.
class MenuPanel : public juce::Component
{
public:
    MenuPanel (std::vector<MenuItem>, MenuStyle);

    float preferredHeight() const;
    std::function<void()> onDismiss;

    void paint (juce::Graphics&) override;
    void mouseMove (const juce::MouseEvent&) override;
    void mouseExit (const juce::MouseEvent&) override;
    void mouseUp (const juce::MouseEvent&) override;
    bool keyPressed (const juce::KeyPress&) override;

    static constexpr float kShadowMargin = 40.0f;

private:
    struct Row
    {
        juce::Rectangle<float> bounds;
        int item = -1;
        int action = -1; // index into an actions grid
    };

    void layout();
    float itemHeight (const MenuItem&) const;
    void activate (int row);
    int rowAt (juce::Point<float>) const;
    void moveFocus (int delta);

    std::vector<MenuItem> items;
    MenuStyle style;
    std::vector<Row> rows;
    int hoverRow = -1, keyRow = -1;
};

// Modal text prompt for preset names, drawn in the plugin's style.
class NamePrompt : public juce::Component, private juce::TextEditor::Listener
{
public:
    NamePrompt (juce::String title, juce::String initial, std::function<void (const juce::String&)> onOk);

    // Confirmation only: shows `message` instead of a text field.
    static std::unique_ptr<NamePrompt> confirmation (juce::String title, juce::String message, juce::String okText,
                                                     std::function<void()> onOk);

    std::function<void()> onDismiss;

    void paint (juce::Graphics&) override;
    void resized() override;
    void mouseUp (const juce::MouseEvent&) override;
    void visibilityChanged() override;

private:
    void textEditorReturnKeyPressed (juce::TextEditor&) override { confirm(); }
    void textEditorEscapeKeyPressed (juce::TextEditor&) override { cancel(); }
    void confirm();
    void cancel();
    juce::Rectangle<float> panel() const;
    juce::Rectangle<float> okButton() const;
    juce::Rectangle<float> cancelButton() const;

    juce::String title, message, okText { "SAVE" };
    bool confirmOnly = false;
    juce::TextEditor editor;
    std::function<void (const juce::String&)> onOk;
};

} // namespace ref::ui

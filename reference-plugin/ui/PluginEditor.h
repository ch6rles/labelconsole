#pragma once

#include "../plugin/PluginProcessor.h"
#include "EditorHost.h"
#include "GraphView.h"
#include "HeaderBars.h"
#include "HelpPage.h"
#include "Rail.h"
#include "SettingsPage.h"

namespace ref::ui
{

class LookAndFeel : public juce::LookAndFeel_V4
{
public:
    LookAndFeel();
    juce::Rectangle<int> getTooltipBounds (const juce::String&, juce::Point<int>, juce::Rectangle<int>) override;
    void drawTooltip (juce::Graphics&, const juce::String&, int width, int height) override;
    void drawCornerResizer (juce::Graphics&, int w, int h, bool isMouseOver, bool isMouseDragging) override;
};

// The editor's content at 100% scale (logical pixels); the editor scales it.
class MainView : public juce::Component, public EditorHost, private EditorModel::Listener
{
public:
    explicit MainView (ReferenceProcessor&);
    ~MainView() override;

    void paint (juce::Graphics&) override;
    void resized() override;
    bool keyPressed (const juce::KeyPress&) override;

    // EditorHost
    void showMenu (std::vector<MenuItem>, MenuStyle, juce::Component& anchor, float gapBelow, float xOffset) override;
    void closeMenu() override;
    bool isMenuOpenFor (const juce::Component& anchor) const override { return menu != nullptr && menuAnchor == &anchor; }
    void promptName (const juce::String& title, const juce::String& initial, std::function<void (const juce::String&)>) override;
    void setPage (Page) override;
    void showHelpTopic (const juce::String&) override;
    EditorModel& model() override { return editorModel; }

private:
    struct DismissLayer : public juce::Component
    {
        std::function<void()> onClick;
        void mouseDown (const juce::MouseEvent&) override { if (onClick) onClick(); }
    };

    void modelChanged() override;

    EditorModel editorModel;
    HeaderRow1 header1;
    HeaderRow2 header2;
    GraphColumn graph;
    Rail rail;
    SettingsPage settings;
    HelpPage help;

    DismissLayer dismissLayer;
    std::unique_ptr<MenuPanel> menu;
    juce::Component* menuAnchor = nullptr;
    std::unique_ptr<NamePrompt> prompt;
};

class ReferenceEditor : public juce::AudioProcessorEditor, private juce::ChangeListener
{
public:
    explicit ReferenceEditor (ReferenceProcessor&);
    ~ReferenceEditor() override;

    void resized() override;
    void paint (juce::Graphics&) override;

    static constexpr int kDefaultWidth = 1200, kDefaultHeight = 700, kMinWidth = 800, kMinHeight = 500;

private:
    void changeListenerCallback (juce::ChangeBroadcaster*) override;
    void applyScale (float);

    ReferenceProcessor& processor;
    LookAndFeel lnf;
    MainView view;
    juce::TooltipWindow tooltips { this, 600 };
    float scale = 1.0f;
};

} // namespace ref::ui

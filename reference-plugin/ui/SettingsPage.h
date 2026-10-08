#pragma once

#include "EditorHost.h"
#include "Widgets.h"

namespace ref::ui
{

// Settings: three columns of sections with a fixed footer. Scrolls when the
// window is too small for the content.
class SettingsPage : public juce::Component, private EditorModel::Listener, private juce::Timer
{
public:
    explicit SettingsPage (EditorHost&);
    ~SettingsPage() override;

    void paint (juce::Graphics&) override;
    void resized() override;
    void mouseUp (const juce::MouseEvent&) override;
    void visibilityChanged() override;

private:
    class Content;

    void modelChanged() override;
    void timerCallback() override;

    EditorHost& host;
    juce::Viewport viewport;
    std::unique_ptr<Content> content;
    juce::Rectangle<float> licencesLink;
};

} // namespace ref::ui

#pragma once

#include "EditorModel.h"
#include "Menus.h"

namespace ref::ui
{

// What child views need from the editor: menus, prompts, navigation.
class EditorHost
{
public:
    virtual ~EditorHost() = default;

    // Opens a menu below `anchor` (a component inside the editor view).
    virtual void showMenu (std::vector<MenuItem>, MenuStyle, juce::Component& anchor, float gapBelow, float xOffset = 0.0f) = 0;
    virtual void closeMenu() = 0;
    virtual bool isMenuOpenFor (const juce::Component& anchor) const = 0;
    virtual void promptName (const juce::String& title, const juce::String& initial, std::function<void (const juce::String&)>) = 0;
    virtual void setPage (Page) = 0;
    virtual void showHelpTopic (const juce::String& topicId) = 0;
    virtual EditorModel& model() = 0;
};

} // namespace ref::ui

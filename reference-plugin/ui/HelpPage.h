#pragma once

#include "EditorHost.h"
#include "Widgets.h"

namespace ref::ui
{

// Help: a topic list beside the article. The handoff lists the topics but
// leaves the page undrawn; it follows the Settings page's type and rules.
class HelpPage : public juce::Component
{
public:
    explicit HelpPage (EditorHost&);
    ~HelpPage() override;

    void showTopic (const juce::String& id);

    void paint (juce::Graphics&) override;
    void resized() override;
    void mouseUp (const juce::MouseEvent&) override;
    void mouseMove (const juce::MouseEvent&) override;

    struct Topic
    {
        juce::String id, title;
        juce::StringArray paragraphs; // a paragraph starting "## " is a subheading
    };

private:
    class Article;

    EditorHost& host;
    std::vector<Topic> topics;
    int current = 0, hover = -1;
    std::vector<juce::Rectangle<float>> topicBounds;
    juce::Viewport viewport;
    std::unique_ptr<Article> article;
};

} // namespace ref::ui

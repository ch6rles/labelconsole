#include "PluginEditor.h"

#include "../plugin/Parameters.h"

namespace ref::ui
{

namespace
{
juce::TextLayout tooltipLayout (const juce::String& text)
{
    juce::AttributedString s;
    s.append (text, sans (11.5f), colours::ink2);
    s.setWordWrap (juce::AttributedString::byWord);
    s.setLineSpacing (3.0f);
    juce::TextLayout layout;
    layout.createLayout (s, 300.0f);
    return layout;
}
} // namespace

LookAndFeel::LookAndFeel()
{
    setColour (juce::TooltipWindow::backgroundColourId, colours::bg);
    setColour (juce::TooltipWindow::outlineColourId, colours::tickMinor);
    setColour (juce::TooltipWindow::textColourId, colours::ink2);
    setColour (juce::ScrollBar::thumbColourId, colours::borderControl);
    setColour (juce::TextEditor::backgroundColourId, colours::field);
    setColour (juce::TextEditor::textColourId, colours::ink);
    setColour (juce::ResizableWindow::backgroundColourId, colours::bg);
}

juce::Rectangle<int> LookAndFeel::getTooltipBounds (const juce::String& text, juce::Point<int> pos, juce::Rectangle<int> parentArea)
{
    const auto layout = tooltipLayout (text);
    const int w = (int) std::ceil (layout.getWidth()) + 20;
    const int h = (int) std::ceil (layout.getHeight()) + 14;
    return juce::Rectangle<int> (pos.x > parentArea.getCentreX() ? pos.x - (w + 12) : pos.x + 12,
                                 pos.y > parentArea.getCentreY() ? pos.y - (h + 8) : pos.y + 16, w, h)
        .constrainedWithin (parentArea);
}

void LookAndFeel::drawTooltip (juce::Graphics& g, const juce::String& text, int width, int height)
{
    const auto r = juce::Rectangle<float> ((float) width, (float) height);
    g.setColour (colours::bg);
    g.fillRoundedRectangle (r, 3.0f);
    g.setColour (colours::tickMinor);
    g.drawRoundedRectangle (r.reduced (0.5f), 3.0f, 1.0f);
    tooltipLayout (text).draw (g, r.reduced (10.0f, 7.0f));
}

void LookAndFeel::drawCornerResizer (juce::Graphics& g, int w, int h, bool over, bool dragging)
{
    // Three dots, quiet until hovered.
    g.setColour (over || dragging ? colours::muted : colours::borderControl);
    for (int i = 0; i < 3; ++i)
        for (int j = 0; j <= i; ++j)
            g.fillRect ((float) w - 4.0f - 4.0f * (float) j, (float) h - 4.0f - 4.0f * (float) (i - j), 1.5f, 1.5f);
}

//==============================================================================
MainView::MainView (ReferenceProcessor& p)
    : editorModel (p), header1 (*this), header2 (*this), graph (*this), rail (*this), settings (*this), help (*this)
{
    setWantsKeyboardFocus (true);
    for (auto* c : std::initializer_list<juce::Component*> { &header1, &header2, &graph, &rail })
        addAndMakeVisible (c);
    addChildComponent (settings);
    addChildComponent (help);
    addChildComponent (dismissLayer);
    dismissLayer.onClick = [this] { closeMenu(); };
    editorModel.addListener (this);
    // Sees clicks on every child, so a click anywhere gives the A key a home.
    addMouseListener (this, true);
}

void MainView::mouseDown (const juce::MouseEvent& e)
{
    // Knobs and most buttons do not take keyboard focus, so after clicking
    // them nothing has it and the A shortcut is never delivered. Take it
    // back here, unless the click is typing into a field.
    auto* focused = juce::Component::getCurrentlyFocusedComponent();
    if (dynamic_cast<juce::TextEditor*> (e.eventComponent) != nullptr
        || (focused != nullptr && dynamic_cast<juce::TextEditor*> (focused) != nullptr && isParentOf (focused)))
        return;
    if (! hasKeyboardFocus (true))
        grabKeyboardFocus();
}

MainView::~MainView()
{
    editorModel.removeListener (this);
}

void MainView::paint (juce::Graphics& g)
{
    g.fillAll (colours::bg);
}

void MainView::resized()
{
    const int W = getWidth(), H = getHeight();
    header1.setBounds (0, 0, W, 48);
    header2.setBounds (0, 48, W, 58);
    const int bodyY = 106, bodyH = juce::jmax (0, H - bodyY);
    graph.setBounds (0, bodyY, W - 268, bodyH);
    rail.setBounds (W - 268, bodyY, 268, bodyH);
    settings.setBounds (0, bodyY, W, bodyH);
    help.setBounds (0, bodyY, W, bodyH);
    dismissLayer.setBounds (getLocalBounds());
    if (prompt != nullptr)
        prompt->setBounds (getLocalBounds());
    closeMenu();
}

void MainView::modelChanged()
{
    const auto page = editorModel.page;
    graph.setVisible (page == Page::calibration);
    rail.setVisible (page == Page::calibration);
    settings.setVisible (page == Page::settings);
    help.setVisible (page == Page::help);
}

bool MainView::keyPressed (const juce::KeyPress& k)
{
    // A/B is one keystroke where the host passes keys to the plugin.
    if (k.getTextCharacter() == 'a' || k.getTextCharacter() == 'A')
    {
        editorModel.setParam (params::abSelect, editorModel.calibrated() ? 0.0f : 1.0f);
        return true;
    }
    if (k == juce::KeyPress::escapeKey && menu != nullptr)
    {
        closeMenu();
        return true;
    }
    return false;
}

void MainView::showMenu (std::vector<MenuItem> items, MenuStyle style, juce::Component& anchor, float gapBelow, float xOffset)
{
    closeMenu();
    menu = std::make_unique<MenuPanel> (std::move (items), style);
    menuAnchor = &anchor;

    const auto a = getLocalArea (&anchor, anchor.getLocalBounds()).toFloat();
    const float h = menu->preferredHeight();
    float x = a.getX() + xOffset;
    float y = a.getBottom() + gapBelow;
    if (x + style.width > (float) getWidth() - 8.0f)
        x = juce::jmax (8.0f, (float) getWidth() - 8.0f - style.width);
    if (y + h > (float) getHeight() - 8.0f)
        y = juce::jmax (8.0f, a.getY() - gapBelow - h);
    const float m = MenuPanel::kShadowMargin;
    menu->setBounds (juce::Rectangle<float> (x - m, y - m, style.width + 2.0f * m, h + 2.0f * m).toNearestInt());
    menu->onDismiss = [this] { closeMenu(); };

    dismissLayer.setVisible (true);
    dismissLayer.toFront (false);
    addAndMakeVisible (*menu);
    menu->toFront (true);
    menu->grabKeyboardFocus();
}

void MainView::closeMenu()
{
    if (menu == nullptr)
        return;
    // Deleted later: this may run inside the menu's own mouse callback.
    auto* dying = menu.release();
    dying->setVisible (false);
    juce::MessageManager::callAsync ([dying] { delete dying; });
    menuAnchor = nullptr;
    dismissLayer.setVisible (false);
}

void MainView::promptName (const juce::String& title, const juce::String& initial, std::function<void (const juce::String&)> onOk)
{
    closeMenu();
    if (title == "DELETE PRESET" || title == "REPLACE PRESET")
        prompt = NamePrompt::confirmation (title, initial, title.upToFirstOccurrenceOf (" ", false, false), [onOk, initial] { onOk (initial); });
    else
        prompt = std::make_unique<NamePrompt> (title, initial, std::move (onOk));
    prompt->onDismiss = [this]
    {
        auto* dying = prompt.release();
        if (dying != nullptr)
        {
            dying->setVisible (false);
            juce::MessageManager::callAsync ([dying] { delete dying; });
        }
    };
    prompt->setBounds (getLocalBounds());
    addAndMakeVisible (*prompt);
    prompt->toFront (true);
}

void MainView::setPage (Page p)
{
    closeMenu();
    editorModel.page = p;
    editorModel.notify();
}

void MainView::showHelpTopic (const juce::String& id)
{
    setPage (Page::help);
    help.showTopic (id);
}

//==============================================================================
ReferenceEditor::ReferenceEditor (ReferenceProcessor& p) : AudioProcessorEditor (p), processor (p), view (p)
{
    setLookAndFeel (&lnf);
    addAndMakeVisible (view);
    scale = processor.getSettings().uiScale;
    setResizable (true, true);
    setResizeLimits ((int) (kMinWidth * scale), (int) (kMinHeight * scale), 8000, 6000);
    setSize ((int) (kDefaultWidth * scale), (int) (kDefaultHeight * scale));
    setWantsKeyboardFocus (false);
    processor.addChangeListener (this);
}

ReferenceEditor::~ReferenceEditor()
{
    processor.removeChangeListener (this);
    setLookAndFeel (nullptr);
}

void ReferenceEditor::paint (juce::Graphics& g)
{
    g.fillAll (colours::bg);
}

void ReferenceEditor::resized()
{
    view.setTransform (juce::AffineTransform::scale (scale));
    view.setBounds (0, 0, juce::roundToInt (getWidth() / scale), juce::roundToInt (getHeight() / scale));
}

void ReferenceEditor::changeListenerCallback (juce::ChangeBroadcaster*)
{
    const float s = processor.getSettings().uiScale;
    if (std::abs (s - scale) > 0.001f)
        applyScale (s);
}

void ReferenceEditor::applyScale (float s)
{
    const int logicalW = view.getWidth(), logicalH = view.getHeight();
    scale = s;
    setResizeLimits ((int) (kMinWidth * scale), (int) (kMinHeight * scale), 8000, 6000);
    setSize ((int) std::round (logicalW * scale), (int) std::round (logicalH * scale));
    resized();
}

} // namespace ref::ui

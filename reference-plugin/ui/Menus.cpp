#include "Menus.h"

namespace ref::ui
{

namespace
{
const juce::Font& groupFont() { static const auto f = mono (9.5f, 400, 0.14f); return f; }
const juce::Font& footerFont() { static const auto f = sans (11.0f); return f; }
const juce::Font& actionFont() { static const auto f = mono (10.0f, 400, 0.08f); return f; }
const juce::Font& tagFont() { static const auto f = mono (9.5f); return f; }

void drawV2Tag (juce::Graphics& g, juce::Rectangle<float> rowArea, float rightX)
{
    const float w = textWidth (tagFont(), "V2") + 10.0f + 2.0f;
    const float h = tagFont().getHeight() + 4.0f + 2.0f;
    const juce::Rectangle<float> r (rightX - w, rowArea.getCentreY() - h * 0.5f, w, h);
    g.setColour (colours::borderControl);
    g.drawRect (r, 1.0f);
    drawText (g, "V2", r, tagFont(), colours::muted, juce::Justification::centred);
}
} // namespace

MenuPanel::MenuPanel (std::vector<MenuItem> i, MenuStyle s) : items (std::move (i)), style (s)
{
    setWantsKeyboardFocus (true);
    layout();
}

float MenuPanel::itemHeight (const MenuItem& m) const
{
    const auto nameFont = style.monoItems ? mono (11.0f) : sans (13.0f);
    switch (m.kind)
    {
        case MenuItem::Kind::group: return 6.0f + groupFont().getHeight() + 6.0f;
        case MenuItem::Kind::divider: return 13.0f;
        case MenuItem::Kind::footer: return 8.0f + footerFont().getHeight() + 6.0f;
        case MenuItem::Kind::actions: return 6.0f + 2.0f * (20.0f + actionFont().getHeight()) + 1.0f;
        case MenuItem::Kind::item:
            if (m.description.isNotEmpty())
            {
                const float w = style.width - 28.0f - 15.0f;
                return 20.0f + nameFont.getHeight() + 3.0f + paragraphHeight (m.description, w, sans (11.5f), 11.5f * 1.4f);
            }
            return 2.0f * style.rowPadY + nameFont.getHeight();
    }
    return 0.0f;
}

float MenuPanel::preferredHeight() const
{
    float h = 6.0f + style.bottomPad;
    bool first = true;
    for (const auto& m : items)
    {
        h += itemHeight (m);
        if (m.kind == MenuItem::Kind::group && first)
            h += style.groupTopPad - 6.0f;
        first = false;
    }
    return h;
}

void MenuPanel::layout()
{
    rows.clear();
    const float x = kShadowMargin;
    float y = kShadowMargin + 6.0f;
    bool first = true;
    for (int i = 0; i < (int) items.size(); ++i)
    {
        const auto& m = items[(size_t) i];
        float h = itemHeight (m);
        if (m.kind == MenuItem::Kind::group && first)
            h += style.groupTopPad - 6.0f;
        first = false;
        if (m.kind == MenuItem::Kind::item)
        {
            rows.push_back ({ { x, y, style.width, h }, i, -1 });
        }
        else if (m.kind == MenuItem::Kind::actions)
        {
            const float cellW = style.width / 3.0f;
            const float cellH = (h - 6.0f - 1.0f) * 0.5f;
            for (int a = 0; a < (int) m.actions.size(); ++a)
                rows.push_back ({ { x + cellW * (float) (a % 3), y + 6.0f + 1.0f + cellH * (float) (a / 3), cellW, cellH }, i, a });
        }
        y += h;
    }
}

void MenuPanel::paint (juce::Graphics& g)
{
    const juce::Rectangle<float> box (kShadowMargin, kShadowMargin, style.width, preferredHeight());
    drawShadow (g, box, 5.0f, 18.0f, 40.0f, 0.65f);
    g.setColour (colours::menu);
    g.fillRoundedRectangle (box, 5.0f);

    juce::Path clip;
    clip.addRoundedRectangle (box, 5.0f);
    g.saveState();
    g.reduceClipRegion (clip);

    const auto nameFont = style.monoItems ? mono (11.0f) : sans (13.0f);
    const auto nameFontSel = style.monoItems ? mono (11.0f, 600) : sans (13.0f, 600);
    float y = box.getY() + 6.0f;
    bool first = true;
    for (int i = 0; i < (int) items.size(); ++i)
    {
        const auto& m = items[(size_t) i];
        float h = itemHeight (m);
        float topPad = 6.0f;
        if (m.kind == MenuItem::Kind::group && first)
        {
            h += style.groupTopPad - 6.0f;
            topPad = style.groupTopPad;
        }
        first = false;
        const juce::Rectangle<float> area (box.getX(), y, style.width, h);

        switch (m.kind)
        {
            case MenuItem::Kind::group:
                drawText (g, m.text, { area.getX() + 14.0f, y + topPad, style.width - 28.0f, groupFont().getHeight() }, groupFont(), colours::label);
                break;

            case MenuItem::Kind::divider:
                g.setColour (colours::divider);
                g.fillRect (area.getX(), y + 6.0f, style.width, 1.0f);
                break;

            case MenuItem::Kind::footer:
                drawText (g, m.text, { area.getX() + 29.0f, y + 8.0f, style.width - 43.0f, footerFont().getHeight() }, footerFont(), colours::label);
                break;

            case MenuItem::Kind::actions:
            {
                g.setColour (colours::divider);
                g.fillRect (area.getX(), y + 6.0f, style.width, 1.0f);
                const float cellW = style.width / 3.0f;
                const float cellH = (h - 7.0f) * 0.5f;
                for (int a = 0; a < (int) m.actions.size(); ++a)
                {
                    const juce::Rectangle<float> cell (area.getX() + cellW * (float) (a % 3), y + 7.0f + cellH * (float) (a / 3), cellW, cellH);
                    bool hot = false;
                    for (int r = 0; r < (int) rows.size(); ++r)
                        if (rows[(size_t) r].item == i && rows[(size_t) r].action == a && (r == hoverRow || r == keyRow))
                            hot = true;
                    if (hot && m.actions[(size_t) a].enabled)
                    {
                        g.setColour (colours::rowHover);
                        g.fillRect (cell);
                    }
                    g.setColour (colours::divider);
                    if (a % 3 != 2)
                        g.fillRect (cell.getRight() - 1.0f, cell.getY(), 1.0f, cell.getHeight());
                    if (a / 3 == 0)
                        g.fillRect (cell.getX(), cell.getBottom() - 1.0f, cell.getWidth(), 1.0f);
                    drawText (g, m.actions[(size_t) a].text, cell, actionFont(),
                              m.actions[(size_t) a].enabled ? colours::ink4 : colours::tickMinor, juce::Justification::centred);
                }
                break;
            }

            case MenuItem::Kind::item:
            {
                bool hot = false;
                for (int r = 0; r < (int) rows.size(); ++r)
                    if (rows[(size_t) r].item == i && (r == hoverRow || r == keyRow))
                        hot = true;
                if (m.selected)
                {
                    g.setColour (colours::rowSelected);
                    g.fillRect (area);
                }
                else if (hot && m.enabled)
                {
                    g.setColour (colours::rowHover);
                    g.fillRect (area);
                }

                const auto& f = m.selected ? nameFontSel : nameFont;
                const auto nameColour = ! m.enabled ? colours::disabled : m.selected ? colours::ink : colours::ink2;
                const float left = area.getX() + 14.0f;
                const float right = area.getRight() - 14.0f;

                if (m.description.isNotEmpty())
                {
                    const float titleY = y + 10.0f;
                    if (m.selected)
                    {
                        g.setColour (colours::ink);
                        g.fillEllipse (left, titleY + 6.0f, 5.0f, 5.0f);
                    }
                    const float textX = left + 15.0f;
                    drawText (g, m.text, { textX, titleY, right - textX - 40.0f, f.getHeight() }, f, nameColour);
                    if (m.v2Tag)
                        drawV2Tag (g, { textX, titleY, right - textX, f.getHeight() }, right);
                    else if (m.detail.isNotEmpty())
                        drawText (g, m.detail, { textX, titleY, right - textX, f.getHeight() }, mono (10.5f),
                                  m.selected ? colours::menuDetail : colours::muted, juce::Justification::centredRight);
                    const auto descColour = ! m.enabled ? colours::disabled : m.selected ? colours::menuDetail : colours::muted;
                    drawParagraph (g, m.description, { textX, titleY + f.getHeight() + 3.0f, right - textX, 200.0f }, sans (11.5f), descColour, 11.5f * 1.4f);
                }
                else
                {
                    if (m.selected)
                    {
                        g.setColour (colours::ink);
                        g.fillEllipse (left, area.getCentreY() - 2.5f, 5.0f, 5.0f);
                    }
                    const float textX = left + 15.0f;
                    drawText (g, m.text, { textX, area.getY(), right - textX, area.getHeight() }, f, nameColour);
                    if (m.v2Tag)
                        drawV2Tag (g, area, right);
                    else if (m.detail.isNotEmpty())
                        drawText (g, m.detail, { textX, area.getY(), right - textX, area.getHeight() }, mono (10.5f),
                                  m.selected ? colours::menuDetail : colours::muted, juce::Justification::centredRight);
                }
                break;
            }
        }
        y += h;
    }
    g.restoreState();

    g.setColour (colours::borderControl);
    g.drawRoundedRectangle (box.reduced (0.5f), 5.0f, 1.0f);
}

int MenuPanel::rowAt (juce::Point<float> p) const
{
    for (int r = 0; r < (int) rows.size(); ++r)
        if (rows[(size_t) r].bounds.contains (p))
            return r;
    return -1;
}

void MenuPanel::mouseMove (const juce::MouseEvent& e)
{
    const int r = rowAt (e.position);
    if (r != hoverRow)
    {
        hoverRow = r;
        repaint();
    }
    const bool enabled = r >= 0 && items[(size_t) rows[(size_t) r].item].enabled;
    setMouseCursor (enabled ? juce::MouseCursor::PointingHandCursor : juce::MouseCursor::NormalCursor);
}

void MenuPanel::mouseExit (const juce::MouseEvent&)
{
    hoverRow = -1;
    repaint();
}

void MenuPanel::mouseUp (const juce::MouseEvent& e)
{
    const juce::Rectangle<float> box (kShadowMargin, kShadowMargin, style.width, preferredHeight());
    if (! box.contains (e.position))
    {
        if (onDismiss)
            onDismiss();
        return;
    }
    const int r = rowAt (e.position);
    if (r >= 0)
        activate (r);
}

void MenuPanel::activate (int r)
{
    const auto& row = rows[(size_t) r];
    const auto& m = items[(size_t) row.item];
    if (! m.enabled || (row.action >= 0 && ! m.actions[(size_t) row.action].enabled))
        return;
    std::function<void()> action = row.action >= 0 ? m.actions[(size_t) row.action].run : m.action;
    auto dismiss = onDismiss;
    if (dismiss)
        dismiss(); // may delete this
    if (action)
        action();
}

void MenuPanel::moveFocus (int delta)
{
    if (rows.empty())
        return;
    int r = keyRow;
    for (int n = 0; n < (int) rows.size(); ++n)
    {
        r = r < 0 ? (delta > 0 ? 0 : (int) rows.size() - 1) : ((r + delta) % (int) rows.size() + (int) rows.size()) % (int) rows.size();
        const auto& row = rows[(size_t) r];
        const auto& it = items[(size_t) row.item];
        if (it.enabled && (row.action < 0 || it.actions[(size_t) row.action].enabled))
            break;
    }
    keyRow = r;
    repaint();
}

bool MenuPanel::keyPressed (const juce::KeyPress& k)
{
    if (k == juce::KeyPress::escapeKey)
    {
        if (onDismiss)
            onDismiss();
        return true;
    }
    if (k == juce::KeyPress::downKey || k == juce::KeyPress::tabKey)
    {
        moveFocus (1);
        return true;
    }
    if (k == juce::KeyPress::upKey)
    {
        moveFocus (-1);
        return true;
    }
    if ((k == juce::KeyPress::returnKey || k == juce::KeyPress::spaceKey) && keyRow >= 0)
    {
        activate (keyRow);
        return true;
    }
    return true; // menus swallow keys while open
}

//==============================================================================
NamePrompt::NamePrompt (juce::String t, juce::String initial, std::function<void (const juce::String&)> ok)
    : title (std::move (t)), onOk (std::move (ok))
{
    editor.setFont (sans (13.0f, 500));
    editor.setColour (juce::TextEditor::backgroundColourId, colours::field);
    editor.setColour (juce::TextEditor::outlineColourId, colours::borderField);
    editor.setColour (juce::TextEditor::focusedOutlineColourId, colours::hoverBorder);
    editor.setColour (juce::TextEditor::textColourId, colours::ink);
    editor.setColour (juce::TextEditor::highlightColourId, colours::ink.withAlpha (0.25f));
    editor.setColour (juce::CaretComponent::caretColourId, colours::ink);
    editor.setIndents (10, 0);
    editor.setText (initial, false);
    editor.addListener (this);
    addAndMakeVisible (editor);
}

std::unique_ptr<NamePrompt> NamePrompt::confirmation (juce::String t, juce::String msg, juce::String ok, std::function<void()> onOk)
{
    auto p = std::make_unique<NamePrompt> (std::move (t), juce::String(), [onOk] (const juce::String&) { if (onOk) onOk(); });
    p->confirmOnly = true;
    p->message = std::move (msg);
    p->okText = std::move (ok);
    p->editor.setVisible (false);
    return p;
}

juce::Rectangle<float> NamePrompt::panel() const
{
    return getLocalBounds().toFloat().withSizeKeepingCentre (360.0f, 150.0f);
}

juce::Rectangle<float> NamePrompt::okButton() const
{
    const auto p = panel();
    return { p.getRight() - 18.0f - 84.0f, p.getBottom() - 18.0f - 28.0f, 84.0f, 28.0f };
}

juce::Rectangle<float> NamePrompt::cancelButton() const
{
    return okButton().translated (-94.0f, 0.0f);
}

void NamePrompt::resized()
{
    const auto p = panel();
    editor.setBounds (juce::Rectangle<float> (p.getX() + 18.0f, p.getY() + 48.0f, p.getWidth() - 36.0f, 32.0f).toNearestInt());
}

void NamePrompt::visibilityChanged()
{
    if (isShowing() && ! confirmOnly)
    {
        editor.grabKeyboardFocus();
        editor.selectAll();
    }
}

void NamePrompt::paint (juce::Graphics& g)
{
    g.fillAll (colours::bg.withAlpha (0.6f));
    const auto p = panel();
    drawShadow (g, p, 5.0f, 18.0f, 40.0f, 0.65f);
    g.setColour (colours::menu);
    g.fillRoundedRectangle (p, 5.0f);
    g.setColour (colours::borderControl);
    g.drawRoundedRectangle (p.reduced (0.5f), 5.0f, 1.0f);
    drawText (g, title, { p.getX() + 18.0f, p.getY() + 18.0f, p.getWidth() - 36.0f, 14.0f }, mono (10.0f, 400, 0.14f), colours::label);

    auto drawButton = [&] (juce::Rectangle<float> r, const juce::String& t, bool primary)
    {
        if (primary)
        {
            g.setColour (colours::ink);
            g.fillRoundedRectangle (r, 3.0f);
        }
        else
        {
            g.setColour (colours::borderControl);
            g.drawRoundedRectangle (r.reduced (0.5f), 3.0f, 1.0f);
        }
        drawText (g, t, r, sans (10.5f, 600, 0.12f), primary ? colours::bg : colours::ink, juce::Justification::centred);
    };
    if (confirmOnly)
        drawText (g, message, { p.getX() + 18.0f, p.getY() + 48.0f, p.getWidth() - 36.0f, 32.0f }, sans (13.0f, 500), colours::ink);
    drawButton (cancelButton(), "CANCEL", false);
    drawButton (okButton(), okText, true);
}

void NamePrompt::mouseUp (const juce::MouseEvent& e)
{
    if (okButton().contains (e.position))
        confirm();
    else if (cancelButton().contains (e.position) || ! panel().contains (e.position))
        cancel();
}

void NamePrompt::confirm()
{
    const auto name = editor.getText().trim();
    if (name.isEmpty() && ! confirmOnly)
        return;
    auto ok = onOk;
    auto dismiss = onDismiss;
    if (dismiss)
        dismiss();
    if (ok)
        ok (name);
}

void NamePrompt::cancel()
{
    if (onDismiss)
        onDismiss();
}

} // namespace ref::ui

#include "Widgets.h"

#include "../measurement/TextUtil.h"

namespace ref::ui
{

namespace
{
constexpr float kPi = juce::MathConstants<float>::pi;

float degToRad (float d) { return d * kPi / 180.0f; }

// Rotated rectangle "tick" hanging from the top of a square box, as the
// design builds them (a rotated div with a child at `top`).
void drawTick (juce::Graphics& g, juce::Point<float> c, float boxRadius, float angleDeg, float top, float length, float width,
               juce::Colour colour, float cornerRadius = 0.0f)
{
    juce::Path p;
    p.addRoundedRectangle (c.x - width * 0.5f, c.y - boxRadius + top, width, length, cornerRadius);
    g.setColour (colour);
    g.fillPath (p, juce::AffineTransform::rotation (degToRad (angleDeg), c.x, c.y));
}

void drawArc (juce::Graphics& g, juce::Point<float> c, float r, float fromDeg, float toDeg, float width, juce::Colour colour, bool roundCaps)
{
    if (std::abs (toDeg - fromDeg) < 0.01f)
        return;
    juce::Path p;
    p.addCentredArc (c.x, c.y, r, r, 0.0f, degToRad (juce::jmin (fromDeg, toDeg)), degToRad (juce::jmax (fromDeg, toDeg)), true);
    g.setColour (colour);
    g.strokePath (p, juce::PathStrokeType (width, juce::PathStrokeType::curved, roundCaps ? juce::PathStrokeType::rounded : juce::PathStrokeType::butt));
}

void drawKnobBody (juce::Graphics& g, juce::Rectangle<float> body)
{
    // box-shadow: 0 8px 18px rgba(0,0,0,0.65)
    juce::Path circle;
    circle.addEllipse (body);
    juce::DropShadow (juce::Colours::black.withAlpha (0.65f), 18, { 0, 8 }).drawForPath (g, circle);

    // radial-gradient(circle at 50% 32%, #222 0%, #131313 72%), farthest-corner
    const float d = body.getWidth();
    const juce::Point<float> gc (body.getCentreX(), body.getY() + 0.32f * d);
    const float extent = 0.72f * std::sqrt (0.25f * d * d + 0.68f * 0.68f * d * d);
    juce::ColourGradient grad (juce::Colour (0xff222222), gc, juce::Colour (0xff131313), gc.translated (extent, 0.0f), true);
    g.setGradientFill (grad);
    g.fillEllipse (body);

    // inset 0 1px 0 rgba(255,255,255,0.06): a hairline lit from above.
    const auto inner = body.reduced (1.0f);
    juce::ColourGradient hl (juce::Colours::white.withAlpha (0.06f), inner.getCentreX(), inner.getY(),
                             juce::Colours::white.withAlpha (0.0f), inner.getCentreX(), inner.getY() + inner.getHeight() * 0.35f, false);
    g.setGradientFill (hl);
    g.drawEllipse (inner.translated (0.0f, 0.5f), 1.0f);

    g.setColour (colours::knobBorder);
    g.drawEllipse (body.reduced (0.5f), 1.0f);
}
} // namespace

//==============================================================================
Clickable::Clickable()
{
    setWantsKeyboardFocus (true);
    setMouseClickGrabsKeyboardFocus (false);
    setMouseCursor (juce::MouseCursor::PointingHandCursor);
}

void Clickable::mouseEnter (const juce::MouseEvent&)
{
    hovered = true;
    repaint();
}

void Clickable::mouseExit (const juce::MouseEvent&)
{
    hovered = false;
    repaint();
}

void Clickable::mouseDown (const juce::MouseEvent&)
{
    pressed = true;
    repaint();
}

void Clickable::mouseUp (const juce::MouseEvent& e)
{
    pressed = false;
    repaint();
    if (enabledLook && e.mouseWasClicked() && getLocalBounds().contains (e.getPosition()) && onClick)
        onClick();
}

bool Clickable::keyPressed (const juce::KeyPress& k)
{
    if ((k == juce::KeyPress::returnKey || k == juce::KeyPress::spaceKey) && onClick && enabledLook)
    {
        onClick();
        return true;
    }
    return false;
}

void Clickable::drawFocusRing (juce::Graphics& g, juce::Rectangle<float> r, float radius) const
{
    if (hasKeyboardFocus (false))
    {
        g.setColour (colours::ink);
        g.drawRoundedRectangle (r.expanded (2.5f), radius + 2.0f, 1.0f);
    }
}

//==============================================================================
SegmentedControl::SegmentedControl (juce::StringArray l, Style s) : labels (std::move (l)), style (std::move (s)) {}

void SegmentedControl::setSubLabels (juce::StringArray s)
{
    subLabels = std::move (s);
    repaint();
}

void SegmentedControl::setSelected (int i)
{
    if (selected != i)
    {
        selected = i;
        repaint();
    }
}

float SegmentedControl::preferredWidth() const
{
    float w = 0.0f;
    for (const auto& l : labels)
        w += textWidth (style.font, l) + 2.0f * style.padX;
    return std::ceil (w + 2.0f);
}

juce::Rectangle<float> SegmentedControl::segmentBounds (int i) const
{
    auto r = getLocalBounds().toFloat().reduced (1.0f);
    if (style.equalWidths || labels.size() == 0)
    {
        const float w = r.getWidth() / (float) labels.size();
        return { r.getX() + w * (float) i, r.getY(), w, r.getHeight() };
    }
    float total = 0.0f;
    juce::Array<float> widths;
    for (const auto& l : labels)
    {
        widths.add (textWidth (style.font, l) + 2.0f * style.padX);
        total += widths.getLast();
    }
    const float scale = r.getWidth() / total;
    float x = r.getX();
    for (int k = 0; k < i; ++k)
        x += widths[k] * scale;
    return { x, r.getY(), widths[i] * scale, r.getHeight() };
}

void SegmentedControl::paint (juce::Graphics& g)
{
    const auto outer = getLocalBounds().toFloat();
    juce::Path clip;
    clip.addRoundedRectangle (outer.reduced (0.5f), style.radius);

    for (int i = 0; i < labels.size(); ++i)
    {
        const auto seg = segmentBounds (i);
        const bool sel = i == selected;
        if (sel)
        {
            g.saveState();
            g.reduceClipRegion (clip);
            g.setColour (colours::ink);
            g.fillRect (seg.expanded (0.5f, 0.5f));
            g.restoreState();
        }
        const auto textColour = sel ? colours::bg : style.inactiveText;
        auto f = style.font;
        if (sel && style.boldWhenSelected)
            f = font (Family::mono, f.getHeightInPoints(), 600);
        if (subLabels.size() > i)
        {
            const float h1 = f.getHeight(), h2 = style.subFont.getHeight();
            const float top = seg.getCentreY() - (h1 + 2.0f + h2) * 0.5f;
            drawText (g, labels[i], { seg.getX(), top, seg.getWidth(), h1 }, f, textColour, juce::Justification::centred);
            drawText (g, subLabels[i], { seg.getX(), top + h1 + 2.0f, seg.getWidth(), h2 }, style.subFont, textColour, juce::Justification::centred);
        }
        else
        {
            drawText (g, labels[i], seg, f, textColour, juce::Justification::centred);
        }
    }

    g.setColour (borderFor (style.border));
    g.drawRoundedRectangle (outer.reduced (0.5f), style.radius, 1.0f);
    drawFocusRing (g, outer, style.radius);
}

void SegmentedControl::mouseUp (const juce::MouseEvent& e)
{
    Clickable::mouseUp (e);
    if (! e.mouseWasClicked() || ! isEnabledLook())
        return;
    for (int i = 0; i < labels.size(); ++i)
    {
        if (segmentBounds (i).contains (e.position))
        {
            if (onSelect)
                onSelect (i);
            return;
        }
    }
}

bool SegmentedControl::keyPressed (const juce::KeyPress& k)
{
    if (k == juce::KeyPress::leftKey || k == juce::KeyPress::rightKey)
    {
        const int n = labels.size();
        const int next = juce::jlimit (0, n - 1, selected + (k == juce::KeyPress::leftKey ? -1 : 1));
        if (next != selected && onSelect)
            onSelect (next);
        return true;
    }
    if (k == juce::KeyPress::spaceKey || k == juce::KeyPress::returnKey)
    {
        if (onSelect)
            onSelect ((selected + 1) % juce::jmax (1, labels.size()));
        return true;
    }
    return false;
}

//==============================================================================
Switch::Switch()
{
    onClick = [this]
    {
        if (onToggle)
            onToggle (! on);
    };
}

void Switch::setOn (bool o)
{
    if (on != o)
    {
        on = o;
        repaint();
    }
}

void Switch::paint (juce::Graphics& g)
{
    const auto r = getLocalBounds().toFloat().withSizeKeepingCentre (30.0f, 16.0f);
    if (on)
    {
        g.setColour (colours::ink);
        g.fillRoundedRectangle (r, 8.0f);
        g.setColour (colours::bg);
        g.fillEllipse (r.getRight() - 14.0f, r.getY() + 2.0f, 12.0f, 12.0f);
    }
    else
    {
        g.setColour (borderFor (colours::borderControl));
        g.drawRoundedRectangle (r.reduced (0.5f), 7.5f, 1.0f);
        g.setColour (colours::label);
        g.fillEllipse (r.getX() + 2.0f, r.getY() + 2.0f, 12.0f, 12.0f);
    }
    drawFocusRing (g, r, 8.0f);
}

//==============================================================================
TextButton::TextButton (juce::String t, Style s) : text (std::move (t)), style (std::move (s)) {}

void TextButton::setText (const juce::String& t)
{
    if (text != t)
    {
        text = t;
        repaint();
    }
}

void TextButton::setEngaged (bool e)
{
    if (engaged != e)
    {
        engaged = e;
        repaint();
    }
}

float TextButton::preferredWidth() const
{
    const auto& f = engaged ? style.engagedFont : style.font;
    return std::ceil (2.0f * style.padX + textWidth (f, text) + (style.powerIcon ? 12.0f + style.iconGap : 0.0f));
}

void TextButton::paint (juce::Graphics& g)
{
    const auto r = getLocalBounds().toFloat();
    const auto& f = engaged ? style.engagedFont : style.font;
    juce::Colour textColour = style.text;
    if (engaged)
    {
        g.setColour (colours::ink);
        g.fillRoundedRectangle (r, style.radius);
        textColour = colours::bg;
    }
    else
    {
        if (isPressed())
        {
            g.setColour (colours::pressed);
            g.fillRoundedRectangle (r, style.radius);
        }
        g.setColour (borderFor (style.border));
        g.drawRoundedRectangle (r.reduced (0.5f), style.radius, 1.0f);
    }

    const float tw = textWidth (f, text);
    const float iconW = style.powerIcon ? 12.0f + style.iconGap : 0.0f;
    float x = r.getCentreX() - (tw + iconW) * 0.5f;
    if (style.powerIcon)
    {
        drawPowerIcon (g, { x, r.getCentreY() - 6.0f, 12.0f, 12.0f }, textColour);
        x += iconW;
    }
    drawText (g, text, { x, r.getY(), tw + 4.0f, r.getHeight() }, f, textColour);
    drawFocusRing (g, r, style.radius);
}

//==============================================================================
DropdownField::DropdownField (Style s) : style (std::move (s)) {}

void DropdownField::setText (const juce::String& t)
{
    if (text != t)
    {
        text = t;
        repaint();
    }
}

float DropdownField::preferredWidth() const
{
    return std::ceil (2.0f * style.padX + textWidth (style.font, text) + style.gap + style.chevronSize + 2.0f);
}

void DropdownField::paint (juce::Graphics& g)
{
    const auto r = getLocalBounds().toFloat();
    if (! style.fill.isTransparent())
    {
        g.setColour (isPressed() ? colours::pressed : style.fill);
        g.fillRoundedRectangle (r, style.radius);
    }
    g.setColour (borderFor (style.border));
    g.drawRoundedRectangle (r.reduced (0.5f), style.radius, 1.0f);

    const float chevronW = style.chevronSize;
    auto inner = r.reduced (style.padX, 0.0f);
    float chevronX;
    if (style.chevronAtEnd)
    {
        chevronX = inner.getRight() - chevronW * 0.5f;
        inner.removeFromRight (chevronW + style.gap);
        drawText (g, text, inner, style.font, isEnabledLook() ? colours::ink : colours::muted);
    }
    else
    {
        const float tw = textWidth (style.font, text);
        const float total = tw + style.gap + chevronW;
        const float x = r.getCentreX() - total * 0.5f;
        drawText (g, text, { x, r.getY(), tw + 2.0f, r.getHeight() }, style.font, colours::ink);
        chevronX = x + tw + style.gap + chevronW * 0.5f;
    }
    drawChevron (g, { chevronX, r.getCentreY() }, chevronW, colours::ink4);
    drawFocusRing (g, r, style.radius);
}

//==============================================================================
ValueField::ValueField (Style s) : style (std::move (s))
{
    setWantsKeyboardFocus (true);
    setMouseCursor (juce::MouseCursor::IBeamCursor);
}

ValueField::~ValueField() = default;

void ValueField::setText (const juce::String& t)
{
    if (text != t)
    {
        text = t;
        repaint();
    }
}

float ValueField::preferredWidth() const
{
    return std::ceil (2.0f * style.padX + textWidth (style.font, text) + 2.0f);
}

void ValueField::paint (juce::Graphics& g)
{
    const auto r = getLocalBounds().toFloat();
    if (! style.fill.isTransparent())
    {
        g.setColour (style.fill);
        g.fillRoundedRectangle (r, style.radius);
    }
    g.setColour (isMouseOver (true) || isEditing() ? colours::hoverBorder : style.border);
    g.drawRoundedRectangle (r.reduced (0.5f), style.radius, 1.0f);
    if (! isEditing())
        drawText (g, text, r.reduced (style.padX, 0.0f), style.font, colours::ink,
                  style.centred ? juce::Justification::centred : juce::Justification::centredLeft);
    if (hasKeyboardFocus (false) && ! isEditing())
    {
        g.setColour (colours::ink);
        g.drawRoundedRectangle (r.expanded (2.5f), style.radius + 2.0f, 1.0f);
    }
}

void ValueField::resized()
{
    if (editor != nullptr)
        editor->setBounds (getLocalBounds().reduced (2, 1));
}

void ValueField::mouseUp (const juce::MouseEvent& e)
{
    if (e.mouseWasClicked())
        beginEditing();
}

bool ValueField::keyPressed (const juce::KeyPress& k)
{
    if (k == juce::KeyPress::returnKey || k == juce::KeyPress::spaceKey)
    {
        beginEditing();
        return true;
    }
    return false;
}

void ValueField::beginEditing()
{
    if (editor != nullptr)
        return;
    editor = std::make_unique<juce::TextEditor>();
    editor->setFont (style.font);
    editor->setJustification (style.centred ? juce::Justification::centred : juce::Justification::centredLeft);
    editor->setColour (juce::TextEditor::backgroundColourId, juce::Colours::transparentBlack);
    editor->setColour (juce::TextEditor::outlineColourId, juce::Colours::transparentBlack);
    editor->setColour (juce::TextEditor::focusedOutlineColourId, juce::Colours::transparentBlack);
    editor->setColour (juce::TextEditor::textColourId, colours::ink);
    editor->setColour (juce::TextEditor::highlightColourId, colours::ink.withAlpha (0.25f));
    editor->setColour (juce::CaretComponent::caretColourId, colours::ink);
    editor->setIndents (0, 0);
    editor->setBorder ({});
    editor->setText (editText ? editText() : text, false);
    editor->addListener (this);
    addAndMakeVisible (*editor);
    resized();
    editor->grabKeyboardFocus();
    editor->selectAll();
    repaint();
}

void ValueField::textEditorReturnKeyPressed (juce::TextEditor&) { finish (true); }
void ValueField::textEditorEscapeKeyPressed (juce::TextEditor&) { finish (false); }
void ValueField::textEditorFocusLost (juce::TextEditor&) { finish (true); }

void ValueField::finish (bool commit)
{
    if (editor == nullptr)
        return;
    const auto typed = editor->getText();
    editor->removeListener (this);
    // Defer destruction: we may be inside the editor's own callback.
    auto* dying = editor.release();
    juce::MessageManager::callAsync ([dying] { delete dying; });
    dying->setVisible (false);
    if (commit && onCommit)
        onCommit (typed);
    repaint();
}

//==============================================================================
Knob::Knob (Kind k, juce::RangedAudioParameter& p, double fineStep, double coarseStep)
    : kind (k), param (p), attachment (p, [this] (float v) {
          currentValue = v;
          repaint();
          if (onValueChange)
              onValueChange();
      }),
      fine (fineStep), coarse (coarseStep)
{
    setWantsKeyboardFocus (true);
    setMouseClickGrabsKeyboardFocus (false);
    setMouseCursor (juce::MouseCursor::UpDownResizeCursor);
    setPaintingIsUnclipped (true); // end labels sit a pixel or two outside the box
    attachment.sendInitialUpdate();
}

Knob::~Knob() = default;

void Knob::setCompact (bool) { repaint(); }

double Knob::norm (double v) const
{
    const auto& r = param.getNormalisableRange();
    return (v - r.start) / (r.end - r.start);
}

void Knob::setValue (double v)
{
    const auto& r = param.getNormalisableRange();
    v = juce::jlimit ((double) r.start, (double) r.end, v);
    if (dragging)
        attachment.setValueAsPartOfGesture ((float) v);
    else
        attachment.setValueAsCompleteGesture ((float) v);
}

void Knob::paint (juce::Graphics& g)
{
    const auto bounds = getLocalBounds().toFloat();
    const float size = juce::jmin (bounds.getWidth(), bounds.getHeight());
    // Wider bounds leave room for end labels that overhang the box.
    const auto box = juce::Rectangle<float> (size, size).withCentre ({ bounds.getCentreX(), bounds.getY() + size * 0.5f });
    const float s = size / (kind == Kind::calibration ? 156.0f : 84.0f); // compact layouts scale the drawing
    const juce::Point<float> c (box.getCentreX(), box.getY() + size * 0.5f);
    const float boxR = size * 0.5f;
    const double n = norm (currentValue);
    const float theta = (float) (-135.0 + 270.0 * n);

    if (kind == Kind::calibration)
    {
        for (int i = 0; i <= 10; ++i)
        {
            const float a = -135.0f + 27.0f * (float) i;
            const bool major = i == 0 || i == 5 || i == 10;
            drawTick (g, c, boxR, a, major ? 0.0f : 1.5f * s, (major ? 7.0f : 4.0f) * s, 1.5f, major ? colours::ink4 : colours::tickMinor);
        }
        const float r = 64.0f * s;
        drawArc (g, c, r, -135.0f, 135.0f, 3.0f, colours::divider, false);
        if (n > 0.0005)
            drawArc (g, c, r, -135.0f, theta, 3.0f, colours::ink, true);

        const float bodyD = 104.0f * s;
        drawKnobBody (g, juce::Rectangle<float> (bodyD, bodyD).withCentre (c));
        drawTick (g, c, bodyD * 0.5f, theta, 6.0f * s, 13.0f * s, 2.0f, colours::ink, 1.0f);

        // Centre value: "100" + "%" (the % sits 7px lower in a centred row).
        const float v = std::round (currentValue * 10.0f) / 10.0f;
        const auto valueText = juce::String (v, std::abs (v - std::round (v)) < 0.001f ? 0 : 1);
        const auto big = sans (28.0f * s, 500, -0.01f);
        const auto pct = sans (12.0f * s);
        const float wBig = textWidth (big, valueText), wPct = textWidth (pct, "%");
        const float x0 = c.x - (wBig + 2.0f + wPct) * 0.5f;
        drawText (g, valueText, { x0, c.y - big.getHeight() * 0.5f, wBig + 2.0f, big.getHeight() }, big, colours::ink);
        drawText (g, "%", { x0 + wBig + 2.0f, c.y - pct.getHeight() * 0.5f + 3.5f * s, wPct + 2.0f, pct.getHeight() }, pct, colours::muted);

        const auto lf = mono (9.0f);
        drawText (g, "0", { box.getX() + 14.0f * s, box.getY() + 138.0f * s, 20.0f, lf.getHeight() }, lf, colours::label);
        drawText (g, "100", { box.getRight() - 6.0f * s - 40.0f, box.getY() + 138.0f * s, 40.0f, lf.getHeight() }, lf, colours::label,
                  juce::Justification::centredRight);
    }
    else
    {
        const bool isOutput = kind == Kind::output;
        const float detent = isOutput ? 45.0f : 0.0f;
        const auto angles = isOutput ? std::vector<float> { -135, -90, -45, 0, 45, 90, 135 } : std::vector<float> { -135, -67.5f, 0, 67.5f, 135 };
        for (float a : angles)
        {
            if (std::abs (a - detent) < 0.01f)
                drawTick (g, c, boxR, a, 0.0f, 6.0f * s, 2.0f, colours::ink);
            else
                drawTick (g, c, boxR, a, 0.0f, 4.0f * s, 1.5f, colours::tickMinor);
        }
        const float r = 33.0f * s;
        drawArc (g, c, r, -135.0f, 135.0f, 2.5f, colours::divider, false);
        if (std::abs (theta - detent) > 0.3f)
            drawArc (g, c, r, detent, theta, 2.5f, colours::ink, true);

        const float bodyD = 54.0f * s;
        drawKnobBody (g, juce::Rectangle<float> (bodyD, bodyD).withCentre (c));
        drawTick (g, c, bodyD * 0.5f, theta, 4.0f * s, 11.0f * s, 2.0f, colours::ink, 1.0f);

        const auto lf = mono (8.5f);
        const float ly = box.getBottom() - 10.0f; // 74 px down an 84 px box; overhangs slightly
        const juce::String left = isOutput ? text::minus + "24" : juce::String ("L6");
        const juce::String right = isOutput ? juce::String ("+12") : juce::String ("R6");
        const float inset = isOutput ? -2.0f : 4.0f;
        drawText (g, left, { box.getX() + inset * s, ly, 30.0f, lf.getHeight() }, lf, colours::label);
        drawText (g, right, { box.getRight() - inset * s - 30.0f, ly, 30.0f, lf.getHeight() }, lf, colours::label, juce::Justification::centredRight);
    }

    if (hasKeyboardFocus (false))
    {
        g.setColour (colours::ink.withAlpha (0.6f));
        g.drawEllipse (juce::Rectangle<float> (size - 2.0f, size - 2.0f).withCentre (c), 1.0f);
    }
}

void Knob::mouseDown (const juce::MouseEvent& e)
{
    if (e.mods.isAltDown())
    {
        setValue (param.convertFrom0to1 (param.getDefaultValue()));
        return;
    }
    dragging = true;
    attachment.beginGesture();
    dragStartValue = currentValue;
    dragStartY = e.position.y;
    dragFine = e.mods.isShiftDown();
}

void Knob::mouseDrag (const juce::MouseEvent& e)
{
    if (! dragging)
        return;
    const auto& r = param.getNormalisableRange();
    const double span = r.end - r.start;
    const bool fineMode = e.mods.isShiftDown();
    if (fineMode != dragFine)
    {
        // Re-anchor when Shift changes mid-drag so the value does not jump.
        dragStartValue = currentValue;
        dragStartY = e.position.y;
        dragFine = fineMode;
    }
    // Full travel is about 250 px; Shift is ten times finer.
    const double delta = (dragStartY - e.position.y) / 250.0 * span * (fineMode ? 0.1 : 1.0);
    const double step = fineMode ? fine : coarse;
    double v = dragStartValue + delta;
    v = std::round (v / step) * step;
    setValue (v);
}

void Knob::mouseUp (const juce::MouseEvent&)
{
    if (dragging)
    {
        dragging = false;
        attachment.endGesture();
    }
}

void Knob::mouseDoubleClick (const juce::MouseEvent&)
{
    setValue (param.convertFrom0to1 (param.getDefaultValue()));
}

void Knob::mouseWheelMove (const juce::MouseEvent& e, const juce::MouseWheelDetails& w)
{
    const double dir = (w.deltaY != 0.0f ? w.deltaY : -w.deltaX) * (w.isReversed ? -1.0f : 1.0f);
    if (dir == 0.0)
        return;
    const double step = e.mods.isShiftDown() ? fine : coarse;
    setValue (std::round ((currentValue + (dir > 0 ? step : -step)) / step) * step);
}

bool Knob::keyPressed (const juce::KeyPress& k)
{
    const double step = k.getModifiers().isShiftDown() ? fine : coarse;
    if (k.isKeyCode (juce::KeyPress::upKey) || k.isKeyCode (juce::KeyPress::rightKey))
    {
        setValue (currentValue + step);
        return true;
    }
    if (k.isKeyCode (juce::KeyPress::downKey) || k.isKeyCode (juce::KeyPress::leftKey))
    {
        setValue (currentValue - step);
        return true;
    }
    if (k.isKeyCode (juce::KeyPress::homeKey) || k.isKeyCode (juce::KeyPress::deleteKey) || k.isKeyCode (juce::KeyPress::backspaceKey))
    {
        setValue (param.convertFrom0to1 (param.getDefaultValue()));
        return true;
    }
    return false;
}

} // namespace ref::ui

#include "GraphView.h"

#include "../measurement/TextUtil.h"
#include "ref/dsp/Biquad.h"
#include "ref/dsp/Format.h"
#include "ref/dsp/Grid.h"

#include <cmath>
#include <optional>

namespace ref::ui
{

namespace
{
constexpr double kLog20 = 1.3010299956639813; // log10(20)
constexpr int kMaxNodes = 8;

const juce::Font& axisFont() { static const auto f = mono (10.0f); return f; }

void strokeDashed (juce::Graphics& g, const juce::Path& p, float width, std::initializer_list<float> dashes, bool roundCaps)
{
    juce::PathStrokeType stroke (width, juce::PathStrokeType::curved, roundCaps ? juce::PathStrokeType::rounded : juce::PathStrokeType::butt);
    juce::Path dashed;
    std::vector<float> d (dashes);
    stroke.createDashedStroke (dashed, p, d.data(), (int) d.size());
    g.fillPath (dashed);
}

juce::String nodeTypeName (dsp::FilterType t)
{
    switch (t)
    {
        case dsp::FilterType::bell: return "Bell";
        case dsp::FilterType::lowShelf: return "Low shelf";
        case dsp::FilterType::highShelf: return "High shelf";
        case dsp::FilterType::lowPass: return "Low-pass";
        case dsp::FilterType::highPass: return "High-pass";
    }
    return "Bell";
}

bool hasGain (dsp::FilterType t)
{
    return t != dsp::FilterType::lowPass && t != dsp::FilterType::highPass;
}

// A typed number, or nothing if the text has no digits (an empty or
// mistyped field must not commit 0).
std::optional<double> parseNumber (const juce::String& s)
{
    const auto t = s.replace (text::minus, "-").retainCharacters ("-+.0123456789");
    if (! t.containsAnyOf ("0123456789"))
        return std::nullopt;
    const double v = t.getDoubleValue();
    return std::isfinite (v) ? std::optional<double> (v) : std::nullopt;
}

double parseFrequency (const juce::String& s)
{
    const auto t = s.toLowerCase();
    double v = parseNumber (t).value_or (0.0); // 0 is ignored by the caller
    if (t.contains ("k"))
        v *= 1000.0;
    return v;
}

juce::String nodeFreqText (double hz)
{
    if (hz >= 1000.0)
        return juce::String (hz / 1000.0, 2) + " kHz";
    return juce::String (hz, hz < 100.0 ? 1 : 0) + " Hz";
}
} // namespace

//==============================================================================
PlotView::PlotView (EditorHost& h) : host (h)
{
    setWantsKeyboardFocus (true);
    setMouseClickGrabsKeyboardFocus (true);
    host.model().addListener (this);
}

PlotView::~PlotView()
{
    host.model().removeListener (this);
}

juce::Rectangle<float> PlotView::plotRect() const
{
    // Inset 8 top, 46 right, 26 bottom; the view starts at the column's left
    // edge so the "20" label can centre on the frame (18 px column padding).
    return getLocalBounds().toFloat().withTrimmedLeft (18.0f).withTrimmedTop (8.0f).withTrimmedRight (46.0f).withTrimmedBottom (26.0f);
}

float PlotView::xForHz (double hz) const
{
    const auto p = plotRect();
    return p.getX() + (float) ((std::log10 (hz) - kLog20) / 3.0) * p.getWidth();
}

double PlotView::hzForX (float x) const
{
    const auto p = plotRect();
    return std::pow (10.0, kLog20 + 3.0 * (x - p.getX()) / p.getWidth());
}

float PlotView::yForDb (double db) const
{
    const auto p = plotRect();
    return p.getY() + (float) ((rangeDb - db) / (2.0 * rangeDb)) * p.getHeight();
}

double PlotView::dbForY (float y) const
{
    const auto p = plotRect();
    return rangeDb - (y - p.getY()) / p.getHeight() * 2.0 * rangeDb;
}

juce::Path PlotView::curvePath (const dsp::GridCurve& c) const
{
    juce::Path path;
    for (int i = 0; i < dsp::kGridSize; ++i)
    {
        const juce::Point<float> pt (xForHz (dsp::gridFrequency (i)), yForDb (c[(size_t) i]));
        if (i == 0)
            path.startNewSubPath (pt);
        else
            path.lineTo (pt);
    }
    return path;
}

void PlotView::drawGrid (juce::Graphics& g)
{
    const auto p = plotRect();
    for (double f : { 50.0, 100.0, 200.0, 500.0, 1000.0, 2000.0, 5000.0, 10000.0 })
    {
        g.setColour (colours::gridMajor);
        g.fillRect (std::round (xForHz (f)), p.getY(), 1.0f, p.getHeight());
    }
    for (int k = -3; k <= 3; ++k)
    {
        const double db = rangeDb * k / 4.0;
        g.setColour (k == 0 ? colours::gridZero : (std::abs (k) == 2 ? colours::gridMajor : colours::gridMinor));
        g.fillRect (p.getX(), std::round (yForDb (db)), p.getWidth(), 1.0f);
    }
    g.setColour (colours::frame);
    g.drawRect (p, 1.0f);

    const juce::StringArray freqLabels { "20", "50", "100", "200", "500", "1k", "2k", "5k", "10k", "20k" };
    const double freqs[] = { 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000 };
    for (int i = 0; i < freqLabels.size(); ++i)
    {
        const float x = xForHz (freqs[i]);
        drawText (g, freqLabels[i], { x - 30.0f, p.getBottom() + 8.0f, 60.0f, axisFont().getHeight() }, axisFont(), colours::label,
                  juce::Justification::centredTop);
    }

    auto dbLabel = [&] (double db) -> juce::String
    {
        if (std::abs (db) < 1e-9)
            return "0 dB";
        const auto mag = juce::String (std::abs (db), std::abs (db - std::round (db)) < 0.01 ? 0 : 1);
        return (db > 0 ? "+" : text::minus) + mag;
    };
    for (int k = -2; k <= 2; ++k)
    {
        const double db = rangeDb * k / 2.0;
        drawText (g, dbLabel (db), { p.getRight() + 10.0f, yForDb (db) - 8.0f, 40.0f, 16.0f }, axisFont(),
                  k == 0 ? colours::ink4 : colours::label);
    }
}

void PlotView::drawStandardCurves (juce::Graphics& g)
{
    const auto& gd = host.model().graph;
    if (! gd.hasCurves)
        return;

    if (! hidden[0])
    {
        juce::Path band;
        for (int i = 0; i < dsp::kGridSize; ++i)
        {
            const juce::Point<float> pt (xForHz (dsp::gridFrequency (i)), yForDb (gd.measured[(size_t) i] + gd.spread[(size_t) i]));
            if (i == 0)
                band.startNewSubPath (pt);
            else
                band.lineTo (pt);
        }
        for (int i = dsp::kGridSize - 1; i >= 0; --i)
            band.lineTo (xForHz (dsp::gridFrequency (i)), yForDb (gd.measured[(size_t) i] - gd.spread[(size_t) i]));
        band.closeSubPath();
        g.setColour (juce::Colours::white.withAlpha (0.075f));
        g.fillPath (band);

        g.setColour (colours::measured);
        g.strokePath (curvePath (gd.measured), juce::PathStrokeType (1.25f));
    }
    if (! hidden[1])
    {
        g.setColour (colours::target);
        strokeDashed (g, curvePath (gd.target), 1.25f, { 6.0f, 4.0f }, false);
    }
    if (! hidden[3])
    {
        g.setColour (colours::predicted);
        strokeDashed (g, curvePath (gd.predicted), 1.6f, { 1.0f, 3.5f }, true);
    }
    if (! hidden[2])
    {
        g.setColour (colours::correction);
        g.strokePath (curvePath (gd.calibration), juce::PathStrokeType (2.25f, juce::PathStrokeType::curved));
    }
}

juce::Point<float> PlotView::nodePosition (int i) const
{
    const auto& nodes = dragNode >= 0 ? editNodes : host.model().settings.overlay;
    const auto& n = nodes[(size_t) i];
    const double y = dsp::analogCascadeDb (nodes.data(), (int) nodes.size(), n.freqHz);
    return { xForHz (n.freqHz), yForDb (y) };
}

void PlotView::drawAdvanced (juce::Graphics& g)
{
    auto& m = host.model();
    const auto& gd = m.graph;
    const auto& nodes = dragNode >= 0 ? editNodes : m.settings.overlay;

    dsp::GridCurve overlay {};
    for (int i = 0; i < dsp::kGridSize; ++i)
        overlay[(size_t) i] = nodes.empty() ? 0.0 : dsp::analogCascadeDb (nodes.data(), (int) nodes.size(), dsp::gridFrequency (i));

    if (gd.hasCurves)
    {
        if (! hidden[0])
        {
            g.setColour (colours::muted);
            strokeDashed (g, curvePath (gd.target), 1.25f, { 6.0f, 4.0f }, false);
        }
        if (! hidden[1])
        {
            g.setColour (juce::Colour (0xff5e5e5e));
            g.strokePath (curvePath (gd.calibration), juce::PathStrokeType (2.25f, juce::PathStrokeType::curved));
        }
        if (! hidden[3])
        {
            dsp::GridCurve predicted {};
            for (size_t i = 0; i < predicted.size(); ++i)
                predicted[i] = gd.measured[i] + gd.calibration[i] + overlay[i];
            g.setColour (colours::predicted);
            strokeDashed (g, curvePath (predicted), 1.6f, { 1.0f, 3.5f }, true);
        }
    }
    if (! hidden[2])
    {
        g.setColour (colours::correction);
        g.strokePath (curvePath (overlay), juce::PathStrokeType (1.75f, juce::PathStrokeType::curved));
    }

    const auto p = plotRect();
    const int sel = m.selectedNode;
    if (sel >= 0 && sel < (int) nodes.size())
    {
        const float x = std::round (xForHz (nodes[(size_t) sel].freqHz)) + 0.5f;
        g.setColour (juce::Colour (0xff5a5a5a));
        const float dash[] = { 3.0f, 3.0f };
        g.drawDashedLine ({ x, p.getY(), x, p.getBottom() }, dash, 2, 1.0f);
    }
    for (int i = 0; i < (int) nodes.size(); ++i)
    {
        const auto c = nodePosition (i);
        const bool selected = i == sel;
        if (selected)
        {
            g.setColour (colours::ink);
            g.drawEllipse (juce::Rectangle<float> (21.0f, 21.0f).withCentre (c), 1.0f);
        }
        const auto dot = juce::Rectangle<float> (12.5f, 12.5f).withCentre (c);
        g.setColour (selected ? colours::ink : colours::bg);
        g.fillEllipse (dot);
        g.setColour (colours::ink);
        g.drawEllipse (dot, 1.5f);
        drawText (g, juce::String (i + 1).paddedLeft ('0', 2), { c.x - 14.0f, c.y - 30.0f, 28.0f, 13.0f }, mono (10.0f), colours::predicted,
                  juce::Justification::centred);
    }
}

void PlotView::drawLimited (juce::Graphics& g)
{
    const auto& gd = host.model().graph;
    const auto p = plotRect();
    for (const auto& range : gd.limitedRanges)
    {
        const float x0 = juce::jmax (p.getX(), xForHz (range.first));
        const float x1 = juce::jmin (p.getRight(), xForHz (range.second));
        if (x1 <= x0)
            continue;
        const juce::Rectangle<float> r (x0, p.getY(), x1 - x0, p.getHeight());

        g.saveState();
        g.reduceClipRegion (r.toNearestInt());
        g.setColour (juce::Colours::white.withAlpha (0.16f));
        const float step = 7.0f * 1.41421356f;
        for (float c = r.getX() + r.getY(); c < r.getRight() + r.getBottom(); c += step)
            g.drawLine (c - r.getBottom(), r.getBottom(), c - r.getY(), r.getY(), 1.0f);
        g.restoreState();

        if (x1 < p.getRight() - 1.0f)
        {
            g.setColour (colours::ink4);
            const float dash[] = { 3.0f, 3.0f };
            g.drawDashedLine ({ std::round (x1) - 0.5f, p.getY(), std::round (x1) - 0.5f, p.getBottom() }, dash, 2, 1.0f);
        }

        const auto tag = "LIMITED " + host.model().formatDb (gd.maxBoostDb, 0, true);
        const auto f = mono (10.0f, 700);
        const juce::Rectangle<float> tr (r.getX() + 8.0f, r.getY() + 8.0f, textWidth (f, tag) + 12.0f, f.getHeight() + 6.0f);
        g.setColour (colours::ink);
        g.fillRect (tr);
        drawText (g, tag, tr, f, colours::bg, juce::Justification::centred);
    }
}

void PlotView::drawHover (juce::Graphics& g)
{
    auto& m = host.model();
    if (hoverX < 0.0f || ! m.graph.hasCorrection || m.renderActive)
        return;
    const auto p = plotRect();
    const double hz = juce::jlimit (20.0, 20000.0, hzForX (hoverX));
    const bool advanced = m.settings.advancedView;
    double value;
    if (advanced)
    {
        const auto& nodes = m.settings.overlay;
        value = nodes.empty() ? 0.0 : dsp::analogCascadeDb (nodes.data(), (int) nodes.size(), hz);
    }
    else
    {
        value = dsp::sampleGridCurve (m.graph.calibration, hz);
    }

    const float x = xForHz (hz);
    g.setColour (colours::tickMinor);
    const float dash[] = { 3.0f, 3.0f };
    g.drawDashedLine ({ std::round (x) + 0.5f, p.getY(), std::round (x) + 0.5f, p.getBottom() }, dash, 2, 1.0f);

    const juce::Point<float> c (x, yForDb (value));
    const auto dot = juce::Rectangle<float> (7.5f, 7.5f).withCentre (c);
    g.setColour (colours::bg);
    g.fillEllipse (dot);
    g.setColour (juce::Colours::white);
    g.drawEllipse (dot, 1.5f);

    const auto label = text::fromStd (dsp::formatFrequency (hz)) + text::spacedDot + (advanced ? "Overlay " : "Correction ")
                     + text::fromStd (dsp::formatDb (value, 1));
    const auto f = mono (11.0f);
    const float w = textWidth (f, label) + 18.0f, h = f.getHeight() + 12.0f;
    float tx = c.x + 12.0f, ty = c.y + 10.0f;
    if (tx + w > (float) getWidth() - 2.0f)
        tx = c.x - 12.0f - w;
    if (ty + h > p.getBottom())
        ty = c.y - 10.0f - h;
    const juce::Rectangle<float> tip (tx, ty, w, h);
    g.setColour (colours::bg);
    g.fillRoundedRectangle (tip, 3.0f);
    g.setColour (colours::tickMinor);
    g.drawRoundedRectangle (tip.reduced (0.5f), 3.0f, 1.0f);
    drawText (g, label, tip, f, colours::ink, juce::Justification::centred);
}

void PlotView::drawRenderOverlay (juce::Graphics& g)
{
    g.setColour (colours::bg.withAlpha (0.82f));
    g.fillRect (getLocalBounds().withTrimmedLeft (18));

    const auto p = plotRect();
    const float blockW = juce::jmin (440.0f, p.getWidth() - 20.0f);
    const auto body = juce::String ("Your export is bit-exact to the dry mix. Processing resumes when the render finishes.");
    const auto bodyFont = sans (13.0f);
    const float bodyH = paragraphHeight (body, blockW, bodyFont, 13.0f * 1.5f);
    const auto titleFont = sans (12.0f, 600, 0.16f);
    const float total = 46.0f + 14.0f + titleFont.getHeight() + 14.0f + bodyH;
    float y = p.getCentreY() - total * 0.5f;

    const auto ring = juce::Rectangle<float> (44.5f, 44.5f).withCentre ({ p.getCentreX(), y + 23.0f });
    g.setColour (colours::ink);
    g.drawEllipse (ring, 1.5f);
    drawPowerIcon (g, juce::Rectangle<float> (18.0f, 18.0f).withCentre (ring.getCentre()), colours::ink, 1.1f);
    y += 46.0f + 14.0f;
    drawText (g, "CALIBRATION BYPASSED FOR OFFLINE RENDER", { p.getCentreX() - 300.0f, y, 600.0f, titleFont.getHeight() }, titleFont, colours::ink,
              juce::Justification::centred);
    y += titleFont.getHeight() + 14.0f;

    juce::AttributedString as;
    as.append (body, bodyFont, juce::Colour (0xffa8a8a8));
    as.setJustification (juce::Justification::centredTop);
    as.setWordWrap (juce::AttributedString::byWord);
    as.setLineSpacing (13.0f * 1.5f - bodyFont.getHeight());
    juce::TextLayout layout;
    layout.createLayout (as, blockW);
    layout.draw (g, { p.getCentreX() - blockW * 0.5f, y, blockW, bodyH + 4.0f });
}

void PlotView::paint (juce::Graphics& g)
{
    auto& m = host.model();
    rangeDb = m.settings.graphRangeDb;
    const auto p = plotRect();

    drawGrid (g);
    g.saveState();
    g.reduceClipRegion (p.expanded (1.0f, 0.0f).toNearestInt());
    if (m.settings.advancedView)
        drawAdvanced (g);
    else
    {
        drawLimited (g);
        drawStandardCurves (g);
    }
    g.restoreState();
    drawHover (g);

    if (! m.graph.hasCurves && ! m.renderActive)
        drawText (g, "No calibration curve to show.", p, sans (12.0f), colours::label, juce::Justification::centred);

    if (m.renderActive)
        drawRenderOverlay (g);
}

void PlotView::mouseMove (const juce::MouseEvent& e)
{
    const auto p = plotRect();
    const float x = p.contains (e.position) ? e.position.x : -1.0f;
    if (x != hoverX)
    {
        hoverX = x;
        repaint();
    }
    if (host.model().settings.advancedView)
        setMouseCursor (nodeAt (e.position) >= 0 ? juce::MouseCursor::DraggingHandCursor : juce::MouseCursor::CrosshairCursor);
    else
        setMouseCursor (juce::MouseCursor::NormalCursor);
}

void PlotView::mouseExit (const juce::MouseEvent&)
{
    hoverX = -1.0f;
    repaint();
}

int PlotView::nodeAt (juce::Point<float> pos) const
{
    const auto& nodes = host.model().settings.overlay;
    for (int i = (int) nodes.size() - 1; i >= 0; --i)
        if (nodePosition (i).getDistanceFrom (pos) <= 10.0f)
            return i;
    return -1;
}

void PlotView::mouseDown (const juce::MouseEvent& e)
{
    auto& m = host.model();
    if (! m.settings.advancedView)
        return;
    const int n = nodeAt (e.position);
    if (e.mods.isPopupMenu())
    {
        if (n >= 0)
        {
            auto nodes = m.settings.overlay;
            nodes.erase (nodes.begin() + n);
            m.selectedNode = -1;
            m.proc.setOverlay (nodes);
        }
        return;
    }
    m.selectedNode = n;
    if (n >= 0)
    {
        dragNode = n;
        editNodes = m.settings.overlay;
    }
    m.notify();
}

void PlotView::mouseDrag (const juce::MouseEvent& e)
{
    if (dragNode < 0)
        return;
    const auto p = plotRect();
    auto& node = editNodes[(size_t) dragNode];
    node.freqHz = juce::jlimit (20.0, 20000.0, hzForX (juce::jlimit (p.getX(), p.getRight(), e.position.x)));
    if (hasGain (node.type))
        node.gainDb = juce::jlimit (-12.0, 12.0, std::round (dbForY (e.position.y) * 10.0) / 10.0);
    hoverX = -1.0f;
    pushOverlay (false);
    repaint();
}

void PlotView::mouseUp (const juce::MouseEvent&)
{
    if (dragNode >= 0)
    {
        pushOverlay (true);
        dragNode = -1;
    }
}

void PlotView::pushOverlay (bool force)
{
    // Rebuilds happen off the audio thread; about 30 per second is plenty.
    const auto now = juce::Time::getMillisecondCounter();
    if (force || now - lastPush > 33)
    {
        lastPush = now;
        host.model().proc.setOverlay (editNodes);
    }
}

void PlotView::mouseDoubleClick (const juce::MouseEvent& e)
{
    auto& m = host.model();
    if (! m.settings.advancedView || ! plotRect().contains (e.position) || nodeAt (e.position) >= 0)
        return;
    auto nodes = m.settings.overlay;
    if ((int) nodes.size() >= kMaxNodes)
        return;
    dsp::FilterSpec n;
    n.type = dsp::FilterType::bell;
    n.freqHz = juce::jlimit (20.0, 20000.0, hzForX (e.position.x));
    const double existing = nodes.empty() ? 0.0 : dsp::analogCascadeDb (nodes.data(), (int) nodes.size(), n.freqHz);
    n.gainDb = juce::jlimit (-12.0, 12.0, std::round ((dbForY (e.position.y) - existing) * 10.0) / 10.0);
    n.q = 1.0;
    nodes.push_back (n);
    m.selectedNode = (int) nodes.size() - 1;
    m.proc.setOverlay (nodes);
}

void PlotView::mouseWheelMove (const juce::MouseEvent& e, const juce::MouseWheelDetails& w)
{
    auto& m = host.model();
    const int n = m.settings.advancedView ? nodeAt (e.position) : -1;
    if (n < 0 || w.deltaY == 0.0f)
        return;
    auto nodes = m.settings.overlay;
    nodes[(size_t) n].q = juce::jlimit (0.1, 10.0, nodes[(size_t) n].q * (w.deltaY > 0 ? 1.1 : 1.0 / 1.1));
    m.selectedNode = n;
    m.proc.setOverlay (nodes);
}

bool PlotView::keyPressed (const juce::KeyPress& k)
{
    auto& m = host.model();
    if (m.settings.advancedView && m.selectedNode >= 0 && m.selectedNode < (int) m.settings.overlay.size()
        && (k == juce::KeyPress::deleteKey || k == juce::KeyPress::backspaceKey))
    {
        auto nodes = m.settings.overlay;
        nodes.erase (nodes.begin() + m.selectedNode);
        m.selectedNode = -1;
        m.proc.setOverlay (nodes);
        return true;
    }
    return false;
}

//==============================================================================
StatusLine::StatusLine (EditorHost& h) : host (h)
{
    host.model().addListener (this);
}

StatusLine::~StatusLine()
{
    host.model().removeListener (this);
}

void StatusLine::paint (juce::Graphics& g)
{
    auto& m = host.model();
    const auto r = getLocalBounds().toFloat();
    g.setColour (colours::line);
    g.fillRect (0.0f, 0.0f, r.getWidth(), 1.0f);

    const auto messages = m.statusMessages();
    const int count = (int) messages.size();
    const auto& msg = messages[(size_t) (m.statusIndex % count)];
    auto area = r.withTrimmedTop (1.0f);

    if (count > 1)
    {
        const auto counter = juce::String (m.statusIndex % count + 1) + "/" + juce::String (count);
        const auto cf = mono (10.0f);
        const float cw = textWidth (cf, counter) + 2.0f;
        drawText (g, counter, area.removeFromRight (cw), cf, colours::label, juce::Justification::centredRight);
        area.removeFromRight (12.0f);
    }

    const float cy = area.getCentreY();
    switch (msg.kind)
    {
        case StatusMessage::Kind::alert:
        {
            const auto tf = sans (12.0f, 600);
            const auto df = mono (12.0f, 500);
            const float textW = textWidth (tf, msg.text);
            const float detailW = msg.detail.isNotEmpty() ? textWidth (df, msg.detail) + 10.0f : 0.0f;
            const float w = juce::jmin (area.getWidth(), 26.0f + 10.0f + textW + detailW + 12.0f);
            const juce::Rectangle<float> pill (area.getX(), cy - 13.0f, w, 26.0f);
            g.setColour (colours::ink);
            g.fillRoundedRectangle (pill, 3.0f);
            juce::Path cell;
            cell.addRoundedRectangle (pill.getX(), pill.getY(), 26.0f, 26.0f, 3.0f, 3.0f, true, false, true, false);
            g.setColour (colours::bg);
            g.fillPath (cell);
            g.setColour (colours::ink);
            g.strokePath (cell, juce::PathStrokeType (1.0f));
            drawText (g, "!", { pill.getX(), pill.getY(), 26.0f, 26.0f }, mono (12.0f, 700), colours::ink, juce::Justification::centred);
            auto textArea = pill.withTrimmedLeft (36.0f).withTrimmedRight (12.0f);
            if (detailW > 0.0f)
                drawText (g, msg.detail, textArea.removeFromRight (detailW - 10.0f), df, colours::bg, juce::Justification::centredLeft);
            drawText (g, msg.text, textArea, tf, colours::bg);
            break;
        }
        case StatusMessage::Kind::render:
            g.setColour (colours::ink);
            g.fillRect (area.getX(), cy - 3.0f, 6.0f, 6.0f);
            drawText (g, msg.text, area.withTrimmedLeft (16.0f), sans (12.0f), colours::ink4);
            break;
        case StatusMessage::Kind::idle:
        case StatusMessage::Kind::info:
            g.setColour (colours::muted);
            g.drawEllipse (area.getX() + 0.5f, cy - 2.5f, 5.0f, 5.0f, 1.0f);
            drawText (g, msg.text + (msg.detail.isNotEmpty() ? "  " + msg.detail : juce::String()), area.withTrimmedLeft (16.0f), sans (12.0f),
                      colours::muted);
            break;
    }
}

void StatusLine::mouseUp (const juce::MouseEvent&)
{
    auto& m = host.model();
    m.statusIndex = (m.statusIndex + 1) % juce::jmax (1, (int) m.statusMessages().size());
    repaint();
}

//==============================================================================
namespace
{
DropdownField::Style typeStyle()
{
    DropdownField::Style s;
    s.font = sans (12.0f);
    s.fill = juce::Colours::transparentBlack;
    s.radius = 3.0f;
    s.padX = 10.0f;
    s.gap = 10.0f;
    s.chevronSize = 4.0f;
    s.chevronAtEnd = false;
    return s;
}

ValueField::Style stripFieldStyle()
{
    ValueField::Style s;
    s.font = mono (12.0f);
    s.fill = juce::Colours::transparentBlack;
    s.padX = 10.0f;
    s.radius = 3.0f;
    return s;
}

TextButton::Style resetStyle()
{
    TextButton::Style s;
    s.font = sans (10.5f, 600, 0.12f);
    s.border = colours::ink;
    s.radius = 3.0f;
    s.padX = 12.0f;
    return s;
}
} // namespace

NodeStrip::NodeStrip (EditorHost& h)
    : host (h), type (typeStyle()), freq (stripFieldStyle()), gain (stripFieldStyle()), q (stripFieldStyle()), reset ("RESET TO CALIBRATION", resetStyle())
{
    for (auto* c : std::initializer_list<juce::Component*> { &type, &freq, &gain, &q, &reset })
        addAndMakeVisible (c);

    type.onClick = [this]
    {
        auto& m = host.model();
        if (m.selectedNode < 0)
            return;
        std::vector<MenuItem> items;
        for (auto t : { dsp::FilterType::bell, dsp::FilterType::lowShelf, dsp::FilterType::highShelf, dsp::FilterType::lowPass, dsp::FilterType::highPass })
        {
            MenuItem it;
            it.text = nodeTypeName (t);
            it.selected = m.settings.overlay[(size_t) m.selectedNode].type == t;
            it.action = [this, t] { edit ([t] (dsp::FilterSpec& n) {
                n.type = t;
                if (! hasGain (t))
                    n.q = 0.7071;
            }); };
            items.push_back (it);
        }
        MenuStyle style;
        style.width = 180.0f;
        style.rowPadY = 8.0f;
        host.showMenu (std::move (items), style, type, 6.0f);
    };
    freq.onCommit = [this] (const juce::String& s)
    {
        const double v = parseFrequency (s);
        if (v > 0.0)
            edit ([v] (dsp::FilterSpec& n) { n.freqHz = juce::jlimit (20.0, 20000.0, v); });
    };
    gain.onCommit = [this] (const juce::String& s)
    {
        if (const auto typed = parseNumber (s))
        {
            const double v = *typed;
            edit ([v] (dsp::FilterSpec& n) { if (hasGain (n.type)) n.gainDb = juce::jlimit (-12.0, 12.0, v); });
        }
    };
    q.onCommit = [this] (const juce::String& s)
    {
        const double v = parseNumber (s).value_or (0.0);
        if (v > 0.0)
            edit ([v] (dsp::FilterSpec& n) { n.q = juce::jlimit (0.1, 10.0, v); });
    };
    reset.onClick = [this]
    {
        auto& m = host.model();
        m.selectedNode = -1;
        m.proc.setOverlay ({});
    };
    host.model().addListener (this);
    modelChanged();
}

NodeStrip::~NodeStrip()
{
    host.model().removeListener (this);
}

void NodeStrip::edit (std::function<void (dsp::FilterSpec&)> fn)
{
    auto& m = host.model();
    if (m.selectedNode < 0 || m.selectedNode >= (int) m.settings.overlay.size())
        return;
    auto nodes = m.settings.overlay;
    fn (nodes[(size_t) m.selectedNode]);
    m.proc.setOverlay (nodes);
}

void NodeStrip::modelChanged()
{
    auto& m = host.model();
    const bool has = m.selectedNode >= 0 && m.selectedNode < (int) m.settings.overlay.size();
    for (auto* c : std::initializer_list<juce::Component*> { &type, &freq, &gain, &q })
        c->setVisible (has);
    if (has)
    {
        const auto& n = m.settings.overlay[(size_t) m.selectedNode];
        type.setText (nodeTypeName (n.type));
        freq.setText (nodeFreqText (n.freqHz));
        gain.setText (hasGain (n.type) ? text::fromStd (dsp::formatDb (n.gainDb, 1)) : text::emDash);
        q.setText (juce::String (n.q, 2));
    }
    resized();
    repaint();
}

void NodeStrip::resized()
{
    const auto r = getLocalBounds().toFloat().withTrimmedTop (1.0f);
    const float cy = r.getCentreY();
    const float rw = reset.preferredWidth();
    reset.setBounds (juce::Rectangle<float> (r.getRight() - rw, cy - 14.0f, rw, 28.0f).toNearestInt());

    auto& m = host.model();
    if (m.selectedNode < 0)
        return;
    const auto tagFont = mono (11.0f, 700);
    const auto tagText = "NODE " + juce::String (m.selectedNode + 1).paddedLeft ('0', 2);
    tagBounds = { r.getX(), cy - (tagFont.getHeight() + 10.0f) * 0.5f, textWidth (tagFont, tagText) + 16.0f, tagFont.getHeight() + 10.0f };
    float x = tagBounds.getRight() + 16.0f;
    const auto lf = mono (9.5f, 400, 0.12f);

    auto place = [&] (juce::Rectangle<float>& label, const juce::String& text, juce::Component& c, float w)
    {
        const float lw = textWidth (lf, text) + 9.5f * 0.12f;
        label = { x, r.getY(), lw + 1.0f, r.getHeight() };
        x += lw + 8.0f;
        c.setBounds (juce::Rectangle<float> (x, cy - 13.0f, w, 26.0f).toNearestInt());
        x += w + 16.0f;
    };
    place (typeLabel, "TYPE", type, juce::jmax (70.0f, type.preferredWidth()));
    place (freqLabel, "FREQ", freq, juce::jmax (72.0f, freq.preferredWidth()));
    place (gainLabel, "GAIN", gain, juce::jmax (64.0f, gain.preferredWidth()));
    place (qLabel, "Q", q, juce::jmax (48.0f, q.preferredWidth()));
}

void NodeStrip::paint (juce::Graphics& g)
{
    auto& m = host.model();
    const auto r = getLocalBounds().toFloat();
    g.setColour (colours::line);
    g.fillRect (0.0f, 0.0f, r.getWidth(), 1.0f);

    if (m.selectedNode < 0 || m.selectedNode >= (int) m.settings.overlay.size())
    {
        const auto hint = m.settings.overlay.empty() ? juce::String ("Double-click the graph to add a filter node. The overlay never edits the calibration.")
                                                     : juce::String ("Select a node to edit it. Double-click to add, Delete to remove.");
        drawText (g, hint, r.withTrimmedTop (1.0f).withRight ((float) reset.getX() - 16.0f), sans (12.0f), colours::muted);
        return;
    }
    const auto tagFont = mono (11.0f, 700);
    g.setColour (colours::ink);
    g.fillRoundedRectangle (tagBounds, 3.0f);
    drawText (g, "NODE " + juce::String (m.selectedNode + 1).paddedLeft ('0', 2), tagBounds, tagFont, colours::bg, juce::Justification::centred);
    const auto lf = mono (9.5f, 400, 0.12f);
    drawText (g, "TYPE", typeLabel, lf, colours::label);
    drawText (g, "FREQ", freqLabel, lf, colours::label);
    drawText (g, "GAIN", gainLabel, lf, colours::label);
    drawText (g, "Q", qLabel, lf, colours::label);
}

//==============================================================================
namespace
{
DropdownField::Style rangeStyle()
{
    DropdownField::Style s;
    s.font = mono (10.5f);
    s.fill = juce::Colours::transparentBlack;
    s.radius = 3.0f;
    s.padX = 8.0f;
    s.gap = 8.0f;
    s.chevronSize = 4.0f;
    s.chevronAtEnd = false;
    return s;
}

TextButton::Style advancedStyle()
{
    TextButton::Style s;
    s.font = sans (10.0f, 600, 0.14f);
    s.engagedFont = sans (10.0f, 700, 0.14f);
    s.radius = 3.0f;
    s.padX = 10.0f;
    return s;
}

const char* const kLegendStandard[] = { "Measured \xc2\xb1 spread", "Target", "Correction", "Predicted result" };
const char* const kLegendAdvanced[] = { "Target", "Calibration (locked)", "User overlay", "Predicted result" };
const char* const kLegendStandardShort[] = { "Measured", "Target", "Correction", "Predicted" };
const char* const kLegendAdvancedShort[] = { "Target", "Calibration", "Overlay", "Predicted" };

void drawLegendSample (juce::Graphics& g, juce::Rectangle<float> r, int index, bool advanced)
{
    const float y = r.getCentreY();
    juce::Path line;
    line.startNewSubPath (r.getX(), y);
    line.lineTo (r.getRight(), y);
    if (! advanced && index == 0)
    {
        g.setColour (juce::Colours::white.withAlpha (0.1f));
        g.fillRect (r.getX(), y - 4.0f, r.getWidth(), 8.0f);
        g.setColour (colours::measured);
        g.strokePath (line, juce::PathStrokeType (1.25f));
    }
    else if ((! advanced && index == 1) || (advanced && index == 0))
    {
        g.setColour (colours::target);
        strokeDashed (g, line, 1.25f, { 6.0f, 4.0f }, false);
    }
    else if (! advanced && index == 2)
    {
        g.setColour (juce::Colours::white);
        g.strokePath (line, juce::PathStrokeType (2.25f));
    }
    else if (advanced && index == 1)
    {
        g.setColour (juce::Colour (0xff6e6e6e));
        g.strokePath (line, juce::PathStrokeType (2.25f));
    }
    else if (advanced && index == 2)
    {
        g.setColour (juce::Colours::white);
        g.strokePath (line, juce::PathStrokeType (1.5f));
        const auto dot = juce::Rectangle<float> (6.0f, 6.0f).withCentre ({ r.getCentreX(), y });
        g.setColour (colours::bg);
        g.fillEllipse (dot);
        g.setColour (juce::Colours::white);
        g.drawEllipse (dot, 1.2f);
    }
    else
    {
        juce::Path dotted;
        dotted.startNewSubPath (r.getX() + 1.0f, y);
        dotted.lineTo (r.getRight(), y);
        g.setColour (colours::predicted);
        strokeDashed (g, dotted, 1.6f, { 1.0f, 3.5f }, true);
    }
}
} // namespace

GraphColumn::GraphColumn (EditorHost& h)
    : host (h), plot (h), status (h), nodeStrip (h), range (rangeStyle()), advanced ("ADVANCED", advancedStyle())
{
    addAndMakeVisible (plot);
    addAndMakeVisible (status);
    addChildComponent (nodeStrip);
    addAndMakeVisible (range);
    addAndMakeVisible (advanced);
    range.setTitle ("Graph range");
    advanced.setTitle ("Advanced");
    range.onClick = [this] { openRangeMenu(); };
    advanced.onClick = [this]
    {
        auto& m = host.model();
        m.selectedNode = -1;
        m.proc.setAdvancedView (! m.settings.advancedView);
    };
    host.model().addListener (this);
    modelChanged();
}

GraphColumn::~GraphColumn()
{
    host.model().removeListener (this);
}

void GraphColumn::modelChanged()
{
    auto& m = host.model();
    range.setText (text::plusMinus + juce::String (m.settings.graphRangeDb) + " dB");
    advanced.setEngaged (m.settings.advancedView);
    advanced.setText (m.settings.advancedView ? "ADVANCED" + text::spacedDot + "ON" : juce::String ("ADVANCED"));
    if (nodeStrip.isVisible() != m.settings.advancedView)
    {
        nodeStrip.setVisible (m.settings.advancedView);
        status.setVisible (! m.settings.advancedView);
        resized();
    }
    resized();
    repaint();
}

void GraphColumn::resized()
{
    const float W = (float) getWidth(), H = (float) getHeight();
    const float left = 18.0f, right = W - 18.0f;
    const float toolbarY = 12.0f, toolbarH = 30.0f;
    const float cy = toolbarY + toolbarH * 0.5f;

    float r = right;
    const float aw = advanced.preferredWidth();
    advanced.setBounds (juce::Rectangle<float> (r - aw, cy - 12.0f, aw, 24.0f).toNearestInt());
    r -= aw + 10.0f;
    const float rw = range.preferredWidth();
    range.setBounds (juce::Rectangle<float> (r - rw, cy - 12.0f, rw, 24.0f).toNearestInt());
    r -= rw + 10.0f;

    auto& m = host.model();
    const auto rigText = m.snap != nullptr && m.snap->rigId.isNotEmpty() ? m.snap->rigId.toUpperCase() + text::spacedDot + m.snap->earSimulator : juce::String();
    const auto rf = mono (10.0f, 400, 0.08f);
    const float rigW = textWidth (rf, rigText) + 1.0f;

    // Legend from the left: full labels, then short ones, then none, as the
    // column narrows (the minimum size was not drawn in the handoff).
    const auto lf = sans (11.0f);
    float x = left;
    for (int variant = 0; variant < 3; ++variant)
    {
        legendBounds.clear();
        legendLabels.clear();
        x = left;
        if (variant == 2)
            break;
        const auto* labels = m.settings.advancedView ? (variant == 0 ? kLegendAdvanced : kLegendAdvancedShort)
                                                     : (variant == 0 ? kLegendStandard : kLegendStandardShort);
        const float gap = variant == 0 ? 16.0f : 12.0f;
        for (int i = 0; i < 4; ++i)
        {
            const auto label = juce::String::fromUTF8 (labels[i]);
            const float w = 24.0f + 8.0f + textWidth (lf, label);
            legendBounds.push_back ({ x, toolbarY, w, toolbarH });
            legendLabels.add (label);
            x += w + gap;
        }
        if (x - gap + 16.0f <= r)
            break;
    }
    showRig = rigText.isNotEmpty() && ! legendBounds.empty() && x + rigW <= r;
    rigBounds = showRig ? juce::Rectangle<float> (r - rigW, toolbarY, rigW, toolbarH) : juce::Rectangle<float>();

    const float bottomH = m.settings.advancedView ? 46.0f : 40.0f;
    const float plotTop = toolbarY + toolbarH;
    plot.setBounds (juce::Rectangle<float> (0.0f, plotTop, W, H - plotTop - bottomH).toNearestInt());
    status.setBounds (juce::Rectangle<float> (left, H - 40.0f, right - left, 40.0f).toNearestInt());
    nodeStrip.setBounds (juce::Rectangle<float> (left, H - 46.0f, right - left, 46.0f).toNearestInt());
}

void GraphColumn::paint (juce::Graphics& g)
{
    auto& m = host.model();
    const auto lf = sans (11.0f);
    for (int i = 0; i < (int) legendBounds.size(); ++i)
    {
        const auto& b = legendBounds[(size_t) i];
        const auto& label = legendLabels[i];
        const bool off = plot.hidden[(size_t) i];
        g.saveState();
        if (off)
            g.setOpacity (0.35f);
        drawLegendSample (g, { b.getX(), b.getCentreY() - 5.0f, 24.0f, 10.0f }, i, m.settings.advancedView);
        g.restoreState();
        drawText (g, label, b.withTrimmedLeft (32.0f), lf, off ? colours::tickMinor : colours::ink3);
    }
    if (showRig && m.snap != nullptr)
        drawText (g, m.snap->rigId.toUpperCase() + text::spacedDot + m.snap->earSimulator, rigBounds, mono (10.0f, 400, 0.08f), colours::label);
}

void GraphColumn::mouseUp (const juce::MouseEvent& e)
{
    // Clicking a legend item toggles that curve (proposed in the handoff).
    for (int i = 0; i < (int) legendBounds.size(); ++i)
    {
        if (legendBounds[(size_t) i].contains (e.position))
        {
            plot.hidden[(size_t) i] = ! plot.hidden[(size_t) i];
            plot.repaint();
            repaint();
            return;
        }
    }
}

void GraphColumn::openRangeMenu()
{
    auto& m = host.model();
    std::vector<MenuItem> items;
    for (int db : { 6, 12, 18, 24 })
    {
        MenuItem it;
        it.text = text::plusMinus + juce::String (db) + " dB";
        it.selected = m.settings.graphRangeDb == db;
        it.action = [&m, db] { m.proc.setGraphRange (db); };
        items.push_back (it);
    }
    MenuStyle style;
    style.width = 120.0f;
    style.rowPadY = 7.0f;
    style.monoItems = true;
    host.showMenu (std::move (items), style, range, 6.0f);
}

} // namespace ref::ui

#pragma once

#include "EditorHost.h"
#include "Widgets.h"

namespace ref::ui
{

// The frequency-response plot: Measured ± spread, Target, Correction and
// Predicted result (or the Advanced overlay view), hover readout, limited
// regions and the offline-render overlay.
class PlotView : public juce::Component, private EditorModel::Listener
{
public:
    explicit PlotView (EditorHost&);
    ~PlotView() override;

    juce::Rectangle<float> plotRect() const;
    std::array<bool, 4> hidden {}; // legend toggles

    // Shows the hover readout at a frequency (used by the snapshot tool).
    void showHoverAt (double hz) { hoverX = hz > 0.0 ? xForHz (hz) : -1.0f; repaint(); }

    void paint (juce::Graphics&) override;
    void mouseMove (const juce::MouseEvent&) override;
    void mouseExit (const juce::MouseEvent&) override;
    void mouseDown (const juce::MouseEvent&) override;
    void mouseDrag (const juce::MouseEvent&) override;
    void mouseUp (const juce::MouseEvent&) override;
    void mouseDoubleClick (const juce::MouseEvent&) override;
    void mouseWheelMove (const juce::MouseEvent&, const juce::MouseWheelDetails&) override;
    bool keyPressed (const juce::KeyPress&) override;

    float xForHz (double hz) const;
    double hzForX (float x) const;
    float yForDb (double db) const;
    double dbForY (float y) const;

private:
    void modelChanged() override { repaint(); }
    juce::Path curvePath (const dsp::GridCurve&) const;
    void drawGrid (juce::Graphics&);
    void drawStandardCurves (juce::Graphics&);
    void drawAdvanced (juce::Graphics&);
    void drawHover (juce::Graphics&);
    void drawLimited (juce::Graphics&);
    void drawRenderOverlay (juce::Graphics&);
    int nodeAt (juce::Point<float>) const;
    juce::Point<float> nodePosition (int) const;
    void pushOverlay (bool force);

    EditorHost& host;
    double rangeDb = 12.0;
    float hoverX = -1.0f;
    int dragNode = -1;
    std::vector<dsp::FilterSpec> editNodes;
    juce::uint32 lastPush = 0;
};

class StatusLine : public juce::Component, private EditorModel::Listener
{
public:
    explicit StatusLine (EditorHost&);
    ~StatusLine() override;
    void paint (juce::Graphics&) override;
    void mouseUp (const juce::MouseEvent&) override;

private:
    void modelChanged() override { repaint(); }
    EditorHost& host;
};

// Advanced (V2): the selected node's type, frequency, gain and Q.
class NodeStrip : public juce::Component, private EditorModel::Listener
{
public:
    explicit NodeStrip (EditorHost&);
    ~NodeStrip() override;
    void paint (juce::Graphics&) override;
    void resized() override;

private:
    void modelChanged() override;
    void edit (std::function<void (dsp::FilterSpec&)>);

    EditorHost& host;
    DropdownField type;
    ValueField freq, gain, q;
    TextButton reset;
    juce::Rectangle<float> tagBounds, typeLabel, freqLabel, gainLabel, qLabel;
};

class GraphColumn : public juce::Component, private EditorModel::Listener
{
public:
    explicit GraphColumn (EditorHost&);
    ~GraphColumn() override;
    void paint (juce::Graphics&) override;
    void resized() override;
    void mouseUp (const juce::MouseEvent&) override;

private:
    void modelChanged() override;
    void openRangeMenu();

    EditorHost& host;
    PlotView plot;
    StatusLine status;
    NodeStrip nodeStrip;
    DropdownField range;
    TextButton advanced;
    std::vector<juce::Rectangle<float>> legendBounds;
    juce::StringArray legendLabels;
    juce::Rectangle<float> rigBounds;
    bool showRig = true;
};

} // namespace ref::ui

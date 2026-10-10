#pragma once

#include "../plugin/PluginProcessor.h"

#include <juce_gui_basics/juce_gui_basics.h>

namespace ref::ui
{

enum class Page
{
    calibration,
    settings,
    help
};

// Curves the graph draws, all on the generator's log grid.
struct GraphData
{
    bool hasCurves = false;     // measured and target exist
    bool hasCorrection = false; // a correction was generated
    dsp::GridCurve measured {}, spread {}, target {};
    dsp::GridCurve calibration {}; // the correction as realised at the current Amount and mode
    dsp::GridCurve overlay {};     // user overlay alone (Advanced)
    dsp::GridCurve predicted {};   // measured + calibration (+ overlay)
    std::vector<std::pair<double, double>> limitedRanges;
    double maxBoostDb = 6.0;
};

struct StatusMessage
{
    enum class Kind
    {
        idle,
        info,
        alert,
        render
    };
    Kind kind = Kind::idle;
    juce::String text, detail;
};

// Everything the editor shows, gathered from the processor on the message
// thread. Recomputes curves and gains when settings, the snapshot or the
// parameters change; runs meter ballistics and the protection hold.
class EditorModel : private juce::ChangeListener, private juce::Timer
{
public:
    explicit EditorModel (ReferenceProcessor&);
    ~EditorModel() override;

    ReferenceProcessor& proc;

    Settings settings;
    std::shared_ptr<const CalibrationSnapshot> snap;
    GraphData graph;
    double matchDb = 0.0, headroomDb = 0.0;

    // Meters: short-term level and held peak per channel, dBFS.
    float levelDb[2] { -120.0f, -120.0f }, holdDb[2] { -120.0f, -120.0f };
    bool protectionHold = false;
    bool renderActive = false;

    Page page = Page::calibration;
    int selectedNode = -1;
    int statusIndex = 0;

    float amount() const;     // percent
    float outputDb() const;
    float balanceDb() const;
    bool calibrated() const;
    bool bypassed() const;

    juce::RangedAudioParameter& param (const char* id) const;
    void setParam (const char* id, float value);

    std::vector<StatusMessage> statusMessages() const;
    // A short-lived message in the status line, e.g. a failed preset save.
    void showNotice (const juce::String&);
    juce::String latencyText (dsp::FilterMode) const;
    juce::String formatDb (double, int decimals = 1, bool plusSign = false) const;

    struct Listener
    {
        virtual ~Listener() = default;
        virtual void modelChanged() {}
        virtual void metersChanged() {}
    };
    void addListener (Listener* l) { listeners.add (l); }
    void removeListener (Listener* l) { listeners.remove (l); }

    // Pull settings and snapshot from the processor and recompute.
    void refresh();
    void notify() { listeners.call ([] (Listener& l) { l.modelChanged(); }); }

private:
    void changeListenerCallback (juce::ChangeBroadcaster*) override;
    void timerCallback() override;
    void recompute();

    juce::ListenerList<Listener> listeners;
    float lastAmount = -1.0f, lastOutput = 1e9f, lastBalance = 1e9f;
    bool lastCalibrated = true, lastBypassed = false, lastRender = false, lastHold = false;
    juce::uint32 lastProtectionEvents = 0, protectionUntil = 0, holdUntil[2] {};
    juce::uint32 lastTick = 0;
    juce::uint32 lastLatencyChange = 0;
    juce::String systemError; // standalone device or routing problem, if any
    juce::String systemHint;  // standalone running but nothing arriving
    juce::uint32 quietSince = 0;
    juce::String notice;
    juce::uint32 noticeUntil = 0;
};

} // namespace ref::ui

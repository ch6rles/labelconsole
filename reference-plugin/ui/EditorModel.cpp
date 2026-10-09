#include "EditorModel.h"

#include "../measurement/TextUtil.h"
#include "../plugin/Parameters.h"
#include "../plugin/SystemAudio.h"
#include "ref/dsp/Biquad.h"
#include "ref/dsp/FirDesign.h"
#include "ref/dsp/Format.h"
#include "ref/dsp/Grid.h"
#include "ref/dsp/Loudness.h"

namespace ref::ui
{

EditorModel::EditorModel (ReferenceProcessor& p) : proc (p)
{
    proc.addChangeListener (this);
    lastProtectionEvents = proc.getEngine().protectionEvents();
    refresh();
    startTimerHz (30);
}

EditorModel::~EditorModel()
{
    proc.removeChangeListener (this);
}

juce::RangedAudioParameter& EditorModel::param (const char* id) const
{
    return *proc.getParameters().getParameter (id);
}

void EditorModel::setParam (const char* id, float value)
{
    auto& p = param (id);
    p.beginChangeGesture();
    p.setValueNotifyingHost (p.convertTo0to1 (value));
    p.endChangeGesture();
}

float EditorModel::amount() const { return proc.getParameters().getRawParameterValue (params::calAmount)->load(); }
float EditorModel::outputDb() const { return proc.getParameters().getRawParameterValue (params::outputGain)->load(); }
float EditorModel::balanceDb() const { return proc.getParameters().getRawParameterValue (params::balance)->load(); }
bool EditorModel::calibrated() const { return proc.getParameters().getRawParameterValue (params::abSelect)->load() > 0.5f; }
bool EditorModel::bypassed() const { return proc.getParameters().getRawParameterValue (params::bypass)->load() > 0.5f; }

juce::String EditorModel::formatDb (double v, int decimals, bool plusSign) const
{
    return text::fromStd (dsp::formatDb (v, decimals, plusSign));
}

juce::String EditorModel::latencyText (dsp::FilterMode mode) const
{
    const double ms = 1000.0 * proc.latencyFor (mode) / proc.getCurrentSampleRate();
    return juce::String (ms, mode == dsp::FilterMode::linearPhase ? 1 : 0) + " ms";
}

void EditorModel::refresh()
{
    settings = proc.getSettings();
    snap = proc.getSnapshot();
    recompute();
    notify();
}

void EditorModel::changeListenerCallback (juce::ChangeBroadcaster*)
{
    refresh();
}

void EditorModel::recompute()
{
    GraphData g;
    const double a = juce::jlimit (0.0, 1.0, amount() / 100.0);

    for (int i = 0; i < dsp::kGridSize; ++i)
        g.overlay[(size_t) i] = settings.overlay.empty()
                                  ? 0.0
                                  : dsp::analogCascadeDb (settings.overlay.data(), (int) settings.overlay.size(), dsp::gridFrequency (i));

    if (snap != nullptr && snap->result.generated)
    {
        const auto& r = snap->result;
        g.hasCurves = g.hasCorrection = true;
        g.measured = r.measured;
        g.spread = r.spread;
        g.target = r.target;
        g.limitedRanges = r.boostLimitedRanges;
        g.maxBoostDb = snap->limits.maxBoostDb;

        // The correction as each mode realises it: Minimum Phase scales each
        // filter's gain, Linear Phase scales the curve.
        auto scaled = r.filters;
        for (auto& f : scaled)
            f.gainDb *= a;
        for (int i = 0; i < dsp::kGridSize; ++i)
        {
            const double hz = dsp::gridFrequency (i);
            g.calibration[(size_t) i] = settings.filterMode == dsp::FilterMode::linearPhase
                                          ? a * r.correction[(size_t) i]
                                          : dsp::analogCascadeDb (scaled.data(), (int) scaled.size(), hz);
            g.predicted[(size_t) i] = g.measured[(size_t) i] + g.calibration[(size_t) i] + g.overlay[(size_t) i];
        }
    }

    dsp::GridCurve total {};
    for (size_t i = 0; i < total.size(); ++i)
        total[i] = g.calibration[i] + g.overlay[i];
    if (settings.autoGain)
    {
        matchDb = dsp::loudnessMatchGainDb (total);
        headroomDb = dsp::headroomDb (total, matchDb);
    }
    else
    {
        matchDb = headroomDb = 0.0;
    }
    graph = std::move (g);
}

void EditorModel::showNotice (const juce::String& message)
{
    notice = message;
    noticeUntil = juce::Time::getMillisecondCounter() + 6000;
    statusIndex = 0;
    notify();
}

std::vector<StatusMessage> EditorModel::statusMessages() const
{
    std::vector<StatusMessage> out;
    if (notice.isNotEmpty())
        out.push_back ({ StatusMessage::Kind::alert, notice, {} });
    // Standalone: a stopped device or a feedback mute matters more than any
    // calibration note.
    if (systemError.isNotEmpty())
        out.push_back ({ StatusMessage::Kind::alert, systemError, {} });
    if (renderActive)
    {
        out.push_back ({ StatusMessage::Kind::render, "Offline render detected. Auto-bypass is on; change it in Settings.", {} });
        return out;
    }
    if (snap != nullptr)
        for (const auto& w : snap->result.warnings)
            out.push_back ({ StatusMessage::Kind::alert, text::fromStd (w.message),
                             w.code == dsp::WarningCode::boostLimited || w.code == dsp::WarningCode::cutLimited
                                 || w.code == dsp::WarningCode::fitOutOfTolerance || w.code == dsp::WarningCode::largeTreble
                                 ? text::fromStd (w.detail)
                                 : juce::String() });
    for (const auto& e : proc.getLibrary().getLoadErrors())
        out.push_back ({ StatusMessage::Kind::alert, e, {} });

    const auto changed = proc.latencyChangedAtMs();
    if (changed != 0 && juce::Time::getMillisecondCounter() - changed < 8000)
        out.push_back ({ StatusMessage::Kind::info, "Latency changed; some hosts apply this when playback stops", {} });
    if (snap != nullptr && snap->fromEmbedded)
        out.push_back ({ StatusMessage::Kind::info, "Using the curve saved with this session", {} });
    if (! settings.overlay.empty() && ! settings.advancedView)
        out.push_back ({ StatusMessage::Kind::info,
                         "User overlay active: " + juce::String ((int) settings.overlay.size()) + " node"
                             + (settings.overlay.size() == 1 ? "" : "s") + " on top of the calibration.",
                         {} });
    if (snap != nullptr && snap->placeholder)
        out.push_back ({ StatusMessage::Kind::info, "Placeholder profile: an illustrative curve, not a measurement.", {} });

    if (out.empty())
        out.push_back ({ StatusMessage::Kind::idle, "No warnings. Correction within limits.", {} });
    return out;
}

void EditorModel::timerCallback()
{
    const auto now = juce::Time::getMillisecondCounter();
    const float dt = lastTick == 0 ? 1.0f / 30.0f : juce::jlimit (0.001f, 0.5f, (float) (now - lastTick) / 1000.0f);
    lastTick = now;

    // Meters: instant attack, 300 ms release; peak held 1.5 s.
    auto& engine = proc.getEngine();
    bool metersMoved = false;
    for (int c = 0; c < 2; ++c)
    {
        const float peak = engine.takePeak (c);
        const float db = peak > 1e-6f ? juce::Decibels::gainToDecibels (peak) : -120.0f;
        const float released = levelDb[c] - dt * 8.686f / 0.3f;
        const float newLevel = juce::jmax (db, released, -120.0f);
        if (db >= holdDb[c] || now > holdUntil[c])
        {
            if (db >= holdDb[c])
                holdUntil[c] = now + 1500;
            holdDb[c] = db >= holdDb[c] ? db : juce::jmax (db, holdDb[c] - dt * 20.0f);
        }
        if (std::abs (newLevel - levelDb[c]) > 0.01f)
            metersMoved = true;
        levelDb[c] = newLevel;
    }

    // Monitor Protection hold indicator: 2 s after the last engagement.
    const auto events = engine.protectionEvents();
    if (events != lastProtectionEvents)
    {
        lastProtectionEvents = events;
        protectionUntil = now + 2000;
    }
    protectionHold = now < protectionUntil;
    renderActive = proc.isRenderBypassActive();
    if (notice.isNotEmpty() && now > noticeUntil)
    {
        notice.clear();
        notify();
    }
    const auto previousSystemError = systemError;
    if (auto* sys = SystemAudioController::instance())
        systemError = sys->getStatus().error;

    if (metersMoved)
        listeners.call ([] (Listener& l) { l.metersChanged(); });

    // Parameters may move from automation on the audio thread; poll them.
    const float a = amount(), o = outputDb(), b = balanceDb();
    const bool cal = calibrated(), byp = bypassed();
    bool changed = protectionHold != lastHold || renderActive != lastRender || cal != lastCalibrated || byp != lastBypassed
                || o != lastOutput || b != lastBalance || systemError != previousSystemError;
    if (a != lastAmount)
    {
        recompute();
        changed = true;
    }
    const auto latencyStamp = proc.latencyChangedAtMs();
    if (latencyStamp != lastLatencyChange || (latencyStamp != 0 && now - latencyStamp > 8000 && now - latencyStamp < 8100))
    {
        lastLatencyChange = latencyStamp;
        changed = true;
    }
    lastAmount = a;
    lastOutput = o;
    lastBalance = b;
    lastCalibrated = cal;
    lastBypassed = byp;
    lastRender = renderActive;
    lastHold = protectionHold;
    if (changed)
        notify();
}

} // namespace ref::ui

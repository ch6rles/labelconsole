#include "SessionState.h"

#include "../measurement/TextUtil.h"

#include <cmath>
#include <cstdio>

namespace ref::state
{

namespace
{
const juce::Identifier kSettings ("SETTINGS"), kOverlay ("OVERLAY"), kNode ("NODE"), kEmbedded ("EMBEDDED"),
    kFilters ("FILTERS"), kFilter ("FILTER"), kWarnings ("WARNINGS"), kWarning ("WARNING"), kRange ("RANGE");

juce::String modeToString (dsp::FilterMode m) { return m == dsp::FilterMode::linearPhase ? "linear" : "min"; }

// Round-trips a double exactly through text: 17 significant digits, in
// the C locale whatever the host has set (snprintf would write a decimal
// comma in some locales).
juce::String exact (double v)
{
    return juce::String (v, 16, true);
}

juce::ValueTree filterToTree (const juce::Identifier& type, const dsp::FilterSpec& f)
{
    juce::ValueTree t (type);
    t.setProperty ("type", juce::String (dsp::toString (f.type)), nullptr);
    t.setProperty ("freq", exact (f.freqHz), nullptr);
    t.setProperty ("gain", exact (f.gainDb), nullptr);
    t.setProperty ("q", exact (f.q), nullptr);
    return t;
}

bool filterFromTree (const juce::ValueTree& t, dsp::FilterSpec& f)
{
    if (! dsp::filterTypeFromString (t.getProperty ("type").toString().toStdString(), f.type))
        return false;
    f.freqHz = t.getProperty ("freq", "1000").toString().getDoubleValue();
    f.gainDb = t.getProperty ("gain", "0").toString().getDoubleValue();
    f.q = t.getProperty ("q", "0.7071").toString().getDoubleValue();
    // A damaged session must not put NaN into the filters (jlimit passes it through).
    if (! std::isfinite (f.freqHz) || ! std::isfinite (f.gainDb) || ! std::isfinite (f.q))
        return false;
    f.freqHz = juce::jlimit (10.0, 40000.0, f.freqHz);
    f.gainDb = juce::jlimit (-30.0, 30.0, f.gainDb);
    f.q = juce::jlimit (0.05, 20.0, f.q);
    return true;
}
} // namespace

juce::ValueTree settingsToTree (const Settings& s)
{
    juce::ValueTree t (kSettings);
    t.setProperty ("profileId", s.profileId, nullptr);
    t.setProperty ("targetId", s.targetKey, nullptr);
    t.setProperty ("filterMode", modeToString (s.filterMode), nullptr);
    t.setProperty ("autoGain", s.autoGain, nullptr);
    t.setProperty ("monitorProtection", s.monitorProtection, nullptr);
    t.setProperty ("autoBypassOffline", s.autoBypassOffline, nullptr);
    t.setProperty ("uiScale", s.uiScale, nullptr);
    t.setProperty ("graphRange", s.graphRangeDb, nullptr);
    t.setProperty ("advancedView", s.advancedView, nullptr);
    t.setProperty ("presetName", s.presetName, nullptr);
    t.appendChild (overlayToTree (s.overlay), nullptr);
    return t;
}

void settingsFromTree (const juce::ValueTree& t, Settings& s)
{
    if (! t.isValid())
        return;
    s.profileId = t.getProperty ("profileId", s.profileId).toString();
    s.targetKey = t.getProperty ("targetId", s.targetKey).toString();
    s.filterMode = t.getProperty ("filterMode").toString() == "linear" ? dsp::FilterMode::linearPhase : dsp::FilterMode::minimumPhase;
    s.autoGain = (bool) t.getProperty ("autoGain", s.autoGain);
    s.monitorProtection = (bool) t.getProperty ("monitorProtection", s.monitorProtection);
    s.autoBypassOffline = (bool) t.getProperty ("autoBypassOffline", s.autoBypassOffline);
    const float scale = (float) t.getProperty ("uiScale", s.uiScale);
    s.uiScale = std::isfinite (scale) ? juce::jlimit (0.75f, 2.0f, scale) : 1.0f;
    s.graphRangeDb = juce::jlimit (3, 24, (int) t.getProperty ("graphRange", s.graphRangeDb));
    s.advancedView = (bool) t.getProperty ("advancedView", s.advancedView);
    s.presetName = t.getProperty ("presetName", s.presetName).toString();
    s.overlay = overlayFromTree (t.getChildWithName (kOverlay));
}

juce::ValueTree overlayToTree (const std::vector<dsp::FilterSpec>& nodes)
{
    juce::ValueTree t (kOverlay);
    for (const auto& n : nodes)
        t.appendChild (filterToTree (kNode, n), nullptr);
    return t;
}

std::vector<dsp::FilterSpec> overlayFromTree (const juce::ValueTree& t)
{
    std::vector<dsp::FilterSpec> out;
    for (const auto& c : t)
    {
        dsp::FilterSpec f;
        if (out.size() < 8 && c.hasType (kNode) && filterFromTree (c, f))
            out.push_back (f);
    }
    return out;
}

juce::String encodeCurve (const dsp::GridCurve& c)
{
    // Exact: the session must reproduce the correction bit for bit.
    juce::MemoryOutputStream out;
    for (double v : c)
        out.writeDouble (v); // little-endian
    return out.getMemoryBlock().toBase64Encoding();
}

bool decodeCurve (const juce::String& s, dsp::GridCurve& c)
{
    juce::MemoryBlock block;
    if (! block.fromBase64Encoding (s) || block.getSize() != sizeof (double) * (size_t) dsp::kGridSize)
        return false;
    juce::MemoryInputStream in (block, false);
    for (auto& v : c)
    {
        v = in.readDouble();
        if (! std::isfinite (v))
            return false;
    }
    return true;
}

juce::ValueTree snapshotToTree (const CalibrationSnapshot& s)
{
    juce::ValueTree t (kEmbedded);
    t.setProperty ("profileId", s.profileId, nullptr);
    t.setProperty ("profileSha", s.profileSha, nullptr);
    t.setProperty ("profileName", s.profileName, nullptr);
    t.setProperty ("manufacturer", s.manufacturer, nullptr);
    t.setProperty ("modelRevision", s.modelRevision, nullptr);
    t.setProperty ("rigId", s.rigId, nullptr);
    t.setProperty ("earSimulator", s.earSimulator, nullptr);
    t.setProperty ("measurementSummary", s.measurementSummary, nullptr);
    t.setProperty ("generatorVersion", s.generatorVersion, nullptr);
    t.setProperty ("targetId", s.targetKey, nullptr);
    t.setProperty ("targetName", s.targetName, nullptr);
    t.setProperty ("placeholder", s.placeholder, nullptr);
    t.setProperty ("generated", s.result.generated, nullptr);
    t.setProperty ("maxBoost", exact (s.limits.maxBoostDb), nullptr);
    t.setProperty ("maxCut", exact (s.limits.maxCutDb), nullptr);
    t.setProperty ("largestBoost", s.result.largestBoostDb, nullptr);
    t.setProperty ("fitRms", s.result.fitRmsDb, nullptr);
    t.setProperty ("fitMax", s.result.fitMaxDb, nullptr);
    t.setProperty ("measured", encodeCurve (s.result.measured), nullptr);
    t.setProperty ("spread", encodeCurve (s.result.spread), nullptr);
    t.setProperty ("target", encodeCurve (s.result.target), nullptr);
    t.setProperty ("correction", encodeCurve (s.result.correction), nullptr);

    juce::ValueTree filters (kFilters);
    for (const auto& f : s.result.filters)
        filters.appendChild (filterToTree (kFilter, f), nullptr);
    t.appendChild (filters, nullptr);

    juce::ValueTree warnings (kWarnings);
    for (const auto& w : s.result.warnings)
    {
        juce::ValueTree wt (kWarning);
        wt.setProperty ("code", (int) w.code, nullptr);
        wt.setProperty ("message", text::fromStd (w.message), nullptr);
        wt.setProperty ("detail", text::fromStd (w.detail), nullptr);
        for (const auto& r : w.ranges)
        {
            juce::ValueTree rt (kRange);
            rt.setProperty ("lo", r.first, nullptr);
            rt.setProperty ("hi", r.second, nullptr);
            wt.appendChild (rt, nullptr);
        }
        warnings.appendChild (wt, nullptr);
    }
    t.appendChild (warnings, nullptr);
    return t;
}

std::shared_ptr<CalibrationSnapshot> snapshotFromTree (const juce::ValueTree& t)
{
    if (! t.isValid() || ! t.hasType (kEmbedded))
        return nullptr;

    auto s = std::make_shared<CalibrationSnapshot>();
    s->profileId = t.getProperty ("profileId").toString();
    s->profileSha = t.getProperty ("profileSha").toString();
    s->profileName = t.getProperty ("profileName").toString();
    s->manufacturer = t.getProperty ("manufacturer").toString();
    s->modelRevision = t.getProperty ("modelRevision").toString();
    s->rigId = t.getProperty ("rigId").toString();
    s->earSimulator = t.getProperty ("earSimulator").toString();
    s->measurementSummary = t.getProperty ("measurementSummary").toString();
    s->generatorVersion = t.getProperty ("generatorVersion").toString();
    s->targetKey = t.getProperty ("targetId").toString();
    s->targetName = t.getProperty ("targetName").toString();
    s->placeholder = (bool) t.getProperty ("placeholder", false);
    s->result.generated = (bool) t.getProperty ("generated", false);
    s->limits.maxBoostDb = t.getProperty ("maxBoost", "6").toString().getDoubleValue();
    s->limits.maxCutDb = t.getProperty ("maxCut", "-12").toString().getDoubleValue();
    s->result.largestBoostDb = (double) t.getProperty ("largestBoost", 0.0);
    s->result.fitRmsDb = (double) t.getProperty ("fitRms", 0.0);
    s->result.fitMaxDb = (double) t.getProperty ("fitMax", 0.0);

    if (! decodeCurve (t.getProperty ("measured").toString(), s->result.measured)
        || ! decodeCurve (t.getProperty ("spread").toString(), s->result.spread)
        || ! decodeCurve (t.getProperty ("target").toString(), s->result.target)
        || ! decodeCurve (t.getProperty ("correction").toString(), s->result.correction))
        return nullptr;

    for (const auto& f : t.getChildWithName (kFilters))
    {
        dsp::FilterSpec spec;
        if (filterFromTree (f, spec))
            s->result.filters.push_back (spec);
    }
    for (const auto& w : t.getChildWithName (kWarnings))
    {
        dsp::GeneratorWarning gw;
        gw.code = (dsp::WarningCode) (int) w.getProperty ("code", 0);
        gw.message = w.getProperty ("message").toString().toStdString();
        gw.detail = w.getProperty ("detail").toString().toStdString();
        for (const auto& r : w)
            gw.ranges.emplace_back ((double) r.getProperty ("lo"), (double) r.getProperty ("hi"));
        s->result.warnings.push_back (gw);
    }
    for (const auto& w : s->result.warnings)
        if (w.code == dsp::WarningCode::boostLimited)
            s->result.boostLimitedRanges = w.ranges;
    return s;
}

} // namespace ref::state

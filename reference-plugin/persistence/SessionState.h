#pragma once

#include <juce_data_structures/juce_data_structures.h>

#include "ref/dsp/CorrectionGenerator.h"
#include "ref/dsp/Types.h"

#include <memory>
#include <vector>

namespace ref
{

// Session settings that are not host parameters (spec Section 9): saved with
// the session, never automated.
struct Settings
{
    juce::String profileId { "audeze_mm520" };
    juce::String targetKey { "studio_reference@1" };
    dsp::FilterMode filterMode = dsp::FilterMode::minimumPhase;
    bool autoGain = true;
    bool monitorProtection = true;
    bool autoBypassOffline = true;
    std::vector<dsp::FilterSpec> overlay; // Advanced user nodes (V2)

    // Display
    float uiScale = 1.0f;
    int graphRangeDb = 12;
    bool advancedView = false;

    // Preset the session last loaded ("" if none).
    juce::String presetName = juce::String::fromUTF8 ("MM-520 \xc2\xb7 Studio Reference");

    bool operator== (const Settings&) const = default;
};

// The generated calibration plus everything the UI shows about where it
// came from. Embedded in the session so it reopens identically even on a
// machine without the profile.
struct CalibrationSnapshot
{
    dsp::CorrectionResult result;
    dsp::GeneratorLimits limits;

    juce::String profileId, profileSha, profileName, manufacturer, modelRevision;
    juce::String rigId, earSimulator, measurementSummary, generatorVersion;
    juce::String targetKey, targetName;
    bool placeholder = false;

    // Restored from the session because the profile is missing or changed.
    bool fromEmbedded = false;
};

namespace state
{
inline constexpr int kStateVersion = 1;

juce::ValueTree settingsToTree (const Settings&);
void settingsFromTree (const juce::ValueTree&, Settings&);

juce::ValueTree overlayToTree (const std::vector<dsp::FilterSpec>&);
std::vector<dsp::FilterSpec> overlayFromTree (const juce::ValueTree&);

juce::ValueTree snapshotToTree (const CalibrationSnapshot&);
std::shared_ptr<CalibrationSnapshot> snapshotFromTree (const juce::ValueTree&);

juce::String encodeCurve (const dsp::GridCurve&);
bool decodeCurve (const juce::String&, dsp::GridCurve&);
} // namespace state

} // namespace ref

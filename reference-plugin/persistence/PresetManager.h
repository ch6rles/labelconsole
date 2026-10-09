#pragma once

#include <juce_core/juce_core.h>

#include "ref/dsp/Types.h"

#include <vector>

namespace ref
{

// A preset stores headphone, target and all controls (spec Section 9).
struct PresetData
{
    juce::String name;
    juce::String profileId, targetKey;
    float calAmount = 100.0f;  // percent
    float outputGain = 0.0f;   // dB
    float balance = 0.0f;      // dB
    dsp::FilterMode filterMode = dsp::FilterMode::minimumPhase;
    bool autoGain = true;
    bool monitorProtection = true;
    std::vector<dsp::FilterSpec> overlay;

    bool factory = false;
    juce::File file; // user presets only
};

// Factory presets plus the user's presets folder: save, rename, delete,
// import and export as files.
class PresetManager
{
public:
    PresetManager();

    void refreshUserPresets();

    const std::vector<PresetData>& getFactory() const noexcept { return factory; }
    const std::vector<PresetData>& getUser() const noexcept { return user; }

    // Factory first, then user, in menu order.
    std::vector<const PresetData*> all() const;
    const PresetData* find (const juce::String& name) const;
    bool isUserPreset (const juce::String& name) const;

    bool saveUser (const PresetData&, juce::String& error);
    bool renameUser (const juce::String& oldName, const juce::String& newName, juce::String& error);
    bool deleteUser (const juce::String& name, juce::String& error);
    bool importFile (const juce::File&, juce::String& importedName, juce::String& error);
    bool exportPreset (const PresetData&, const juce::File& destination, juce::String& error) const;

    static juce::File presetsDirectory();
    // A file for a new preset called `name` that no other preset uses:
    // different names can map to one file name (illegal characters, case-
    // insensitive file systems). `keep` is the preset's current file, if any.
    static juce::File fileFor (const juce::String& name, const juce::File& keep = {});
    static constexpr const char* kExtension = ".refpreset";

    static juce::String toJson (const PresetData&);
    static bool fromJson (const juce::String&, PresetData&, juce::String& error);

private:
    std::vector<PresetData> factory, user;
};

} // namespace ref

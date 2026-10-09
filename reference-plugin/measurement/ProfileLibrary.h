#pragma once

#include <juce_core/juce_core.h>

#include "ref/dsp/CorrectionGenerator.h"

#include <vector>

namespace ref
{

// A versioned target curve tagged with its rig (spec Section 4, Targets).
struct TargetInfo
{
    juce::String id;          // "studio_reference"
    int version = 1;
    juce::String displayName; // "Studio Reference"
    juce::String description;
    juce::String rigId;
    juce::String source;
    dsp::RawCurve curve;
    bool userProvided = false;

    juce::String key() const { return id + "@" + juce::String (version); }
};

// A headphone profile with provenance (spec Section 9, profile schema).
struct ProfileInfo
{
    juce::String id;            // "audeze_mm520"
    juce::String displayName;   // "Audeze MM-520"
    juce::String manufacturer;  // "Audeze"
    juce::String modelRevision; // "MM-520"
    juce::String rigId, earSimulator, source, license, date;
    int units = 0, reseatsPerUnit = 0;
    int schemaVersion = 2;
    juce::String generatorVersion;
    juce::StringArray targetKeys; // "studio_reference@1"
    dsp::GeneratorLimits limits;
    dsp::RawCurve curve;
    juce::String sha256;
    bool placeholder = false;
    bool userProvided = false;

    // "rig-01 · 3 units", or "rig-01 · placeholder" for illustrative data.
    juce::String menuDetail() const;
    // "IEC 60318-4 · in-house · 3 units × 5 reseats"
    juce::String measurementSummary() const;
};

// Loads factory profiles and targets (compiled in) and the user's own from
// the data folder. Profiles whose checksum fails are rejected with a reason.
class ProfileLibrary
{
public:
    ProfileLibrary();

    void reload();

    const std::vector<ProfileInfo>& getProfiles() const noexcept { return profiles; }
    const std::vector<TargetInfo>& getTargets() const noexcept { return targets; }
    const juce::StringArray& getLoadErrors() const noexcept { return loadErrors; }

    const ProfileInfo* findProfile (const juce::String& id) const;
    const TargetInfo* findTarget (const juce::String& key) const;

    // Targets a profile may use: listed by the profile and on its rig.
    std::vector<const TargetInfo*> targetsFor (const ProfileInfo&) const;

    // <user app data>/REFERENCE, with Profiles, Targets and Presets inside.
    static juce::File userDataDirectory();
    // Points the user folder somewhere else (the standalone's --snapshot mode
    // uses a temporary one so it never touches the real library).
    static void setUserDataDirectoryOverride (const juce::File&);
    static juce::File userProfilesDirectory() { return userDataDirectory().getChildFile ("Profiles"); }
    static juce::File userTargetsDirectory() { return userDataDirectory().getChildFile ("Targets"); }

    // Parsing, exposed for the profile tool and tests.
    static bool parseProfile (const juce::String& jsonText, ProfileInfo& out, juce::String& error);
    // One data row of a curve CSV: the first two numbers. False if a cell
    // is not a number.
    static bool parseCsvRow (const juce::String& line, double& first, double& second);
    static bool parseTargetCsv (const juce::String& csvText, TargetInfo& out, juce::String& error);
    static juce::String computeChecksum (const juce::String& jsonText); // sha256 field blanked
    static bool verifyChecksum (const juce::String& jsonText, juce::String& error);

private:
    void addProfile (const juce::String& text, const juce::String& origin, bool user);
    void addTarget (const juce::String& text, const juce::String& origin, bool user);

    std::vector<ProfileInfo> profiles;
    std::vector<TargetInfo> targets;
    juce::StringArray loadErrors;
};

} // namespace ref

#include "ProfileLibrary.h"

#include "TextUtil.h"

#include <BinaryData.h>
#include <juce_cryptography/juce_cryptography.h>

namespace ref
{

namespace
{
std::vector<double> toDoubles (const juce::var& v)
{
    std::vector<double> out;
    if (auto* arr = v.getArray())
    {
        out.reserve ((size_t) arr->size());
        for (const auto& x : *arr)
            out.push_back ((double) x);
    }
    return out;
}

// Splits "id@version" into its parts.
void splitKey (const juce::String& key, juce::String& id, int& version)
{
    id = key.upToFirstOccurrenceOf ("@", false, false);
    version = key.contains ("@") ? key.fromFirstOccurrenceOf ("@", false, false).getIntValue() : 1;
}

// Locates the sha256 value inside the JSON text: [start, end) of the hex.
bool findChecksumSpan (const juce::String& text, int& start, int& end)
{
    const int key = text.indexOf ("\"sha256\"");
    if (key < 0)
        return false;
    const int colon = text.indexOfChar (key + 8, ':');
    if (colon < 0)
        return false;
    const int open = text.indexOfChar (colon, '"');
    if (open < 0)
        return false;
    const int close = text.indexOfChar (open + 1, '"');
    if (close < 0)
        return false;
    start = open + 1;
    end = close;
    return true;
}
} // namespace

juce::String ProfileInfo::menuDetail() const
{
    juce::String units_ = placeholder ? juce::String ("placeholder") : juce::String (units) + (units == 1 ? " unit" : " units");
    return rigId + text::spacedDot + units_;
}

juce::String ProfileInfo::measurementSummary() const
{
    if (placeholder)
        return earSimulator + text::spacedDot + "placeholder curve, not a measurement";
    return earSimulator + text::spacedDot + source + text::spacedDot + juce::String (units) + " units " + text::times + " "
         + juce::String (reseatsPerUnit) + " reseats";
}

//==============================================================================
ProfileLibrary::ProfileLibrary()
{
    reload();
}

juce::File ProfileLibrary::userDataDirectory()
{
#if JUCE_MAC
    return juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory)
        .getChildFile ("Application Support")
        .getChildFile ("REFERENCE");
#else
    return juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory).getChildFile ("REFERENCE");
#endif
}

void ProfileLibrary::reload()
{
    profiles.clear();
    targets.clear();
    loadErrors.clear();

    for (int i = 0; i < BinaryData::namedResourceListSize; ++i)
    {
        const juce::String name (BinaryData::originalFilenames[i]);
        int size = 0;
        const char* data = BinaryData::getNamedResource (BinaryData::namedResourceList[i], size);
        if (data == nullptr)
            continue;
        const auto text = juce::String::fromUTF8 (data, size);
        if (name.endsWithIgnoreCase (".json"))
            addProfile (text, name, false);
        else if (name.endsWithIgnoreCase (".csv"))
            addTarget (text, name, false);
    }

    for (const auto& f : userProfilesDirectory().findChildFiles (juce::File::findFiles, false, "*.json"))
        addProfile (f.loadFileAsString(), f.getFileName(), true);
    for (const auto& f : userTargetsDirectory().findChildFiles (juce::File::findFiles, true, "*.csv"))
        addTarget (f.loadFileAsString(), f.getFileName(), true);
}

void ProfileLibrary::addProfile (const juce::String& text, const juce::String& origin, bool user)
{
    juce::String error;
    if (! verifyChecksum (text, error))
    {
        loadErrors.add ("Profile " + origin + " was rejected: " + error);
        return;
    }
    ProfileInfo p;
    if (! parseProfile (text, p, error))
    {
        loadErrors.add ("Profile " + origin + " was rejected: " + error);
        return;
    }
    p.userProvided = user;
    // A user profile with the same id replaces the factory one.
    for (auto& existing : profiles)
    {
        if (existing.id == p.id)
        {
            existing = std::move (p);
            return;
        }
    }
    profiles.push_back (std::move (p));
}

void ProfileLibrary::addTarget (const juce::String& text, const juce::String& origin, bool user)
{
    TargetInfo t;
    juce::String error;
    if (! parseTargetCsv (text, t, error))
    {
        loadErrors.add ("Target " + origin + " was rejected: " + error);
        return;
    }
    t.userProvided = user;
    for (auto& existing : targets)
    {
        if (existing.key() == t.key())
        {
            existing = std::move (t);
            return;
        }
    }
    targets.push_back (std::move (t));
}

const ProfileInfo* ProfileLibrary::findProfile (const juce::String& id) const
{
    for (const auto& p : profiles)
        if (p.id == id)
            return &p;
    return nullptr;
}

const TargetInfo* ProfileLibrary::findTarget (const juce::String& key) const
{
    for (const auto& t : targets)
        if (t.key() == key)
            return &t;
    return nullptr;
}

std::vector<const TargetInfo*> ProfileLibrary::targetsFor (const ProfileInfo& p) const
{
    std::vector<const TargetInfo*> out;
    for (const auto& key : p.targetKeys)
        if (const auto* t = findTarget (key))
            out.push_back (t);
    // Also any user target on the same rig that the profile does not list.
    for (const auto& t : targets)
        if (t.userProvided && t.rigId == p.rigId && ! p.targetKeys.contains (t.key()))
            out.push_back (&t);
    return out;
}

//==============================================================================
juce::String ProfileLibrary::computeChecksum (const juce::String& jsonText)
{
    auto text = jsonText.replace ("\r\n", "\n");
    int start = 0, end = 0;
    if (! findChecksumSpan (text, start, end))
        return {};
    text = text.replaceSection (start, end - start, {});
    const auto utf8 = text.toUTF8();
    return juce::SHA256 (utf8.getAddress(), utf8.sizeInBytes() - 1).toHexString();
}

bool ProfileLibrary::verifyChecksum (const juce::String& jsonText, juce::String& error)
{
    const auto text = jsonText.replace ("\r\n", "\n");
    int start = 0, end = 0;
    if (! findChecksumSpan (text, start, end))
    {
        error = "no sha256 field";
        return false;
    }
    const auto stored = text.substring (start, end).trim().toLowerCase();
    if (stored != computeChecksum (text))
    {
        error = "checksum does not match the file contents";
        return false;
    }
    return true;
}

bool ProfileLibrary::parseProfile (const juce::String& jsonText, ProfileInfo& p, juce::String& error)
{
    juce::var root;
    const auto result = juce::JSON::parse (jsonText, root);
    if (result.failed() || ! root.isObject())
    {
        error = "not valid JSON (" + result.getErrorMessage() + ")";
        return false;
    }

    p.schemaVersion = (int) root.getProperty ("schema_version", 0);
    if (p.schemaVersion != 2)
    {
        error = "unsupported schema_version " + juce::String (p.schemaVersion);
        return false;
    }
    p.id = root.getProperty ("id", {}).toString();
    p.displayName = root.getProperty ("display_name", {}).toString();
    p.manufacturer = root.getProperty ("manufacturer", {}).toString();
    p.modelRevision = root.getProperty ("model_revision", {}).toString();
    p.generatorVersion = root.getProperty ("generator_version", {}).toString();
    p.sha256 = root.getProperty ("sha256", {}).toString();
    p.placeholder = (bool) root.getProperty ("placeholder", false);
    if (p.id.isEmpty() || p.displayName.isEmpty())
    {
        error = "missing id or display_name";
        return false;
    }

    const auto m = root.getProperty ("measurement", {});
    p.rigId = m.getProperty ("rig_id", {}).toString();
    p.earSimulator = m.getProperty ("ear_simulator", {}).toString();
    p.source = m.getProperty ("source", {}).toString();
    p.license = m.getProperty ("license", {}).toString();
    p.date = m.getProperty ("date", {}).toString();
    p.units = (int) m.getProperty ("units", 0);
    p.reseatsPerUnit = (int) m.getProperty ("reseats_per_unit", 0);
    if (p.rigId.isEmpty())
    {
        error = "measurement.rig_id is missing";
        return false;
    }

    if (auto* arr = root.getProperty ("targets", {}).getArray())
        for (const auto& t : *arr)
            p.targetKeys.add (t.toString());

    const auto lim = root.getProperty ("limits", {});
    p.limits.maxBoostDb = (double) lim.getProperty ("max_boost_db", p.limits.maxBoostDb);
    p.limits.maxCutDb = (double) lim.getProperty ("max_cut_db", p.limits.maxCutDb);
    p.limits.trebleAverageAboveHz = (double) lim.getProperty ("treble_average_above_hz", p.limits.trebleAverageAboveHz);
    p.limits.maxSlopeDbPerOctave = (double) lim.getProperty ("max_slope_db_per_oct", p.limits.maxSlopeDbPerOctave);
    p.limits.maxQ = (double) lim.getProperty ("max_q", p.limits.maxQ);

    const auto curve = root.getProperty ("curve", {});
    p.curve.freqHz = toDoubles (curve.getProperty ("freq_hz", {}));
    p.curve.db = toDoubles (curve.getProperty ("mean_db", {}));
    p.curve.spreadDb = toDoubles (curve.getProperty ("spread_db", {}));

    auto check = p.curve;
    if (auto e = dsp::sortAndValidate (check))
    {
        error = juce::String (e->c_str());
        return false;
    }
    return true;
}

bool ProfileLibrary::parseTargetCsv (const juce::String& csvText, TargetInfo& t, juce::String& error)
{
    juce::StringArray lines;
    lines.addLines (csvText);
    for (auto line : lines)
    {
        line = line.trim();
        if (line.isEmpty())
            continue;
        if (line.startsWithChar ('#'))
        {
            const auto body = line.substring (1).trim();
            const auto key = body.upToFirstOccurrenceOf (":", false, false).trim().toLowerCase();
            const auto value = body.fromFirstOccurrenceOf (":", false, false).trim();
            if (key == "id")
                t.id = value;
            else if (key == "version")
                t.version = value.getIntValue();
            else if (key == "rig_id")
                t.rigId = value;
            else if (key == "display_name")
                t.displayName = value;
            else if (key == "description")
                t.description = value;
            else if (key == "source")
                t.source = value;
            continue;
        }
        if (! (juce::CharacterFunctions::isDigit (line[0]) || line[0] == '.'))
            continue; // header row
        const auto cols = juce::StringArray::fromTokens (line, ",;\t", "");
        if (cols.size() < 2)
            continue;
        t.curve.freqHz.push_back (cols[0].getDoubleValue());
        t.curve.db.push_back (cols[1].getDoubleValue());
    }

    if (t.id.isEmpty() || t.rigId.isEmpty())
    {
        error = "missing '# id:' or '# rig_id:' header";
        return false;
    }
    if (t.displayName.isEmpty())
        t.displayName = t.id;
    auto check = t.curve;
    if (auto e = dsp::sortAndValidate (check))
    {
        error = juce::String (e->c_str());
        return false;
    }
    return true;
}

} // namespace ref

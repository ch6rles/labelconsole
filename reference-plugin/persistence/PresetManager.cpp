#include "PresetManager.h"

#include "../measurement/ProfileLibrary.h"
#include "../measurement/TextUtil.h"

namespace ref
{

namespace
{
PresetData makeFactory (const char* model, const char* profileId, const char* targetName, const char* targetKey, float amount)
{
    PresetData p;
    p.name = juce::String (model) + text::spacedDot + targetName;
    p.profileId = profileId;
    p.targetKey = targetKey;
    p.calAmount = amount;
    p.factory = true;
    return p;
}
} // namespace

PresetManager::PresetManager()
{
    for (auto [model, id] : { std::pair { "MM-520", "audeze_mm520" }, std::pair { "MM-500", "audeze_mm500" } })
    {
        factory.push_back (makeFactory (model, id, "Studio Reference", "studio_reference@1", 100.0f));
        factory.push_back (makeFactory (model, id, "Neutral", "neutral@1", 100.0f));
        factory.push_back (makeFactory (model, id, "Gentle (50%)", "studio_reference@1", 50.0f));
    }
    refreshUserPresets();
}

juce::File PresetManager::presetsDirectory()
{
    return ProfileLibrary::userDataDirectory().getChildFile ("Presets");
}

void PresetManager::refreshUserPresets()
{
    user.clear();
    auto files = presetsDirectory().findChildFiles (juce::File::findFiles, false, juce::String ("*") + kExtension);
    files.sort();
    for (const auto& f : files)
    {
        PresetData p;
        juce::String error;
        if (fromJson (f.loadFileAsString(), p, error))
        {
            p.factory = false;
            p.file = f;
            user.push_back (std::move (p));
        }
    }
    std::sort (user.begin(), user.end(), [] (const PresetData& a, const PresetData& b) { return a.name.compareNatural (b.name) < 0; });
}

std::vector<const PresetData*> PresetManager::all() const
{
    std::vector<const PresetData*> out;
    for (const auto& p : factory)
        out.push_back (&p);
    for (const auto& p : user)
        out.push_back (&p);
    return out;
}

const PresetData* PresetManager::find (const juce::String& name) const
{
    for (const auto* p : all())
        if (p->name == name)
            return p;
    return nullptr;
}

bool PresetManager::isUserPreset (const juce::String& name) const
{
    for (const auto& p : user)
        if (p.name == name)
            return true;
    return false;
}

bool PresetManager::saveUser (const PresetData& data, juce::String& error)
{
    const auto name = data.name.trim();
    if (name.isEmpty())
    {
        error = "A preset needs a name.";
        return false;
    }
    for (const auto& f : factory)
    {
        if (f.name == name)
        {
            error = "That name belongs to a factory preset.";
            return false;
        }
    }
    auto dir = presetsDirectory();
    if (! dir.createDirectory())
    {
        error = "Could not create " + dir.getFullPathName();
        return false;
    }

    PresetData copy = data;
    copy.name = name;
    copy.factory = false;
    auto file = dir.getChildFile (juce::File::createLegalFileName (name) + kExtension);
    for (const auto& u : user)
        if (u.name == name)
            file = u.file;
    if (! file.replaceWithText (toJson (copy)))
    {
        error = "Could not write " + file.getFullPathName();
        return false;
    }
    refreshUserPresets();
    return true;
}

bool PresetManager::renameUser (const juce::String& oldName, const juce::String& newName, juce::String& error)
{
    const PresetData* existing = nullptr;
    for (const auto& u : user)
        if (u.name == oldName)
            existing = &u;
    if (existing == nullptr)
    {
        error = "Only user presets can be renamed.";
        return false;
    }
    if (find (newName.trim()) != nullptr)
    {
        error = "A preset with that name already exists.";
        return false;
    }
    PresetData copy = *existing;
    const auto oldFile = copy.file;
    copy.name = newName.trim();
    copy.file = juce::File();
    if (! saveUser (copy, error))
        return false;
    oldFile.deleteFile();
    refreshUserPresets();
    return true;
}

bool PresetManager::deleteUser (const juce::String& name, juce::String& error)
{
    for (const auto& u : user)
    {
        if (u.name == name)
        {
            if (! u.file.deleteFile())
            {
                error = "Could not delete " + u.file.getFullPathName();
                return false;
            }
            refreshUserPresets();
            return true;
        }
    }
    error = "Only user presets can be deleted.";
    return false;
}

bool PresetManager::importFile (const juce::File& file, juce::String& importedName, juce::String& error)
{
    PresetData p;
    if (! fromJson (file.loadFileAsString(), p, error))
        return false;
    // Keep both if the name is taken.
    auto name = p.name;
    for (int n = 2; find (name) != nullptr; ++n)
        name = p.name + " (" + juce::String (n) + ")";
    p.name = name;
    if (! saveUser (p, error))
        return false;
    importedName = name;
    return true;
}

bool PresetManager::exportPreset (const PresetData& p, const juce::File& destination, juce::String& error) const
{
    if (! destination.replaceWithText (toJson (p)))
    {
        error = "Could not write " + destination.getFullPathName();
        return false;
    }
    return true;
}

juce::String PresetManager::toJson (const PresetData& p)
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty ("format", "REFERENCE preset");
    obj->setProperty ("version", 1);
    obj->setProperty ("name", p.name);
    obj->setProperty ("profileId", p.profileId);
    obj->setProperty ("targetId", p.targetKey);
    obj->setProperty ("calAmount", p.calAmount);
    obj->setProperty ("outputGain", p.outputGain);
    obj->setProperty ("balance", p.balance);
    obj->setProperty ("filterMode", p.filterMode == dsp::FilterMode::linearPhase ? "linear" : "min");
    obj->setProperty ("autoGain", p.autoGain);
    obj->setProperty ("monitorProtection", p.monitorProtection);
    juce::Array<juce::var> nodes;
    for (const auto& n : p.overlay)
    {
        auto* node = new juce::DynamicObject();
        node->setProperty ("type", juce::String (dsp::toString (n.type)));
        node->setProperty ("freq", n.freqHz);
        node->setProperty ("gain", n.gainDb);
        node->setProperty ("q", n.q);
        nodes.add (juce::var (node));
    }
    obj->setProperty ("overlay", nodes);
    return juce::JSON::toString (juce::var (obj));
}

bool PresetManager::fromJson (const juce::String& text, PresetData& p, juce::String& error)
{
    juce::var root;
    if (juce::JSON::parse (text, root).failed() || ! root.isObject())
    {
        error = "Not a REFERENCE preset file.";
        return false;
    }
    if (root.getProperty ("format", {}).toString() != "REFERENCE preset")
    {
        error = "Not a REFERENCE preset file.";
        return false;
    }
    p.name = root.getProperty ("name", {}).toString().trim();
    p.profileId = root.getProperty ("profileId", {}).toString();
    p.targetKey = root.getProperty ("targetId", {}).toString();
    p.calAmount = juce::jlimit (0.0f, 100.0f, (float) root.getProperty ("calAmount", 100.0f));
    p.outputGain = juce::jlimit (-24.0f, 12.0f, (float) root.getProperty ("outputGain", 0.0f));
    p.balance = juce::jlimit (-6.0f, 6.0f, (float) root.getProperty ("balance", 0.0f));
    p.filterMode = root.getProperty ("filterMode", {}).toString() == "linear" ? dsp::FilterMode::linearPhase : dsp::FilterMode::minimumPhase;
    p.autoGain = (bool) root.getProperty ("autoGain", true);
    p.monitorProtection = (bool) root.getProperty ("monitorProtection", true);
    p.overlay.clear();
    if (auto* arr = root.getProperty ("overlay", {}).getArray())
    {
        for (const auto& n : *arr)
        {
            dsp::FilterSpec f;
            if (! dsp::filterTypeFromString (n.getProperty ("type", {}).toString().toStdString(), f.type))
                continue;
            f.freqHz = juce::jlimit (20.0, 20000.0, (double) n.getProperty ("freq", 1000.0));
            f.gainDb = juce::jlimit (-18.0, 18.0, (double) n.getProperty ("gain", 0.0));
            f.q = juce::jlimit (0.1, 10.0, (double) n.getProperty ("q", 0.7071));
            p.overlay.push_back (f);
        }
    }
    if (p.name.isEmpty() || p.profileId.isEmpty())
    {
        error = "The preset is missing its name or headphone.";
        return false;
    }
    return true;
}

} // namespace ref

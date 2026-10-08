// Plugin-level tests (spec Section 12): state save and reload, the
// embedded-curve fallback, render safety, latency reporting, presets and
// profile checksums. Runs with a private data folder.

#include "../../measurement/ProfileLibrary.h"
#include "../../persistence/PresetManager.h"
#include "../../plugin/Parameters.h"
#include "../../plugin/PluginProcessor.h"
#include "ref/dsp/FirDesign.h"

#include <BinaryData.h>

#include <cstdio>
#include <cstdlib>

namespace
{
int failures = 0, checks = 0;

void check (bool ok, const char* what)
{
    ++checks;
    if (! ok)
    {
        ++failures;
        std::printf ("    FAIL: %s\n", what);
    }
}

void setParam (ref::ReferenceProcessor& p, const char* id, float v)
{
    auto* param = p.getParameters().getParameter (id);
    param->setValueNotifyingHost (param->convertTo0to1 (v));
}

juce::AudioBuffer<float> noise (int n, int seed)
{
    juce::AudioBuffer<float> b (2, n);
    juce::Random r (seed);
    for (int c = 0; c < 2; ++c)
        for (int i = 0; i < n; ++i)
            b.setSample (c, i, (r.nextFloat() * 2.0f - 1.0f) * 0.3f);
    return b;
}

// Prepares and processes in 512-sample blocks, as a host would.
juce::AudioBuffer<float> render (ref::ReferenceProcessor& p, const juce::AudioBuffer<float>& input, bool offline = false)
{
    p.setNonRealtime (offline);
    p.setPlayConfigDetails (2, 2, 48000.0, 512);
    p.prepareToPlay (48000.0, 512);
    auto out = input;
    juce::MidiBuffer midi;
    for (int off = 0; off < out.getNumSamples(); off += 512)
    {
        juce::AudioBuffer<float> view (out.getArrayOfWritePointers(), 2, off, juce::jmin (512, out.getNumSamples() - off));
        p.processBlock (view, midi);
    }
    return out;
}

float maxDiff (const juce::AudioBuffer<float>& a, const juce::AudioBuffer<float>& b)
{
    float d = 0.0f;
    for (int c = 0; c < 2; ++c)
        for (int i = 0; i < a.getNumSamples(); ++i)
            d = juce::jmax (d, std::abs (a.getSample (c, i) - b.getSample (c, i)));
    return d;
}

void configure (ref::ReferenceProcessor& p, ref::dsp::FilterMode mode)
{
    p.setProfile ("audeze_mm500");
    p.setTarget ("neutral@1");
    p.setFilterMode (mode);
    setParam (p, ref::params::calAmount, 70.0f);
    setParam (p, ref::params::outputGain, -3.0f);
    setParam (p, ref::params::balance, 1.5f);
    p.setOverlay ({ { ref::dsp::FilterType::bell, 2500.0, -2.0, 1.5 } });
}

juce::MemoryBlock stateOf (ref::ReferenceProcessor& p)
{
    juce::MemoryBlock m;
    p.getStateInformation (m);
    return m;
}

juce::MemoryBlock edited (const juce::MemoryBlock& state, std::function<void (juce::ValueTree&)> fn)
{
    auto xml = juce::AudioProcessor::getXmlFromBinary (state.getData(), (int) state.getSize());
    auto tree = juce::ValueTree::fromXml (*xml);
    fn (tree);
    juce::MemoryBlock out;
    juce::AudioProcessor::copyXmlToBinary (*tree.createXml(), out);
    return out;
}
} // namespace

int main()
{
    // Private data folder for presets and user profiles.
    const auto home = juce::File::getSpecialLocation (juce::File::tempDirectory)
                          .getChildFile ("reference-plugin-tests-" + juce::String (juce::Time::currentTimeMillis()));
    home.createDirectory();
#if JUCE_WINDOWS
    _putenv_s ("APPDATA", home.getFullPathName().toRawUTF8());
#else
    setenv ("HOME", home.getFullPathName().toRawUTF8(), 1);
#endif
    juce::ScopedJuceInitialiser_GUI juceInit;

    const auto input = noise (48000, 3);

    for (auto mode : { ref::dsp::FilterMode::minimumPhase, ref::dsp::FilterMode::linearPhase })
    {
        const bool linear = mode == ref::dsp::FilterMode::linearPhase;
        std::printf ("[ RUN ] state: save and reload give identical output (%s)\n", linear ? "Linear Phase" : "Min Phase");
        ref::ReferenceProcessor a;
        configure (a, mode);
        const auto outA = render (a, input);
        const auto state = stateOf (a);

        ref::ReferenceProcessor b;
        b.setStateInformation (state.getData(), (int) state.getSize());
        const auto outB = render (b, input);
        check (maxDiff (outA, outB) == 0.0f, "reloaded session output differs");
        check (b.getLatencySamples() == (linear ? ref::dsp::linearPhaseSizing (48000.0).latencySamples : 0), "latency after reload");

        std::printf ("[ RUN ] state: removed profile falls back to the embedded curve\n");
        const auto missing = edited (state, [] (juce::ValueTree& t)
        {
            t.getChildWithName ("SETTINGS").setProperty ("profileId", "removed_profile", nullptr);
            t.getChildWithName ("EMBEDDED").setProperty ("profileId", "removed_profile", nullptr);
        });
        ref::ReferenceProcessor c;
        c.setStateInformation (missing.getData(), (int) missing.getSize());
        const auto outC = render (c, input);
        check (c.getSnapshot() != nullptr && c.getSnapshot()->fromEmbedded, "embedded curve not used for a removed profile");
        check (maxDiff (outA, outC) == 0.0f, "embedded-curve output differs");

        std::printf ("[ RUN ] state: changed profile falls back to the embedded curve\n");
        const auto changed = edited (state, [] (juce::ValueTree& t) { t.getChildWithName ("EMBEDDED").setProperty ("profileSha", "0000", nullptr); });
        ref::ReferenceProcessor d;
        d.setStateInformation (changed.getData(), (int) changed.getSize());
        const auto outD = render (d, input);
        check (d.getSnapshot() != nullptr && d.getSnapshot()->fromEmbedded, "embedded curve not used for a changed profile");
        check (maxDiff (outA, outD) == 0.0f, "changed-profile output differs");

        std::printf ("[ RUN ] render safety: offline export is bit-exact to the dry mix\n");
        ref::ReferenceProcessor e;
        configure (e, mode);
        const auto outE = render (e, input, true);
        const int L = e.getLatencySamples();
        bool exact = true;
        for (int ch = 0; ch < 2 && exact; ++ch)
            for (int i = L; i < input.getNumSamples() && exact; ++i)
                exact = outE.getSample (ch, i) == input.getSample (ch, i - L);
        check (exact, "offline render is not bit-exact after the reported delay");
        check (e.isRenderBypassActive(), "render bypass not flagged for the UI");
    }

    std::printf ("[ RUN ] latency: reported on every mode change\n");
    {
        ref::ReferenceProcessor p;
        p.setPlayConfigDetails (2, 2, 96000.0, 256);
        p.prepareToPlay (96000.0, 256);
        p.setFilterMode (ref::dsp::FilterMode::linearPhase);
        check (p.getLatencySamples() == 8192, "Linear Phase latency at 96 kHz");
        p.setFilterMode (ref::dsp::FilterMode::minimumPhase);
        check (p.getLatencySamples() == 0, "Minimum Phase latency");
    }

    std::printf ("[ RUN ] presets: factory list, save, rename, export, import, delete\n");
    {
        ref::ReferenceProcessor p;
        auto& pm = p.getPresets();
        check (pm.getFactory().size() == 6, "six factory presets");
        p.loadPreset (pm.getFactory()[2]); // MM-520 · Gentle (50%)
        check (std::abs (p.getParameters().getRawParameterValue (ref::params::calAmount)->load() - 50.0f) < 0.01f, "Gentle sets 50%");
        check (! p.isPresetModified(), "a freshly loaded preset is unmodified");
        setParam (p, ref::params::outputGain, -6.0f);
        check (p.isPresetModified(), "an edit marks the preset modified");

        juce::String err;
        check (pm.saveUser (p.captureCurrentAsPreset ("Late-night, low level"), err), "save a user preset");
        check (pm.find ("Late-night, low level") != nullptr, "saved preset listed");
        check (pm.renameUser ("Late-night, low level", "Quiet", err), "rename");
        check (pm.find ("Quiet") != nullptr && pm.find ("Late-night, low level") == nullptr, "renamed preset listed");
        const auto exported = home.getChildFile ("quiet.refpreset");
        check (pm.exportPreset (*pm.find ("Quiet"), exported, err), "export");
        juce::String imported;
        check (pm.importFile (exported, imported, err) && imported == "Quiet (2)", "import keeps both");
        check (pm.find ("Quiet (2)") != nullptr && std::abs (pm.find ("Quiet (2)")->outputGain + 6.0f) < 0.01f, "imported preset keeps its controls");
        check (pm.deleteUser ("Quiet", err) && pm.find ("Quiet") == nullptr, "delete");
        check (! pm.saveUser (p.captureCurrentAsPreset (pm.getFactory()[0].name), err), "factory names are protected");
    }

    std::printf ("[ RUN ] profiles: checksums verified, tampered files rejected\n");
    {
        ref::ProfileLibrary lib;
        check (lib.getLoadErrors().isEmpty(), "factory profiles load cleanly");
        check (lib.findProfile ("audeze_mm520") != nullptr && lib.findProfile ("audeze_mm500") != nullptr, "factory profiles present");

        int size = 0;
        const char* data = nullptr;
        for (int i = 0; i < BinaryData::namedResourceListSize; ++i)
            if (juce::String (BinaryData::originalFilenames[i]) == "audeze_mm520.json")
                data = BinaryData::getNamedResource (BinaryData::namedResourceList[i], size);
        const auto text = juce::String::fromUTF8 (data, size);

        auto withId = [&] (const juce::String& id)
        {
            auto t = text.replace ("\"audeze_mm520\"", "\"" + id + "\"");
            const int s0 = t.indexOf ("\"sha256\": \"") + 11;
            const int s1 = t.indexOfChar (s0, '"');
            t = t.replaceSection (s0, s1 - s0, {});
            return t.replace ("\"sha256\": \"\"", "\"sha256\": \"" + ref::ProfileLibrary::computeChecksum (t) + "\"");
        };
        auto dir = ref::ProfileLibrary::userProfilesDirectory();
        dir.createDirectory();
        dir.getChildFile ("user_good.json").replaceWithText (withId ("user_good"));
        dir.getChildFile ("user_crlf.json").replaceWithText (withId ("user_crlf").replace ("\n", "\r\n"));
        dir.getChildFile ("user_tampered.json").replaceWithText (withId ("user_tampered").replace ("\"units\": 0", "\"units\": 3"));

        lib.reload();
        check (lib.findProfile ("user_good") != nullptr, "a valid user profile loads");
        check (lib.findProfile ("user_crlf") != nullptr, "CRLF line endings do not break the checksum");
        check (lib.findProfile ("user_tampered") == nullptr, "a tampered profile is rejected");
        check (lib.getLoadErrors().size() == 1 && lib.getLoadErrors()[0].contains ("checksum"), "the rejection names the checksum");
    }

    home.deleteRecursively();
    std::printf ("\n%d checks, %d failed\n", checks, failures);
    return failures == 0 ? 0 : 1;
}

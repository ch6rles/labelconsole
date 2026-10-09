// reference-profile-tool: builds REFERENCE headphone profiles and targets
// from measurement CSV files, and verifies profile checksums.
//
//   reference-profile-tool profile --id my_hp --name "Brand Model" --manufacturer Brand
//       --revision "Model" --rig rig-01 --ear-simulator "IEC 60318-4" --source in-house
//       --license owned --units 3 --targets studio_reference@1,neutral@1
//       --out my_hp.json unit1_seat1.csv unit1_seat2.csv ...
//
//   reference-profile-tool target --id my_target --version 1 --rig rig-01
//       --name "My Target" --description "..." --out my_target@1.csv curve.csv
//
//   reference-profile-tool verify my_hp.json
//
// Each measurement CSV holds one frequency response (one unit, one reseat):
// frequency in Hz and level in dB per line. Header lines and AutoEq-style
// "frequency,raw" files are accepted. The profile stores the mean response
// and the per-frequency standard deviation across all files as the spread.

#include <juce_core/juce_core.h>

#include "../measurement/ProfileLibrary.h"

#include <cmath>
#include <cstdio>

namespace
{
constexpr int kPoints = 241; // 1/24 octave, 20 Hz .. 20 kHz

struct Args
{
    juce::StringPairArray options;
    juce::StringArray files;
};

Args parse (const juce::StringArray& raw)
{
    Args a;
    for (int i = 0; i < raw.size(); ++i)
    {
        if (raw[i].startsWith ("--") && i + 1 < raw.size())
        {
            a.options.set (raw[i].substring (2), raw[i + 1]);
            ++i;
        }
        else
        {
            a.files.add (raw[i]);
        }
    }
    return a;
}

bool readCurve (const juce::File& f, std::vector<double>& freq, std::vector<double>& db, juce::String& error)
{
    juce::StringArray lines;
    lines.addLines (f.loadFileAsString());
    for (auto line : lines)
    {
        line = line.trim();
        if (line.isEmpty() || line.startsWithChar ('#') || ! (juce::CharacterFunctions::isDigit (line[0]) || line[0] == '.'))
            continue;
        // Space-separated columns are accepted too.
        if (! line.containsAnyOf (",;\t"))
            line = line.replaceCharacter (' ', '\t');
        double hz = 0.0, level = 0.0;
        if (! ref::ProfileLibrary::parseCsvRow (line, hz, level))
        {
            error = f.getFileName() + ": not a number in line: " + line.substring (0, 60);
            return false;
        }
        freq.push_back (hz);
        db.push_back (level);
    }
    ref::dsp::RawCurve rc { freq, db, {} };
    if (auto e = ref::dsp::sortAndValidate (rc))
    {
        error = f.getFileName() + ": " + juce::String (e->c_str());
        return false;
    }
    freq = rc.freqHz;
    db = rc.db;
    return true;
}

double interpolate (const std::vector<double>& freq, const std::vector<double>& db, double hz)
{
    if (hz <= freq.front())
        return db.front();
    if (hz >= freq.back())
        return db.back();
    size_t j = 1;
    while (freq[j] < hz)
        ++j;
    const double t = std::log (hz / freq[j - 1]) / std::log (freq[j] / freq[j - 1]);
    return db[j - 1] + (db[j] - db[j - 1]) * t;
}

juce::String list (const std::vector<double>& v)
{
    juce::String s ("[");
    for (size_t i = 0; i < v.size(); ++i)
        s << (i > 0 ? ", " : "") << juce::String (v[i], 3);
    return s + "]";
}

juce::String q (const juce::String& s)
{
    return juce::JSON::toString (juce::var (s));
}

int buildProfile (const Args& a)
{
    const auto opt = [&] (const char* k, const char* def = "") { return a.options.getValue (k, def); };
    // Provenance is recorded as given (spec Section 11); it is never assumed.
    if (opt ("id").isEmpty() || opt ("name").isEmpty() || opt ("rig").isEmpty() || opt ("out").isEmpty() || opt ("source").isEmpty()
        || opt ("license").isEmpty() || opt ("ear-simulator").isEmpty() || a.files.isEmpty())
    {
        std::fprintf (stderr, "profile needs --id, --name, --rig, --ear-simulator, --source, --license, --out and at least one measurement CSV\n");
        return 2;
    }

    std::vector<std::vector<double>> curves;
    std::vector<double> grid (kPoints);
    for (int i = 0; i < kPoints; ++i)
        grid[(size_t) i] = 20.0 * std::pow (1000.0, i / (kPoints - 1.0));

    for (const auto& path : a.files)
    {
        std::vector<double> f, d;
        juce::String error;
        if (! readCurve (juce::File::getCurrentWorkingDirectory().getChildFile (path), f, d, error))
        {
            std::fprintf (stderr, "%s\n", error.toRawUTF8());
            return 1;
        }
        std::vector<double> c (kPoints);
        for (int i = 0; i < kPoints; ++i)
            c[(size_t) i] = interpolate (f, d, grid[(size_t) i]);
        // Level each measurement to 0 dB over 500 Hz-2 kHz, as the generator
        // does, so unit sensitivity or drive level differences are not
        // mistaken for spread (which would weaken the whole correction).
        double sum = 0.0;
        int count = 0;
        for (int i = 0; i < kPoints; ++i)
            if (grid[(size_t) i] >= 500.0 && grid[(size_t) i] <= 2000.0)
            {
                sum += c[(size_t) i];
                ++count;
            }
        for (auto& v : c)
            v -= sum / juce::jmax (1, count);
        curves.push_back (std::move (c));
    }

    std::vector<double> mean (kPoints, 0.0), spread (kPoints, 0.0);
    for (int i = 0; i < kPoints; ++i)
    {
        for (const auto& c : curves)
            mean[(size_t) i] += c[(size_t) i];
        mean[(size_t) i] /= (double) curves.size();
        for (const auto& c : curves)
            spread[(size_t) i] += (c[(size_t) i] - mean[(size_t) i]) * (c[(size_t) i] - mean[(size_t) i]);
        spread[(size_t) i] = curves.size() > 1 ? std::sqrt (spread[(size_t) i] / (double) (curves.size() - 1)) : 0.0;
    }

    const int units = opt ("units", "1").getIntValue();
    const int reseats = juce::jmax (1, (int) curves.size() / juce::jmax (1, units));
    juce::StringArray targets;
    targets.addTokens (opt ("targets", "studio_reference@1,neutral@1"), ",", "");
    juce::String targetList;
    for (int i = 0; i < targets.size(); ++i)
        targetList << (i > 0 ? ", " : "") << q (targets[i].trim());

    juce::String text;
    text << "{\n"
         << "  \"schema_version\": 2,\n"
         << "  \"id\": " << q (opt ("id")) << ",\n"
         << "  \"display_name\": " << q (opt ("name")) << ",\n"
         << "  \"manufacturer\": " << q (opt ("manufacturer")) << ",\n"
         << "  \"model_revision\": " << q (opt ("revision", opt ("name").toRawUTF8())) << ",\n"
         << "  \"measurement\": {\n"
         << "    \"rig_id\": " << q (opt ("rig")) << ",\n"
         << "    \"ear_simulator\": " << q (opt ("ear-simulator")) << ",\n"
         << "    \"source\": " << q (opt ("source")) << ",\n"
         << "    \"license\": " << q (opt ("license")) << ",\n"
         << "    \"units\": " << units << ",\n"
         << "    \"reseats_per_unit\": " << reseats << ",\n"
         << "    \"date\": " << q (opt ("date", juce::Time::getCurrentTime().formatted ("%Y-%m-%d").toRawUTF8())) << "\n"
         << "  },\n"
         << "  \"targets\": [" << targetList << "],\n"
         << "  \"limits\": { \"max_boost_db\": " << opt ("max-boost", "6") << ", \"max_cut_db\": " << opt ("max-cut", "-12")
         << ", \"treble_average_above_hz\": " << opt ("treble-above", "9000") << " },\n"
         << "  \"curve\": {\n"
         << "    \"freq_hz\": " << list (grid) << ",\n"
         << "    \"mean_db\": " << list (mean) << ",\n"
         << "    \"spread_db\": " << list (spread) << "\n"
         << "  },\n"
         << "  \"generator_version\": \"1.0.0\",\n"
         << "  \"sha256\": \"\"\n"
         << "}\n";
    text = text.replace ("\"sha256\": \"\"", "\"sha256\": \"" + ref::ProfileLibrary::computeChecksum (text) + "\"");

    ref::ProfileInfo info;
    juce::String error;
    if (! ref::ProfileLibrary::parseProfile (text, info, error))
    {
        std::fprintf (stderr, "profile is invalid: %s\n", error.toRawUTF8());
        return 1;
    }
    const auto out = juce::File::getCurrentWorkingDirectory().getChildFile (opt ("out"));
    if (! out.replaceWithText (text))
    {
        std::fprintf (stderr, "could not write %s\n", out.getFullPathName().toRawUTF8());
        return 1;
    }
    std::printf ("wrote %s from %d measurements (%d units x %d reseats)\n", out.getFullPathName().toRawUTF8(), (int) curves.size(), units, reseats);
    return 0;
}

int buildTarget (const Args& a)
{
    const auto opt = [&] (const char* k, const char* def = "") { return a.options.getValue (k, def); };
    if (opt ("id").isEmpty() || opt ("rig").isEmpty() || opt ("out").isEmpty() || a.files.size() != 1)
    {
        std::fprintf (stderr, "target needs --id, --rig, --out and one curve CSV\n");
        return 2;
    }
    std::vector<double> f, d;
    juce::String error;
    if (! readCurve (juce::File::getCurrentWorkingDirectory().getChildFile (a.files[0]), f, d, error))
    {
        std::fprintf (stderr, "%s\n", error.toRawUTF8());
        return 1;
    }
    juce::String text;
    text << "# REFERENCE target curve\n# id: " << opt ("id") << "\n# version: " << opt ("version", "1") << "\n# rig_id: " << opt ("rig")
         << "\n# display_name: " << opt ("name", opt ("id").toRawUTF8()) << "\n# description: " << opt ("description") << "\n# source: "
         << opt ("source", "user") << "\nfreq_hz,db\n";
    for (size_t i = 0; i < f.size(); ++i)
        text << juce::String (f[i], 3) << "," << juce::String (d[i], 3) << "\n";
    const auto out = juce::File::getCurrentWorkingDirectory().getChildFile (opt ("out"));
    if (! out.replaceWithText (text))
        return 1;
    std::printf ("wrote %s\n", out.getFullPathName().toRawUTF8());
    return 0;
}

int verify (const Args& a)
{
    int bad = 0;
    for (const auto& path : a.files)
    {
        const auto text = juce::File::getCurrentWorkingDirectory().getChildFile (path).loadFileAsString();
        juce::String error;
        ref::ProfileInfo info;
        const bool ok = ref::ProfileLibrary::verifyChecksum (text, error) && ref::ProfileLibrary::parseProfile (text, info, error);
        std::printf ("%s: %s\n", path.toRawUTF8(), ok ? "ok" : error.toRawUTF8());
        bad += ok ? 0 : 1;
    }
    return bad == 0 ? 0 : 1;
}
} // namespace

int main (int argc, char** argv)
{
    juce::StringArray raw;
    for (int i = 2; i < argc; ++i)
        raw.add (juce::String::fromUTF8 (argv[i]));
    const juce::String command = argc > 1 ? juce::String (argv[1]) : juce::String();
    const auto args = parse (raw);

    if (command == "profile")
        return buildProfile (args);
    if (command == "target")
        return buildTarget (args);
    if (command == "verify")
        return verify (args);

    std::printf ("usage: reference-profile-tool profile|target|verify ... (see the comment at the top of tools/ProfileTool.cpp)\n");
    return 2;
}

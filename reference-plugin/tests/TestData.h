#pragma once

// Loads the shipped (placeholder) profiles and targets for host-free tests.
// The plugin parses them with JUCE; here a minimal reader is enough.

#include "ref/dsp/CorrectionGenerator.h"
#include "ref/dsp/FilterSet.h"

#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>

namespace reftest
{

inline std::string readFile (const std::string& path)
{
    std::ifstream f (path, std::ios::binary);
    if (! f)
        throw std::runtime_error ("cannot open " + path);
    std::stringstream s;
    s << f.rdbuf();
    return s.str();
}

inline std::vector<double> jsonArray (const std::string& text, const std::string& key)
{
    auto p = text.find ("\"" + key + "\"");
    p = text.find ('[', p);
    const auto e = text.find (']', p);
    std::vector<double> v;
    std::stringstream ss (text.substr (p + 1, e - p - 1));
    std::string tok;
    while (std::getline (ss, tok, ','))
        v.push_back (std::stod (tok));
    return v;
}

inline ref::dsp::CurveSource loadProfile (const std::string& id)
{
    const auto text = readFile (std::string (REF_PROFILES_DIR) + "/headphones/" + id + ".json");
    return { "rig-01", { jsonArray (text, "freq_hz"), jsonArray (text, "mean_db"), jsonArray (text, "spread_db") } };
}

inline ref::dsp::CurveSource loadTarget (const std::string& file)
{
    std::ifstream f (std::string (REF_PROFILES_DIR) + "/targets/rig-01/" + file);
    ref::dsp::CurveSource t { "rig-01", {} };
    std::string line;
    while (std::getline (f, line))
    {
        if (line.empty() || line[0] == '#' || line[0] == 'f')
            continue;
        double a, b;
        if (std::sscanf (line.c_str(), "%lf,%lf", &a, &b) == 2)
        {
            t.curve.freqHz.push_back (a);
            t.curve.db.push_back (b);
        }
    }
    return t;
}

inline const ref::dsp::CorrectionResult& mm520Studio()
{
    static const auto r = ref::dsp::generateCorrection (loadProfile ("audeze_mm520"), loadTarget ("studio_reference@1.csv"));
    return r;
}

inline ref::dsp::FilterSetConfig configFor (const ref::dsp::CorrectionResult& r, ref::dsp::FilterMode mode, double fs, double amount = 1.0)
{
    ref::dsp::FilterSetConfig c;
    c.mode = mode;
    c.sampleRate = fs;
    c.hasCorrection = r.generated;
    c.correction = r.correction;
    c.calibration = r.filters;
    c.linearAmount = amount;
    return c;
}

} // namespace reftest

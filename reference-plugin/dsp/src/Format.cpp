#include "ref/dsp/Format.h"

#include <cmath>
#include <cstdio>

namespace ref::dsp
{

std::string formatNumber (double value, int decimals, bool plusSign)
{
    const double scale = std::pow (10.0, decimals);
    double rounded = std::round (value * scale) / scale;
    if (rounded == 0.0)
        rounded = 0.0; // drop a negative zero

    char buf[64];
    std::snprintf (buf, sizeof (buf), "%.*f", decimals, std::abs (rounded));
    if (rounded < 0.0)
        return std::string (kMinus) + buf;
    if (plusSign && rounded > 0.0)
        return std::string ("+") + buf;
    return buf;
}

std::string formatDb (double value, int decimals, bool plusSign)
{
    return formatNumber (value, decimals, plusSign) + " dB";
}

namespace
{
// Three significant figures, trailing zeros kept to that precision
// ("1.02", "12.5", "100").
std::string threeSig (double v)
{
    if (v >= 100.0)
        return formatNumber (v, 0);
    if (v >= 10.0)
        return formatNumber (v, 1);
    return formatNumber (v, 2);
}

// Range ends: shortest form ("46", "1.2", "12").
std::string compact (double v)
{
    char buf[32];
    if (v >= 100.0)
        std::snprintf (buf, sizeof (buf), "%.0f", v);
    else if (v >= 10.0)
        std::snprintf (buf, sizeof (buf), "%.1f", v);
    else
        std::snprintf (buf, sizeof (buf), "%.2f", v);
    std::string s (buf);
    if (s.find ('.') != std::string::npos)
    {
        while (! s.empty() && s.back() == '0')
            s.pop_back();
        if (! s.empty() && s.back() == '.')
            s.pop_back();
    }
    return s;
}
} // namespace

std::string formatFrequency (double hz)
{
    if (hz >= 999.5)
        return threeSig (hz / 1000.0) + " kHz";
    return formatNumber (hz, 0) + " Hz";
}

std::string formatFrequencyRange (double loHz, double hiHz)
{
    const bool loK = loHz >= 999.5, hiK = hiHz >= 999.5;
    if (loK && hiK)
        return compact (loHz / 1000.0) + kEnDash + compact (hiHz / 1000.0) + " kHz";
    if (! loK && ! hiK)
        return compact (loHz) + kEnDash + compact (hiHz) + " Hz";
    return compact (loHz) + " Hz" + kEnDash + compact (hiHz / 1000.0) + " kHz";
}

} // namespace ref::dsp

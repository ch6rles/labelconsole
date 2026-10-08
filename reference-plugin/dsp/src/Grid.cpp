#include "ref/dsp/Grid.h"

#include <algorithm>
#include <cmath>
#include <numeric>

namespace ref::dsp
{

namespace
{
const double kLogSpan = std::log (kGridMaxHz / kGridMinHz);

GridCurve makeFrequencies()
{
    GridCurve f {};
    for (int i = 0; i < kGridSize; ++i)
        f[(size_t) i] = kGridMinHz * std::exp (kLogSpan * i / (kGridSize - 1));
    f.back() = kGridMaxHz;
    return f;
}
} // namespace

const char* toString (FilterType t)
{
    switch (t)
    {
        case FilterType::bell:      return "bell";
        case FilterType::lowShelf:  return "low_shelf";
        case FilterType::highShelf: return "high_shelf";
        case FilterType::lowPass:   return "low_pass";
        case FilterType::highPass:  return "high_pass";
    }
    return "bell";
}

bool filterTypeFromString (const std::string& s, FilterType& out)
{
    for (auto t : { FilterType::bell, FilterType::lowShelf, FilterType::highShelf, FilterType::lowPass, FilterType::highPass })
    {
        if (s == toString (t))
        {
            out = t;
            return true;
        }
    }
    return false;
}

const GridCurve& gridFrequencies()
{
    static const GridCurve f = makeFrequencies();
    return f;
}

double gridFrequency (int index)
{
    return gridFrequencies()[(size_t) std::clamp (index, 0, kGridSize - 1)];
}

double gridPosition (double hz)
{
    return std::log (hz / kGridMinHz) / kLogSpan * (kGridSize - 1);
}

double sampleGridCurve (const GridCurve& c, double hz)
{
    if (! (hz > kGridMinHz))
        return c.front();
    if (hz >= kGridMaxHz)
        return c.back();

    const double pos = gridPosition (hz);
    const int i = std::clamp ((int) std::floor (pos), 0, kGridSize - 2);
    const double t = pos - i;
    return c[(size_t) i] + (c[(size_t) i + 1] - c[(size_t) i]) * t;
}

double sampleCorrectionExtended (const GridCurve& c, double hz, double minDb, double maxDb)
{
    double v;
    if (hz < kGridMinHz)
    {
        const double slopePerOct = (sampleGridCurve (c, kGridMinHz * std::exp2 (0.25)) - c.front()) / 0.25;
        const double o = std::max (-1.0, std::log2 (std::max (hz, 1e-3) / kGridMinHz));
        v = c.front() + slopePerOct * (o + 0.5 * o * o);
    }
    else if (hz > kGridMaxHz)
    {
        const double x = std::min (1.0, std::log2 (hz / kGridMaxHz) / 0.5);
        v = c.back() * 0.5 * (1.0 + std::cos (3.14159265358979323846 * x));
    }
    else
    {
        v = sampleGridCurve (c, hz);
    }
    return std::clamp (v, minDb, maxDb);
}

std::optional<std::string> sortAndValidate (RawCurve& curve)
{
    const auto n = curve.freqHz.size();
    if (n == 0 || curve.db.size() != n)
        return std::string ("Curve is empty or its columns have different lengths.");
    if (! curve.spreadDb.empty() && curve.spreadDb.size() != n)
        return std::string ("Spread column has a different length from the frequency column.");
    if (n < 8)
        return std::string ("Curve has fewer than 8 points.");

    for (size_t i = 0; i < n; ++i)
    {
        if (! std::isfinite (curve.freqHz[i]) || ! std::isfinite (curve.db[i])
            || (! curve.spreadDb.empty() && ! std::isfinite (curve.spreadDb[i])))
            return std::string ("Curve contains NaN or infinite values.");
        if (curve.freqHz[i] <= 0.0)
            return std::string ("Curve contains a frequency at or below 0 Hz.");
    }

    std::vector<size_t> order (n);
    std::iota (order.begin(), order.end(), size_t { 0 });
    std::stable_sort (order.begin(), order.end(), [&] (size_t a, size_t b) { return curve.freqHz[a] < curve.freqHz[b]; });

    RawCurve sorted;
    sorted.freqHz.reserve (n);
    sorted.db.reserve (n);
    for (auto i : order)
    {
        sorted.freqHz.push_back (curve.freqHz[i]);
        sorted.db.push_back (curve.db[i]);
        if (! curve.spreadDb.empty())
            sorted.spreadDb.push_back (curve.spreadDb[i]);
    }

    for (size_t i = 1; i < n; ++i)
        if (! (sorted.freqHz[i] > sorted.freqHz[i - 1]))
            return std::string ("Curve has duplicate frequency points.");

    // A 1% margin absorbs files that stop at 19.9 kHz or start at 20.1 Hz.
    if (sorted.freqHz.front() > kGridMinHz * 1.01 || sorted.freqHz.back() < kGridMaxHz / 1.01)
        return std::string ("Curve does not cover 20 Hz to 20 kHz.");

    curve = std::move (sorted);
    return std::nullopt;
}

GridCurve resampleToGrid (const std::vector<double>& freqHz, const std::vector<double>& values)
{
    GridCurve out {};
    const auto& grid = gridFrequencies();
    const size_t n = freqHz.size();
    size_t j = 0;

    for (int i = 0; i < kGridSize; ++i)
    {
        const double f = grid[(size_t) i];
        if (f <= freqHz.front())
        {
            out[(size_t) i] = values.front();
            continue;
        }
        if (f >= freqHz.back())
        {
            out[(size_t) i] = values.back();
            continue;
        }
        while (j + 1 < n && freqHz[j + 1] < f)
            ++j;
        const double l0 = std::log (freqHz[j]), l1 = std::log (freqHz[j + 1]);
        const double t = (std::log (f) - l0) / (l1 - l0);
        out[(size_t) i] = values[j] + (values[j + 1] - values[j]) * t;
    }
    return out;
}

double meanOver (const GridCurve& c, double loHz, double hiHz)
{
    const auto& grid = gridFrequencies();
    double sum = 0.0;
    int count = 0;
    for (int i = 0; i < kGridSize; ++i)
    {
        if (grid[(size_t) i] >= loHz && grid[(size_t) i] <= hiHz)
        {
            sum += c[(size_t) i];
            ++count;
        }
    }
    return count > 0 ? sum / count : 0.0;
}

void normaliseMidband (GridCurve& c)
{
    const double m = meanOver (c, 500.0, 2000.0);
    for (auto& v : c)
        v -= m;
}

double smoothingWidthOctaves (double hz)
{
    constexpr double narrow = 1.0 / 12.0, wide = 1.0 / 3.0;
    if (hz <= 1000.0)
        return narrow;
    if (hz >= 8000.0)
        return wide;
    return narrow + (wide - narrow) * std::log2 (hz / 1000.0) / 3.0;
}

GridCurve smoothVariable (const GridCurve& in)
{
    GridCurve out {};
    const double octavesPerPoint = std::log2 (kGridMaxHz / kGridMinHz) / (kGridSize - 1);

    for (int i = 0; i < kGridSize; ++i)
    {
        const double halfWidthPoints = 0.5 * smoothingWidthOctaves (gridFrequency (i)) / octavesPerPoint;
        const int lo = std::max (0, (int) std::ceil (i - halfWidthPoints));
        const int hi = std::min (kGridSize - 1, (int) std::floor (i + halfWidthPoints));

        // Keep the window symmetric at the edges so a slope is not biased.
        const int reach = std::min (i - lo, hi - i);
        double sum = 0.0;
        for (int k = i - reach; k <= i + reach; ++k)
            sum += in[(size_t) k];
        out[(size_t) i] = sum / (2 * reach + 1);
    }
    return out;
}

} // namespace ref::dsp

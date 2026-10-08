// Correction generator (spec Section 4) and supporting maths.

#include "TestData.h"
#include "TestFramework.h"

#include "ref/dsp/Biquad.h"
#include "ref/dsp/CorrectionGenerator.h"
#include "ref/dsp/FilterSet.h"
#include "ref/dsp/Format.h"
#include "ref/dsp/Grid.h"

#include <algorithm>
#include <cmath>
#include <limits>

using namespace ref::dsp;

namespace
{
CurveSource flatCurve (const std::string& rig, double db = 0.0)
{
    CurveSource c { rig, {} };
    for (int i = 0; i <= 120; ++i)
    {
        c.curve.freqHz.push_back (20.0 * std::pow (1000.0, i / 120.0));
        c.curve.db.push_back (db);
    }
    return c;
}

bool hasWarning (const CorrectionResult& r, WarningCode code)
{
    return std::any_of (r.warnings.begin(), r.warnings.end(), [code] (const auto& w) { return w.code == code; });
}
} // namespace

TEST_CASE ("format: minus sign, en dash and frequency ranges")
{
    CHECK (formatDb (-1.5) == "\xE2\x88\x92" "1.5 dB");
    CHECK (formatDb (6.0, 0, true) == "+6 dB");
    CHECK (formatDb (-0.04) == "0.0 dB");
    CHECK (formatFrequencyRange (20.0, 46.0) == "20\xE2\x80\x93" "46 Hz");
    CHECK (formatFrequencyRange (1200.0, 2400.0) == "1.2\xE2\x80\x93" "2.4 kHz");
    CHECK (formatFrequencyRange (800.0, 1200.0) == "800 Hz\xE2\x80\x93" "1.2 kHz");
    CHECK (formatFrequency (1020.0) == "1.02 kHz");
    CHECK (formatFrequency (46.0) == "46 Hz");
}

TEST_CASE ("validation: rejects NaN, duplicates, short coverage")
{
    auto good = flatCurve ("rig-01").curve;
    CHECK (! sortAndValidate (good).has_value());

    auto nan = flatCurve ("rig-01").curve;
    nan.db[10] = std::numeric_limits<double>::quiet_NaN();
    CHECK (sortAndValidate (nan).has_value());

    auto dup = flatCurve ("rig-01").curve;
    dup.freqHz[11] = dup.freqHz[10];
    CHECK (sortAndValidate (dup).has_value());

    auto shortCurve = flatCurve ("rig-01").curve;
    shortCurve.freqHz.resize (100);
    shortCurve.db.resize (100);
    CHECK (sortAndValidate (shortCurve).has_value());

    // Unsorted input is fine once sorted.
    auto shuffled = flatCurve ("rig-01").curve;
    std::swap (shuffled.freqHz[3], shuffled.freqHz[40]);
    std::swap (shuffled.db[3], shuffled.db[40]);
    CHECK (! sortAndValidate (shuffled).has_value());
    CHECK (std::is_sorted (shuffled.freqHz.begin(), shuffled.freqHz.end()));
}

TEST_CASE ("generator: refuses a measurement and target from different rigs")
{
    const auto r = generateCorrection (flatCurve ("rig-01"), flatCurve ("rig-02"));
    CHECK (! r.generated);
    CHECK (r.filters.empty());
    CHECK (hasWarning (r, WarningCode::rigMismatch));
    CHECK (r.warnings.front().message == "Measurement and target come from different rigs; correction not generated.");
}

TEST_CASE ("generator: invalid measurement reports no valid measurement")
{
    auto m = flatCurve ("rig-01");
    m.curve.db[5] = std::numeric_limits<double>::infinity();
    const auto r = generateCorrection (m, flatCurve ("rig-01"));
    CHECK (! r.generated);
    CHECK (r.warnings.size() == 1 && r.warnings[0].message == "No valid measurement loaded.");
}

TEST_CASE ("generator: identical measurement and target need no correction")
{
    const auto r = generateCorrection (flatCurve ("rig-01", 3.0), flatCurve ("rig-01", -2.0));
    CHECK (r.generated);
    for (double v : r.correction)
        CHECK_NEAR (v, 0.0, 1e-9);
    CHECK (r.warnings.empty());
}

TEST_CASE ("generator: clamps boosts and cuts and reports the limited range")
{
    // A deep low-bass roll-off needs far more than +6 dB.
    auto m = flatCurve ("rig-01");
    for (size_t i = 0; i < m.curve.freqHz.size(); ++i)
    {
        const double f = m.curve.freqHz[i];
        m.curve.db[i] = f < 40.0 ? -14.0 * (1.0 - std::log2 (f / 20.0)) : 0.0;
        if (f > 5000.0 && f < 6000.0)
            m.curve.db[i] = 15.0; // and a large peak needing more than -12 dB
    }
    const auto r = generateCorrection (m, flatCurve ("rig-01"));
    CHECK (r.generated);
    CHECK (*std::max_element (r.correction.begin(), r.correction.end()) <= 6.0 + 1e-9);
    CHECK (*std::min_element (r.correction.begin(), r.correction.end()) >= -12.0 - 1e-9);
    CHECK (hasWarning (r, WarningCode::boostLimited));
    CHECK (hasWarning (r, WarningCode::cutLimited));
    CHECK (! r.boostLimitedRanges.empty() && r.boostLimitedRanges[0].first <= 20.5);

    for (const auto& w : r.warnings)
        if (w.code == WarningCode::boostLimited)
            CHECK (w.message == "This correction needs more than +6 dB of boost; it was limited.");
}

TEST_CASE ("generator: treble above 9 kHz is corrected as an average level only")
{
    auto m = flatCurve ("rig-01");
    for (size_t i = 0; i < m.curve.freqHz.size(); ++i)
    {
        const double f = m.curve.freqHz[i];
        if (f > 10000.0)
            m.curve.db[i] = 4.0 * std::sin (f / 900.0); // sharp fit-dependent peaks and notches
    }
    const auto r = generateCorrection (m, flatCurve ("rig-01"));
    double lo = 1e9, hi = -1e9;
    for (int i = 0; i < kGridSize; ++i)
    {
        if (gridFrequency (i) >= 12000.0)
        {
            lo = std::min (lo, r.correction[(size_t) i]);
            hi = std::max (hi, r.correction[(size_t) i]);
        }
    }
    CHECK_MSG (hi - lo < 0.5, "treble correction varies by " + std::to_string (hi - lo) + " dB above 12 kHz");
}

TEST_CASE ("generator: large spread halves the correction")
{
    auto m = flatCurve ("rig-01");
    m.curve.spreadDb.assign (m.curve.freqHz.size(), 3.0);
    for (size_t i = 0; i < m.curve.freqHz.size(); ++i)
        if (m.curve.freqHz[i] > 150.0 && m.curve.freqHz[i] < 300.0)
            m.curve.db[i] = -2.0;
    auto mNarrow = m;
    mNarrow.curve.spreadDb.assign (m.curve.freqHz.size(), 0.5);
    const auto wide = generateCorrection (m, flatCurve ("rig-01"));
    const auto narrow = generateCorrection (mNarrow, flatCurve ("rig-01"));
    const int i = (int) std::lround (gridPosition (210.0));
    CHECK_NEAR (wide.correction[(size_t) i], 0.5 * narrow.correction[(size_t) i], 0.05);
}

TEST_CASE ("generator: slope limiter only ever reduces the correction")
{
    GridCurve c {};
    for (int i = 0; i < kGridSize; ++i)
        c[(size_t) i] = (i % 40 < 20) ? 5.0 : -5.0;
    const auto before = c;
    limitSlope (c, 18.0);
    const double maxStep = 18.0 * std::log2 (1000.0) / (kGridSize - 1);
    for (int i = 0; i + 1 < kGridSize; ++i)
    {
        CHECK (std::abs (c[(size_t) i + 1] - c[(size_t) i]) <= maxStep + 1e-9);
        CHECK (std::abs (c[(size_t) i]) <= std::abs (before[(size_t) i]) + 1e-12);
    }
}

TEST_CASE ("generator: placeholder profiles fit within tolerance (Section 4, step 10)")
{
    for (const char* p : { "audeze_mm520", "audeze_mm500" })
    {
        for (const char* t : { "studio_reference@1.csv", "neutral@1.csv" })
        {
            const auto r = generateCorrection (reftest::loadProfile (p), reftest::loadTarget (t));
            CHECK (r.generated);
            CHECK_MSG (r.fitRmsDb < 0.5, std::string (p) + " " + t + " fit RMS " + std::to_string (r.fitRmsDb));
            CHECK_MSG (r.fitMaxDb < 1.5, std::string (p) + " " + t + " fit max " + std::to_string (r.fitMaxDb));
            CHECK (! hasWarning (r, WarningCode::fitOutOfTolerance));

            int shelves = 0, bells = 0;
            for (const auto& f : r.filters)
            {
                if (f.type == FilterType::bell)
                {
                    ++bells;
                    CHECK (f.q <= 3.0 + 1e-9);
                }
                else
                {
                    ++shelves;
                }
            }
            CHECK (shelves <= 2 && bells <= 10);
        }
    }
}

TEST_CASE ("generator: deterministic")
{
    const auto a = generateCorrection (reftest::loadProfile ("audeze_mm520"), reftest::loadTarget ("neutral@1.csv"));
    const auto b = generateCorrection (reftest::loadProfile ("audeze_mm520"), reftest::loadTarget ("neutral@1.csv"));
    CHECK (a.correction == b.correction);
    CHECK (a.filters == b.filters);
}

TEST_CASE ("biquad: 0 dB design is exactly unity")
{
    const auto c = designMatched ({ FilterType::bell, 1000.0, 0.0, 2.0 }, 48000.0);
    CHECK (c.b0 == 1.0 && c.b1 == 0.0 && c.b2 == 0.0 && c.a1 == 0.0 && c.a2 == 0.0);
}

TEST_CASE ("biquad: matched design tracks the analogue prototype below 10 kHz")
{
    for (double fs : kSupportedSampleRates)
    {
        for (const FilterSpec& s : { FilterSpec { FilterType::bell, 1000, 6, 3 }, FilterSpec { FilterType::lowShelf, 100, -8, 0.7071 },
                                     FilterSpec { FilterType::highShelf, 6000, 5, 0.7071 }, FilterSpec { FilterType::bell, 40, 4, 0.5 } })
        {
            const auto c = designMatched (s, fs);
            for (int i = 0; i < 200; ++i)
            {
                const double f = 20.0 * std::pow (500.0, i / 199.0);
                CHECK_NEAR (digitalMagnitudeDb (c, f, fs), analogMagnitudeDb (s, f), 0.05);
            }
        }
    }
}

TEST_CASE ("biquad: high-pass has no DC response and tracks the prototype")
{
    for (double fs : kSupportedSampleRates)
    {
        const FilterSpec s { FilterType::highPass, 80.0, 0.0, 0.7071 };
        const auto c = designMatched (s, fs);
        CHECK (std::abs (c.b0 + c.b1 + c.b2) < 1e-12);
        for (int i = 0; i < 200; ++i)
        {
            const double f = 10.0 * std::pow (2000.0, i / 199.0); // down to -40 dB
            CHECK_NEAR (digitalMagnitudeDb (c, f, fs), analogMagnitudeDb (s, f), 0.05);
        }
    }
}

// Compilers and maths libraries round differently in the last bit. The
// Minimum Phase cascade must give the same accuracy on every platform, so
// the design is checked with its inputs nudged by a few ulps.
TEST_CASE ("biquad: cascade accuracy does not depend on last-bit rounding")
{
    const CorrectionResult corrections[] = {
        reftest::mm520Studio(), generateCorrection (reftest::loadProfile ("audeze_mm500"), reftest::loadTarget ("neutral@1.csv"))
    };
    for (const auto& corr : corrections)
    {
        for (double fs : kSupportedSampleRates)
        {
            const auto analogue = reftest::configFor (corr, FilterMode::minimumPhase, fs).calibration;
            double lo = 1e9, hi = 0.0;
            for (int k = 0; k < 8; ++k)
            {
                auto nudged = analogue;
                for (size_t j = 0; j < nudged.size(); ++j)
                {
                    nudged[j].freqHz *= 1.0 + (double) ((k * 7 + (int) j * 3) % 9 - 4) * 1e-15;
                    nudged[j].q *= 1.0 + (double) ((k * 5 + (int) j) % 7 - 3) * 1e-15;
                }
                const auto digital = refineCascadeForRate (nudged, fs);
                double worst = 0.0;
                for (int i = 0; i < 400; ++i)
                {
                    const double f = 20.0 * std::pow (1000.0, i / 399.0);
                    double db = 0.0;
                    for (const auto& s : digital)
                        db += digitalMagnitudeDb (designMatched (s, fs), f, fs);
                    worst = std::max (worst, std::abs (db - analogCascadeDb (analogue.data(), (int) analogue.size(), f)));
                }
                lo = std::min (lo, worst);
                hi = std::max (hi, worst);
            }
            CHECK_MSG (hi < 0.05 && hi - lo < 0.005,
                       std::to_string (fs) + " Hz: " + std::to_string (lo) + " .. " + std::to_string (hi) + " dB");
        }
    }
}

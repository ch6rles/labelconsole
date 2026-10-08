#include "ref/dsp/CorrectionGenerator.h"

#include "ref/dsp/Biquad.h"
#include "ref/dsp/Format.h"
#include "ref/dsp/LeastSquares.h"
#include "ref/dsp/Loudness.h"

#include <algorithm>
#include <cmath>

namespace ref::dsp
{

namespace
{
const double kOctavesPerPoint = std::log2 (kGridMaxHz / kGridMinHz) / (kGridSize - 1);

double sigmoid (double hz, double centreHz, double steepness)
{
    return 1.0 / (1.0 + std::exp (-std::log2 (hz / centreHz) * steepness));
}

// Confidence weighting (step 6): full strength up to 1.2 dB spread, half
// strength from 2 dB, linear in between.
double confidenceWeight (double spreadDb)
{
    if (spreadDb <= 1.2)
        return 1.0;
    if (spreadDb >= 2.0)
        return 0.5;
    return 1.0 - 0.5 * (spreadDb - 1.2) / 0.8;
}

std::vector<std::pair<double, double>> findRanges (const GridCurve& c, double threshold, bool above)
{
    std::vector<std::pair<double, double>> ranges;
    int start = -1;
    for (int i = 0; i <= kGridSize; ++i)
    {
        const bool in = i < kGridSize && (above ? c[(size_t) i] > threshold : c[(size_t) i] < threshold);
        if (in && start < 0)
            start = i;
        if (! in && start >= 0)
        {
            ranges.emplace_back (gridFrequency (start), gridFrequency (i - 1));
            start = -1;
        }
    }
    return ranges;
}

std::string joinRanges (const std::vector<std::pair<double, double>>& ranges)
{
    std::string s;
    for (const auto& r : ranges)
    {
        if (! s.empty())
            s += ", ";
        s += formatFrequencyRange (r.first, r.second);
    }
    return s;
}

double weightAt (double hz)
{
    return (hz >= 50.0 && hz <= 8000.0) ? 1.0 : 0.5;
}

//==============================================================================
// Parameter packing for the fitter: [log2 f, gain, (log2 Q)] per filter.
struct FitLayout
{
    std::vector<FilterSpec> filters;
    std::vector<bool> qFixed;

    int paramCount() const
    {
        int n = 0;
        for (bool fixed : qFixed)
            n += fixed ? 2 : 3;
        return n;
    }
};

void unpack (const FitLayout& layout, const std::vector<double>& p, std::vector<FilterSpec>& out)
{
    out = layout.filters;
    size_t k = 0;
    for (size_t i = 0; i < out.size(); ++i)
    {
        out[i].freqHz = std::exp2 (p[k++]);
        out[i].gainDb = p[k++];
        if (! layout.qFixed[i])
            out[i].q = std::exp2 (p[k++]);
    }
}

void bounds (FilterType t, const GeneratorLimits& lim, double& fLo, double& fHi)
{
    switch (t)
    {
        case FilterType::lowShelf:  fLo = 20.0;   fHi = 300.0;   break;
        case FilterType::highShelf: fLo = 2000.0; fHi = 12000.0; break;
        default:                    fLo = 20.0;   fHi = std::min (12000.0, lim.trebleAverageAboveHz * 1.4); break;
    }
}

LmProblem makeProblem (const FitLayout& layout, const GridCurve& target, const GeneratorLimits& lim)
{
    LmProblem prob;
    prob.numResiduals = kGridSize;
    for (size_t i = 0; i < layout.filters.size(); ++i)
    {
        const auto& f = layout.filters[i];
        double fLo, fHi;
        bounds (f.type, lim, fLo, fHi);
        prob.params.push_back (std::log2 (std::clamp (f.freqHz, fLo, fHi)));
        prob.lower.push_back (std::log2 (fLo));
        prob.upper.push_back (std::log2 (fHi));
        prob.step.push_back (1e-3);

        prob.params.push_back (std::clamp (f.gainDb, -15.0, 12.0));
        prob.lower.push_back (-15.0);
        prob.upper.push_back (12.0);
        prob.step.push_back (1e-3);

        if (! layout.qFixed[i])
        {
            prob.params.push_back (std::log2 (std::clamp (f.q, 0.3, lim.maxQ)));
            prob.lower.push_back (std::log2 (0.3));
            prob.upper.push_back (std::log2 (lim.maxQ));
            prob.step.push_back (1e-3);
        }
    }

    static const GridCurve sqrtWeights = []
    {
        GridCurve w {};
        for (int i = 0; i < kGridSize; ++i)
            w[(size_t) i] = std::sqrt (weightAt (gridFrequency (i)));
        return w;
    }();

    prob.residuals = [layout, target] (const std::vector<double>& p, std::vector<double>& r)
    {
        std::vector<FilterSpec> fs;
        unpack (layout, p, fs);
        for (int i = 0; i < kGridSize; ++i)
        {
            const double hz = gridFrequency (i);
            r[(size_t) i] = sqrtWeights[(size_t) i] * (analogCascadeDb (fs.data(), (int) fs.size(), hz) - target[(size_t) i]);
        }
    };

    // Each parameter moves one filter only, so a Jacobian column needs that
    // filter's response alone.
    prob.jacobian = [layout] (const std::vector<double>& p, const std::vector<double>&, std::vector<double>& J)
    {
        std::vector<FilterSpec> fs;
        unpack (layout, p, fs);
        const int P = (int) p.size();
        std::vector<double> base ((size_t) kGridSize);
        int col = 0;
        for (size_t fi = 0; fi < fs.size(); ++fi)
        {
            for (int i = 0; i < kGridSize; ++i)
                base[(size_t) i] = analogMagnitudeDb (fs[fi], gridFrequency (i));

            const int nParams = layout.qFixed[fi] ? 2 : 3;
            for (int k = 0; k < nParams; ++k, ++col)
            {
                auto pert = fs[fi];
                const double h = 1e-4;
                if (k == 0)
                    pert.freqHz = std::exp2 (std::log2 (pert.freqHz) + h);
                else if (k == 1)
                    pert.gainDb += h;
                else
                    pert.q = std::exp2 (std::log2 (pert.q) + h);

                for (int i = 0; i < kGridSize; ++i)
                {
                    const double d = (analogMagnitudeDb (pert, gridFrequency (i)) - base[(size_t) i]) / h;
                    J[(size_t) (i * P + col)] = sqrtWeights[(size_t) i] * d;
                }
            }
        }
    };
    return prob;
}

void optimise (FitLayout& layout, const GridCurve& target, const GeneratorLimits& lim, int iterations)
{
    if (layout.filters.empty())
        return;
    const auto prob = makeProblem (layout, target, lim);
    const auto res = solveLevenbergMarquardt (prob, iterations, 1e-6);
    unpack (layout, res.params, layout.filters);
}

GridCurve modelCurve (const std::vector<FilterSpec>& fs)
{
    GridCurve m {};
    for (int i = 0; i < kGridSize; ++i)
        m[(size_t) i] = analogCascadeDb (fs.data(), (int) fs.size(), gridFrequency (i));
    return m;
}
} // namespace

//==============================================================================
void limitSlope (GridCurve& c, double maxDbPerOctave)
{
    if (! (maxDbPerOctave > 0.0))
        return;
    const double maxStep = maxDbPerOctave * kOctavesPerPoint;
    for (int pass = 0; pass < 4000; ++pass)
    {
        bool changed = false;
        for (int i = 0; i + 1 < kGridSize; ++i)
        {
            const double d = c[(size_t) i + 1] - c[(size_t) i];
            if (std::abs (d) <= maxStep + 1e-12)
                continue;
            const double dir = d > 0.0 ? 1.0 : -1.0;
            if (std::abs (c[(size_t) i + 1]) > std::abs (c[(size_t) i]))
                c[(size_t) i + 1] = c[(size_t) i] + dir * maxStep;
            else
                c[(size_t) i] = c[(size_t) i + 1] - dir * maxStep;
            changed = true;
        }
        if (! changed)
            break;
    }
}

void fitError (const std::vector<FilterSpec>& fs, const GridCurve& curve, double loHz, double hiHz, double& rmsDb, double& maxDb)
{
    double sum = 0.0, peak = 0.0;
    int count = 0;
    for (int i = 0; i < kGridSize; ++i)
    {
        const double hz = gridFrequency (i);
        if (hz < loHz || hz > hiHz)
            continue;
        const double e = analogCascadeDb (fs.data(), (int) fs.size(), hz) - curve[(size_t) i];
        sum += e * e;
        peak = std::max (peak, std::abs (e));
        ++count;
    }
    rmsDb = count > 0 ? std::sqrt (sum / count) : 0.0;
    maxDb = peak;
}

FitResult fitParametric (const GridCurve& curve, const GeneratorLimits& lim)
{
    FitLayout layout;

    // Shelves first: they carry the broad bass and treble levels.
    if (lim.maxShelves >= 1)
    {
        layout.filters.push_back ({ FilterType::lowShelf, 100.0, meanOver (curve, 20.0, 40.0), 0.7071067811865476 });
        layout.qFixed.push_back (true);
    }
    if (lim.maxShelves >= 2)
    {
        layout.filters.push_back ({ FilterType::highShelf, 8000.0, meanOver (curve, 10000.0, 20000.0), 0.7071067811865476 });
        layout.qFixed.push_back (true);
    }
    optimise (layout, curve, lim, 40);

    const double fHiBell = std::min (12000.0, lim.trebleAverageAboveHz * 1.4);
    double rms = 0.0, peak = 0.0;

    for (int b = 0; b < lim.maxBells; ++b)
    {
        fitError (layout.filters, curve, 50.0, 8000.0, rms, peak);
        if (rms < 0.12 && peak < 0.35)
            break;

        const auto model = modelCurve (layout.filters);
        GridCurve residual {};
        for (int i = 0; i < kGridSize; ++i)
            residual[(size_t) i] = curve[(size_t) i] - model[(size_t) i];

        int best = -1;
        double bestScore = 0.0;
        for (int i = 0; i < kGridSize; ++i)
        {
            const double hz = gridFrequency (i);
            if (hz > fHiBell)
                break;
            const double score = weightAt (hz) * std::abs (residual[(size_t) i]);
            if (score > bestScore)
            {
                bestScore = score;
                best = i;
            }
        }
        if (best < 0 || std::abs (residual[(size_t) best]) < 0.2)
            break;

        // Bandwidth from the half-height points of the residual peak.
        const double peakVal = residual[(size_t) best];
        int lo = best, hi = best;
        while (lo > 0 && residual[(size_t) lo - 1] * peakVal > 0.0 && std::abs (residual[(size_t) lo - 1]) > 0.5 * std::abs (peakVal))
            --lo;
        while (hi + 1 < kGridSize && residual[(size_t) hi + 1] * peakVal > 0.0 && std::abs (residual[(size_t) hi + 1]) > 0.5 * std::abs (peakVal))
            ++hi;
        const double bwOct = std::max ((hi - lo + 1) * kOctavesPerPoint, 0.1);
        const double r = std::exp2 (bwOct);
        const double q = std::clamp (std::sqrt (r) / (r - 1.0), 0.3, lim.maxQ);

        layout.filters.push_back ({ FilterType::bell, std::min (gridFrequency (best), fHiBell), peakVal, q });
        layout.qFixed.push_back (false);
        optimise (layout, curve, lim, 30);
    }

    // Drop bells that ended up doing nothing, then settle once more.
    {
        FitLayout pruned;
        for (size_t i = 0; i < layout.filters.size(); ++i)
        {
            const auto& f = layout.filters[i];
            if (f.type == FilterType::bell && std::abs (f.gainDb) < 0.1)
                continue;
            pruned.filters.push_back (f);
            pruned.qFixed.push_back (layout.qFixed[i]);
        }
        if (pruned.filters.size() != layout.filters.size())
        {
            layout = pruned;
            optimise (layout, curve, lim, 30);
        }
    }

    FitResult out;
    out.filters = layout.filters;
    std::stable_sort (out.filters.begin(), out.filters.end(), [] (const FilterSpec& a, const FilterSpec& b)
    {
        auto rank = [] (const FilterSpec& f) { return f.type == FilterType::lowShelf ? 0 : f.type == FilterType::highShelf ? 2 : 1; };
        if (rank (a) != rank (b))
            return rank (a) < rank (b);
        return a.freqHz < b.freqHz;
    });
    fitError (out.filters, curve, 50.0, 8000.0, out.rmsDb, out.maxDb);
    return out;
}

//==============================================================================
CorrectionResult generateCorrection (const CurveSource& measurementIn, const CurveSource& targetIn, const GeneratorLimits& lim)
{
    CorrectionResult res;

    auto measurement = measurementIn;
    auto target = targetIn;

    // Step 1: validate.
    if (auto err = sortAndValidate (measurement.curve))
    {
        res.warnings.push_back ({ WarningCode::noMeasurement, "No valid measurement loaded.", *err, {} });
        return res;
    }
    if (auto err = sortAndValidate (target.curve))
    {
        res.warnings.push_back ({ WarningCode::invalidTarget, "Target curve is invalid; correction not generated.", *err, {} });
        return res;
    }

    // A target only means something on the rig it was defined for.
    if (measurement.rigId != target.rigId)
    {
        res.warnings.push_back ({ WarningCode::rigMismatch,
                                  "Measurement and target come from different rigs; correction not generated.",
                                  measurement.rigId + " / " + target.rigId, {} });
        return res;
    }

    // Steps 2-4: resample, normalise, smooth.
    auto measured = resampleToGrid (measurement.curve.freqHz, measurement.curve.db);
    auto tgt = resampleToGrid (target.curve.freqHz, target.curve.db);
    GridCurve spread {};
    if (! measurement.curve.spreadDb.empty())
        spread = resampleToGrid (measurement.curve.freqHz, measurement.curve.spreadDb);

    normaliseMidband (measured);
    normaliseMidband (tgt);
    measured = smoothVariable (measured);
    tgt = smoothVariable (tgt);
    spread = smoothVariable (spread);
    for (auto& s : spread)
        s = std::max (0.0, s);

    res.measured = measured;
    res.target = tgt;
    res.spread = spread;

    // Steps 5-7: error, confidence weighting, treble policy.
    GridCurve corr {};
    for (int i = 0; i < kGridSize; ++i)
        corr[(size_t) i] = (tgt[(size_t) i] - measured[(size_t) i]) * confidenceWeight (spread[(size_t) i]);

    double trebleSum = 0.0;
    int trebleCount = 0;
    for (int i = 0; i < kGridSize; ++i)
    {
        if (gridFrequency (i) >= lim.trebleAverageAboveHz)
        {
            trebleSum += corr[(size_t) i];
            ++trebleCount;
        }
    }
    const double trebleAvg = trebleCount > 0 ? trebleSum / trebleCount : 0.0;
    for (int i = 0; i < kGridSize; ++i)
    {
        const double t = sigmoid (gridFrequency (i), lim.trebleAverageAboveHz, 6.0);
        corr[(size_t) i] = (1.0 - t) * corr[(size_t) i] + t * trebleAvg;
    }
    res.trebleAverageDb = trebleAvg;

    // Step 8: clamp and slope-limit, remembering where the limits bit.
    res.boostLimitedRanges = findRanges (corr, lim.maxBoostDb + 0.05, true);
    const auto cutRanges = findRanges (corr, lim.maxCutDb - 0.05, false);
    for (auto& v : corr)
        v = std::clamp (v, lim.maxCutDb, lim.maxBoostDb);
    limitSlope (corr, lim.maxSlopeDbPerOctave);
    res.correction = corr;
    res.largestBoostDb = std::max (0.0, *std::max_element (corr.begin(), corr.end()));

    if (! res.boostLimitedRanges.empty())
        res.warnings.push_back ({ WarningCode::boostLimited,
                                  "This correction needs more than " + formatDb (lim.maxBoostDb, 0, true) + " of boost; it was limited.",
                                  joinRanges (res.boostLimitedRanges), res.boostLimitedRanges });
    if (! cutRanges.empty())
        res.warnings.push_back ({ WarningCode::cutLimited,
                                  "This correction needs more than " + formatDb (lim.maxCutDb, 0) + " of cut; it was limited.",
                                  joinRanges (cutRanges), cutRanges });
    if (std::abs (trebleAvg) > lim.largeTrebleDb)
        res.warnings.push_back ({ WarningCode::largeTreble, "Large upper-treble correction; results depend heavily on fit.",
                                  formatDb (trebleAvg, 1, true) + " above " + formatFrequency (lim.trebleAverageAboveHz), {} });

    // Steps 9-10: fit and validate.
    const auto fit = fitParametric (corr, lim);
    res.filters = fit.filters;
    res.fitRmsDb = fit.rmsDb;
    res.fitMaxDb = fit.maxDb;
    if (fit.rmsDb > 0.5 || fit.maxDb > 1.5)
        res.warnings.push_back ({ WarningCode::fitOutOfTolerance,
                                  "Minimum Phase filters miss the correction curve by up to " + formatDb (fit.maxDb, 1) + ".",
                                  "RMS " + formatDb (fit.rmsDb, 2) + ", 50 Hz" + kEnDash + "8 kHz", {} });

    // Step 11: the loudness match of the curve itself, for reference.
    res.matchGainDb = loudnessMatchGainDb (corr);
    res.generated = true;
    return res;
}

} // namespace ref::dsp

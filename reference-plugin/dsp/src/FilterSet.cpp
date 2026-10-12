#include "ref/dsp/FilterSet.h"

#include "ref/dsp/Grid.h"
#include "ref/dsp/LeastSquares.h"
#include "ref/dsp/Loudness.h"

#include <algorithm>
#include <cmath>

namespace ref::dsp
{

namespace
{
constexpr int kRefinePoints = 240;

const std::array<double, kRefinePoints>& refineFrequencies()
{
    static const auto f = []
    {
        std::array<double, kRefinePoints> a {};
        for (int i = 0; i < kRefinePoints; ++i)
            a[(size_t) i] = 20.0 * std::pow (1000.0, i / (kRefinePoints - 1.0));
        return a;
    }();
    return f;
}

void digitalResponseOf (const FilterSpec& s, double fs, double* out)
{
    const auto c = designMatched (s, fs);
    const auto& f = refineFrequencies();
    for (int i = 0; i < kRefinePoints; ++i)
        out[i] = digitalMagnitudeDb (c, f[(size_t) i], fs);
}
} // namespace

std::vector<FilterSpec> refineCascadeForRate (const std::vector<FilterSpec>& analogue, double fs, const std::vector<FilterSpec>& startFrom)
{
    if (analogue.empty())
        return analogue;

    const auto& freqs = refineFrequencies();
    const int n = (int) analogue.size();

    std::vector<double> target ((size_t) kRefinePoints);
    for (int i = 0; i < kRefinePoints; ++i)
        target[(size_t) i] = analogCascadeDb (analogue.data(), n, freqs[(size_t) i]);

    // Specs entering the design are clamped below Nyquist.
    auto clampSpec = [fs] (FilterSpec s)
    {
        s.freqHz = std::min (s.freqHz, 0.45 * fs);
        return s;
    };

    auto errorOf = [&] (const std::vector<FilterSpec>& specs)
    {
        std::vector<double> sum ((size_t) kRefinePoints, 0.0), r ((size_t) kRefinePoints);
        for (const auto& s : specs)
        {
            digitalResponseOf (clampSpec (s), fs, r.data());
            for (int i = 0; i < kRefinePoints; ++i)
                sum[(size_t) i] += r[(size_t) i];
        }
        double worst = 0.0;
        for (int i = 0; i < kRefinePoints; ++i)
            worst = std::max (worst, std::abs (sum[(size_t) i] - target[(size_t) i]));
        return worst;
    };

    std::vector<FilterSpec> start;
    for (const auto& s : analogue)
        start.push_back (clampSpec (s));
    const double initialError = errorOf (start);

    // A seed that is already accurate wins, so neighbouring Amounts stay on
    // the same answer.
    std::vector<FilterSpec> seeded;
    double seededError = 1e9;
    if (startFrom.size() == start.size())
    {
        seeded = startFrom;
        for (size_t i = 0; i < seeded.size(); ++i)
        {
            const auto& a = start[i];
            auto& s = seeded[i];
            s.freqHz = std::clamp (s.freqHz, a.freqHz * std::exp2 (-0.5), std::min (a.freqHz * std::exp2 (0.5), 0.45 * fs));
            s.gainDb = std::clamp (s.gainDb, a.gainDb - 3.0, a.gainDb + 3.0);
            s.q = std::clamp (s.q, a.q * 0.5, a.q * 2.0);
        }
        seededError = errorOf (seeded);
        if (seededError < 0.03)
            return seeded;
    }
    if (initialError < 0.02)
        return start;

    LmProblem prob;
    prob.numResiduals = kRefinePoints;
    for (const auto& s : start)
    {
        const double lf = std::log2 (s.freqHz);
        prob.lower.push_back (lf - 0.5);
        prob.upper.push_back (std::min (lf + 0.5, std::log2 (0.45 * fs)));
        prob.lower.push_back (s.gainDb - 3.0);
        prob.upper.push_back (s.gainDb + 3.0);
        const double lq = std::log2 (s.q);
        prob.lower.push_back (lq - 1.0);
        prob.upper.push_back (lq + 1.0);
    }
    prob.step.assign (prob.lower.size(), 1e-4);

    auto pack = [] (const std::vector<FilterSpec>& specs)
    {
        std::vector<double> p;
        for (const auto& s : specs)
        {
            p.push_back (std::log2 (s.freqHz));
            p.push_back (s.gainDb);
            p.push_back (std::log2 (s.q));
        }
        return p;
    };
    auto unpackSpecs = [start] (const std::vector<double>& p)
    {
        auto specs = start;
        for (size_t i = 0; i < specs.size(); ++i)
        {
            specs[i].freqHz = std::exp2 (p[i * 3]);
            specs[i].gainDb = p[i * 3 + 1];
            specs[i].q = std::exp2 (p[i * 3 + 2]);
        }
        return specs;
    };

    // Least squares with weights, reweighted toward the largest misses
    // between rounds (Lawson), so the worst error comes down, not just the
    // mean: the spec bound is on the worst frequency.
    std::vector<double> sqrtWeight ((size_t) kRefinePoints, 1.0);

    prob.residuals = [&, unpackSpecs] (const std::vector<double>& p, std::vector<double>& r)
    {
        std::fill (r.begin(), r.end(), 0.0);
        std::vector<double> one ((size_t) kRefinePoints);
        for (const auto& s : unpackSpecs (p))
        {
            digitalResponseOf (s, fs, one.data());
            for (int i = 0; i < kRefinePoints; ++i)
                r[(size_t) i] += one[(size_t) i];
        }
        for (int i = 0; i < kRefinePoints; ++i)
            r[(size_t) i] = (r[(size_t) i] - target[(size_t) i]) * sqrtWeight[(size_t) i];
    };

    prob.jacobian = [&, unpackSpecs] (const std::vector<double>& p, const std::vector<double>&, std::vector<double>& J)
    {
        const auto specs = unpackSpecs (p);
        const int P = (int) p.size();
        std::vector<double> base ((size_t) kRefinePoints), pert ((size_t) kRefinePoints);
        for (size_t f = 0; f < specs.size(); ++f)
        {
            digitalResponseOf (specs[f], fs, base.data());
            for (int k = 0; k < 3; ++k)
            {
                auto s = specs[f];
                const double h = 1e-4;
                if (k == 0)
                    s.freqHz = std::exp2 (std::log2 (s.freqHz) + h);
                else if (k == 1)
                    s.gainDb += h;
                else
                    s.q = std::exp2 (std::log2 (s.q) + h);
                digitalResponseOf (s, fs, pert.data());
                const int col = (int) f * 3 + k;
                for (int i = 0; i < kRefinePoints; ++i)
                    J[(size_t) (i * P + col)] = (pert[(size_t) i] - base[(size_t) i]) / h * sqrtWeight[(size_t) i];
            }
        }
    };

    auto best = start;
    double bestError = initialError;
    std::vector<double> weight ((size_t) kRefinePoints, 1.0), sum ((size_t) kRefinePoints), one ((size_t) kRefinePoints);
    prob.params = pack (start);
    if (! seeded.empty())
    {
        // Stay near the seed: the answers for neighbouring Amounts are
        // interpolated, so they must not jump to a different solution.
        prob.params = pack (seeded);
        constexpr double reach[] = { 0.05, 0.25, 0.1 }; // octaves, dB, octaves
        for (size_t i = 0; i < prob.params.size(); ++i)
        {
            prob.lower[i] = std::max (prob.lower[i], prob.params[i] - reach[i % 3]);
            prob.upper[i] = std::min (prob.upper[i], prob.params[i] + reach[i % 3]);
        }
        if (seededError < bestError)
        {
            bestError = seededError;
            best = seeded;
        }
    }
    for (int round = 0; round < 10 && bestError > 0.04; ++round)
    {
        const auto res = solveLevenbergMarquardt (prob, 30, 1e-9);
        const auto refined = unpackSpecs (res.params);
        const double e = errorOf (refined);
        if (e < bestError)
        {
            bestError = e;
            best = refined;
        }

        std::fill (sum.begin(), sum.end(), 0.0);
        for (const auto& s : refined)
        {
            digitalResponseOf (s, fs, one.data());
            for (int i = 0; i < kRefinePoints; ++i)
                sum[(size_t) i] += one[(size_t) i];
        }
        double mean = 0.0;
        for (int i = 0; i < kRefinePoints; ++i)
        {
            weight[(size_t) i] *= std::max (std::abs (sum[(size_t) i] - target[(size_t) i]), 1e-4);
            mean += weight[(size_t) i];
        }
        mean /= kRefinePoints;
        for (int i = 0; i < kRefinePoints; ++i)
        {
            weight[(size_t) i] /= mean;
            sqrtWeight[(size_t) i] = std::sqrt (weight[(size_t) i]);
        }
        prob.params = res.params;
    }
    return best;
}

//==============================================================================
std::unique_ptr<FilterSet> FilterSet::build (const FilterSetConfig& cfg)
{
    std::unique_ptr<FilterSet> set (new FilterSet());
    set->config = cfg;
    const double fs = cfg.sampleRate;

    if (cfg.mode == FilterMode::minimumPhase)
    {
        // The cascade is refined for this rate at several Amounts, since a
        // refinement for 100% does not hold when every gain is scaled down;
        // rows in between interpolate the refined parameters.
        constexpr int numAnchors = 16; // every 1/16 of Amount
        auto anchor = [] (int k) { return (double) (k + 1) / numAnchors; };
        std::vector<std::vector<FilterSpec>> refined;
        auto analogue = cfg.calibration;
        if (cfg.hasCorrection && ! analogue.empty() && fs < 88200.0)
        {
            // A digital-only high shelf at 0 dB in the design: it leaves the
            // target alone and gives the refinement a free hand in the top
            // octave, where matched biquads at 44.1 and 48 kHz still differ
            // from their analogue designs.
            analogue.push_back ({ FilterType::highShelf, 16000.0, 0.0, 0.7071067811865476 });
        }
        if (cfg.hasCorrection)
        {
            // From 100% down, each seeded with the one above (gains scaled).
            refined.resize ((size_t) numAnchors);
            for (int k = numAnchors - 1; k >= 0; --k)
            {
                auto scaled = analogue;
                for (auto& spec : scaled)
                    spec.gainDb *= anchor (k);
                std::vector<FilterSpec> seed;
                if (k < numAnchors - 1)
                {
                    seed = refined[(size_t) k + 1];
                    for (auto& spec : seed)
                        spec.gainDb *= anchor (k) / anchor (k + 1);
                }
                refined[(size_t) k] = refineCascadeForRate (scaled, fs, seed);
            }
            set->calDigital = refined.back();
        }
        auto overlay = cfg.overlay;
        if (! overlay.empty() && fs < 88200.0)
            overlay.push_back ({ FilterType::highShelf, 16000.0, 0.0, 0.7071067811865476 }); // as above
        set->overlayDigital = refineCascadeForRate (overlay, fs);
        if (set->overlayDigital.size() > cfg.overlay.size() && set->overlayDigital.back().gainDb == 0.0)
            set->overlayDigital.pop_back(); // the helper was not needed
        set->numCal = (int) set->calDigital.size();
        set->numOverlay = (int) set->overlayDigital.size();

        set->calTable.resize ((size_t) (set->numCal * kAmountSteps));
        for (int f = 0; f < set->numCal; ++f)
        {
            for (int s = 0; s < kAmountSteps; ++s)
            {
                const double a = (double) s / (kAmountSteps - 1);
                int k = 0;
                while (k < numAnchors - 1 && a > anchor (k))
                    ++k;
                auto spec = refined[(size_t) k][(size_t) f];
                if (k == 0)
                {
                    spec.gainDb *= a / anchor (0); // toward no gain at 0%
                }
                else
                {
                    const auto& lo = refined[(size_t) k - 1][(size_t) f];
                    const double t = (a - anchor (k - 1)) / (anchor (k) - anchor (k - 1));
                    spec.freqHz = std::exp2 (std::log2 (lo.freqHz) + (std::log2 (spec.freqHz) - std::log2 (lo.freqHz)) * t);
                    spec.q = std::exp2 (std::log2 (lo.q) + (std::log2 (spec.q) - std::log2 (lo.q)) * t);
                    spec.gainDb = lo.gainDb + (spec.gainDb - lo.gainDb) * t;
                }
                set->calTable[(size_t) (f * kAmountSteps + s)] = designMatched (spec, fs);
            }
        }
        for (const auto& s : set->overlayDigital)
            set->overlayCoeffs.push_back (designMatched (s, fs));

        set->calCurrent.assign ((size_t) set->numCal, BiquadCoeffs::identity());
        set->states.assign ((size_t) (2 * (set->numCal + set->numOverlay)), {});
        set->latency = 0;
    }
    else
    {
        const auto sizing = linearPhaseSizing (fs);
        const auto& c = cfg;
        auto dbAt = [&c] (double hz)
        {
            double v = 0.0;
            if (c.hasCorrection)
                v += c.linearAmount * sampleCorrectionExtended (c.correction, hz, c.maxCutDb, c.maxBoostDb);
            if (! c.overlay.empty())
                v += analogCascadeDb (c.overlay.data(), (int) c.overlay.size(), std::max (hz, 1.0));
            return v;
        };
        set->convolver.prepare (designLinearPhaseFir (dbAt, fs, sizing.halfLength), sizing.partitionSize);
        set->latency = sizing.latencySamples;
    }

    // Static gains over Amount, from the response this set actually realises.
    // Headroom also covers it above 20 kHz, up to Nyquist: the correction plus
    // match gain never exceeds 0 dB at any frequency (spec Section 7), and a
    // Minimum Phase shelf keeps its gain up there while bells fade.
    const auto& grid = gridFrequencies();
    std::vector<double> ultrasonic;
    for (double hz = kGridMaxHz * std::exp2 (1.0 / 12.0); hz < 0.48 * fs; hz *= std::exp2 (1.0 / 12.0))
        ultrasonic.push_back (hz);
    for (int k = 0; k < kGainSteps; ++k)
    {
        const double a = (double) k / (kGainSteps - 1);
        GridCurve r {};
        for (int i = 0; i < kGridSize; ++i)
            r[(size_t) i] = set->realisedResponseDb (a, grid[(size_t) i]);
        const double match = loudnessMatchGainDb (r);
        double headroom = headroomDb (r, match);
        for (double hz : ultrasonic)
            headroom = std::min (headroom, -(set->realisedResponseDb (a, hz) + match));
        set->matchTable[(size_t) k] = match;
        set->headroomTable[(size_t) k] = headroom;
    }
    return set;
}

double FilterSet::realisedResponseDb (double amount, double hz) const
{
    const double fs = config.sampleRate;
    double v = 0.0;
    if (config.mode == FilterMode::minimumPhase)
    {
        const double pos = std::clamp (amount, 0.0, 1.0) * (kAmountSteps - 1);
        const int i = std::min ((int) pos, kAmountSteps - 2);
        const double t = pos - i;
        for (int f = 0; f < numCal; ++f)
        {
            const auto c = lerp (calTable[(size_t) (f * kAmountSteps + i)], calTable[(size_t) (f * kAmountSteps + i + 1)], t);
            v += digitalMagnitudeDb (c, hz, fs);
        }
        for (const auto& c : overlayCoeffs)
            v += digitalMagnitudeDb (c, hz, fs);
    }
    else
    {
        if (config.hasCorrection)
            v += amount * sampleCorrectionExtended (config.correction, hz, config.maxCutDb, config.maxBoostDb);
        if (! config.overlay.empty())
            v += analogCascadeDb (config.overlay.data(), (int) config.overlay.size(), hz);
    }
    return v;
}

double FilterSet::minimumPhaseDesignErrorDb() const
{
    if (config.mode != FilterMode::minimumPhase || ! config.hasCorrection)
        return 0.0;
    double worst = 0.0;
    for (int i = 0; i < 2000; ++i)
    {
        const double hz = 20.0 * std::pow (1000.0, i / 1999.0);
        double d = 0.0;
        for (int f = 0; f < numCal; ++f)
            d += digitalMagnitudeDb (calTable[(size_t) (f * kAmountSteps + kAmountSteps - 1)], hz, config.sampleRate);
        const double a = analogCascadeDb (config.calibration.data(), (int) config.calibration.size(), hz);
        worst = std::max (worst, std::abs (d - a));
    }
    return worst;
}

void FilterSet::gainsForAmount (double amount, double& matchDb, double& headroomDb) const noexcept
{
    const double pos = std::clamp (amount, 0.0, 1.0) * (kGainSteps - 1);
    const int i = std::min ((int) pos, kGainSteps - 2);
    const double t = pos - i;
    matchDb = matchTable[(size_t) i] + (matchTable[(size_t) i + 1] - matchTable[(size_t) i]) * t;
    headroomDb = headroomTable[(size_t) i] + (headroomTable[(size_t) i + 1] - headroomTable[(size_t) i]) * t;
}

void FilterSet::reset() noexcept
{
    for (auto& s : states)
        s.reset();
    currentAmount = -1.0;
    if (convolver.isPrepared())
        convolver.reset();
}

bool FilterSet::takeStateFrom (const FilterSet& other) noexcept
{
    if (config.mode != FilterMode::linearPhase || other.config.mode != FilterMode::linearPhase
        || other.config.sampleRate != config.sampleRate)
        return false;
    return convolver.copyStateFrom (other.convolver);
}

void FilterSet::updateCoefficients (double amount) noexcept
{
    currentAmount = amount;
    const double pos = std::clamp (amount, 0.0, 1.0) * (kAmountSteps - 1);
    const int i = std::min ((int) pos, kAmountSteps - 2);
    const double t = pos - i;
    for (int f = 0; f < numCal; ++f)
    {
        const auto* row = &calTable[(size_t) (f * kAmountSteps)];
        calCurrent[(size_t) f] = t == 0.0 ? row[i] : lerp (row[i], row[i + 1], t);
    }
}

void FilterSet::process (double* const* ch, int numChannels, int numSamples, const double* amountPerSample, double amount) noexcept
{
    numChannels = std::min (numChannels, 2);

    if (config.mode == FilterMode::linearPhase)
    {
        convolver.process (ch[0], numChannels > 1 ? ch[1] : nullptr, numSamples);
        return;
    }

    const int perChannel = numCal + numOverlay;
    if (perChannel == 0)
        return;

    if (amountPerSample == nullptr)
    {
        if (amount != currentAmount)
            updateCoefficients (amount);
        for (int c = 0; c < numChannels; ++c)
        {
            auto* st = &states[(size_t) (c * perChannel)];
            double* x = ch[c];
            for (int n = 0; n < numSamples; ++n)
            {
                double v = x[n];
                for (int f = 0; f < numCal; ++f)
                    v = st[f].process (calCurrent[(size_t) f], v);
                for (int o = 0; o < numOverlay; ++o)
                    v = st[numCal + o].process (overlayCoeffs[(size_t) o], v);
                x[n] = v;
            }
        }
        return;
    }

    for (int n = 0; n < numSamples; ++n)
    {
        if (amountPerSample[n] != currentAmount)
            updateCoefficients (amountPerSample[n]);
        for (int c = 0; c < numChannels; ++c)
        {
            auto* st = &states[(size_t) (c * perChannel)];
            double v = ch[c][n];
            for (int f = 0; f < numCal; ++f)
                v = st[f].process (calCurrent[(size_t) f], v);
            for (int o = 0; o < numOverlay; ++o)
                v = st[numCal + o].process (overlayCoeffs[(size_t) o], v);
            ch[c][n] = v;
        }
    }
}

} // namespace ref::dsp

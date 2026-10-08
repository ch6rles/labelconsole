#include "ref/dsp/Biquad.h"

#include <algorithm>
#include <cmath>
#include <numbers>

namespace ref::dsp
{

namespace
{
constexpr double pi = std::numbers::pi;

double shelfA (double gainDb) { return std::pow (10.0, gainDb / 40.0); }

struct PoleSpec
{
    double omega; // analogue pole natural frequency, rad/s
    double zeta;  // damping
};

PoleSpec analoguePoles (const FilterSpec& s)
{
    const double w0 = 2.0 * pi * s.freqHz;
    const double q = std::max (s.q, 0.05);
    const double A = shelfA (s.gainDb);

    switch (s.type)
    {
        case FilterType::bell:      return { w0, 1.0 / (2.0 * A * q) };
        case FilterType::lowShelf:  return { w0 / std::sqrt (A), 1.0 / (2.0 * q) };
        case FilterType::highShelf: return { w0 * std::sqrt (A), 1.0 / (2.0 * q) };
        case FilterType::lowPass:
        case FilterType::highPass:  return { w0, 1.0 / (2.0 * q) };
    }
    return { w0, 0.5 };
}
} // namespace

double analogMagnitudeSquared (const FilterSpec& s, double hz)
{
    const double w = hz / s.freqHz;
    const double w2 = w * w;
    const double q = std::max (s.q, 0.05);
    const double A = shelfA (s.gainDb);

    switch (s.type)
    {
        case FilterType::bell:
        {
            const double re = 1.0 - w2;
            const double num = re * re + (w * A / q) * (w * A / q);
            const double den = re * re + (w / (A * q)) * (w / (A * q));
            return num / den;
        }
        case FilterType::lowShelf:
        {
            const double k = w2 * A / (q * q);
            const double n = A - w2, d = 1.0 - A * w2;
            return A * A * (n * n + k) / (d * d + k);
        }
        case FilterType::highShelf:
        {
            const double k = w2 * A / (q * q);
            const double n = 1.0 - A * w2, d = A - w2;
            return A * A * (n * n + k) / (d * d + k);
        }
        case FilterType::lowPass:
        {
            const double re = 1.0 - w2;
            return 1.0 / (re * re + w2 / (q * q));
        }
        case FilterType::highPass:
        {
            const double re = 1.0 - w2;
            return (w2 * w2) / (re * re + w2 / (q * q));
        }
    }
    return 1.0;
}

double analogMagnitudeDb (const FilterSpec& s, double hz)
{
    return 10.0 * std::log10 (std::max (analogMagnitudeSquared (s, hz), 1e-30));
}

double analogCascadeDb (const FilterSpec* filters, int count, double hz)
{
    double sum = 0.0;
    for (int i = 0; i < count; ++i)
        sum += analogMagnitudeDb (filters[i], hz);
    return sum;
}

BiquadCoeffs designBilinear (const FilterSpec& s, double fs)
{
    const double f0 = std::min (s.freqHz, 0.49 * fs);
    const double w0 = 2.0 * pi * f0 / fs;
    const double cw = std::cos (w0), sw = std::sin (w0);
    const double q = std::max (s.q, 0.05);
    const double alpha = sw / (2.0 * q);
    const double A = shelfA (s.gainDb);

    double b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
    switch (s.type)
    {
        case FilterType::bell:
            b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
            a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
            break;
        case FilterType::lowShelf:
        {
            const double sa = 2 * std::sqrt (A) * alpha;
            b0 = A * ((A + 1) - (A - 1) * cw + sa);
            b1 = 2 * A * ((A - 1) - (A + 1) * cw);
            b2 = A * ((A + 1) - (A - 1) * cw - sa);
            a0 = (A + 1) + (A - 1) * cw + sa;
            a1 = -2 * ((A - 1) + (A + 1) * cw);
            a2 = (A + 1) + (A - 1) * cw - sa;
            break;
        }
        case FilterType::highShelf:
        {
            const double sa = 2 * std::sqrt (A) * alpha;
            b0 = A * ((A + 1) + (A - 1) * cw + sa);
            b1 = -2 * A * ((A - 1) + (A + 1) * cw);
            b2 = A * ((A + 1) + (A - 1) * cw - sa);
            a0 = (A + 1) - (A - 1) * cw + sa;
            a1 = 2 * ((A - 1) - (A + 1) * cw);
            a2 = (A + 1) - (A - 1) * cw - sa;
            break;
        }
        case FilterType::lowPass:
            b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
            a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
            break;
        case FilterType::highPass:
            b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
            a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
            break;
    }
    return { b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0 };
}

BiquadCoeffs designMatched (const FilterSpec& s, double fs)
{
    // A 0 dB bell or shelf is exactly unity; keep it bit-clean so Amount 0%
    // nulls against bypass (spec Section 12).
    if (s.gainDb == 0.0 && (s.type == FilterType::bell || s.type == FilterType::lowShelf || s.type == FilterType::highShelf))
        return BiquadCoeffs::identity();

    const double T = 1.0 / fs;
    const auto poles = analoguePoles (s);
    const double x = poles.zeta * poles.omega * T;

    double a1 = 0.0;
    if (poles.zeta < 1.0)
    {
        const double y = poles.omega * T * std::sqrt (1.0 - poles.zeta * poles.zeta);
        if (y >= 0.9 * pi)
            return designBilinear (s, fs); // impulse invariance would alias
        a1 = -2.0 * std::exp (-x) * std::cos (y);
    }
    else
    {
        const double y = poles.omega * T * std::sqrt (poles.zeta * poles.zeta - 1.0);
        a1 = -2.0 * std::exp (-x) * std::cosh (y);
    }
    const double a2 = std::exp (-2.0 * x);

    const double A0 = (1.0 + a1 + a2) * (1.0 + a1 + a2);
    const double A1 = (1.0 - a1 + a2) * (1.0 - a1 + a2);
    const double A2 = -4.0 * a2;

    auto phi = [] (double w, double& p0, double& p1, double& p2)
    {
        const double s2 = std::sin (w * 0.5);
        p1 = s2 * s2;
        p0 = 1.0 - p1;
        p2 = 4.0 * p0 * p1;
    };

    // The numerator's squared magnitude is linear in (B0, B1, B2):
    //   |B(w)|^2 = B0 phi0 + B1 phi1 + B2 phi2.
    // Vicanek solves it from three match points. A weighted least-squares
    // fit over 10 Hz .. min(Nyquist, 22 kHz) in relative terms tracks the
    // analogue curve about three times more closely near Nyquist, so that is
    // tried first and the three-point solution kept as the fallback.
    //
    // In p = sin^2(w/2) the same function is the quadratic
    //   B0 + (B1 - B0 + 4 B2) p - 4 B2 p^2.
    // The fit uses u = p / p(fHi) and Householder QR: at high sample rates p
    // stays small across the audio band, phi1 and phi2 become nearly
    // parallel, and solving them through normal equations made the result
    // depend on last-bit rounding (different on every compiler and libm).
    auto factor = [&] (double B0, double B1, double B2, BiquadCoeffs& out)
    {
        if (! (B0 >= 0.0) || ! (B1 >= 0.0) || ! std::isfinite (B2))
            return false;
        const double sB0 = std::sqrt (B0), sB1 = std::sqrt (B1);
        const double W = 0.5 * (sB0 + sB1);
        const double disc = W * W + B2;
        if (disc < -1e-12)
            return false;
        const double b0 = 0.5 * (W + std::sqrt (std::max (disc, 0.0)));
        if (! (b0 > 0.0) || ! std::isfinite (b0))
            return false;
        out = { b0, 0.5 * (sB0 - sB1), -B2 / (4.0 * b0), a1, a2 };
        return true;
    };

    BiquadCoeffs result;
    {
        constexpr int K = 256;
        const double fLo = 10.0, fHi = std::min (0.5 * fs, 22000.0);
        const double sHi = std::sin (pi * fHi / fs);
        const double pMax = sHi * sHi;

        // A high-pass has |B(0)| = 0 exactly, so its constant term is pinned
        // to zero; otherwise the stop band floors well short of the analogue
        // slope when the corner sits near Nyquist.
        const int first = s.type == FilterType::highPass ? 1 : 0;
        const int cols = 3 - first;

        // Rows scaled by 1 / target: minimises the relative error. The
        // right-hand side (all ones) is the column after the basis.
        double M[K][4];
        int rows = 0;
        for (int k = 0; k < K; ++k)
        {
            const double f = fLo * std::pow (fHi / fLo, k / (K - 1.0));
            double p0, p1, p2;
            phi (2.0 * pi * f / fs, p0, p1, p2);
            const double target = analogMagnitudeSquared (s, f) * (A0 * p0 + A1 * p1 + A2 * p2);
            if (! (target > 1e-24))
                continue;
            const double u = p1 / pMax;
            const double basis[3] { 1.0, u, u * u };
            for (int j = 0; j < cols; ++j)
                M[rows][j] = basis[first + j] / target;
            M[rows][cols] = 1.0;
            ++rows;
        }

        bool solved = rows >= cols;
        for (int c = 0; c < cols && solved; ++c)
        {
            double norm = 0.0;
            for (int r = c; r < rows; ++r)
                norm += M[r][c] * M[r][c];
            norm = std::sqrt (norm);
            if (! (norm > 0.0) || ! std::isfinite (norm))
            {
                solved = false;
                break;
            }
            const double alpha = M[c][c] > 0.0 ? -norm : norm;
            M[c][c] -= alpha; // M[c..rows)[c] is now the Householder vector v
            double vNorm2 = 0.0;
            for (int r = c; r < rows; ++r)
                vNorm2 += M[r][c] * M[r][c];
            for (int k = c + 1; k <= cols; ++k)
            {
                double dot = 0.0;
                for (int r = c; r < rows; ++r)
                    dot += M[r][c] * M[r][k];
                const double f = 2.0 * dot / vNorm2;
                for (int r = c; r < rows; ++r)
                    M[r][k] -= f * M[r][c];
            }
            M[c][c] = alpha; // R's diagonal
        }

        if (solved)
        {
            // Back-substitute R d = Q^T 1 (R on and above the diagonal,
            // Q^T 1 in the last column).
            double d[3] {};
            for (int i = cols - 1; i >= 0; --i)
            {
                double v = M[i][cols];
                for (int j = i + 1; j < cols; ++j)
                    v -= M[i][j] * d[first + j];
                d[first + i] = v / M[i][i];
            }
            const double c0 = d[0], c1 = d[1] / pMax, c2 = d[2] / (pMax * pMax);
            const double B0 = c0, B2 = -0.25 * c2, B1 = c0 + c1 + c2;
            if (std::isfinite (B1) && factor (B0, B1, B2, result))
                return result;
        }
    }

    const double hDc = s.type == FilterType::highPass ? 0.0 : analogMagnitudeSquared (s, 1e-9 * s.freqHz);
    const double hNyq = analogMagnitudeSquared (s, 0.5 * fs);
    const double fm = std::min (s.freqHz, 0.42 * fs);
    double p0, p1, p2;
    phi (2.0 * pi * fm / fs, p0, p1, p2);
    const double B0 = hDc * A0;
    const double B1 = hNyq * A1;
    const double B2 = (analogMagnitudeSquared (s, fm) * (A0 * p0 + A1 * p1 + A2 * p2) - B0 * p0 - B1 * p1) / p2;

    if (factor (B0, B1, B2, result))
        return result;
    return designBilinear (s, fs);
}

std::complex<double> digitalResponse (const BiquadCoeffs& c, double hz, double fs)
{
    const double w = 2.0 * pi * hz / fs;
    const std::complex<double> z1 = std::polar (1.0, -w);
    const std::complex<double> z2 = z1 * z1;
    return (c.b0 + c.b1 * z1 + c.b2 * z2) / (1.0 + c.a1 * z1 + c.a2 * z2);
}

double digitalMagnitudeDb (const BiquadCoeffs& c, double hz, double fs)
{
    return 20.0 * std::log10 (std::max (std::abs (digitalResponse (c, hz, fs)), 1e-15));
}

} // namespace ref::dsp

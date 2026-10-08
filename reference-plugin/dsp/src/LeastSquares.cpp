#include "ref/dsp/LeastSquares.h"

#include <algorithm>
#include <cmath>

namespace ref::dsp
{

bool solveLinearSystem (std::vector<double>& A, std::vector<double>& b, int n)
{
    for (int c = 0; c < n; ++c)
    {
        int p = c;
        for (int r = c + 1; r < n; ++r)
            if (std::abs (A[(size_t) (r * n + c)]) > std::abs (A[(size_t) (p * n + c)]))
                p = r;
        if (std::abs (A[(size_t) (p * n + c)]) < 1e-300)
            return false;
        if (p != c)
        {
            for (int k = 0; k < n; ++k)
                std::swap (A[(size_t) (c * n + k)], A[(size_t) (p * n + k)]);
            std::swap (b[(size_t) c], b[(size_t) p]);
        }
        const double pivot = A[(size_t) (c * n + c)];
        for (int r = c + 1; r < n; ++r)
        {
            const double f = A[(size_t) (r * n + c)] / pivot;
            if (f == 0.0)
                continue;
            for (int k = c; k < n; ++k)
                A[(size_t) (r * n + k)] -= f * A[(size_t) (c * n + k)];
            b[(size_t) r] -= f * b[(size_t) c];
        }
    }
    for (int r = n - 1; r >= 0; --r)
    {
        double s = b[(size_t) r];
        for (int k = r + 1; k < n; ++k)
            s -= A[(size_t) (r * n + k)] * b[(size_t) k];
        b[(size_t) r] = s / A[(size_t) (r * n + r)];
    }
    return true;
}

namespace
{
double sumSquares (const std::vector<double>& r)
{
    double s = 0.0;
    for (double v : r)
        s += v * v;
    return s;
}

void clampParams (std::vector<double>& p, const LmProblem& prob)
{
    for (size_t i = 0; i < p.size(); ++i)
        p[i] = std::clamp (p[i], prob.lower[i], prob.upper[i]);
}
} // namespace

LmResult solveLevenbergMarquardt (const LmProblem& prob, int maxIterations, double relativeTolerance)
{
    const int P = (int) prob.params.size();
    const int N = prob.numResiduals;

    LmResult result;
    result.params = prob.params;
    clampParams (result.params, prob);

    std::vector<double> r ((size_t) N), rTrial ((size_t) N), rStep ((size_t) N);
    prob.residuals (result.params, r);
    result.cost = sumSquares (r);
    if (P == 0)
        return result;

    std::vector<double> J ((size_t) (N * P)), A ((size_t) (P * P)), g ((size_t) P), M, delta;
    std::vector<double> trial ((size_t) P);
    double lambda = 1e-3;

    for (int it = 0; it < maxIterations; ++it)
    {
        result.iterations = it + 1;

        if (prob.jacobian)
        {
            prob.jacobian (result.params, r, J);
        }
        else
        {
            for (int j = 0; j < P; ++j)
            {
                auto p = result.params;
                double h = prob.step[(size_t) j];
                if (p[(size_t) j] + h > prob.upper[(size_t) j])
                    h = -h;
                p[(size_t) j] += h;
                prob.residuals (p, rStep);
                for (int i = 0; i < N; ++i)
                    J[(size_t) (i * P + j)] = (rStep[(size_t) i] - r[(size_t) i]) / h;
            }
        }

        std::fill (A.begin(), A.end(), 0.0);
        std::fill (g.begin(), g.end(), 0.0);
        for (int i = 0; i < N; ++i)
        {
            const double* row = &J[(size_t) (i * P)];
            const double ri = r[(size_t) i];
            for (int a = 0; a < P; ++a)
            {
                if (row[a] == 0.0)
                    continue;
                g[(size_t) a] += row[a] * ri;
                for (int b = a; b < P; ++b)
                    A[(size_t) (a * P + b)] += row[a] * row[b];
            }
        }
        for (int a = 0; a < P; ++a)
            for (int b = 0; b < a; ++b)
                A[(size_t) (a * P + b)] = A[(size_t) (b * P + a)];

        bool improved = false;
        double newCost = result.cost;
        while (lambda < 1e10)
        {
            M = A;
            delta.assign ((size_t) P, 0.0);
            for (int a = 0; a < P; ++a)
            {
                M[(size_t) (a * P + a)] += lambda * (A[(size_t) (a * P + a)] + 1e-9);
                delta[(size_t) a] = -g[(size_t) a];
            }
            if (solveLinearSystem (M, delta, P))
            {
                for (int a = 0; a < P; ++a)
                    trial[(size_t) a] = result.params[(size_t) a] + delta[(size_t) a];
                clampParams (trial, prob);
                prob.residuals (trial, rTrial);
                newCost = sumSquares (rTrial);
                if (std::isfinite (newCost) && newCost < result.cost)
                {
                    improved = true;
                    break;
                }
            }
            lambda *= 4.0;
        }

        if (! improved)
            break;

        const double gain = (result.cost - newCost) / std::max (result.cost, 1e-30);
        result.params = trial;
        r.swap (rTrial);
        result.cost = newCost;
        lambda = std::max (lambda / 3.0, 1e-9);

        if (gain < relativeTolerance)
            break;
    }
    return result;
}

} // namespace ref::dsp

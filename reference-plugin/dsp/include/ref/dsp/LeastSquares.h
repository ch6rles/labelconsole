#pragma once

#include <functional>
#include <vector>

namespace ref::dsp
{

// Solves the dense system A x = b in place (Gaussian elimination with
// partial pivoting). A is row-major n x n. Returns false if singular.
bool solveLinearSystem (std::vector<double>& A, std::vector<double>& b, int n);

// Small bounded Levenberg-Marquardt solver. The model maps parameters to a
// residual vector; the Jacobian is formed by forward differences, but only
// the residuals that a parameter can move are recomputed when the caller
// supplies a per-parameter "column" function. Used offline only (filter
// fitting, per-rate cascade refinement), never on the audio thread.
struct LmProblem
{
    int numResiduals = 0;
    std::vector<double> params, lower, upper, step;

    // Fills residuals for the given parameters.
    std::function<void (const std::vector<double>& params, std::vector<double>& residuals)> residuals;

    // Optional: fills the row-major numResiduals x numParams Jacobian. When
    // absent, forward differences of `residuals` are used.
    std::function<void (const std::vector<double>& params, const std::vector<double>& residuals, std::vector<double>& jacobian)> jacobian;
};

struct LmResult
{
    std::vector<double> params;
    double cost = 0.0; // sum of squared residuals
    int iterations = 0;
};

LmResult solveLevenbergMarquardt (const LmProblem&, int maxIterations, double relativeTolerance = 1e-7);

} // namespace ref::dsp

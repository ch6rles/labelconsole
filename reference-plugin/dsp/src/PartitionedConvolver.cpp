#include "ref/dsp/PartitionedConvolver.h"

#include <algorithm>

namespace ref::dsp
{

void PartitionedConvolver::prepare (const std::vector<double>& impulse, int partitionSize)
{
    P = partitionSize;
    M = 2 * P;
    K = std::max (1, (int) ((impulse.size() + (size_t) P - 1) / (size_t) P));
    fft = std::make_unique<FFT> (M);

    filterSpectra.assign ((size_t) (K * M), {});
    for (int k = 0; k < K; ++k)
    {
        auto* spec = &filterSpectra[(size_t) (k * M)];
        for (int i = 0; i < P; ++i)
        {
            const size_t idx = (size_t) (k * P + i);
            spec[i] = idx < impulse.size() ? impulse[idx] : 0.0;
        }
        fft->forward (spec);
    }

    delayLine.assign ((size_t) (K * M), {});
    inputBlock.assign ((size_t) M, {});
    work.assign ((size_t) M, {});
    accumulator.assign ((size_t) M, {});
    inFifo.assign ((size_t) P, {});
    outFifo.assign ((size_t) P, {});
    head = 0;
    fifoPos = 0;
}

void PartitionedConvolver::reset() noexcept
{
    std::fill (delayLine.begin(), delayLine.end(), std::complex<double> {});
    std::fill (inputBlock.begin(), inputBlock.end(), std::complex<double> {});
    std::fill (inFifo.begin(), inFifo.end(), std::complex<double> {});
    std::fill (outFifo.begin(), outFifo.end(), std::complex<double> {});
    head = 0;
    fifoPos = 0;
}

void PartitionedConvolver::process (double* left, double* right, int numSamples) noexcept
{
    for (int i = 0; i < numSamples; ++i)
    {
        inFifo[(size_t) fifoPos] = { left[i], right != nullptr ? right[i] : 0.0 };
        const auto y = outFifo[(size_t) fifoPos];
        left[i] = y.real();
        if (right != nullptr)
            right[i] = y.imag();

        if (++fifoPos == P)
        {
            processPartition();
            fifoPos = 0;
        }
    }
}

void PartitionedConvolver::processPartition() noexcept
{
    // Slide the 2P input window: previous partition, then the new one.
    std::copy (inputBlock.begin() + P, inputBlock.end(), inputBlock.begin());
    std::copy (inFifo.begin(), inFifo.end(), inputBlock.begin() + P);

    std::copy (inputBlock.begin(), inputBlock.end(), work.begin());
    fft->forward (work.data());

    head = (head + K - 1) % K;
    std::copy (work.begin(), work.end(), delayLine.begin() + (ptrdiff_t) head * M);
    computeOutput();
}

void PartitionedConvolver::computeOutput() noexcept
{
    std::fill (accumulator.begin(), accumulator.end(), std::complex<double> {});
    for (int k = 0; k < K; ++k)
    {
        const auto* x = &delayLine[(size_t) (((head + k) % K) * M)];
        const auto* h = &filterSpectra[(size_t) (k * M)];
        for (int i = 0; i < M; ++i)
            accumulator[(size_t) i] += cmul (x[i], h[i]);
    }
    fft->inverse (accumulator.data());

    std::copy (accumulator.begin() + P, accumulator.end(), outFifo.begin());
}

bool PartitionedConvolver::copyStateFrom (const PartitionedConvolver& other) noexcept
{
    if (other.P != P || other.K != K || P == 0)
        return false;
    std::copy (other.delayLine.begin(), other.delayLine.end(), delayLine.begin());
    std::copy (other.inputBlock.begin(), other.inputBlock.end(), inputBlock.begin());
    std::copy (other.inFifo.begin(), other.inFifo.end(), inFifo.begin());
    head = other.head;
    fifoPos = other.fifoPos;
    computeOutput();
    return true;
}

} // namespace ref::dsp

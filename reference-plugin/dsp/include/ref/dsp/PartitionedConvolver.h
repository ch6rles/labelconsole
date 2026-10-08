#pragma once

#include "FFT.h"

#include <complex>
#include <memory>
#include <vector>

namespace ref::dsp
{

// Uniformly partitioned overlap-save convolution (spec Section 6, Linear
// Phase). Left and right are packed into one complex FFT, which works
// because the impulse response is real. Adds exactly `partitionSize`
// samples of latency regardless of the host block size. prepare()
// allocates; process() never does.
class PartitionedConvolver
{
public:
    void prepare (const std::vector<double>& impulse, int partitionSize);
    void reset() noexcept;

    int latency() const noexcept { return P; }
    bool isPrepared() const noexcept { return P > 0; }

    // In place. `right` may be null for mono.
    void process (double* left, double* right, int numSamples) noexcept;

    // Takes over another convolver's input history (same partition size and
    // partition count) and recomputes the pending output with this filter,
    // so a new filter starts mid-stream with no warm-up. Returns false if
    // the layouts differ.
    bool copyStateFrom (const PartitionedConvolver& other) noexcept;

private:
    void processPartition() noexcept;
    void computeOutput() noexcept;

    int P = 0, M = 0, K = 0;
    std::unique_ptr<FFT> fft;
    std::vector<std::complex<double>> filterSpectra; // K x M
    std::vector<std::complex<double>> delayLine;     // K x M, frequency domain
    std::vector<std::complex<double>> inputBlock, work, accumulator, inFifo, outFifo;
    int head = 0, fifoPos = 0;
};

} // namespace ref::dsp

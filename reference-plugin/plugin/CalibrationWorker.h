#pragma once

#include <juce_core/juce_core.h>

#include "../measurement/ProfileLibrary.h"
#include "../persistence/SessionState.h"
#include "ref/dsp/Engine.h"

#include <functional>
#include <memory>

namespace ref
{

// What the worker should currently be producing.
struct WorkerRequest
{
    juce::String profileId, targetKey;
    dsp::FilterMode mode = dsp::FilterMode::minimumPhase;
    double sampleRate = 0.0;
    std::vector<dsp::FilterSpec> overlay;

    // Calibration saved with the session; used when the profile is missing
    // or its checksum no longer matches (spec Section 9).
    std::shared_ptr<const CalibrationSnapshot> embedded;

    int libraryGeneration = 0; // bumped when profiles are reloaded
};

// Runs the correction generator and designs filter sets off the audio
// thread (spec Section 5), then hands each set to the engine through its
// lock-free slot. Polls Calibration Amount so Linear Phase can rebuild its
// FIR when Amount moves, without the audio thread signalling anything.
class CalibrationWorker : private juce::Thread
{
public:
    CalibrationWorker (ProfileLibrary&, dsp::Engine&, std::function<double()> amount01, std::function<void()> onSnapshotChanged);
    ~CalibrationWorker() override;

    void start();
    void setRequest (const WorkerRequest&);

    // prepareToPlay: generate if needed and build the set for the new rate
    // on the calling thread, so playback starts with the right filters.
    void prepareEngine (double sampleRate, int maxBlockSize, int numChannels);

    std::shared_ptr<const CalibrationSnapshot> getSnapshot() const;

    static std::shared_ptr<CalibrationSnapshot> generate (const ProfileLibrary&, const WorkerRequest&);

private:
    void run() override;
    void step (bool forceSet);

    ProfileLibrary& library;
    dsp::Engine& engine;
    std::function<double()> amountProvider;
    std::function<void()> onSnapshot;

    juce::CriticalSection requestLock, buildLock, snapshotLock;
    juce::WaitableEvent wake;
    WorkerRequest request;

    // What was last built (worker / buildLock only).
    juce::String builtKey;
    dsp::FilterMode builtMode = dsp::FilterMode::minimumPhase;
    double builtRate = 0.0, builtAmount = -1.0;
    std::vector<dsp::FilterSpec> builtOverlay;
    std::shared_ptr<const CalibrationSnapshot> snapshot;
};

} // namespace ref

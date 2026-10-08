#include "CalibrationWorker.h"

#include "../measurement/TextUtil.h"

namespace ref
{

namespace
{
juce::String keyFor (const WorkerRequest& r, const ProfileLibrary& lib)
{
    const auto* p = lib.findProfile (r.profileId);
    return r.profileId + "|" + r.targetKey + "|" + (p != nullptr ? p->sha256 : juce::String ("missing")) + "|"
         + juce::String (r.libraryGeneration) + "|" + juce::String ((juce::pointer_sized_int) r.embedded.get());
}

dsp::GeneratorWarning simpleWarning (dsp::WarningCode code, const juce::String& msg)
{
    return { code, msg.toStdString(), {}, {} };
}
} // namespace

CalibrationWorker::CalibrationWorker (ProfileLibrary& lib, dsp::Engine& e, std::function<double()> amount01, std::function<void()> onChanged)
    : juce::Thread ("REFERENCE calibration"), library (lib), engine (e), amountProvider (std::move (amount01)), onSnapshot (std::move (onChanged))
{
}

CalibrationWorker::~CalibrationWorker()
{
    stopThread (4000);
}

void CalibrationWorker::start()
{
    startThread (juce::Thread::Priority::low);
}

void CalibrationWorker::setRequest (const WorkerRequest& r)
{
    {
        const juce::ScopedLock sl (requestLock);
        request = r;
    }
    wake.signal();
}

std::shared_ptr<const CalibrationSnapshot> CalibrationWorker::getSnapshot() const
{
    const juce::ScopedLock sl (snapshotLock);
    return snapshot;
}

void CalibrationWorker::prepareEngine (double sampleRate, int maxBlockSize, int numChannels)
{
    const juce::ScopedLock sl (buildLock);
    engine.prepare (sampleRate, maxBlockSize, numChannels);
    {
        const juce::ScopedLock rl (requestLock);
        request.sampleRate = sampleRate;
    }
    step (true);
}

void CalibrationWorker::run()
{
    while (! threadShouldExit())
    {
        wake.wait (20);
        if (threadShouldExit())
            break;
        const juce::ScopedLock sl (buildLock);
        engine.collectGarbage();
        step (false);
    }
}

std::shared_ptr<CalibrationSnapshot> CalibrationWorker::generate (const ProfileLibrary& lib, const WorkerRequest& req)
{
    auto snap = std::make_shared<CalibrationSnapshot>();
    const auto* profile = lib.findProfile (req.profileId);
    const auto* target = lib.findTarget (req.targetKey);

    // A session whose profile is gone or changed reopens with the curve it
    // was saved with.
    if (req.embedded != nullptr && req.embedded->profileId == req.profileId && req.embedded->targetKey == req.targetKey
        && (profile == nullptr || profile->sha256 != req.embedded->profileSha || target == nullptr))
    {
        *snap = *req.embedded;
        snap->fromEmbedded = true;
        return snap;
    }

    snap->profileId = req.profileId;
    snap->targetKey = req.targetKey;
    snap->generatorVersion = dsp::kGeneratorVersion;

    if (profile == nullptr)
    {
        snap->result.warnings.push_back (simpleWarning (dsp::WarningCode::noMeasurement, "No valid measurement loaded."));
        return snap;
    }

    snap->profileSha = profile->sha256;
    snap->profileName = profile->displayName;
    snap->manufacturer = profile->manufacturer;
    snap->modelRevision = profile->modelRevision;
    snap->rigId = profile->rigId;
    snap->earSimulator = profile->earSimulator;
    snap->measurementSummary = profile->measurementSummary();
    snap->placeholder = profile->placeholder;
    snap->limits = profile->limits;

    if (target == nullptr)
    {
        snap->targetName = req.targetKey;
        snap->result.warnings.push_back (simpleWarning (dsp::WarningCode::invalidTarget,
                                                        "Target " + req.targetKey + " is not installed; correction not generated."));
        return snap;
    }
    snap->targetName = target->displayName;

    snap->result = dsp::generateCorrection ({ profile->rigId.toStdString(), profile->curve },
                                            { target->rigId.toStdString(), target->curve }, profile->limits);
    return snap;
}

void CalibrationWorker::step (bool forceSet)
{
    WorkerRequest req;
    {
        const juce::ScopedLock sl (requestLock);
        req = request;
    }

    const auto key = keyFor (req, library);
    const bool correctionChanged = key != builtKey || snapshot == nullptr;
    if (correctionChanged)
    {
        std::shared_ptr<const CalibrationSnapshot> fresh = generate (library, req);
        {
            const juce::ScopedLock sl (snapshotLock);
            snapshot = fresh;
        }
        builtKey = key;
        if (onSnapshot)
            onSnapshot();
    }

    if (req.sampleRate <= 0.0)
        return;

    const double amount = juce::jlimit (0.0, 1.0, amountProvider ? amountProvider() : 1.0);
    const bool needSet = forceSet || correctionChanged || req.mode != builtMode || req.sampleRate != builtRate
                      || req.overlay != builtOverlay
                      || (req.mode == dsp::FilterMode::linearPhase && std::abs (amount - builtAmount) > 0.0005);
    if (! needSet)
        return;

    std::shared_ptr<const CalibrationSnapshot> snap;
    {
        const juce::ScopedLock sl (snapshotLock);
        snap = snapshot;
    }

    dsp::FilterSetConfig cfg;
    cfg.mode = req.mode;
    cfg.sampleRate = req.sampleRate;
    cfg.hasCorrection = snap->result.generated;
    cfg.correction = snap->result.correction;
    cfg.calibration = snap->result.filters;
    cfg.overlay = req.overlay;
    cfg.linearAmount = amount;
    cfg.maxBoostDb = snap->limits.maxBoostDb;
    cfg.maxCutDb = snap->limits.maxCutDb;
    engine.submit (dsp::FilterSet::build (cfg));

    builtMode = req.mode;
    builtRate = req.sampleRate;
    builtOverlay = req.overlay;
    builtAmount = amount;
}

} // namespace ref

#include "PluginProcessor.h"

#include "../ui/PluginEditor.h"
#include "Parameters.h"

namespace ref
{

namespace
{
const juce::Identifier kRoot ("REFERENCE_STATE");

void setParam (juce::AudioProcessorValueTreeState& apvts, const char* id, float value)
{
    if (auto* p = apvts.getParameter (id))
    {
        p->beginChangeGesture();
        p->setValueNotifyingHost (p->convertTo0to1 (value));
        p->endChangeGesture();
    }
}
} // namespace

ReferenceProcessor::ReferenceProcessor()
    : AudioProcessor (BusesProperties()
                          .withInput ("Input", juce::AudioChannelSet::stereo(), true)
                          .withOutput ("Output", juce::AudioChannelSet::stereo(), true)),
      apvts (*this, nullptr, "PARAMETERS", params::createLayout()),
      worker (
          library, engine, [this] { return amountParam != nullptr ? amountParam->load() / 100.0 : 1.0; },
          [this] { sendChangeMessage(); })
{
    amountParam = apvts.getRawParameterValue (params::calAmount);
    outputParam = apvts.getRawParameterValue (params::outputGain);
    balanceParam = apvts.getRawParameterValue (params::balance);
    abParam = apvts.getRawParameterValue (params::abSelect);
    bypassParam = apvts.getRawParameterValue (params::bypass);

    pushRequest();
    worker.start();
}

ReferenceProcessor::~ReferenceProcessor() = default;

bool ReferenceProcessor::runningStandalone()
{
    return juce::PluginHostType::getPluginLoadedAs() == juce::AudioProcessor::wrapperType_Standalone;
}

Settings ReferenceProcessor::getSettings() const
{
    const juce::ScopedLock sl (settingsLock);
    return settings;
}

int ReferenceProcessor::latencyFor (dsp::FilterMode mode) const
{
    return mode == dsp::FilterMode::linearPhase ? dsp::linearPhaseSizing (getCurrentSampleRate()).latencySamples : 0;
}

//==============================================================================
bool ReferenceProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    const auto& in = layouts.getMainInputChannelSet();
    const auto& out = layouts.getMainOutputChannelSet();
    if (in != out)
        return false;
    return out == juce::AudioChannelSet::mono() || out == juce::AudioChannelSet::stereo();
}

void ReferenceProcessor::prepareToPlay (double sampleRate, int samplesPerBlock)
{
    currentSampleRate.store (sampleRate);
    dsp::FilterMode mode;
    {
        const juce::ScopedLock sl (settingsLock);
        mode = settings.filterMode;
    }
    setLatencySamples (latencyFor (mode));
    pushRequest();
    worker.prepareEngine (sampleRate, juce::jmax (1, samplesPerBlock), juce::jmax (getTotalNumInputChannels(), getTotalNumOutputChannels()));
}

void ReferenceProcessor::processWith (juce::AudioBuffer<float>& buffer, bool forceBypass) noexcept
{
    juce::ScopedNoDenormals noDenormals;

    for (auto i = getTotalNumInputChannels(); i < getTotalNumOutputChannels(); ++i)
        buffer.clear (i, 0, buffer.getNumSamples());

    dsp::EngineParams p;
    p.amount = amountParam->load (std::memory_order_relaxed) / 100.0;
    p.outputGainDb = outputParam->load (std::memory_order_relaxed);
    p.balanceDb = balanceParam->load (std::memory_order_relaxed);
    p.calibrated = abParam->load (std::memory_order_relaxed) > 0.5f;
    p.bypass = forceBypass || bypassParam->load (std::memory_order_relaxed) > 0.5f;
    p.autoGain = autoGainFlag.load (std::memory_order_relaxed);
    p.protection = protectionFlag.load (std::memory_order_relaxed);

    // Render safety (spec Section 7): an offline export with calibration on
    // would ruin the file, so it is bypassed bit-exactly.
    p.renderBypass = isNonRealtime() && autoBypassOfflineFlag.load (std::memory_order_relaxed);
    renderBypassActive.store (p.renderBypass, std::memory_order_relaxed);

    const int channels = juce::jmin (2, buffer.getNumChannels());
    if (channels > 0)
        engine.process (buffer.getArrayOfWritePointers(), channels, buffer.getNumSamples(), p);
}

void ReferenceProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    processWith (buffer, false);
}

void ReferenceProcessor::processBlockBypassed (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    // Keep running so the bypass is crossfaded and delay-compensated.
    processWith (buffer, true);
}

juce::AudioProcessorParameter* ReferenceProcessor::getBypassParameter() const
{
    return apvts.getParameter (params::bypass);
}

juce::AudioProcessorEditor* ReferenceProcessor::createEditor()
{
    return new ReferenceEditor (*this);
}

//==============================================================================
void ReferenceProcessor::pushRequest()
{
    WorkerRequest r;
    {
        const juce::ScopedLock sl (settingsLock);
        r.profileId = settings.profileId;
        r.targetKey = settings.targetKey;
        r.mode = settings.filterMode;
        r.overlay = settings.overlay;
        r.embedded = embedded;
        r.libraryGeneration = libraryGeneration;
        autoGainFlag.store (settings.autoGain);
        protectionFlag.store (settings.monitorProtection);
        autoBypassOfflineFlag.store (settings.autoBypassOffline);
    }
    r.sampleRate = currentSampleRate.load();
    worker.setRequest (r);
}

void ReferenceProcessor::setProfile (const juce::String& profileId)
{
    {
        const juce::ScopedLock sl (settingsLock);
        settings.profileId = profileId;
        if (const auto* p = library.findProfile (profileId))
        {
            const auto ts = library.targetsFor (*p);
            const bool keep = std::any_of (ts.begin(), ts.end(), [this] (const TargetInfo* t) { return t->key() == settings.targetKey; });
            if (! keep && ! ts.empty())
                settings.targetKey = ts.front()->key();
        }
        embedded = nullptr;
    }
    pushRequest();
    sendChangeMessage();
}

void ReferenceProcessor::setTarget (const juce::String& targetKey)
{
    {
        const juce::ScopedLock sl (settingsLock);
        settings.targetKey = targetKey;
        embedded = nullptr;
    }
    pushRequest();
    sendChangeMessage();
}

void ReferenceProcessor::setFilterMode (dsp::FilterMode mode)
{
    {
        const juce::ScopedLock sl (settingsLock);
        if (settings.filterMode == mode)
            return;
        settings.filterMode = mode;
    }
    // Report the new latency on every mode change (spec Section 6).
    setLatencySamples (latencyFor (mode));
    latencyChangedTime = juce::Time::getMillisecondCounter();
    pushRequest();
    sendChangeMessage();
}

void ReferenceProcessor::setAutoGain (bool on)
{
    {
        const juce::ScopedLock sl (settingsLock);
        settings.autoGain = on;
    }
    pushRequest();
    sendChangeMessage();
}

void ReferenceProcessor::setMonitorProtection (bool on)
{
    {
        const juce::ScopedLock sl (settingsLock);
        settings.monitorProtection = on;
    }
    pushRequest();
    sendChangeMessage();
}

void ReferenceProcessor::setAutoBypassOffline (bool on)
{
    {
        const juce::ScopedLock sl (settingsLock);
        settings.autoBypassOffline = on;
    }
    pushRequest();
    sendChangeMessage();
}

void ReferenceProcessor::setOverlay (const std::vector<dsp::FilterSpec>& nodes)
{
    {
        const juce::ScopedLock sl (settingsLock);
        settings.overlay = nodes;
    }
    pushRequest();
    sendChangeMessage();
}

void ReferenceProcessor::setUiScale (float scale)
{
    {
        const juce::ScopedLock sl (settingsLock);
        settings.uiScale = juce::jlimit (0.75f, 2.0f, scale);
    }
    sendChangeMessage();
}

void ReferenceProcessor::setGraphRange (int dB)
{
    {
        const juce::ScopedLock sl (settingsLock);
        settings.graphRangeDb = juce::jlimit (3, 24, dB);
    }
    sendChangeMessage();
}

void ReferenceProcessor::setAdvancedView (bool on)
{
    {
        const juce::ScopedLock sl (settingsLock);
        settings.advancedView = on;
    }
    sendChangeMessage();
}

void ReferenceProcessor::reloadLibrary()
{
    library.reload();
    {
        const juce::ScopedLock sl (settingsLock);
        ++libraryGeneration;
    }
    pushRequest();
    sendChangeMessage();
}

//==============================================================================
void ReferenceProcessor::loadPreset (const PresetData& p)
{
    bool modeChanged;
    {
        const juce::ScopedLock sl (settingsLock);
        modeChanged = settings.filterMode != p.filterMode;
        settings.profileId = p.profileId;
        settings.targetKey = p.targetKey;
        settings.filterMode = p.filterMode;
        settings.autoGain = p.autoGain;
        settings.monitorProtection = p.monitorProtection;
        settings.overlay = p.overlay;
        settings.presetName = p.name;
        embedded = nullptr;
    }
    setParam (apvts, params::calAmount, p.calAmount);
    setParam (apvts, params::outputGain, p.outputGain);
    setParam (apvts, params::balance, p.balance);
    if (modeChanged)
    {
        setLatencySamples (latencyFor (p.filterMode));
        latencyChangedTime = juce::Time::getMillisecondCounter();
    }
    pushRequest();
    sendChangeMessage();
}

PresetData ReferenceProcessor::captureCurrentAsPreset (const juce::String& name) const
{
    const auto s = getSettings();
    PresetData p;
    p.name = name;
    p.profileId = s.profileId;
    p.targetKey = s.targetKey;
    p.calAmount = amountParam->load();
    p.outputGain = outputParam->load();
    p.balance = balanceParam->load();
    p.filterMode = s.filterMode;
    p.autoGain = s.autoGain;
    p.monitorProtection = s.monitorProtection;
    p.overlay = s.overlay;
    return p;
}

bool ReferenceProcessor::isPresetModified() const
{
    const auto s = getSettings();
    const auto* p = presets.find (s.presetName);
    if (p == nullptr)
        return true;
    return p->profileId != s.profileId || p->targetKey != s.targetKey || p->filterMode != s.filterMode || p->autoGain != s.autoGain
        || p->monitorProtection != s.monitorProtection || p->overlay != s.overlay || std::abs (p->calAmount - amountParam->load()) > 0.05f
        || std::abs (p->outputGain - outputParam->load()) > 0.05f || std::abs (p->balance - balanceParam->load()) > 0.05f;
}

void ReferenceProcessor::stepPreset (int delta)
{
    const auto list = presets.all();
    if (list.empty())
        return;
    const auto name = getSettings().presetName;
    int idx = -1;
    for (size_t i = 0; i < list.size(); ++i)
        if (list[i]->name == name)
            idx = (int) i;
    const int n = (int) list.size();
    const int next = idx < 0 ? (delta > 0 ? 0 : n - 1) : ((idx + delta) % n + n) % n;
    loadPreset (*list[(size_t) next]);
}

//==============================================================================
void ReferenceProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    juce::ValueTree root (kRoot);
    root.setProperty ("stateVersion", state::kStateVersion, nullptr);
    root.setProperty ("generatorVersion", juce::String (dsp::kGeneratorVersion), nullptr);
    root.appendChild (apvts.copyState(), nullptr);
    root.appendChild (state::settingsToTree (getSettings()), nullptr);
    if (auto snap = worker.getSnapshot(); snap != nullptr && snap->result.generated)
        root.appendChild (state::snapshotToTree (*snap), nullptr);

    if (auto xml = root.createXml())
        copyXmlToBinary (*xml, destData);
}

void ReferenceProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    const auto xml = getXmlFromBinary (data, sizeInBytes);
    if (xml == nullptr)
        return;
    const auto root = juce::ValueTree::fromXml (*xml);
    if (! root.hasType (kRoot))
        return;

    const auto paramTree = root.getChildWithName (apvts.state.getType());
    if (paramTree.isValid())
        apvts.replaceState (paramTree);

    Settings s;
    state::settingsFromTree (root.getChildWithName ("SETTINGS"), s);
    {
        const juce::ScopedLock sl (settingsLock);
        settings = s;
        embedded = state::snapshotFromTree (root.getChildWithName ("EMBEDDED"));
    }
    setLatencySamples (latencyFor (s.filterMode));
    pushRequest();
    sendChangeMessage();
}

} // namespace ref

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new ref::ReferenceProcessor();
}

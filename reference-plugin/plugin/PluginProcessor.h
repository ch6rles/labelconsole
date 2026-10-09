#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include "../measurement/ProfileLibrary.h"
#include "../persistence/PresetManager.h"
#include "../persistence/SessionState.h"
#include "CalibrationWorker.h"
#include "ref/dsp/Engine.h"

#include <atomic>

namespace ref
{

// The plugin. Host parameters live in the APVTS; everything else the
// session needs is in Settings (message thread) mirrored into atomics for
// the audio thread. Filters are designed by the CalibrationWorker.
class ReferenceProcessor : public juce::AudioProcessor, public juce::ChangeBroadcaster
{
public:
    ReferenceProcessor();
    ~ReferenceProcessor() override;

    //==========================================================================
    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override {}
    bool isBusesLayoutSupported (const BusesLayout&) const override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    void processBlockBypassed (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    using AudioProcessor::processBlock;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return "REFERENCE"; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return {}; }
    void changeProgramName (int, const juce::String&) override {}

    void getStateInformation (juce::MemoryBlock&) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    juce::AudioProcessorParameter* getBypassParameter() const override;

    //==========================================================================
    // Model API for the editor (message thread).
    juce::AudioProcessorValueTreeState& getParameters() noexcept { return apvts; }
    ProfileLibrary& getLibrary() noexcept { return library; }
    PresetManager& getPresets() noexcept { return presets; }
    dsp::Engine& getEngine() noexcept { return engine; }

    Settings getSettings() const;
    std::shared_ptr<const CalibrationSnapshot> getSnapshot() const { return worker.getSnapshot(); }

    void setProfile (const juce::String& profileId);
    void setTarget (const juce::String& targetKey);
    void setFilterMode (dsp::FilterMode);
    void setAutoGain (bool);
    void setMonitorProtection (bool);
    void setAutoBypassOffline (bool);
    void setOverlay (const std::vector<dsp::FilterSpec>&);
    void setUiScale (float);
    void setGraphRange (int dB);
    void setAdvancedView (bool);
    void reloadLibrary();

    void loadPreset (const PresetData&);
    // Names the current state without changing it (empty: no preset).
    void setPresetName (const juce::String&);
    PresetData captureCurrentAsPreset (const juce::String& name) const;
    bool isPresetModified() const;
    void stepPreset (int delta);

    // Live status for the UI.
    double getCurrentSampleRate() const noexcept { const double r = currentSampleRate.load(); return r > 0.0 ? r : 48000.0; }
    int latencyFor (dsp::FilterMode) const;
    bool isRenderBypassActive() const noexcept { return renderBypassActive.load (std::memory_order_relaxed); }
    juce::uint32 latencyChangedAtMs() const noexcept { return latencyChangedTime; }

    // Set by the standalone app: no host, so no offline render and no host
    // bypass mechanics.
    static bool runningStandalone();

private:
    void pushRequest();
    void processWith (juce::AudioBuffer<float>&, bool forceBypass) noexcept;

    juce::AudioProcessorValueTreeState apvts;
    ProfileLibrary library;
    PresetManager presets;
    dsp::Engine engine;
    CalibrationWorker worker;

    Settings settings;
    std::shared_ptr<const CalibrationSnapshot> embedded; // from the last loaded session
    int libraryGeneration = 0;

    std::atomic<float>* amountParam = nullptr;
    std::atomic<float>* outputParam = nullptr;
    std::atomic<float>* balanceParam = nullptr;
    std::atomic<float>* abParam = nullptr;
    std::atomic<float>* bypassParam = nullptr;

    std::atomic<bool> autoGainFlag { true }, protectionFlag { true }, autoBypassOfflineFlag { true };
    std::atomic<bool> renderBypassActive { false };
    std::atomic<double> currentSampleRate { 0.0 };
    juce::CriticalSection settingsLock;
    juce::uint32 latencyChangedTime = 0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (ReferenceProcessor)
};

} // namespace ref

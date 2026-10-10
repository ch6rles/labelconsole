#pragma once

#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_processors/juce_audio_processors.h>

#include "../plugin/SystemAudio.h"
#include "ref/dsp/DriftCompensatedFifo.h"

namespace ref::standalone
{

// System-wide routing for the standalone app. The computer plays into a
// loopback device (VB-CABLE, BlackHole, a PipeWire null sink); this opens
// that device's input and the headphone output as two independent devices,
// joins them with a drift-compensated FIFO and runs the processor on the
// output device's thread.
class SystemAudioBridge : public SystemAudioController, private juce::Timer, private juce::ChangeListener
{
public:
    SystemAudioBridge (juce::AudioProcessor&, juce::PropertiesFile&);
    ~SystemAudioBridge() override;

    // Opens the devices saved last time, or sensible defaults.
    void restore();
    void close();

    // SystemAudioController
    juce::StringArray getDeviceTypes() override;
    juce::String getDeviceType() override;
    void setDeviceType (const juce::String&) override;
    juce::StringArray getInputDevices() override;
    juce::StringArray getOutputDevices() override;
    juce::String getInputDevice() override { return inputName; }
    juce::String getOutputDevice() override { return outputName; }
    void setInputDevice (const juce::String&) override;
    void setOutputDevice (const juce::String&) override;
    Status getStatus() override;
    void playTestTone() override;

    // Loopback devices we recognise by name, best first.
    static juce::String guessLoopbackInput (const juce::StringArray& inputs);
    static bool looksLikeLoopbackOutput (const juce::String& outputName, const juce::String& inputName);

private:
    class InputCallback;
    class OutputCallback;

    void reopen();
    void save();
    void timerCallback() override;
    void changeListenerCallback (juce::ChangeBroadcaster*) override {}
    double chooseRate (juce::AudioIODevice&) const;
    int chooseBuffer (juce::AudioIODevice&) const;

    juce::AudioProcessor& processor;
    juce::PropertiesFile& props;

    juce::AudioDeviceManager typeSource; // only used to create the device types
    juce::OwnedArray<juce::AudioIODeviceType> types;
    juce::AudioIODeviceType* type = nullptr;

    std::unique_ptr<juce::AudioIODevice> input, output;
    std::unique_ptr<InputCallback> inputCallback;
    std::unique_ptr<OutputCallback> outputCallback;

    juce::String inputName, outputName, lastError;
    dsp::DriftCompensatedFifo fifo;
    double inputRate = 0.0, outputRate = 0.0;
    int outputBlock = 0, inputBlock = 0;
    bool running = false;
    juce::uint32 lastSignalMs = 0, lastRetryMs = 0, mutedSinceMs = 0;
    double sourceLevelDb = -120.0;
    juce::uint32 lastTicks[2] {};
    int quietTimerTicks = 0; // timer ticks in a row with a device not calling back
};

} // namespace ref::standalone

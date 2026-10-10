#pragma once

#include <juce_core/juce_core.h>

namespace ref
{

// Implemented by the standalone app, which routes system audio from a
// loopback device through the processor to the headphones. The editor shows
// these controls only when an instance is registered (never in a plugin).
class SystemAudioController
{
public:
    virtual ~SystemAudioController() = default;

    struct Status
    {
        bool running = false;
        bool receivingSignal = false;
        double sampleRate = 0.0;
        double latencyMs = 0.0;
        double driftPpm = 0.0;
        juce::uint32 dropouts = 0;
        double sourceLevelDb = -120.0; // peak of what arrives from the loopback device
        juce::String error;
    };

    virtual juce::StringArray getDeviceTypes() = 0;
    virtual juce::String getDeviceType() = 0;
    virtual void setDeviceType (const juce::String&) = 0;

    virtual juce::StringArray getInputDevices() = 0;
    virtual juce::StringArray getOutputDevices() = 0;
    virtual juce::String getInputDevice() = 0;
    virtual juce::String getOutputDevice() = 0;
    virtual void setInputDevice (const juce::String&) = 0;
    virtual void setOutputDevice (const juce::String&) = 0;

    virtual Status getStatus() = 0;

    // Plays a short tone through the calibration to the headphones, to check
    // the output side on its own.
    virtual void playTestTone() = 0;

    static SystemAudioController* instance() { return current(); }
    static void setInstance (SystemAudioController* c) { current() = c; }

private:
    static SystemAudioController*& current()
    {
        static SystemAudioController* c = nullptr;
        return c;
    }
};

} // namespace ref

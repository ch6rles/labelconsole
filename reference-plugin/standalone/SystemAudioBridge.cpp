#include "SystemAudioBridge.h"

#if JucePlugin_Build_Standalone && JUCE_USE_CUSTOM_PLUGIN_STANDALONE_APP

namespace ref::standalone
{

class SystemAudioBridge::InputCallback : public juce::AudioIODeviceCallback
{
public:
    explicit InputCallback (SystemAudioBridge& b) : bridge (b) {}

    void audioDeviceIOCallbackWithContext (const float* const* in, int numIn, float* const* out, int numOut, int n,
                                           const juce::AudioIODeviceCallbackContext&) override
    {
        bridge.fifo.push (in, numIn, n);
        for (int c = 0; c < numOut; ++c)
            if (out[c] != nullptr)
                juce::FloatVectorOperations::clear (out[c], n);
    }

    void audioDeviceAboutToStart (juce::AudioIODevice*) override {}
    void audioDeviceStopped() override {}
    void audioDeviceError (const juce::String&) override { failed.store (true); }

    std::atomic<bool> failed { false };

private:
    SystemAudioBridge& bridge;
};

class SystemAudioBridge::OutputCallback : public juce::AudioIODeviceCallback
{
public:
    explicit OutputCallback (SystemAudioBridge& b) : bridge (b) {}

    void prepare (int maxBlock)
    {
        work.setSize (2, juce::jmax (maxBlock, 4096));
        midi.ensureSize (16);
    }

    void audioDeviceIOCallbackWithContext (const float* const*, int, float* const* out, int numOut, int n,
                                           const juce::AudioIODeviceCallbackContext&) override
    {
        juce::ScopedNoDenormals noDenormals;
        int done = 0;
        while (done < n)
        {
            const int len = juce::jmin (n - done, work.getNumSamples());
            float* ch[2] = { work.getWritePointer (0), work.getWritePointer (1) };
            bridge.fifo.pull (ch, 2, len);
            {
                juce::AudioBuffer<float> view (ch, 2, len);
                midi.clear();
                const juce::ScopedLock sl (bridge.processor.getCallbackLock());
                if (bridge.processor.isSuspended())
                    view.clear();
                else
                    bridge.processor.processBlock (view, midi);
            }
            for (int c = 0; c < numOut; ++c)
            {
                if (out[c] == nullptr)
                    continue;
                if (c < 2)
                    juce::FloatVectorOperations::copy (out[c] + done, ch[numOut == 1 ? 0 : c], len);
                else
                    juce::FloatVectorOperations::clear (out[c] + done, len);
            }
            done += len;
        }
    }

    void audioDeviceAboutToStart (juce::AudioIODevice*) override {}
    void audioDeviceStopped() override {}
    void audioDeviceError (const juce::String&) override { failed.store (true); }

    std::atomic<bool> failed { false };

private:
    SystemAudioBridge& bridge;
    juce::AudioBuffer<float> work;
    juce::MidiBuffer midi;
};

//==============================================================================
SystemAudioBridge::SystemAudioBridge (juce::AudioProcessor& p, juce::PropertiesFile& pf)
    : processor (p), props (pf), inputCallback (std::make_unique<InputCallback> (*this)), outputCallback (std::make_unique<OutputCallback> (*this))
{
    typeSource.createAudioDeviceTypes (types);
    for (auto* t : types)
        t->scanForDevices();
}

SystemAudioBridge::~SystemAudioBridge()
{
    stopTimer();
    close();
}

juce::String SystemAudioBridge::guessLoopbackInput (const juce::StringArray& inputs)
{
    for (const char* pattern : { "CABLE Output", "BlackHole", "Loopback", "Monitor of", "VB-Audio", "Soundflower", "VoiceMeeter Out", "Stereo Mix" })
        for (const auto& name : inputs)
            if (name.containsIgnoreCase (pattern))
                return name;
    return {};
}

bool SystemAudioBridge::looksLikeLoopbackOutput (const juce::String& out, const juce::String& in)
{
    for (const char* pattern : { "CABLE Input", "BlackHole", "Loopback", "Soundflower", "VoiceMeeter In", "VB-Audio" })
        if (out.containsIgnoreCase (pattern))
            return true;
    return out.isNotEmpty() && out == in && guessLoopbackInput ({ in }).isNotEmpty();
}

void SystemAudioBridge::restore()
{
    const auto savedType = props.getValue ("deviceType");
    for (auto* t : types)
        if (t->getTypeName() == savedType)
            type = t;
    if (type == nullptr)
    {
        for (auto* t : types)
            if (t->getTypeName() == "Windows Audio")
                type = t;
        if (type == nullptr && ! types.isEmpty())
            type = types.getFirst();
    }
    inputName = props.getValue ("inputDevice");
    outputName = props.getValue ("outputDevice");
    reopen();
    startTimerHz (2);
}

void SystemAudioBridge::close()
{
    if (input != nullptr)
    {
        input->stop();
        input->close();
    }
    if (output != nullptr)
    {
        output->stop();
        output->close();
    }
    input.reset();
    output.reset();
    if (running)
        processor.releaseResources();
    running = false;
}

double SystemAudioBridge::chooseRate (juce::AudioIODevice& d) const
{
    const auto rates = d.getAvailableSampleRates();
    if (outputRate > 0.0 && rates.contains (outputRate))
        return outputRate;
    for (double r : { 48000.0, 44100.0, 96000.0, 88200.0 })
        if (rates.contains (r))
            return r;
    return rates.isEmpty() ? 48000.0 : rates[0];
}

int SystemAudioBridge::chooseBuffer (juce::AudioIODevice& d) const
{
    const auto sizes = d.getAvailableBufferSizes();
    for (int s : { 256, 480, 512, 384, 192, 128 })
        if (sizes.contains (s))
            return s;
    return d.getDefaultBufferSize();
}

void SystemAudioBridge::reopen()
{
    close();
    lastError.clear();
    inputCallback->failed.store (false);
    outputCallback->failed.store (false);

    if (type == nullptr)
    {
        lastError = "No audio system is available.";
        return;
    }
    type->scanForDevices();
    const auto inputs = type->getDeviceNames (true);
    const auto outputs = type->getDeviceNames (false);

    if (outputName.isEmpty() || ! outputs.contains (outputName))
    {
        if (outputName.isNotEmpty())
        {
            lastError = outputName + " is not connected.";
            return;
        }
        const int idx = type->getDefaultDeviceIndex (false);
        outputName = outputs[juce::jmax (0, idx)];
    }
    if (inputName.isEmpty())
        inputName = guessLoopbackInput (inputs);
    if (inputName.isEmpty())
    {
        lastError = "Choose the loopback device as Source. See Help for setup.";
        return;
    }
    if (! inputs.contains (inputName))
    {
        lastError = inputName + " is not connected.";
        return;
    }
    if (looksLikeLoopbackOutput (outputName, inputName))
    {
        lastError = "Headphones is set to the loopback device; that would feed the output back into the input. Choose your headphones.";
        return;
    }

    output.reset (type->createDevice (outputName, {}));
    input.reset (type->createDevice ({}, inputName));
    if (output == nullptr || input == nullptr)
    {
        lastError = "Could not open " + (output == nullptr ? outputName : inputName) + ".";
        close();
        return;
    }

    auto channelsFor = [] (const juce::StringArray& names)
    {
        juce::BigInteger bits;
        bits.setRange (0, juce::jlimit (1, 2, names.size()), true);
        return bits;
    };

    outputRate = 0.0;
    auto err = output->open ({}, channelsFor (output->getOutputChannelNames()), chooseRate (*output), chooseBuffer (*output));
    if (err.isNotEmpty())
    {
        lastError = outputName + ": " + err;
        close();
        return;
    }
    outputRate = output->getCurrentSampleRate();
    outputBlock = output->getCurrentBufferSizeSamples();

    err = input->open (channelsFor (input->getInputChannelNames()), {}, chooseRate (*input), chooseBuffer (*input));
    if (err.isNotEmpty())
    {
        lastError = inputName + ": " + err;
        close();
        return;
    }
    inputRate = input->getCurrentSampleRate();
    inputBlock = input->getCurrentBufferSizeSamples();

    processor.setPlayConfigDetails (2, 2, outputRate, outputBlock);
    processor.prepareToPlay (outputRate, outputBlock);
    fifo.prepare (2, inputRate, outputRate, inputBlock, outputBlock);
    outputCallback->prepare (outputBlock);

    output->start (outputCallback.get());
    input->start (inputCallback.get());
    running = true;
    save();
}

void SystemAudioBridge::save()
{
    if (type != nullptr)
        props.setValue ("deviceType", type->getTypeName());
    props.setValue ("inputDevice", inputName);
    props.setValue ("outputDevice", outputName);
    props.saveIfNeeded();
}

void SystemAudioBridge::timerCallback()
{
    const auto now = juce::Time::getMillisecondCounter();
    if (fifo.takeSignalFlag())
        lastSignalMs = now;

    if (running && (inputCallback->failed.load() || outputCallback->failed.load() || ! output->isPlaying() || ! input->isPlaying()))
    {
        const auto detail = output->getLastError().isNotEmpty() ? output->getLastError() : input->getLastError();
        close();
        lastError = "The audio device stopped" + (detail.isNotEmpty() ? " (" + detail + ")" : juce::String()) + ". Retrying" + juce::String::fromUTF8 ("\xe2\x80\xa6");
        lastRetryMs = now;
    }

    // Reconnect after an unplug or a driver restart.
    if (! running && inputName.isNotEmpty() && ! looksLikeLoopbackOutput (outputName, inputName) && now - lastRetryMs > 3000)
    {
        lastRetryMs = now;
        reopen();
    }
}

juce::StringArray SystemAudioBridge::getDeviceTypes()
{
    juce::StringArray names;
    for (auto* t : types)
        names.add (t->getTypeName());
    return names;
}

juce::String SystemAudioBridge::getDeviceType()
{
    return type != nullptr ? type->getTypeName() : juce::String();
}

void SystemAudioBridge::setDeviceType (const juce::String& name)
{
    for (auto* t : types)
    {
        if (t->getTypeName() == name && t != type)
        {
            close();
            type = t;
            type->scanForDevices();
            if (! type->getDeviceNames (true).contains (inputName))
                inputName = guessLoopbackInput (type->getDeviceNames (true));
            if (! type->getDeviceNames (false).contains (outputName))
                outputName.clear();
            reopen();
            return;
        }
    }
}

juce::StringArray SystemAudioBridge::getInputDevices()
{
    if (type == nullptr)
        return {};
    type->scanForDevices();
    return type->getDeviceNames (true);
}

juce::StringArray SystemAudioBridge::getOutputDevices()
{
    if (type == nullptr)
        return {};
    type->scanForDevices();
    return type->getDeviceNames (false);
}

void SystemAudioBridge::setInputDevice (const juce::String& name)
{
    inputName = name;
    reopen();
    save();
}

void SystemAudioBridge::setOutputDevice (const juce::String& name)
{
    outputName = name;
    reopen();
    save();
}

SystemAudioController::Status SystemAudioBridge::getStatus()
{
    Status s;
    s.running = running;
    s.error = lastError;
    s.receivingSignal = running && juce::Time::getMillisecondCounter() - lastSignalMs < 2000;
    if (running)
    {
        s.sampleRate = outputRate;
        const double inSec = (input->getInputLatencyInSamples() + inputBlock) / inputRate;
        const double outSec = (output->getOutputLatencyInSamples() + outputBlock + processor.getLatencySamples()) / outputRate;
        s.latencyMs = 1000.0 * (inSec + fifo.latencySeconds() + outSec);
        s.driftPpm = fifo.ratioCorrectionPpm();
        s.dropouts = fifo.underruns() + fifo.overruns();
    }
    return s;
}

} // namespace ref::standalone

#endif

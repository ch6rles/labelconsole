#include "SystemAudioBridge.h"

#if JucePlugin_Build_Standalone && JUCE_USE_CUSTOM_PLUGIN_STANDALONE_APP

 #if JUCE_MAC
  #include "MacSystem.h"
 #endif

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
        ticks.fetch_add (1, std::memory_order_relaxed);
    }

    // A device restarted by the system at another rate (Sound settings,
    // Audio MIDI Setup) must be prepared again.
    void audioDeviceAboutToStart (juce::AudioIODevice* d) override
    {
        if (d != nullptr && expectedRate > 0.0 && d->getCurrentSampleRate() != expectedRate)
            rateChanged.store (true);
    }
    void audioDeviceStopped() override {}
    void audioDeviceError (const juce::String&) override { failed.store (true); }

    std::atomic<bool> failed { false }, rateChanged { false };
    std::atomic<juce::uint32> ticks { 0 };
    double expectedRate = 0.0;

private:
    SystemAudioBridge& bridge;
};

class SystemAudioBridge::OutputCallback : public juce::AudioIODeviceCallback
{
public:
    explicit OutputCallback (SystemAudioBridge& b) : bridge (b) {}

    void prepare (int maxBlock, double sampleRate)
    {
        // The processor is prepared for maxBlock; larger device callbacks are
        // processed in pieces of that size.
        work.setSize (2, juce::jmax (1, maxBlock));
        midi.ensureSize (16);
        windowLength = juce::jmax (1, (int) (0.5 * sampleRate));
        fadeStep = (float) (1.0 / (0.02 * sampleRate));
        windowEnergy = 0.0;
        windowFrames = loudWindows = 0;
        muteGain = 1.0f;
        muted.store (false);
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
            guardAgainstFeedback (ch, len);
            for (int c = 0; c < numOut; ++c)
            {
                if (out[c] == nullptr)
                    continue;
                if (numOut == 1)
                {
                    // A mono device gets both sides, not just the left.
                    juce::FloatVectorOperations::copyWithMultiply (out[c] + done, ch[0], 0.5f, len);
                    juce::FloatVectorOperations::addWithMultiply (out[c] + done, ch[1], 0.5f, len);
                }
                else if (c < 2)
                    juce::FloatVectorOperations::copy (out[c] + done, ch[c], len);
                else
                    juce::FloatVectorOperations::clear (out[c] + done, len);
            }
            done += len;
        }
        ticks.fetch_add (1, std::memory_order_relaxed);
    }

    void audioDeviceAboutToStart (juce::AudioIODevice* d) override
    {
        if (d != nullptr && expectedRate > 0.0 && d->getCurrentSampleRate() != expectedRate)
            rateChanged.store (true);
    }
    void audioDeviceStopped() override {}
    void audioDeviceError (const juce::String&) override { failed.store (true); }

    std::atomic<bool> failed { false }, rateChanged { false };
    std::atomic<juce::uint32> ticks { 0 };
    double expectedRate = 0.0;
    // Set here when the output looks like it is feeding back into the input;
    // cleared by the bridge's timer to try again.
    std::atomic<bool> muted { false };

private:
    // If Headphones is routed into the loopback device, the calibrated output
    // comes back in as input and builds up until the protection clipper holds
    // it near full scale. Music never stays above -2.5 dBFS RMS for 1.5 s (a
    // full-scale sine is -3 dBFS), so that mutes the output, which breaks the
    // loop, before the user reroutes and gets the full level in their ears.
    void guardAgainstFeedback (float* const* ch, int len) noexcept
    {
        double energy = 0.0;
        for (int c = 0; c < 2; ++c)
            for (int i = 0; i < len; ++i)
                energy += (double) ch[c][i] * ch[c][i];
        windowEnergy += energy;
        windowFrames += len;
        if (windowFrames >= windowLength)
        {
            const double meanSquare = windowEnergy / (2.0 * windowFrames);
            loudWindows = meanSquare > kLoudMeanSquare ? loudWindows + 1 : 0;
            if (loudWindows >= 3)
                muted.store (true);
            windowEnergy = 0.0;
            windowFrames = 0;
        }

        const float target = muted.load (std::memory_order_relaxed) ? 0.0f : 1.0f;
        if (muteGain == 1.0f && target == 1.0f)
            return;
        for (int i = 0; i < len; ++i)
        {
            muteGain = target > muteGain ? juce::jmin (target, muteGain + fadeStep) : juce::jmax (target, muteGain - fadeStep);
            ch[0][i] *= muteGain;
            ch[1][i] *= muteGain;
        }
    }

    static constexpr double kLoudMeanSquare = 0.5623413251903491; // -2.5 dBFS RMS

    SystemAudioBridge& bridge;
    juce::AudioBuffer<float> work;
    juce::MidiBuffer midi;
    double windowEnergy = 0.0;
    int windowFrames = 0, windowLength = 24000, loudWindows = 0;
    float muteGain = 1.0f, fadeStep = 0.001f;
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
    // Stereo Mix is not offered: it records the sound card's own output, so it
    // only works while the headphones are on a different device.
    for (const char* pattern : { "CABLE Output", "BlackHole", "Loopback", "Monitor of", "VB-Audio", "Soundflower", "VoiceMeeter Out" })
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
    // "Stereo Mix (Realtek Audio)" records "Speakers (Realtek Audio)": the same
    // card, so playing there feeds back.
    auto card = [] (const juce::String& name) { return name.fromLastOccurrenceOf ("(", false, false).upToLastOccurrenceOf (")", false, false).trim(); };
    for (const char* mix : { "Stereo Mix", "What U Hear", "Wave Out Mix", "Wave Out" })
        if (in.containsIgnoreCase (mix) && card (in).isNotEmpty() && card (in) == card (out))
            return true;
    return out.isNotEmpty() && out == in && guessLoopbackInput ({ in }).isNotEmpty();
}

void SystemAudioBridge::restore()
{
   #if JUCE_MAC
    // Reading any audio input needs the microphone permission on macOS.
    mac::requestMicrophoneAccess();
   #endif
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
    outputCallback->prepare (outputBlock, outputRate);
    outputCallback->expectedRate = outputRate;
    inputCallback->expectedRate = inputRate;
    outputCallback->rateChanged.store (false);
    inputCallback->rateChanged.store (false);
    lastTicks[0] = lastTicks[1] = 0;
    quietTimerTicks = 0;

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

    // Unmute after a pause to see whether the routing has been fixed; if not,
    // the guard trips again before the level builds up.
    if (outputCallback->muted.load())
    {
        if (mutedSinceMs == 0)
            mutedSinceMs = now;
        else if (now - mutedSinceMs > 5000)
        {
            outputCallback->muted.store (false);
            mutedSinceMs = 0;
        }
    }
    else
    {
        mutedSinceMs = 0;
    }

    // A device restarted at another sample rate: prepare everything again.
    if (running && (inputCallback->rateChanged.load() || outputCallback->rateChanged.load()))
    {
        reopen();
        return;
    }

    // Some drivers keep a device "playing" after it is unplugged but stop
    // calling back. Two seconds without a callback counts as stopped.
    if (running)
    {
        const juce::uint32 now0 = inputCallback->ticks.load(), now1 = outputCallback->ticks.load();
        quietTimerTicks = (now0 == lastTicks[0] || now1 == lastTicks[1]) ? quietTimerTicks + 1 : 0;
        lastTicks[0] = now0;
        lastTicks[1] = now1;
    }
    const bool silentDevice = running && quietTimerTicks >= 4; // the timer runs at 2 Hz

    if (running && (silentDevice || inputCallback->failed.load() || outputCallback->failed.load() || ! output->isPlaying() || ! input->isPlaying()))
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
    if (running && outputCallback->muted.load())
        s.error = "Muted: REFERENCE is hearing its own output. Send it to your headphones, not the loopback.";
   #if JUCE_MAC
    // Without the permission macOS delivers silence, which would otherwise
    // read as a routing problem.
    if (running && s.error.isEmpty() && ! (juce::Time::getMillisecondCounter() - lastSignalMs < 2000) && mac::microphoneAccess() < 0)
        s.error = "macOS is not letting REFERENCE hear the loopback device. Allow it in System Settings, Privacy & Security, Microphone.";
   #endif
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

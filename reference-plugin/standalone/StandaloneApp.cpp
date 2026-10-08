// The standalone app: REFERENCE for the whole system. Replaces JUCE's
// default standalone wrapper (JUCE_USE_CUSTOM_PLUGIN_STANDALONE_APP).

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_extra/juce_gui_extra.h>

#if JucePlugin_Build_Standalone && JUCE_USE_CUSTOM_PLUGIN_STANDALONE_APP

 #include "../plugin/Parameters.h"
 #include "../plugin/PluginProcessor.h"
 #include "../ui/GraphView.h"
 #include "../ui/HeaderBars.h"
 #include "../ui/PluginEditor.h"
 #include "../ui/Theme.h"
 #include "SystemAudioBridge.h"

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter();

namespace ref::standalone
{

namespace
{
std::unique_ptr<juce::AudioProcessor> createStandaloneProcessor()
{
    juce::PluginHostType::jucePlugInClientCurrentWrapperType = juce::AudioProcessor::wrapperType_Standalone;
    juce::AudioProcessor::setTypeOfNextNewPlugin (juce::AudioProcessor::wrapperType_Standalone);
    std::unique_ptr<juce::AudioProcessor> p (createPluginFilter());
    juce::AudioProcessor::setTypeOfNextNewPlugin (juce::AudioProcessor::wrapperType_Undefined);
    return p;
}

juce::Image trayImage()
{
    juce::Image img (juce::Image::ARGB, 64, 64, true);
    juce::Graphics g (img);
    ui::drawPowerIcon (g, { 8.0f, 8.0f, 48.0f, 48.0f }, juce::Colours::white, 1.6f);
    return img;
}

template <typename T>
T* findChild (juce::Component& root)
{
    if (auto* t = dynamic_cast<T*> (&root))
        return t;
    for (auto* c : root.getChildren())
        if (auto* t = findChild<T> (*c))
            return t;
    return nullptr;
}

template <typename T>
std::vector<T*> findChildren (juce::Component& root)
{
    std::vector<T*> out;
    if (auto* t = dynamic_cast<T*> (&root))
        out.push_back (t);
    for (auto* c : root.getChildren())
        for (auto* t : findChildren<T> (*c))
            out.push_back (t);
    return out;
}
} // namespace

//==============================================================================
class MainWindow : public juce::DocumentWindow
{
public:
    MainWindow (juce::AudioProcessorEditor* editor, std::function<void()> onClose)
        : DocumentWindow ("REFERENCE", ui::colours::bg, DocumentWindow::allButtons), closeHandler (std::move (onClose))
    {
        setUsingNativeTitleBar (true);
        editor->setResizable (true, false); // the native window border resizes
        setContentOwned (editor, true);
        setResizable (true, false);
        setConstrainer (editor->getConstrainer());
        centreWithSize (getWidth(), getHeight());
    }

    void closeButtonPressed() override { closeHandler(); }

private:
    std::function<void()> closeHandler;
};

//==============================================================================
// Renders every UI state to PNG for review (REFERENCE --snapshot <dir>).
class SnapshotRunner : private juce::Timer
{
public:
    explicit SnapshotRunner (juce::File dir) : outDir (std::move (dir))
    {
        outDir.createDirectory();
        processor = createStandaloneProcessor();
        proc = dynamic_cast<ReferenceProcessor*> (processor.get());
        processor->setPlayConfigDetails (2, 2, 48000.0, 480);
        processor->prepareToPlay (48000.0, 480);
        buffer.setSize (2, 480);
        editor.reset (processor->createEditorAndMakeActive());
        editor->setSize (1200, 700);
        startTimer (10);
    }

    std::function<void()> onFinished;

private:
    void timerCallback() override
    {
        // Simulated playback: pink-ish noise around -20 dBFS (louder for the
        // protection state).
        for (int c = 0; c < 2; ++c)
        {
            auto* d = buffer.getWritePointer (c);
            for (int i = 0; i < buffer.getNumSamples(); ++i)
            {
                lp[c] = 0.97f * lp[c] + 0.03f * (rng.nextFloat() * 2.0f - 1.0f);
                d[i] = level * (0.35f * (rng.nextFloat() * 2.0f - 1.0f) + 3.0f * lp[c]);
            }
        }
        juce::MidiBuffer midi;
        processor->processBlock (buffer, midi);

        elapsed += 10;
        if (elapsed >= nextStepAt)
            step();
    }

    void shoot (const juce::String& name)
    {
        const auto img = editor->createComponentSnapshot (editor->getLocalBounds(), true, 2.0f);
        juce::FileOutputStream out (outDir.getChildFile (name + ".png"));
        if (out.openedOk())
        {
            out.setPosition (0);
            out.truncate();
            juce::PNGImageFormat().writeImageToStream (img, out);
        }
    }

    ui::MainView& view() { return *findChild<ui::MainView> (*editor); }

    void wait (int ms) { nextStepAt = elapsed + ms; }

    void step()
    {
        auto& v = view();
        switch (stage++)
        {
            case 0:
                wait (1500);
                break;
            case 1:
                findChild<ui::PlotView> (v)->showHoverAt (1020.0);
                wait (100);
                break;
            case 2:
                shoot ("01-main");
                findChild<ui::PlotView> (v)->showHoverAt (-1.0);
                proc->setOverlay ({ { dsp::FilterType::lowShelf, 90.0, 1.5, 0.7 }, { dsp::FilterType::bell, 4500.0, -2.5, 2.5 },
                                    { dsp::FilterType::bell, 1600.0, 1.2, 1.0 }, { dsp::FilterType::highShelf, 11000.0, -1.5, 0.7 } });
                proc->setAdvancedView (true);
                v.model().selectedNode = 1;
                wait (400);
                break;
            case 3:
                shoot ("02-advanced");
                proc->setOverlay ({});
                proc->setAdvancedView (false);
                v.model().selectedNode = -1;
                v.setPage (ui::Page::settings);
                wait (300);
                break;
            case 4:
                shoot ("03-settings");
                v.setPage (ui::Page::calibration);
                findChildren<ui::DropdownField> (*findChild<ui::HeaderRow2> (v))[0]->onClick();
                wait (200);
                break;
            case 5:
                shoot ("04-headphone-menu");
                v.closeMenu();
                findChildren<ui::DropdownField> (*findChild<ui::HeaderRow2> (v))[1]->onClick();
                wait (200);
                break;
            case 6:
                shoot ("05-target-menu");
                v.closeMenu();
                writeWarningProfile();
                proc->reloadLibrary();
                proc->setProfile ("test_bass_rolloff");
                proc->setAutoGain (false);
                v.model().setParam (params::outputGain, 12.0f);
                level = 0.6f;
                wait (900);
                break;
            case 7:
                shoot ("06-warning-protection");
                level = 0.1f;
                proc->setAutoGain (true);
                v.model().setParam (params::outputGain, 0.0f);
                proc->setProfile ("audeze_mm520");
                wait (2500);
                break;
            case 8:
                processor->setNonRealtime (true);
                wait (300);
                break;
            case 9:
                shoot ("07-offline-render");
                processor->setNonRealtime (false);
                wait (300);
                break;
            case 10:
                findChild<ui::PresetBox> (v)->menuButton.onClick();
                wait (200);
                break;
            case 11:
                shoot ("08-preset-menu");
                v.closeMenu();
                v.showHelpTopic ("systemwide");
                wait (200);
                break;
            case 12:
                shoot ("09-help");
                v.setPage (ui::Page::calibration);
                editor->setSize (800, 500);
                wait (300);
                break;
            case 13:
                shoot ("10-minimum-size");
                editor->setSize (1200, 700);
                proc->setFilterMode (dsp::FilterMode::linearPhase);
                wait (600);
                break;
            case 14:
                shoot ("11-linear-phase");
                proc->setFilterMode (dsp::FilterMode::minimumPhase);
                stopTimer();
                if (onFinished)
                    onFinished();
                break;
            default:
                break;
        }
    }

    // A test-only profile with a deep low-bass roll-off, so the generator
    // limits the boost (the warning state). Written to the snapshot's own
    // data folder, never shipped.
    void writeWarningProfile()
    {
        auto g = [] (double f, double fc, double w) { const double o = std::log2 (f / fc) / w; return std::exp (-0.5 * o * o); };
        auto sig = [] (double f, double fc, double k) { return 1.0 / (1.0 + std::exp (-std::log2 (f / fc) * k)); };
        auto target = [&] (double f) { return 3.2 * (1 - sig (f, 110, 2.6)) + 7.2 * g (f, 2900, 0.75) - 4.6 * sig (f, 12500, 2.2) - 1.2; };
        auto dev = [&] (double f) { return -9.5 * g (f, 26, 0.85) - 2.4 * g (f, 190, 0.6) + 1.8 * g (f, 1000, 0.45) - 4.0 * g (f, 4300, 0.3); };
        juce::String fq, mean, spread;
        for (int i = 0; i < 241; ++i)
        {
            const double f = 20.0 * std::pow (1000.0, i / 240.0);
            const auto sep = i == 0 ? "" : ", ";
            fq << sep << juce::String (f, 3);
            mean << sep << juce::String (target (f) + dev (f), 3);
            spread << sep << juce::String (0.3 + 2.6 * sig (f, 7000, 3) + 0.7 * g (f, 30, 0.6), 3);
        }
        juce::String text;
        text << "{\n  \"schema_version\": 2,\n  \"id\": \"test_bass_rolloff\",\n  \"display_name\": \"Audeze MM-520\",\n"
             << "  \"manufacturer\": \"Audeze\",\n  \"model_revision\": \"MM-520\",\n  \"placeholder\": true,\n"
             << "  \"measurement\": { \"rig_id\": \"rig-01\", \"ear_simulator\": \"IEC 60318-4\", \"source\": \"test\", \"license\": \"test\", \"units\": 0, \"reseats_per_unit\": 0, \"date\": \"2026-10-08\" },\n"
             << "  \"targets\": [\"studio_reference@1\", \"neutral@1\"],\n"
             << "  \"limits\": { \"max_boost_db\": 6, \"max_cut_db\": -12, \"treble_average_above_hz\": 9000 },\n"
             << "  \"curve\": { \"freq_hz\": [" << fq << "], \"mean_db\": [" << mean << "], \"spread_db\": [" << spread << "] },\n"
             << "  \"generator_version\": \"1.0.0\",\n  \"sha256\": \"\"\n}\n";
        text = text.replace ("\"sha256\": \"\"", "\"sha256\": \"" + ProfileLibrary::computeChecksum (text) + "\"");
        auto dir = ProfileLibrary::userProfilesDirectory();
        dir.createDirectory();
        dir.getChildFile ("test_bass_rolloff.json").replaceWithText (text);
    }

    juce::File outDir;
    std::unique_ptr<juce::AudioProcessor> processor;
    ReferenceProcessor* proc = nullptr;
    std::unique_ptr<juce::AudioProcessorEditor> editor;
    juce::AudioBuffer<float> buffer;
    juce::Random rng { 42 };
    float lp[2] {}, level = 0.1f;
    int elapsed = 0, nextStepAt = 0, stage = 0;
};

//==============================================================================
class ReferenceApp : public juce::JUCEApplication, private juce::Timer
{
public:
    const juce::String getApplicationName() override { return JucePlugin_Name; }
    const juce::String getApplicationVersion() override { return JucePlugin_VersionString; }
    bool moreThanOneInstanceAllowed() override { return false; }

    void initialise (const juce::String& commandLine) override
    {
        if (commandLine.contains ("--snapshot"))
        {
            const auto dir = juce::File::getCurrentWorkingDirectory().getChildFile (
                commandLine.fromFirstOccurrenceOf ("--snapshot", false, false).trim().unquoted());
            snapshot = std::make_unique<SnapshotRunner> (dir);
            snapshot->onFinished = [] { juce::MessageManager::callAsync ([] { quit(); }); };
            return;
        }

        juce::PropertiesFile::Options opts;
        opts.applicationName = "REFERENCE";
        opts.filenameSuffix = ".settings";
        opts.folderName = "REFERENCE";
        opts.osxLibrarySubFolder = "Application Support";
        settings = std::make_unique<juce::PropertiesFile> (opts);

        processor = createStandaloneProcessor();
        juce::MemoryBlock state;
        if (state.fromBase64Encoding (settings->getValue ("pluginState")) && state.getSize() > 0)
            processor->setStateInformation (state.getData(), (int) state.getSize());

        bridge = std::make_unique<SystemAudioBridge> (*processor, *settings);
        SystemAudioController::setInstance (bridge.get());

        window = std::make_unique<MainWindow> (processor->createEditorAndMakeActive(), [this] { closeWindow(); });
        window->setVisible (true);

        bridge->restore();

       #if ! JUCE_LINUX
        tray = std::make_unique<Tray> (*this);
       #endif
        startTimer (10000);
    }

    void shutdown() override
    {
        stopTimer();
        if (snapshot != nullptr)
        {
            snapshot.reset();
            return;
        }
        saveState();
        tray.reset();
        SystemAudioController::setInstance (nullptr);
        bridge.reset();
        window.reset();
        processor.reset();
        settings.reset();
    }

    void systemRequestedQuit() override { quit(); }

    void anotherInstanceStarted (const juce::String&) override { showWindow(); }

    void showWindow()
    {
        if (window != nullptr)
        {
            window->setVisible (true);
            window->toFront (true);
        }
    }

private:
    // Tray (Windows) or menu bar (macOS) icon: REFERENCE keeps calibrating
    // while its window is closed.
    class Tray : public juce::SystemTrayIconComponent
    {
    public:
        explicit Tray (ReferenceApp& a) : app (a)
        {
            const auto img = trayImage();
            setIconImage (img, img);
            setIconTooltip ("REFERENCE");
        }

        void mouseDown (const juce::MouseEvent& e) override
        {
           #if JUCE_WINDOWS
            if (! e.mods.isPopupMenu())
            {
                app.showWindow();
                return;
            }
           #endif
            juce::ignoreUnused (e);
            showMenu();
        }

    private:
        void showMenu()
        {
            auto* proc = dynamic_cast<ReferenceProcessor*> (app.processor.get());
            juce::PopupMenu m;
            m.addItem ("Show REFERENCE", [this] { app.showWindow(); });
            m.addSeparator();
            if (proc != nullptr)
            {
                auto& params = proc->getParameters();
                const bool cal = params.getRawParameterValue (params::abSelect)->load() > 0.5f;
                const bool byp = params.getRawParameterValue (params::bypass)->load() > 0.5f;
                auto set = [&params] (const char* id, float v)
                {
                    auto* p = params.getParameter (id);
                    p->setValueNotifyingHost (p->convertTo0to1 (v));
                };
                m.addItem ("Calibrated (A/B)", true, cal, [set, cal] { set (params::abSelect, cal ? 0.0f : 1.0f); });
                m.addItem ("Bypass", true, byp, [set, byp] { set (params::bypass, byp ? 0.0f : 1.0f); });
                m.addSeparator();
            }
            m.addItem ("Quit REFERENCE", [] { juce::JUCEApplication::quit(); });
           #if JUCE_MAC
            showDropdownMenu (m);
           #else
            m.showMenuAsync ({});
           #endif
        }

        ReferenceApp& app;
    };

    void closeWindow()
    {
        if (tray != nullptr)
            window->setVisible (false); // keep running in the tray
        else
            quit();
    }

    void saveState()
    {
        if (processor == nullptr || settings == nullptr)
            return;
        juce::MemoryBlock state;
        processor->getStateInformation (state);
        settings->setValue ("pluginState", state.toBase64Encoding());
        settings->saveIfNeeded();
    }

    void timerCallback() override { saveState(); }

    std::unique_ptr<juce::PropertiesFile> settings;
    std::unique_ptr<juce::AudioProcessor> processor;
    std::unique_ptr<SystemAudioBridge> bridge;
    std::unique_ptr<MainWindow> window;
    std::unique_ptr<Tray> tray;
    std::unique_ptr<SnapshotRunner> snapshot;
};

} // namespace ref::standalone

juce::JUCEApplicationBase* juce_CreateApplication()
{
    return new ref::standalone::ReferenceApp();
}

#endif

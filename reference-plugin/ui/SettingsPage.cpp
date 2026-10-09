#include "SettingsPage.h"

#include "../measurement/TextUtil.h"
#include "ref/dsp/Format.h"
#include "../plugin/SystemAudio.h"
#include "ref/dsp/FirDesign.h"

namespace ref::ui
{

namespace
{
const juce::Font& sectionFont() { static const auto f = mono (10.0f, 400, 0.14f); return f; }
const juce::Font& titleFont() { static const auto f = sans (13.0f, 500); return f; }
const juce::Font& descFont() { static const auto f = sans (11.5f); return f; }
const juce::Font& valueFont() { static const auto f = mono (11.5f); return f; }
const juce::Font& linkFont() { static const auto f = mono (10.5f); return f; }
constexpr float kDescLine = 11.5f * 1.45f;

SegmentedControl::Style smallSegStyle()
{
    SegmentedControl::Style s;
    s.font = mono (10.5f);
    s.border = colours::borderField;
    s.padX = 8.0f;
    s.boldWhenSelected = true;
    return s;
}

DropdownField::Style smallDropdown()
{
    DropdownField::Style s;
    s.font = mono (11.0f);
    s.fill = juce::Colours::transparentBlack;
    s.padX = 9.0f;
    s.gap = 10.0f;
    s.chevronSize = 4.0f;
    s.chevronAtEnd = false;
    return s;
}

juce::String rateText (double fs)
{
    const double k = fs / 1000.0;
    return juce::String (k, std::abs (k - std::round (k)) < 1e-6 ? 0 : 1) + " kHz";
}

juce::String withThousands (int v)
{
    auto s = juce::String (v);
    for (int i = s.length() - 3; i > 0; i -= 3)
        s = s.substring (0, i) + "," + s.substring (i);
    return s;
}
} // namespace

//==============================================================================
class SettingsPage::Content : public juce::Component
{
public:
    struct Row
    {
        juce::String title, desc, value, linkText;
        juce::Component* control = nullptr;
        std::function<void()> link;
        bool keycap = false;
        juce::Rectangle<float> bounds, right;
    };

    struct Section
    {
        juce::String title;
        std::vector<Row> rows;
        juce::Rectangle<float> header;
    };

    explicit Content (EditorHost& h)
        : host (h), filterMode ({ "MIN", "LINEAR" }, smallSegStyle()), uiScale ({ "75", "100", "125", "150", "200" }, smallSegStyle()),
          graphRange (smallDropdown()), source (smallDropdown()), headphones (smallDropdown()), driver (smallDropdown())
    {
        for (auto* c : std::initializer_list<juce::Component*> { &autoBypass, &autoGain, &protection, &filterMode, &uiScale, &graphRange })
            addAndMakeVisible (c);
        auto& m = host.model();
        autoBypass.onToggle = [&m] (bool on) { m.proc.setAutoBypassOffline (on); };
        autoGain.onToggle = [&m] (bool on) { m.proc.setAutoGain (on); };
        protection.onToggle = [&m] (bool on) { m.proc.setMonitorProtection (on); };
        filterMode.onSelect = [&m] (int i) { m.proc.setFilterMode (i == 1 ? dsp::FilterMode::linearPhase : dsp::FilterMode::minimumPhase); };
        uiScale.onSelect = [&m] (int i) { m.proc.setUiScale (std::array<float, 5> { 0.75f, 1.0f, 1.25f, 1.5f, 2.0f }[(size_t) i]); };
        graphRange.onClick = [this]
        {
            auto& model = host.model();
            std::vector<MenuItem> items;
            for (int db : { 6, 12, 18, 24 })
            {
                MenuItem it;
                it.text = text::plusMinus + juce::String (db) + " dB";
                it.selected = model.settings.graphRangeDb == db;
                it.action = [&model, db] { model.proc.setGraphRange (db); };
                items.push_back (it);
            }
            MenuStyle style;
            style.width = 120.0f;
            style.rowPadY = 7.0f;
            style.monoItems = true;
            host.showMenu (std::move (items), style, graphRange, 6.0f);
        };

        if (auto* sys = SystemAudioController::instance())
        {
            for (auto* c : { &source, &headphones, &driver })
                addAndMakeVisible (c);
            auto deviceMenu = [this, sys] (DropdownField& anchor, juce::StringArray names, juce::String current, std::function<void (const juce::String&)> pick)
            {
                std::vector<MenuItem> items;
                if (names.isEmpty())
                {
                    MenuItem none;
                    none.text = "No devices found";
                    none.enabled = false;
                    items.push_back (none);
                }
                for (const auto& n : names)
                {
                    MenuItem it;
                    it.text = n;
                    it.selected = n == current;
                    it.action = [pick, n] { pick (n); };
                    items.push_back (it);
                }
                MenuStyle style;
                style.width = 320.0f;
                style.rowPadY = 8.0f;
                host.showMenu (std::move (items), style, anchor, 6.0f);
                juce::ignoreUnused (sys);
            };
            source.onClick = [this, sys, deviceMenu] { deviceMenu (source, sys->getInputDevices(), sys->getInputDevice(), [this, sys] (const juce::String& n) { sys->setInputDevice (n); refresh(); }); };
            headphones.onClick = [this, sys, deviceMenu] { deviceMenu (headphones, sys->getOutputDevices(), sys->getOutputDevice(), [this, sys] (const juce::String& n) { sys->setOutputDevice (n); refresh(); }); };
            driver.onClick = [this, sys, deviceMenu] { deviceMenu (driver, sys->getDeviceTypes(), sys->getDeviceType(), [this, sys] (const juce::String& n) { sys->setDeviceType (n); refresh(); }); };
        }
        refresh();
    }

    void refresh()
    {
        auto& m = host.model();
        const auto& s = m.settings;
        autoBypass.setOn (s.autoBypassOffline);
        autoGain.setOn (s.autoGain);
        protection.setOn (s.monitorProtection);
        filterMode.setSelected (s.filterMode == dsp::FilterMode::linearPhase ? 1 : 0);
        int scaleIndex = 1;
        const float scales[] = { 0.75f, 1.0f, 1.25f, 1.5f, 2.0f };
        for (int i = 0; i < 5; ++i)
            if (std::abs (scales[i] - s.uiScale) < 0.01f)
                scaleIndex = i;
        uiScale.setSelected (scaleIndex);
        graphRange.setText (text::plusMinus + juce::String (s.graphRangeDb) + " dB");

        for (auto& c : cols)
            c.clear();

        // Column 1
        if (auto* sys = SystemAudioController::instance())
        {
            const auto st = sys->getStatus();
            source.setText (sys->getInputDevice().isEmpty() ? juce::String ("Choose") + text::ellipsis : sys->getInputDevice());
            headphones.setText (sys->getOutputDevice().isEmpty() ? juce::String ("Choose") + text::ellipsis : sys->getOutputDevice());
            driver.setText (sys->getDeviceType());
            // Device names can be long; the field shows the start, the tooltip all of it.
            source.setTooltip (sys->getInputDevice());
            headphones.setTooltip (sys->getOutputDevice());
            juce::String statusDesc;
            if (st.error.isNotEmpty())
                statusDesc = st.error;
            else if (! st.running)
                statusDesc = "Not running. Choose a source and your headphones.";
            else if (! st.receivingSignal)
                statusDesc = "No audio from the source yet. Is it set as your computer's sound output?";
            else
                statusDesc = "Receiving system audio. Clock drift " + text::fromStd (dsp::formatNumber (st.driftPpm, 0, true)) + " ppm, corrected"
                           + (st.dropouts > 0 ? "; " + juce::String ((int) st.dropouts) + (st.dropouts == 1 ? " dropout." : " dropouts.") : juce::String ("."));
            Section audio { "SYSTEM AUDIO", {}, {} };
            audio.rows.push_back ({ "Source", "Set this device as your computer's sound output; REFERENCE listens to it.", {}, {}, &source });
            audio.rows.push_back ({ "Headphones", "Calibrated audio plays here.", {}, {}, &headphones });
            audio.rows.push_back ({ "Driver", "The audio system both devices belong to.", {}, {}, &driver });
            audio.rows.push_back ({ "Status", statusDesc, st.running ? rateText (st.sampleRate) + "\n" + juce::String (st.latencyMs, 1) + " ms" : text::emDash });
            Row guide { "Setup guide", "Step by step for Windows, macOS and Linux.", {}, "Help " + text::arrowRight };
            guide.link = [this] { host.showHelpTopic ("systemwide"); };
            audio.rows.push_back (guide);
            cols[0].push_back (audio);
            autoBypass.setVisible (false);
        }
        else
        {
            Section render { "RENDER SAFETY", {}, {} };
            render.rows.push_back ({ "Auto-bypass offline render", "Calibration switches off while the host exports offline, so the file is bit-exact to the dry mix.", {}, {}, &autoBypass });
            Row bounces { "Real-time bounces", "These can't be detected. Bypass before bouncing in real time.", {}, "Help " + text::arrowRight };
            bounces.link = [this] { host.showHelpTopic ("daw"); };
            render.rows.push_back (bounces);
            cols[0].push_back (render);
        }

        Section gain { "GAIN STAGING", {}, {} };
        gain.rows.push_back ({ "Auto Gain", "Static level match and headroom, computed from the correction curve, so A/B compares at equal loudness.", {}, {}, &autoGain });
        gain.rows.push_back ({ "Monitor Protection",
                               "Soft-knee clipper from about " + text::minus + "1 dBFS, zero latency. A last resort; it engages only on already-hot sources.", {}, {}, &protection });
        gain.rows.push_back ({ "Ceiling", {}, text::minus + "0.1 dBFS" });
        cols[0].push_back (gain);

        // Column 2
        const double fs = m.proc.getCurrentSampleRate();
        const auto sizing = dsp::linearPhaseSizing (fs);
        Section filter { "FILTER", {}, {} };
        filter.rows.push_back ({ "Filter mode", "Linear Phase keeps the correction phase-neutral, at the cost of latency and possible pre-ringing. With gentle corrections the difference is small.", {}, {}, &filterMode });
        filter.rows.push_back ({ "Linear Phase at " + rateText (fs), "FIR length scales with sample rate; latency in ms stays the same.",
                                 withThousands (sizing.nominalTaps) + " taps\n" + m.latencyText (dsp::FilterMode::linearPhase) });
        filter.rows.push_back ({ "Sample rate", "Supported from 44.1 to 384 kHz. Filters are designed for each rate.", rateText (fs) });
        cols[1].push_back (filter);

        Section ab { "A/B AND BYPASS", {}, {} };
        ab.rows.push_back ({ "Crossfade", "Used by A/B and Bypass, to avoid clicks.", "20 ms" });
        Row key { "A/B shortcut", "Works where the host passes keys to plugins.", "A" };
        key.keycap = true;
        ab.rows.push_back (key);
        cols[1].push_back (ab);

        // Column 3
        Section profile { "PROFILE AND SESSION", {}, {} };
        const auto& snap = m.snap;
        juce::String profileDesc, measDesc, rig;
        if (snap != nullptr)
        {
            profileDesc = snap->profileName + text::spacedDot + "schema 2" + text::spacedDot + "generator " + snap->generatorVersion
                        + text::spacedDot + (snap->fromEmbedded ? "using the embedded curve" : "checksum verified");
            measDesc = snap->measurementSummary;
            rig = snap->rigId;
        }
        profile.rows.push_back ({ "Profile", profileDesc, s.profileId });
        profile.rows.push_back ({ "Measurement", measDesc, rig });
        profile.rows.push_back ({ "Session recall", "The correction curve is saved with the session, so it reopens identically even without this profile installed.", "Embedded" });
        Row folder { "Your profiles", "Measured profiles (.json) and targets (.csv) placed here appear in the menus.", {}, "Open " + text::arrowRight };
        folder.link = []
        {
            const auto dir = ProfileLibrary::userDataDirectory();
            ProfileLibrary::userProfilesDirectory().createDirectory();
            ProfileLibrary::userTargetsDirectory().createDirectory();
            dir.startAsProcess();
        };
        profile.rows.push_back (folder);
        Row reload { "Reload profiles", "Reads the folder again after you add or change files.", {}, "Reload" };
        reload.link = [&m] { m.proc.reloadLibrary(); };
        profile.rows.push_back (reload);
        cols[2].push_back (profile);

        Section display { "DISPLAY", {}, {} };
        display.rows.push_back ({ "UI scale", {}, {}, {}, &uiScale });
        display.rows.push_back ({ "Graph range", "Level axis zoom", {}, {}, &graphRange });
        cols[2].push_back (display);

        layout ((float) getWidth());
        repaint();
    }

    float layout (float width)
    {
        constexpr float padX = 32.0f, gapX = 40.0f;
        const float colW = (width - 2.0f * padX - 2.0f * gapX) / 3.0f;
        float maxY = 0.0f;
        for (int c = 0; c < 3; ++c)
        {
            const float x = padX + (float) c * (colW + gapX);
            float y = 24.0f;
            for (auto& sec : cols[(size_t) c])
            {
                sec.header = { x, y, colW, sectionFont().getHeight() + 9.0f + 1.0f };
                y += sec.header.getHeight();
                for (auto& row : sec.rows)
                {
                    float rightW = 0.0f, rightH = 0.0f;
                    if (row.control != nullptr)
                    {
                        if (auto* seg = dynamic_cast<SegmentedControl*> (row.control))
                            rightW = seg->preferredWidth(), rightH = 26.0f;
                        else if (auto* dd = dynamic_cast<DropdownField*> (row.control))
                            rightW = juce::jmin (juce::jmax (colW * 0.5f, 120.0f), dd->preferredWidth()), rightH = 26.0f;
                        else
                            rightW = 30.0f, rightH = 16.0f;
                    }
                    else if (row.keycap)
                    {
                        rightW = juce::jmax (26.0f, textWidth (mono (11.0f), row.value) + 14.0f);
                        rightH = 24.0f;
                    }
                    else if (row.linkText.isNotEmpty())
                    {
                        rightW = textWidth (linkFont(), row.linkText) + 2.0f;
                        rightH = linkFont().getHeight() + 2.0f;
                    }
                    else if (row.value.isNotEmpty())
                    {
                        juce::StringArray lines;
                        lines.addLines (row.value);
                        for (const auto& l : lines)
                            rightW = juce::jmax (rightW, textWidth (valueFont(), l) + 1.0f);
                        rightH = (float) lines.size() * (valueFont().getHeight() + 1.0f);
                    }

                    const float textW = juce::jmax (60.0f, colW - rightW - (rightW > 0.0f ? 18.0f : 0.0f));
                    float leftH = titleFont().getHeight();
                    if (row.desc.isNotEmpty())
                        leftH += 3.0f + paragraphHeight (row.desc, textW, descFont(), kDescLine);
                    const float h = 11.0f + juce::jmax (leftH, rightH) + 11.0f;
                    row.bounds = { x, y, colW, h };
                    const float th = titleFont().getHeight();
                    const float ry = y + 11.0f + (rightH < th ? (th - rightH) * 0.5f : 0.0f);
                    row.right = { x + colW - rightW, ry, rightW, rightH };
                    if (row.control != nullptr)
                        row.control->setBounds (row.right.toNearestInt());
                    y += h;
                }
                y += 22.0f;
            }
            maxY = juce::jmax (maxY, y);
        }
        return maxY;
    }

    void paint (juce::Graphics& g) override
    {
        for (const auto& col : cols)
        {
            for (const auto& sec : col)
            {
                drawText (g, sec.title, sec.header.withHeight (sectionFont().getHeight()), sectionFont(), colours::label);
                g.setColour (colours::divider);
                g.fillRect (sec.header.getX(), sec.header.getBottom() - 1.0f, sec.header.getWidth(), 1.0f);
                for (const auto& row : sec.rows)
                {
                    const auto& b = row.bounds;
                    g.setColour (colours::lineSubtle);
                    g.fillRect (b.getX(), b.getBottom() - 1.0f, b.getWidth(), 1.0f);
                    const float textW = juce::jmax (60.0f, b.getWidth() - row.right.getWidth() - (row.right.getWidth() > 0.0f ? 18.0f : 0.0f));
                    drawText (g, row.title, { b.getX(), b.getY() + 11.0f, textW, titleFont().getHeight() }, titleFont(), colours::ink);
                    if (row.desc.isNotEmpty())
                        drawParagraph (g, row.desc, { b.getX(), b.getY() + 11.0f + titleFont().getHeight() + 3.0f, textW, 400.0f }, descFont(), colours::muted, kDescLine);

                    if (row.control != nullptr)
                        continue;
                    if (row.keycap)
                    {
                        g.setColour (colours::borderControl);
                        g.drawRoundedRectangle (row.right.reduced (0.5f), 4.0f, 1.0f);
                        g.fillRect (row.right.getX() + 3.0f, row.right.getBottom() - 2.0f, row.right.getWidth() - 6.0f, 1.0f);
                        drawText (g, row.value, row.right.withTrimmedBottom (1.0f), mono (11.0f), colours::ink, juce::Justification::centred);
                    }
                    else if (row.linkText.isNotEmpty())
                    {
                        drawText (g, row.linkText, row.right.withHeight (linkFont().getHeight()), linkFont(), colours::ink2);
                        g.setColour (colours::muted);
                        g.fillRect (row.right.getX(), row.right.getY() + linkFont().getHeight() + 1.0f, row.right.getWidth(), 1.0f);
                    }
                    else if (row.value.isNotEmpty())
                    {
                        juce::StringArray lines;
                        lines.addLines (row.value);
                        float y = row.right.getY();
                        for (const auto& l : lines)
                        {
                            drawText (g, l, { row.right.getX() - 4.0f, y, row.right.getWidth() + 4.0f, valueFont().getHeight() }, valueFont(), colours::ink2,
                                      juce::Justification::centredRight);
                            y += valueFont().getHeight() + 1.0f;
                        }
                    }
                }
            }
        }
    }

    void mouseUp (const juce::MouseEvent& e) override
    {
        for (const auto& col : cols)
            for (const auto& sec : col)
                for (const auto& row : sec.rows)
                    if (row.link && row.right.expanded (4.0f).contains (e.position))
                    {
                        auto fn = row.link;
                        fn();
                        return;
                    }
    }

    void mouseMove (const juce::MouseEvent& e) override
    {
        bool overLink = false;
        for (const auto& col : cols)
            for (const auto& sec : col)
                for (const auto& row : sec.rows)
                    overLink = overLink || (row.link && row.right.expanded (4.0f).contains (e.position));
        setMouseCursor (overLink ? juce::MouseCursor::PointingHandCursor : juce::MouseCursor::NormalCursor);
    }

private:
    EditorHost& host;
    std::array<std::vector<Section>, 3> cols;
    Switch autoBypass, autoGain, protection;
    SegmentedControl filterMode, uiScale;
    DropdownField graphRange, source, headphones, driver;
};

//==============================================================================
SettingsPage::SettingsPage (EditorHost& h) : host (h)
{
    content = std::make_unique<Content> (h);
    viewport.setViewedComponent (content.get(), false);
    viewport.setScrollBarsShown (true, false);
    viewport.setScrollBarThickness (6);
    viewport.getVerticalScrollBar().setColour (juce::ScrollBar::thumbColourId, colours::borderControl);
    addAndMakeVisible (viewport);
    host.model().addListener (this);
}

SettingsPage::~SettingsPage()
{
    host.model().removeListener (this);
}

void SettingsPage::modelChanged()
{
    if (isVisible())
        content->refresh();
}

void SettingsPage::visibilityChanged()
{
    if (isVisible())
    {
        content->refresh();
        resized();
        if (SystemAudioController::instance() != nullptr)
            startTimerHz (2);
    }
    else
    {
        stopTimer();
    }
}

void SettingsPage::timerCallback()
{
    content->refresh();
}

void SettingsPage::resized()
{
    const auto r = getLocalBounds();
    viewport.setBounds (r.withTrimmedBottom (42));
    const float w = (float) viewport.getWidth();
    const float h = content->layout (w);
    content->setSize ((int) w - (h > (float) viewport.getHeight() ? 6 : 0), (int) std::ceil (h));
    content->layout ((float) content->getWidth());
}

void SettingsPage::paint (juce::Graphics& g)
{
    const auto r = getLocalBounds().toFloat();
    const float y = r.getBottom() - 42.0f;
    g.setColour (colours::line);
    g.fillRect (32.0f, y, r.getWidth() - 64.0f, 1.0f);

    const auto f = mono (10.5f);
    auto format = juce::AudioProcessor::getWrapperTypeDescription (host.model().proc.wrapperType);
    if (juce::String (format) == "Undefined")
        format = "VST3";
    drawText (g, "REFERENCE " + juce::String (JucePlugin_VersionString) + text::spacedDot + juce::String (format).toUpperCase(),
              { 32.0f, y + 1.0f, r.getWidth() * 0.5f, 41.0f }, f, colours::label);

    const juce::String licences ("Third-party licences");
    const auto left = juce::String ("Not affiliated with or endorsed by Audeze.") + text::spacedDot;
    const float lw = textWidth (f, licences);
    licencesLink = { r.getRight() - 32.0f - lw, y + 1.0f, lw, 41.0f };
    drawText (g, licences, licencesLink, f, colours::label);
    drawText (g, left, { licencesLink.getX() - 500.0f, y + 1.0f, 500.0f, 41.0f }, f, colours::label, juce::Justification::centredRight);
}

void SettingsPage::mouseUp (const juce::MouseEvent& e)
{
    if (licencesLink.contains (e.position))
        host.showHelpTopic ("licences");
}

} // namespace ref::ui

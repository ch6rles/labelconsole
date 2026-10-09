#include "HelpPage.h"

#include "../measurement/TextUtil.h"

namespace ref::ui
{

namespace
{
juce::String u (const char* s) { return juce::String::fromUTF8 (s); }

std::vector<HelpPage::Topic> buildTopics()
{
    std::vector<HelpPage::Topic> t;

    t.push_back ({ "what", "What calibration does", {
        u ("REFERENCE is a reference calibration for headphones. It moves a specific headphone model toward a chosen target, measured on a named rig, so your monitoring is more consistent from day to day and from one pair of the same model to the next."),
        u ("It keeps three things apart. Headphone correction moves the headphone toward the target. The monitoring reference is the target itself: a voicing decision, not a truth. Spatial simulation (crossfeed and virtual speakers) is planned for later versions and is off."),
        u ("Every filter the plugin runs comes from one bounded correction curve: at most +6 dB of boost and \xe2\x88\x92" "12 dB of cut, with fit-dependent treble detail averaged out. The graph shows the measured response, the target, the correction and the predicted result on the rig."),
    } });

    t.push_back ({ "target", "Why the target is not flat", {
        u ("A headphone measured flat at an ear simulator sounds wrong: the ear simulator includes the ear canal resonance that you hear in every real room. Targets therefore start from the rig's diffuse-field response."),
        u ("Studio Reference adds a gentle bass shelf and treble tilt, set by a blind listening panel and frozen for each release. Neutral is the diffuse-field response with no tilt. Native (V2) keeps the manufacturer's voicing and corrects only your unit's deviation."),
        u ("There is no \xe2\x80\x9C" "Flat\xe2\x80\x9D target. No correction at all is what Bypass and A/B already give you."),
    } });

    t.push_back ({ "fit", "Fit and seal", {
        u ("Headphones measure differently every time they are put on. Profiles store the spread across several units and reseats, shown as the shaded band around the measured curve."),
        u ("Where that spread is large the correction is applied at reduced strength, and above about 9 kHz only the average level is corrected, because peaks and notches there depend on how the headphone sits on your head."),
        u ("Reseat the headphones a couple of times before judging. Glasses, hair and worn pads all change the low end."),
    } });

    t.push_back ({ "phase", "Minimum vs linear phase", {
        u ("Minimum Phase realises the correction with up to 12 cascaded filters, designed for each sample rate so they match their analogue design up to 20 kHz. It adds no latency and is right for tracking, production and everyday monitoring."),
        u ("Linear Phase builds an FIR from the same correction curve. It keeps the correction phase-neutral, at the cost of about 85 ms of latency and possible pre-ringing. With gentle corrections the difference is small; neither mode is better in general."),
        u ("Changing mode reports the new latency to the host. Some hosts apply it only when playback stops. Bypass is delayed by the same amount, so toggling it never shifts timing."),
    } });

    t.push_back ({ "hrtf", "HRTF and spatial", {
        u ("Spatial simulation is not part of this version. A simple crossfeed is planned next, then virtual speakers built on HRTF data and measured or licensed rooms, all off by default and bypassable on their own."),
        u ("When HRTF rendering arrives, the target switches automatically to the reference the HRTF set assumes, so the outer-ear response is not applied twice."),
    } });

    t.push_back ({ "ab", "Level-matched A/B", {
        u ("A/B compares calibrated and raw at the same loudness. Auto Gain computes a static match gain from the correction curve (K-weighted, as in ITU-R BS.1770), plus headroom so the calibrated path never exceeds 0 dB at any frequency."),
        u ("Both sides get the same headroom and only the calibrated side gets the match gain, so the comparison is fair and nothing clips. Nothing follows the programme level, so A/B never pumps."),
        u ("Press A to switch where the host passes keys to plugins. Bypass is different: it sends the input straight to the output, bit for bit."),
    } });

    t.push_back ({ "translation", "Translation checks", {
        u ("Calibration is designed for more consistent monitoring; it does not guarantee that a mix translates. Keep checking on speakers, in the car and on earbuds."),
        u ("A useful habit: switch to RAW now and then. If a decision only works on one side of the A/B, it is probably a decision about the headphone, not the mix."),
    } });

    t.push_back ({ "daw", "Where should this plugin go in my DAW?", {
        u ("REFERENCE is for monitoring only. Never leave it on a path that is printed or exported."),
        u ("## Hosts with a monitor-only insert"),
        u ("Cubase and Nuendo: Control Room inserts. REAPER: Monitoring FX. Studio One: the Listen Bus. These never reach your export."),
        u ("## Everywhere else"),
        u ("In Logic, Ableton Live and Pro Tools, insert it last on the master bus. Offline exports are detected and bypassed automatically (Settings, Render safety). Real-time bounces cannot be detected: bypass REFERENCE before bouncing in real time."),
        u ("The MONITORING ONLY badge in the header is there as a reminder whenever processing is active."),
    } });

    t.push_back ({ "rig", "Why does the graph name a rig?", {
        u ("The same headphone measures very differently on different ear simulators and head-and-torso fixtures. A curve only means something on the rig it was measured on, so every graph and number names its rig."),
        u ("Targets are tagged with their rig too, and the generator refuses to pair a measurement with a target from another rig. The Predicted result describes the rig, not your ears."),
    } });

    t.push_back ({ "systemwide", "Using REFERENCE for all system audio", {
        u ("The standalone app calibrates everything your computer plays. Your system sends its audio to a virtual loopback device; REFERENCE listens to that device, applies the calibration and plays the result on your headphones. Clock drift between the two devices is corrected continuously."),
        u ("## Windows"),
        u ("1. Install VB-CABLE (free, from vb-audio.com) and restart.  2. In Windows sound settings, make \xe2\x80\x9C" "CABLE Input\xe2\x80\x9D the default output.  3. In REFERENCE, Settings: Driver \xe2\x80\x9CWindows Audio\xe2\x80\x9D, Source \xe2\x80\x9C" "CABLE Output\xe2\x80\x9D, Headphones your headphone output."),
        u ("## macOS"),
        u ("1. Install BlackHole 2ch (free, from existential.audio, or brew install blackhole-2ch).  2. In System Settings, Sound, choose BlackHole 2ch as the output.  3. In REFERENCE: Source BlackHole 2ch, Headphones your interface or headphones. Allow microphone access when macOS asks; it is how macOS names audio input."),
        u ("## Linux (PulseAudio or PipeWire)"),
        u ("1. Create a sink: pactl load-module module-null-sink sink_name=reference sink_properties=device.description=REFERENCE  2. Make it the default output.  3. In REFERENCE, Settings: Driver ALSA, and the PulseAudio or PipeWire sound server as both Source and Headphones.  4. In Volume Control (pavucontrol), Recording: set REFERENCE to \xe2\x80\x9CMonitor of REFERENCE\xe2\x80\x9D; Playback: set REFERENCE to your headphones."),
        u ("## Notes"),
        u ("Expect roughly 30 to 70 ms of added latency, depending on the devices (Settings shows the estimate), and 85 ms more in Linear Phase: fine for listening, not for monitoring while you record. Never send REFERENCE's output to the loopback device; if its output comes back into its input, REFERENCE mutes itself and says so in the status line. Closing the window keeps REFERENCE running in the system tray; quit from the tray to stop."),
    } });

    t.push_back ({ "profiles", "Profiles and measurement data", {
        u ("A profile is a versioned data file: the mean response and per-frequency spread of a headphone model on one rig, with its provenance and a checksum. The filters are generated from it when it loads, so a generator fix improves every profile."),
        u ("The MM-500 and MM-520 profiles that ship with this build are placeholders: illustrative curves from the design handoff, not measurements. They exercise every part of the app, but the correction they produce is not a calibration of real headphones."),
        u ("To use real data, measure your own units on one rig (or license measurements) and build a profile with the reference-profile-tool included in the project, then place the .json in your profiles folder (Settings, Your profiles) together with targets defined on the same rig."),
    } });

    t.push_back ({ "licences", "About and third-party licences", {
        u ("REFERENCE " JucePlugin_VersionString ". Not affiliated with or endorsed by Audeze. Model names are used only to state compatibility."),
        u ("## JUCE 8"),
        u ("Application framework, dual licensed under the GNU AGPLv3 or a commercial JUCE licence. juce.com"),
        u ("## VST3 SDK"),
        u ("Steinberg VST3 SDK, MIT licence. VST is a registered trademark of Steinberg Media Technologies GmbH."),
        u ("## Instrument Sans"),
        u ("Copyright 2022 The Instrument Sans Project Authors. SIL Open Font License 1.1."),
        u ("## JetBrains Mono"),
        u ("Copyright 2020 The JetBrains Mono Project Authors. SIL Open Font License 1.1."),
    } });
    return t;
}
} // namespace

class HelpPage::Article : public juce::Component
{
public:
    void setTopic (const Topic& t)
    {
        topic = t;
        layoutHeight();
        repaint();
    }

    float layoutHeight()
    {
        const float w = (float) getWidth();
        float y = 24.0f + 30.0f;
        for (const auto& p : topic.paragraphs)
        {
            if (p.startsWith ("## "))
                y += 10.0f + mono (10.0f).getHeight() + 8.0f;
            else
                y += paragraphHeight (p, juce::jmin (w, 640.0f), sans (13.0f), 13.0f * 1.55f) + 12.0f;
        }
        return y + 24.0f;
    }

    void paint (juce::Graphics& g) override
    {
        const float w = juce::jmin ((float) getWidth(), 640.0f);
        drawText (g, topic.title, { 0.0f, 24.0f, w, 22.0f }, sans (18.0f, 500), colours::ink);
        float y = 24.0f + 30.0f;
        for (const auto& p : topic.paragraphs)
        {
            if (p.startsWith ("## "))
            {
                y += 10.0f;
                drawText (g, p.substring (3).toUpperCase(), { 0.0f, y, w, mono (10.0f).getHeight() }, mono (10.0f, 400, 0.14f), colours::label);
                y += mono (10.0f).getHeight() + 8.0f;
            }
            else
            {
                y += drawParagraph (g, p, { 0.0f, y, w, 1000.0f }, sans (13.0f), colours::ink4, 13.0f * 1.55f) + 12.0f;
            }
        }
    }

private:
    Topic topic;
};

HelpPage::HelpPage (EditorHost& h) : host (h), topics (buildTopics())
{
    article = std::make_unique<Article>();
    viewport.setViewedComponent (article.get(), false);
    viewport.setScrollBarsShown (true, false);
    viewport.setScrollBarThickness (6);
    viewport.getVerticalScrollBar().setColour (juce::ScrollBar::thumbColourId, colours::borderControl);
    addAndMakeVisible (viewport);
    article->setTopic (topics.front());
}

HelpPage::~HelpPage() = default;

void HelpPage::showTopic (const juce::String& id)
{
    for (int i = 0; i < (int) topics.size(); ++i)
        if (topics[(size_t) i].id == id)
            current = i;
    article->setTopic (topics[(size_t) current]);
    resized();
    viewport.setViewPosition (0, 0);
    repaint();
}

void HelpPage::resized()
{
    const float listW = juce::jlimit (220.0f, 300.0f, (float) getWidth() * 0.26f);
    topicBounds.clear();
    float y = 24.0f + sans (10.0f).getHeight() + 10.0f;
    for (size_t i = 0; i < topics.size(); ++i)
    {
        topicBounds.push_back ({ 32.0f, y, listW, 34.0f });
        y += 34.0f;
    }
    const int x = (int) (32.0f + listW + 40.0f);
    viewport.setBounds (x, 0, juce::jmax (100, getWidth() - x - 32), getHeight());
    article->setSize (viewport.getWidth() - 8, 10);
    article->setSize (viewport.getWidth() - 8, (int) std::ceil (article->layoutHeight()));
}

void HelpPage::paint (juce::Graphics& g)
{
    const float listW = topicBounds.empty() ? 260.0f : topicBounds.front().getWidth();
    drawText (g, "HELP", { 32.0f, 24.0f, listW, mono (10.0f).getHeight() }, mono (10.0f, 400, 0.14f), colours::label);
    g.setColour (colours::divider);
    g.fillRect (32.0f, 24.0f + mono (10.0f).getHeight() + 9.0f, listW, 1.0f);

    for (int i = 0; i < (int) topics.size(); ++i)
    {
        const auto& b = topicBounds[(size_t) i];
        const bool sel = i == current;
        if (sel || i == hover)
        {
            g.setColour (sel ? colours::rowSelected : colours::rowHover);
            g.fillRect (b.withTrimmedBottom (1.0f));
        }
        g.setColour (colours::lineSubtle);
        g.fillRect (b.getX(), b.getBottom() - 1.0f, b.getWidth(), 1.0f);
        if (sel)
        {
            g.setColour (colours::ink);
            g.fillRect (b.getX(), b.getY(), 2.0f, b.getHeight() - 1.0f);
        }
        drawText (g, topics[(size_t) i].title, b.withTrimmedLeft (12.0f), sel ? sans (13.0f, 600) : sans (13.0f), sel ? colours::ink : colours::ink2);
    }
}

void HelpPage::mouseUp (const juce::MouseEvent& e)
{
    for (int i = 0; i < (int) topicBounds.size(); ++i)
        if (topicBounds[(size_t) i].contains (e.position))
            showTopic (topics[(size_t) i].id);
}

void HelpPage::mouseMove (const juce::MouseEvent& e)
{
    int h = -1;
    for (int i = 0; i < (int) topicBounds.size(); ++i)
        if (topicBounds[(size_t) i].contains (e.position))
            h = i;
    if (h != hover)
    {
        hover = h;
        setMouseCursor (h >= 0 ? juce::MouseCursor::PointingHandCursor : juce::MouseCursor::NormalCursor);
        repaint();
    }
}

} // namespace ref::ui

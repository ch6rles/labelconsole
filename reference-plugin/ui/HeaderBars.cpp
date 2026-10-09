#include "HeaderBars.h"

#include "../measurement/TextUtil.h"
#include "../plugin/Parameters.h"

namespace ref::ui
{

namespace
{
const juce::Font& wordmarkFont() { static const auto f = sans (14.0f, 600, 0.24f); return f; }
const juce::Font& tabFont() { static const auto f = sans (11.0f, 500, 0.14f); return f; }
const juce::Font& smallCaps() { static const auto f = mono (9.5f, 400, 0.14f); return f; }
const juce::Font& statLabelFont() { static const auto f = mono (9.5f, 400, 0.12f); return f; }
const juce::Font& statValueFont() { static const auto f = mono (13.0f); return f; }
const juce::Font& badgeFont() { static const auto f = mono (10.0f, 400, 0.08f); return f; }
const juce::Font& pillFont() { static const auto f = mono (10.0f, 700, 0.05f); return f; }

// CSS letter-spacing also follows the last glyph.
float trackedWidth (const juce::Font& f, const juce::String& s, float px, float em)
{
    return textWidth (f, s) + px * em;
}

SegmentedControl::Style abStyle()
{
    SegmentedControl::Style s;
    s.font = sans (11.0f, 600, 0.10f);
    s.padX = 10.0f;
    s.border = colours::borderControl;
    return s;
}

TextButton::Style bypassStyle()
{
    TextButton::Style s;
    s.powerIcon = true;
    s.padX = 11.0f;
    return s;
}

DropdownField::Style fieldStyle()
{
    DropdownField::Style s;
    s.font = sans (13.0f, 500);
    return s;
}
} // namespace

//==============================================================================
float TabButton::preferredWidth() const
{
    return std::ceil (trackedWidth (tabFont(), text, 11.0f, 0.14f));
}

void TabButton::paint (juce::Graphics& g)
{
    const auto r = getLocalBounds().toFloat();
    const float h = tabFont().getHeight();
    drawText (g, text, { r.getX(), r.getY() + 5.0f, r.getWidth() + 4.0f, h }, tabFont(),
              active ? colours::ink : (isHovered() ? colours::ink4 : colours::label));
    if (active)
    {
        g.setColour (colours::ink);
        g.fillRect (r.getX(), r.getBottom() - 1.0f, r.getWidth(), 1.0f);
    }
    drawFocusRing (g, r, 2.0f);
}

//==============================================================================
PresetBox::PresetBox (EditorHost& h) : host (h)
{
    for (auto* c : { &menuButton, &prevButton, &nextButton })
        addAndMakeVisible (*c);
    menuButton.setTitle ("Presets");
    prevButton.setTitle ("Previous preset");
    nextButton.setTitle ("Next preset");
}

void PresetBox::setName (const juce::String& n, bool m)
{
    if (name != n || modified != m)
    {
        name = n;
        modified = m;
        repaint();
    }
}

void PresetBox::setShowArrows (bool a)
{
    arrows = a;
    prevButton.setVisible (a);
    nextButton.setVisible (a);
    resized();
    repaint();
}

void PresetBox::resized()
{
    auto r = getLocalBounds();
    if (arrows)
    {
        nextButton.setBounds (r.removeFromRight (24));
        prevButton.setBounds (r.removeFromRight (24));
    }
    menuButton.setBounds (r);
}

void PresetBox::paint (juce::Graphics& g)
{
    const auto r = getLocalBounds().toFloat();
    g.setColour (colours::field);
    g.fillRoundedRectangle (r, 4.0f);

    juce::Path clip;
    clip.addRoundedRectangle (r, 4.0f);
    g.saveState();
    g.reduceClipRegion (clip);
    for (auto* c : { &menuButton, &prevButton, &nextButton })
    {
        if (c->isVisible() && (c->isPressed() || c->isHovered()))
        {
            g.setColour (c->isPressed() ? colours::pressed : colours::rowHover);
            g.fillRect (c->getBounds().toFloat());
        }
    }
    g.restoreState();

    g.setColour (colours::borderField);
    g.drawRoundedRectangle (r.reduced (0.5f), 4.0f, 1.0f);
    g.fillRect (30.0f, 1.0f, 1.0f, r.getHeight() - 2.0f);
    drawListIcon (g, { 15.0f, r.getCentreY() }, colours::ink4);

    float right = r.getRight();
    if (arrows)
    {
        g.setColour (colours::borderField);
        g.fillRect (right - 24.0f, 1.0f, 1.0f, r.getHeight() - 2.0f);
        g.fillRect (right - 48.0f, 1.0f, 1.0f, r.getHeight() - 2.0f);
        const auto arrowFont = sans (14.0f);
        drawText (g, juce::String::fromUTF8 ("\xe2\x80\xb9"), { right - 48.0f, 0.0f, 24.0f, r.getHeight() - 1.0f }, arrowFont, colours::ink4,
                  juce::Justification::centred);
        drawText (g, juce::String::fromUTF8 ("\xe2\x80\xba"), { right - 24.0f, 0.0f, 24.0f, r.getHeight() - 1.0f }, arrowFont, colours::ink4,
                  juce::Justification::centred);
        right -= 48.0f;
    }

    const auto f = sans (12.0f, 500);
    const juce::Rectangle<float> nameArea (31.0f, 0.0f, right - 31.0f, r.getHeight());
    const float available = nameArea.getWidth() - 12.0f;
    auto base = name.isEmpty() ? juce::String ("No preset") : name;
    const juce::String suffix (modified ? " *" : "");
    auto shown = base + suffix;
    // Truncate the name (never the modified mark) with an ellipsis rather
    // than overflow; the name shrinks every pass, so this always ends.
    if (textWidth (f, shown) > available)
    {
        while (base.length() > 1 && textWidth (f, base.trimEnd() + text::ellipsis + suffix) > available)
            base = base.dropLastCharacters (1);
        shown = base.trimEnd() + text::ellipsis + suffix;
    }
    drawText (g, shown, nameArea, f, colours::ink, juce::Justification::centred);

    for (auto* c : { &menuButton, &prevButton, &nextButton })
        if (c->isVisible() && c->hasKeyboardFocus (false))
        {
            g.setColour (colours::ink);
            g.drawRect (c->getBounds().toFloat().reduced (2.0f), 1.0f);
        }
}

//==============================================================================
HeaderRow1::HeaderRow1 (EditorHost& h)
    : host (h), presetBox (h), ab ({ "RAW", "CAL" }, abStyle()), bypass ("BYPASS", bypassStyle())
{
    for (int i = 0; i < 3; ++i)
    {
        addAndMakeVisible (tabs[i]);
        tabs[i].onClick = [this, i] { host.setPage ((Page) i); };
    }
    addAndMakeVisible (presetBox);
    addAndMakeVisible (ab);
    addAndMakeVisible (bypass);
    ab.setTitle ("A/B");
    bypass.setTitle ("Bypass");

    presetBox.menuButton.onClick = [this] { openPresetMenu(); };
    presetBox.prevButton.onClick = [this] { host.model().proc.stepPreset (-1); };
    presetBox.nextButton.onClick = [this] { host.model().proc.stepPreset (1); };

    ab.onSelect = [this] (int i) { host.model().setParam (params::abSelect, (float) i); };
    bypass.onClick = [this] { host.model().setParam (params::bypass, host.model().bypassed() ? 0.0f : 1.0f); };

    host.model().addListener (this);
    modelChanged();
}

HeaderRow1::~HeaderRow1()
{
    host.model().removeListener (this);
}

void HeaderRow1::modelChanged()
{
    auto& m = host.model();
    for (int i = 0; i < 3; ++i)
        tabs[i].setActive ((int) m.page == i);
    presetBox.setName (m.settings.presetName, m.proc.isPresetModified());
    ab.setSelected (m.calibrated() ? 1 : 0);
    bypass.setEngaged (m.bypassed());

    const bool pill = m.protectionHold && ! m.renderActive;
    if (pill != showPill)
    {
        showPill = pill;
        resized();
    }
    repaint();
}

void HeaderRow1::resized()
{
    const float W = (float) getWidth();
    constexpr float pad = 18.0f, h = 48.0f;

    wordmarkWidth = trackedWidth (wordmarkFont(), "REFERENCE", 14.0f, 0.24f);
    float x = pad + wordmarkWidth + 28.0f;
    const float tabGap = W < 1040.0f ? 16.0f : 20.0f;
    const float tabH = std::round (tabFont().getHeight() + 11.0f);
    for (auto& t : tabs)
    {
        const float w = t.preferredWidth();
        t.setBounds (juce::Rectangle<float> (x, std::round ((h - tabH) * 0.5f), w, tabH).toNearestInt());
        x += w + tabGap;
    }
    const float leftEnd = x - tabGap;

    // Right group, laid out from the right edge.
    float r = W - pad;
    const float bw = bypass.preferredWidth();
    bypass.setBounds (juce::Rectangle<float> (r - bw, 10.0f, bw, 28.0f).toNearestInt());
    r -= bw + 10.0f;
    const float aw = ab.preferredWidth();
    ab.setBounds (juce::Rectangle<float> (r - aw, 10.0f, aw, 28.0f).toNearestInt());
    r -= aw + 8.0f;
    const float lw = textWidth (mono (10.0f), "A/B");
    abLabelBounds = { r - lw, 10.0f, lw + 1.0f, 28.0f };
    r -= lw;
    if (showPill)
    {
        const float pw = 10.0f + 7.0f + 8.0f + trackedWidth (pillFont(), "OUTPUT PROTECTION ACTIVE", 10.0f, 0.05f) + 10.0f;
        r -= 10.0f;
        pillBounds = { r - pw, 10.0f, pw, 28.0f };
        r -= pw;
    }
    const float rightStart = r;

    // Preset box: centred; narrower without the arrows below about 1040 px,
    // and pushed aside if the groups would collide.
    const bool narrow = W < 1040.0f;
    presetBox.setShowArrows (! narrow);
    float pw = narrow ? 210.0f : 264.0f;
    float px = std::round ((W - pw) * 0.5f);
    const float minX = leftEnd + 16.0f, maxRight = rightStart - 16.0f;
    if (px < minX)
        px = minX;
    if (px + pw > maxRight)
        pw = juce::jmax (120.0f, maxRight - px);
    presetBox.setBounds (juce::Rectangle<float> (px, 10.0f, pw, 28.0f).toNearestInt());
}

void HeaderRow1::paint (juce::Graphics& g)
{
    const float h = (float) getHeight();
    drawText (g, "REFERENCE", { 18.0f, 0.0f, wordmarkWidth + 6.0f, h }, wordmarkFont(), colours::ink);
    drawText (g, "A/B", abLabelBounds, mono (10.0f), colours::label);

    if (showPill)
    {
        g.setColour (colours::ink);
        g.fillRoundedRectangle (pillBounds, 3.0f);
        g.setColour (colours::bg);
        g.fillRect (pillBounds.getX() + 10.0f, pillBounds.getCentreY() - 3.5f, 7.0f, 7.0f);
        drawText (g, "OUTPUT PROTECTION ACTIVE", pillBounds.withTrimmedLeft (25.0f), pillFont(), colours::bg);
    }

    g.setColour (colours::line);
    g.fillRect (0.0f, h - 1.0f, (float) getWidth(), 1.0f);
}

void HeaderRow1::openPresetMenu()
{
    auto& m = host.model();
    auto& proc = m.proc;
    auto& presets = proc.getPresets();
    const auto current = m.settings.presetName;

    std::vector<MenuItem> items;
    items.push_back (MenuItem::group ("FACTORY"));
    for (const auto& p : presets.getFactory())
    {
        MenuItem it;
        it.text = p.name;
        it.selected = p.name == current;
        const auto data = p;
        it.action = [&proc, data] { proc.loadPreset (data); };
        items.push_back (it);
    }
    items.push_back (MenuItem::divider());
    auto userGroup = MenuItem::group ("USER");
    items.push_back (userGroup);
    if (presets.getUser().empty())
    {
        MenuItem none;
        none.text = "No user presets yet";
        none.enabled = false;
        items.push_back (none);
    }
    for (const auto& p : presets.getUser())
    {
        MenuItem it;
        it.text = p.name;
        it.selected = p.name == current;
        const auto data = p;
        it.action = [&proc, data] { proc.loadPreset (data); };
        items.push_back (it);
    }

    const bool isUser = presets.isUserPreset (current);
    auto* hostPtr = &host;
    auto saveAs = [hostPtr, &proc, current]
    {
        const auto base = current.isEmpty() ? juce::String ("My preset") : current;
        hostPtr->promptName ("SAVE PRESET AS", base, [&proc] (const juce::String& name)
        {
            juce::String error;
            auto data = proc.captureCurrentAsPreset (name);
            if (proc.getPresets().saveUser (data, error))
                proc.loadPreset (*proc.getPresets().find (name));
        });
    };

    MenuItem actions;
    actions.kind = MenuItem::Kind::actions;
    actions.actions.push_back ({ "SAVE", [hostPtr, &proc, current, isUser, saveAs]
    {
        if (! isUser)
        {
            saveAs();
            return;
        }
        juce::String error;
        if (proc.getPresets().saveUser (proc.captureCurrentAsPreset (current), error))
            proc.loadPreset (*proc.getPresets().find (current));
        juce::ignoreUnused (hostPtr);
    } });
    actions.actions.push_back ({ "RENAME", [hostPtr, &proc, current]
    {
        hostPtr->promptName ("RENAME PRESET", current, [&proc, current] (const juce::String& name)
        {
            juce::String error;
            if (proc.getPresets().renameUser (current, name, error))
                if (const auto* p = proc.getPresets().find (name))
                    proc.loadPreset (*p);
        });
    }, isUser });
    actions.actions.push_back ({ "DELETE", [hostPtr, &proc, current]
    {
        hostPtr->promptName ("DELETE PRESET", current, [&proc] (const juce::String& name)
        {
            juce::String error;
            if (proc.getPresets().deleteUser (name, error))
                proc.loadPreset (proc.getPresets().getFactory().front());
        });
    }, isUser });
    actions.actions.push_back ({ "SAVE AS" + text::ellipsis, saveAs });
    actions.actions.push_back ({ "IMPORT", [&proc]
    {
        auto chooser = std::make_shared<juce::FileChooser> ("Import a REFERENCE preset", juce::File::getSpecialLocation (juce::File::userDocumentsDirectory),
                                                            "*.refpreset");
        chooser->launchAsync (juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles, [&proc, chooser] (const juce::FileChooser& fc)
        {
            const auto file = fc.getResult();
            if (file == juce::File())
                return;
            juce::String name, error;
            if (proc.getPresets().importFile (file, name, error))
                if (const auto* p = proc.getPresets().find (name))
                    proc.loadPreset (*p);
        });
    } });
    actions.actions.push_back ({ "EXPORT", [&proc, current]
    {
        const auto name = current.isEmpty() ? juce::String ("REFERENCE preset") : current;
        auto chooser = std::make_shared<juce::FileChooser> (
            "Export preset", juce::File::getSpecialLocation (juce::File::userDocumentsDirectory).getChildFile (juce::File::createLegalFileName (name) + ".refpreset"),
            "*.refpreset");
        chooser->launchAsync (juce::FileBrowserComponent::saveMode | juce::FileBrowserComponent::warnAboutOverwriting, [&proc, chooser, name] (const juce::FileChooser& fc)
        {
            auto file = fc.getResult();
            if (file == juce::File())
                return;
            if (! file.hasFileExtension ("refpreset"))
                file = file.withFileExtension ("refpreset");
            juce::String error;
            proc.getPresets().exportPreset (proc.captureCurrentAsPreset (name), file, error);
        });
    } });
    items.push_back (actions);

    MenuStyle style;
    style.width = 300.0f;
    style.rowPadY = 8.0f;
    style.bottomPad = 0.0f;
    host.showMenu (std::move (items), style, presetBox, 6.0f, -1.0f);
}

//==============================================================================
HeaderRow2::HeaderRow2 (EditorHost& h) : host (h), headphones (fieldStyle()), target (fieldStyle())
{
    addAndMakeVisible (headphones);
    addAndMakeVisible (target);
    headphones.setTitle ("Headphones");
    target.setTitle ("Target");
    headphones.onClick = [this] { openHeadphoneMenu(); };
    target.onClick = [this] { openTargetMenu(); };
    host.model().addListener (this);
    modelChanged();
}

HeaderRow2::~HeaderRow2()
{
    host.model().removeListener (this);
}

void HeaderRow2::modelChanged()
{
    auto& m = host.model();
    const auto* profile = m.proc.getLibrary().findProfile (m.settings.profileId);
    const auto* targetInfo = m.proc.getLibrary().findTarget (m.settings.targetKey);

    juce::String hp = profile != nullptr ? profile->displayName : (m.snap != nullptr && m.snap->profileName.isNotEmpty() ? m.snap->profileName : m.settings.profileId);
    juce::String tg = targetInfo != nullptr ? targetInfo->displayName : (m.snap != nullptr && m.snap->targetName.isNotEmpty() ? m.snap->targetName : m.settings.targetKey);
    headphones.setText (hp);
    target.setText (tg);

    stats.clear();
    const bool render = m.renderActive;
    stats.push_back ({ "LEVEL MATCHED", render ? text::emDash : (m.settings.autoGain ? m.formatDb (m.matchDb) : juce::String ("Off")), render });
    stats.push_back ({ "HEADROOM", render ? text::emDash : (m.settings.autoGain ? m.formatDb (m.headroomDb) : juce::String ("Off")), render });
    const double ms = 1000.0 * m.proc.latencyFor (m.settings.filterMode) / m.proc.getCurrentSampleRate();
    stats.push_back ({ "LATENCY", juce::String (ms, 2) + " ms", false });
    resized();
    repaint();
}

void HeaderRow2::resized()
{
    const float W = (float) getWidth();
    constexpr float pad = 18.0f, h = 58.0f;
    compact = W < 1040.0f;
    auto& m = host.model();

    // Right side first, from the right edge.
    float r = W - pad;
    const float labelH = statLabelFont().getHeight(), valueH = statValueFont().getHeight();
    const float blockH = labelH + 3.0f + valueH;
    for (int i = (int) stats.size() - 1; i >= 0; --i)
    {
        auto& s = stats[(size_t) i];
        const float cw = compact ? textWidth (statValueFont(), s.value)
                                 : juce::jmax (trackedWidth (statLabelFont(), s.label, 9.5f, 0.12f), textWidth (statValueFont(), s.value));
        const float bh = compact ? valueH : blockH;
        s.bounds = { r - cw - 14.0f, std::round ((h - bh) * 0.5f), cw + 14.0f, bh };
        r -= cw + 14.0f + 14.0f + 4.0f;
    }

    // Badge: MONITORING ONLY, or AUTO-BYPASSED during an offline render.
    r += 4.0f;
    const bool showBadge = m.renderActive || ! m.bypassed();
    if (showBadge)
    {
        const bool render = m.renderActive;
        const float tw = render ? trackedWidth (pillFont(), "AUTO-BYPASSED" + text::spacedDot + "OFFLINE RENDER", 10.0f, 0.05f) + 15.0f
                                : trackedWidth (badgeFont(), "MONITORING ONLY", 10.0f, 0.08f);
        const float bw = tw + (render ? 20.0f : 18.0f);
        const float bh = badgeFont().getHeight() + 12.0f;
        badgeBounds = { r - bw, std::round ((h - bh) * 0.5f), bw, bh };
        r -= bw;
    }
    else
    {
        badgeBounds = {};
    }
    const float rightStart = r - 16.0f;

    // Left: label, field, label, field. Shrink the fields, then drop the
    // labels to tooltips, when the window is narrow.
    const float labelGap = 10.0f, groupGap = 24.0f;
    const float hl = trackedWidth (smallCaps(), "HEADPHONES", 9.5f, 0.14f), tl = trackedWidth (smallCaps(), "TARGET", 9.5f, 0.14f);
    float fieldW = 196.0f;
    showFieldLabels = true;
    auto needed = [&] { return pad + (showFieldLabels ? hl + labelGap + tl + labelGap : 0.0f) + 2.0f * fieldW + groupGap; };
    if (needed() > rightStart)
        fieldW = juce::jmax (150.0f, (rightStart - (needed() - 2.0f * fieldW)) * 0.5f);
    if (needed() > rightStart)
    {
        showFieldLabels = false;
        fieldW = juce::jlimit (120.0f, 196.0f, (rightStart - (needed() - 2.0f * fieldW)) * 0.5f);
    }

    float x = pad;
    const float fy = 13.0f;
    if (showFieldLabels)
    {
        headphonesLabel = { x, 0.0f, hl + 1.0f, h };
        x += hl + labelGap;
    }
    headphones.setBounds (juce::Rectangle<float> (x, fy, fieldW, 32.0f).toNearestInt());
    x += fieldW + groupGap;
    if (showFieldLabels)
    {
        targetLabel = { x, 0.0f, tl + 1.0f, h };
        x += tl + labelGap;
    }
    target.setBounds (juce::Rectangle<float> (x, fy, fieldW, 32.0f).toNearestInt());
    headphones.setTooltip (showFieldLabels ? juce::String() : juce::String ("Headphones"));
    target.setTooltip (showFieldLabels ? juce::String() : juce::String ("Target"));
}

void HeaderRow2::mouseMove (const juce::MouseEvent& e)
{
    // Stat labels become tooltips when the window is narrow.
    juce::String tip;
    if (compact)
        for (const auto& s : stats)
            if (s.bounds.contains (e.position))
                tip = s.label;
    setTooltip (tip);
}

void HeaderRow2::paint (juce::Graphics& g)
{
    auto& m = host.model();
    const float h = (float) getHeight();

    if (showFieldLabels)
    {
        drawText (g, "HEADPHONES", headphonesLabel, smallCaps(), colours::label);
        drawText (g, "TARGET", targetLabel, smallCaps(), colours::label);
    }

    if (! badgeBounds.isEmpty())
    {
        if (m.renderActive)
        {
            g.setColour (colours::ink);
            g.fillRoundedRectangle (badgeBounds, 3.0f);
            g.setColour (colours::bg);
            g.fillRect (badgeBounds.getX() + 10.0f, badgeBounds.getCentreY() - 3.5f, 7.0f, 7.0f);
            drawText (g, "AUTO-BYPASSED" + text::spacedDot + "OFFLINE RENDER", badgeBounds.withTrimmedLeft (25.0f), pillFont(), colours::bg);
        }
        else
        {
            g.setColour (colours::ink);
            g.drawRoundedRectangle (badgeBounds.reduced (0.5f), 3.0f, 1.0f);
            drawText (g, "MONITORING ONLY", badgeBounds.withTrimmedLeft (9.0f), badgeFont(), colours::ink);
        }
    }

    const float labelH = statLabelFont().getHeight();
    for (const auto& s : stats)
    {
        g.setColour (colours::divider);
        g.fillRect (s.bounds.getX(), s.bounds.getY(), 1.0f, s.bounds.getHeight());
        const float x = s.bounds.getX() + 14.0f;
        if (compact)
        {
            drawText (g, s.value, { x, s.bounds.getY(), s.bounds.getWidth(), s.bounds.getHeight() }, statValueFont(), s.dim ? colours::label : colours::ink);
        }
        else
        {
            drawText (g, s.label, { x, s.bounds.getY(), s.bounds.getWidth() + 4.0f, labelH }, statLabelFont(), colours::label);
            drawText (g, s.value, { x, s.bounds.getY() + labelH + 3.0f, s.bounds.getWidth() + 4.0f, statValueFont().getHeight() }, statValueFont(),
                      s.dim ? colours::label : colours::ink);
        }
    }

    g.setColour (colours::line);
    g.fillRect (0.0f, h - 1.0f, (float) getWidth(), 1.0f);
}

void HeaderRow2::openHeadphoneMenu()
{
    auto& m = host.model();
    auto& proc = m.proc;
    const auto& lib = proc.getLibrary();

    std::vector<MenuItem> items;
    juce::StringArray manufacturers;
    for (const auto& p : lib.getProfiles())
        manufacturers.addIfNotAlreadyThere (p.manufacturer);
    bool anyAudeze = false;
    for (const auto& maker : manufacturers)
    {
        items.push_back (MenuItem::group (maker.toUpperCase()));
        anyAudeze = anyAudeze || maker.equalsIgnoreCase ("Audeze");
        // Newest revision first, as the design lists MM-520 above MM-500.
        std::vector<const ProfileInfo*> ps;
        for (const auto& p : lib.getProfiles())
            if (p.manufacturer == maker)
                ps.push_back (&p);
        std::sort (ps.begin(), ps.end(), [] (auto* a, auto* b) { return a->modelRevision.compareNatural (b->modelRevision) > 0; });
        for (const auto* p : ps)
        {
            MenuItem it;
            it.text = p->modelRevision.isNotEmpty() ? p->modelRevision : p->displayName;
            it.detail = p->menuDetail();
            it.selected = p->id == m.settings.profileId;
            const auto id = p->id;
            it.action = [&proc, id] { proc.setProfile (id); };
            items.push_back (it);
        }
    }
    items.push_back (MenuItem::divider());
    MenuItem import;
    import.text = "Import unit measurement" + text::ellipsis;
    import.enabled = false;
    import.v2Tag = true;
    items.push_back (import);
    if (anyAudeze)
        items.push_back (MenuItem::footer ("Not affiliated with or endorsed by Audeze."));

    MenuStyle style;
    style.width = 300.0f;
    host.showMenu (std::move (items), style, headphones, 6.0f);
}

void HeaderRow2::openTargetMenu()
{
    auto& m = host.model();
    auto& proc = m.proc;
    const auto& lib = proc.getLibrary();
    const auto* profile = lib.findProfile (m.settings.profileId);

    std::vector<MenuItem> items;
    const auto rig = profile != nullptr ? profile->rigId : juce::String ("rig");
    items.push_back (MenuItem::group (rig.toUpperCase() + " TARGETS"));
    if (profile != nullptr)
    {
        for (const auto* t : lib.targetsFor (*profile))
        {
            MenuItem it;
            it.text = t->displayName;
            it.detail = "@" + juce::String (t->version);
            it.description = t->description;
            it.selected = t->key() == m.settings.targetKey;
            const auto key = t->key();
            it.action = [&proc, key] { proc.setTarget (key); };
            items.push_back (it);
        }
    }
    items.push_back (MenuItem::divider());
    for (auto [name, desc] : { std::pair<const char*, const char*> { "Native", "Keeps the manufacturer's voicing; corrects only this unit's deviation. Needs an individual measurement." },
                               std::pair<const char*, const char*> { "Custom", "Drawn or imported, same rig rules" } })
    {
        MenuItem it;
        it.text = name;
        it.description = juce::String::fromUTF8 (desc).replace ("'", juce::String::fromUTF8 ("\xe2\x80\x99"));
        it.enabled = false;
        it.v2Tag = true;
        items.push_back (it);
    }

    MenuStyle style;
    style.width = 360.0f;
    host.showMenu (std::move (items), style, target, 6.0f);
}

} // namespace ref::ui

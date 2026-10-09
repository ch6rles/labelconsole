#pragma once

#include <juce_core/juce_core.h>

#include <string>

namespace ref::text
{

// Typographic characters used in the UI copy (UTF-8).
inline const juce::String dot = juce::String::fromUTF8 ("\xc2\xb7");            // ·
inline const juce::String spacedDot = juce::String::fromUTF8 (" \xc2\xb7 ");    // " · "
inline const juce::String minus = juce::String::fromUTF8 ("\xe2\x88\x92");      // −
inline const juce::String enDash = juce::String::fromUTF8 ("\xe2\x80\x93");     // –
inline const juce::String emDash = juce::String::fromUTF8 ("\xe2\x80\x94");     // —
inline const juce::String times = juce::String::fromUTF8 ("\xc3\x97");          // ×
inline const juce::String ellipsis = juce::String::fromUTF8 ("\xe2\x80\xa6");   // …
inline const juce::String plusMinus = juce::String::fromUTF8 ("\xc2\xb1");      // ±
inline const juce::String arrowRight = juce::String::fromUTF8 ("\xe2\x86\x92"); // →

inline juce::String fromStd (const std::string& s)
{
    return juce::String::fromUTF8 (s.c_str(), (int) s.size());
}

// JUCE's JSON parser recurses once per nesting level, so a hostile file in a
// user folder could overflow the stack on every launch. Profiles and presets
// are shallow; anything deeper or larger than this is not one.
inline bool jsonIsSafeToParse (const juce::String& json, int maxDepth = 32, int maxLength = 8 * 1024 * 1024)
{
    if (json.length() > maxLength)
        return false;
    int depth = 0;
    bool inString = false, escaped = false;
    for (auto p = json.getCharPointer(); ! p.isEmpty(); ++p)
    {
        const auto c = *p;
        if (inString)
        {
            if (escaped)
                escaped = false;
            else if (c == '\\')
                escaped = true;
            else if (c == '"')
                inString = false;
        }
        else if (c == '"')
            inString = true;
        else if (c == '[' || c == '{')
        {
            if (++depth > maxDepth)
                return false;
        }
        else if (c == ']' || c == '}')
            --depth;
    }
    return true;
}

} // namespace ref::text

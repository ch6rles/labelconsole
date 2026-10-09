#pragma once

// macOS services JUCE does not wrap for the standalone app.
namespace ref::standalone::mac
{

// Microphone permission (macOS names any audio input that way):
// 1 granted, 0 not asked yet, -1 denied or restricted.
int microphoneAccess();

// Asks once, if the user has not decided yet.
void requestMicrophoneAccess();

// Calls `callback` when the Dock icon is clicked while no window is visible
// (the window was closed to keep calibrating in the background).
void onDockReopen (void (*callback)());

} // namespace ref::standalone::mac

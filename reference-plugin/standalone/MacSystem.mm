#include "MacSystem.h"

#import <AVFoundation/AVFoundation.h>
#import <AppKit/AppKit.h>
#include <objc/runtime.h>

namespace ref::standalone::mac
{

int microphoneAccess()
{
    switch ([AVCaptureDevice authorizationStatusForMediaType: AVMediaTypeAudio])
    {
        case AVAuthorizationStatusAuthorized: return 1;
        case AVAuthorizationStatusNotDetermined: return 0;
        case AVAuthorizationStatusDenied:
        case AVAuthorizationStatusRestricted: return -1;
    }
    return 1;
}

void requestMicrophoneAccess()
{
    if ([AVCaptureDevice authorizationStatusForMediaType: AVMediaTypeAudio] == AVAuthorizationStatusNotDetermined)
        [AVCaptureDevice requestAccessForMediaType: AVMediaTypeAudio completionHandler: ^(BOOL) {}];
}

namespace
{
void (*reopenCallback)() = nullptr;

BOOL handleReopen (id, SEL, NSApplication*, BOOL hasVisibleWindows)
{
    if (reopenCallback != nullptr && ! hasVisibleWindows)
        reopenCallback();
    return YES;
}
} // namespace

void onDockReopen (void (*callback)())
{
    reopenCallback = callback;
    id delegate = [NSApp delegate];
    if (delegate == nil)
        return;

    // JUCE's application delegate does not implement this; add it.
    Class cls = object_getClass (delegate);
    SEL sel = @selector (applicationShouldHandleReopen:hasVisibleWindows:);
    const auto types = [NSString stringWithFormat: @"%s%s%s%s%s", @encode (BOOL), @encode (id), @encode (SEL), @encode (id), @encode (BOOL)];
    if (! class_addMethod (cls, sel, (IMP) handleReopen, types.UTF8String))
        class_replaceMethod (cls, sel, (IMP) handleReopen, types.UTF8String);
}

} // namespace ref::standalone::mac

# The JUCE wrapper: VST3, AU and the system-wide standalone app.

option(REF_CUSTOM_STANDALONE "Use REFERENCE's system-wide standalone app instead of JUCE's default" ON)

set(REF_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/..)

file(GLOB REF_PROFILE_FILES CONFIGURE_DEPENDS
    ${REF_ROOT}/profiles/headphones/*.json
    ${REF_ROOT}/profiles/targets/*/*.csv)

juce_add_binary_data(RefBinaryData
    HEADER_NAME BinaryData.h
    NAMESPACE BinaryData
    SOURCES
        ${REF_ROOT}/resources/fonts/InstrumentSans-Regular.ttf
        ${REF_ROOT}/resources/fonts/InstrumentSans-Medium.ttf
        ${REF_ROOT}/resources/fonts/InstrumentSans-SemiBold.ttf
        ${REF_ROOT}/resources/fonts/InstrumentSans-Bold.ttf
        ${REF_ROOT}/resources/fonts/JetBrainsMono-Regular.ttf
        ${REF_ROOT}/resources/fonts/JetBrainsMono-Medium.ttf
        ${REF_ROOT}/resources/fonts/JetBrainsMono-SemiBold.ttf
        ${REF_ROOT}/resources/fonts/JetBrainsMono-Bold.ttf
        ${REF_PROFILE_FILES})
set_target_properties(RefBinaryData PROPERTIES POSITION_INDEPENDENT_CODE ON)

set(REF_FORMATS VST3 Standalone)
if(APPLE)
    list(APPEND REF_FORMATS AU)
endif()

juce_add_plugin(Reference
    PRODUCT_NAME "REFERENCE"
    COMPANY_NAME "Reference Calibration"
    COMPANY_WEBSITE ""
    BUNDLE_ID com.referencecalibration.reference
    PLUGIN_MANUFACTURER_CODE Rfcl
    PLUGIN_CODE Rfhc
    FORMATS ${REF_FORMATS}
    IS_SYNTH FALSE
    NEEDS_MIDI_INPUT FALSE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS TRUE
    COPY_PLUGIN_AFTER_BUILD FALSE
    VST3_CATEGORIES Fx Tools
    AU_MAIN_TYPE kAudioUnitType_Effect
    MICROPHONE_PERMISSION_ENABLED TRUE
    MICROPHONE_PERMISSION_TEXT "REFERENCE listens to the loopback device you choose, so it can calibrate your computer's audio for your headphones.")

target_sources(Reference PRIVATE
    Parameters.cpp
    PluginProcessor.cpp
    CalibrationWorker.cpp
    ${REF_ROOT}/measurement/ProfileLibrary.cpp
    ${REF_ROOT}/persistence/PresetManager.cpp
    ${REF_ROOT}/persistence/SessionState.cpp
    ${REF_ROOT}/ui/EditorModel.cpp
    ${REF_ROOT}/ui/GraphView.cpp
    ${REF_ROOT}/ui/HeaderBars.cpp
    ${REF_ROOT}/ui/HelpPage.cpp
    ${REF_ROOT}/ui/Menus.cpp
    ${REF_ROOT}/ui/PluginEditor.cpp
    ${REF_ROOT}/ui/Rail.cpp
    ${REF_ROOT}/ui/SettingsPage.cpp
    ${REF_ROOT}/ui/Theme.cpp
    ${REF_ROOT}/ui/Widgets.cpp)

target_compile_definitions(Reference PUBLIC
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0
    JUCE_REPORT_APP_USAGE=0
    $<$<PLATFORM_ID:Linux>:JUCE_JACK=1>
    JUCE_MODAL_LOOPS_PERMITTED=0
    JUCE_STRICT_REFCOUNTEDPOINTER=1)

if(REF_CUSTOM_STANDALONE)
    # Compiled into the shared code; guarded by JucePlugin_Build_Standalone.
    target_compile_definitions(Reference PUBLIC JUCE_USE_CUSTOM_PLUGIN_STANDALONE_APP=1)
    target_sources(Reference PRIVATE
        ${REF_ROOT}/standalone/StandaloneApp.cpp
        ${REF_ROOT}/standalone/SystemAudioBridge.cpp)
    if(APPLE)
        target_sources(Reference PRIVATE ${REF_ROOT}/standalone/MacSystem.mm)
        target_link_libraries(Reference PRIVATE "-framework AVFoundation")
    endif()
endif()

# Exact float comparisons (detents, settled smoothers) and partial
# aggregate initialisers are intended here.
target_compile_options(Reference PRIVATE
    $<$<CXX_COMPILER_ID:GNU,Clang,AppleClang>:-Wno-float-equal -Wno-missing-field-initializers>)

target_link_libraries(Reference
    PRIVATE
        refdsp
        RefBinaryData
        juce::juce_audio_utils
        juce::juce_cryptography
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_lto_flags)

# Command-line tool that builds profiles and targets from measurement CSVs.
juce_add_console_app(ReferenceProfileTool PRODUCT_NAME "reference-profile-tool")
target_sources(ReferenceProfileTool PRIVATE
    ${REF_ROOT}/tools/ProfileTool.cpp
    ${REF_ROOT}/measurement/ProfileLibrary.cpp)
target_compile_definitions(ReferenceProfileTool PRIVATE JUCE_USE_CURL=0 JUCE_WEB_BROWSER=0)
target_link_libraries(ReferenceProfileTool PRIVATE
    refdsp RefBinaryData juce::juce_core juce::juce_cryptography juce::juce_recommended_config_flags)
set_target_properties(ReferenceProfileTool PROPERTIES OUTPUT_NAME reference-profile-tool)

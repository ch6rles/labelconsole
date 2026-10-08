add_executable(refdsp_tests
    AcceptanceTests.cpp
    AllocationGuard.cpp
    GeneratorTests.cpp
    ResamplerTests.cpp
    main.cpp)

target_link_libraries(refdsp_tests PRIVATE refdsp)
target_compile_definitions(refdsp_tests PRIVATE REF_PROFILES_DIR="${CMAKE_SOURCE_DIR}/profiles")

if(REF_RTSAN)
    target_compile_options(refdsp PRIVATE -fsanitize=realtime)
    target_compile_options(refdsp_tests PRIVATE -fsanitize=realtime)
    target_link_options(refdsp_tests PRIVATE -fsanitize=realtime)
    target_compile_definitions(refdsp_tests PRIVATE REF_RTSAN=1)
endif()

add_test(NAME refdsp_tests COMMAND refdsp_tests)

# Plugin-level tests: built from the same sources as the plugin, without a host.
if(REF_BUILD_PLUGIN)
    juce_add_console_app(ReferencePluginTests PRODUCT_NAME "ReferencePluginTests")
    target_sources(ReferencePluginTests PRIVATE
        plugin/PluginTests.cpp
        ${CMAKE_SOURCE_DIR}/plugin/Parameters.cpp
        ${CMAKE_SOURCE_DIR}/plugin/PluginProcessor.cpp
        ${CMAKE_SOURCE_DIR}/plugin/CalibrationWorker.cpp
        ${CMAKE_SOURCE_DIR}/measurement/ProfileLibrary.cpp
        ${CMAKE_SOURCE_DIR}/persistence/PresetManager.cpp
        ${CMAKE_SOURCE_DIR}/persistence/SessionState.cpp
        ${CMAKE_SOURCE_DIR}/ui/EditorModel.cpp
        ${CMAKE_SOURCE_DIR}/ui/GraphView.cpp
        ${CMAKE_SOURCE_DIR}/ui/HeaderBars.cpp
        ${CMAKE_SOURCE_DIR}/ui/HelpPage.cpp
        ${CMAKE_SOURCE_DIR}/ui/Menus.cpp
        ${CMAKE_SOURCE_DIR}/ui/PluginEditor.cpp
        ${CMAKE_SOURCE_DIR}/ui/Rail.cpp
        ${CMAKE_SOURCE_DIR}/ui/SettingsPage.cpp
        ${CMAKE_SOURCE_DIR}/ui/Theme.cpp
        ${CMAKE_SOURCE_DIR}/ui/Widgets.cpp)
    target_compile_definitions(ReferencePluginTests PRIVATE
        JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0 JUCE_MODAL_LOOPS_PERMITTED=0
        JucePlugin_Name="REFERENCE" JucePlugin_VersionString="${PROJECT_VERSION}")
    target_compile_options(ReferencePluginTests PRIVATE
        $<$<CXX_COMPILER_ID:GNU,Clang,AppleClang>:-Wno-float-equal -Wno-missing-field-initializers>)
    target_link_libraries(ReferencePluginTests PRIVATE
        refdsp RefBinaryData
        juce::juce_audio_utils juce::juce_cryptography
        juce::juce_recommended_config_flags)
    add_test(NAME ReferencePluginTests COMMAND ReferencePluginTests)
endif()

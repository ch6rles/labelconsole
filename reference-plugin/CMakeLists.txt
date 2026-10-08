cmake_minimum_required(VERSION 3.22)

set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "Minimum macOS version")

project(REFERENCE VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(REF_BUILD_PLUGIN "Build the JUCE plugin (VST3/AU) and the standalone app" ON)
option(REF_BUILD_TESTS "Build the test suites" ON)
option(REF_RTSAN "Build tests with Clang's RealtimeSanitizer (Clang 20+)" OFF)
set(REF_JUCE_DIR "" CACHE PATH "Use a local JUCE checkout instead of downloading JUCE 8.0.15")

add_subdirectory(dsp)

if(REF_BUILD_PLUGIN)
    if(REF_JUCE_DIR)
        add_subdirectory(${REF_JUCE_DIR} ${CMAKE_BINARY_DIR}/juce EXCLUDE_FROM_ALL)
    else()
        include(FetchContent)
        FetchContent_Declare(juce
            GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
            GIT_TAG 8.0.15
            GIT_SHALLOW TRUE)
        FetchContent_MakeAvailable(juce)
    endif()
    add_subdirectory(plugin)
endif()

if(REF_BUILD_TESTS)
    enable_testing()
    add_subdirectory(tests)
endif()

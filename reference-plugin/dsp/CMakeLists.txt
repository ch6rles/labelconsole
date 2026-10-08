# JUCE-free DSP and calibration engine (spec Section 11: separate from the
# plugin wrapper so it can be tested without a host).
add_library(refdsp STATIC
    src/Biquad.cpp
    src/DriftCompensatedFifo.cpp
    src/CorrectionGenerator.cpp
    src/Engine.cpp
    src/FFT.cpp
    src/FilterSet.cpp
    src/FirDesign.cpp
    src/Format.cpp
    src/Grid.cpp
    src/LeastSquares.cpp
    src/Loudness.cpp
    src/PartitionedConvolver.cpp)

target_include_directories(refdsp PUBLIC include)
target_compile_features(refdsp PUBLIC cxx_std_20)
set_target_properties(refdsp PROPERTIES POSITION_INDEPENDENT_CODE ON)

if(MSVC)
    target_compile_options(refdsp PRIVATE /W4 /permissive-)
else()
    target_compile_options(refdsp PRIVATE -Wall -Wextra -Wno-unused-parameter)
endif()

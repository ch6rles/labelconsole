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

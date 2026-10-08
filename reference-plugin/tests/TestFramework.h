#pragma once

// A deliberately tiny test harness: no dependencies, so the DSP tests build
// anywhere the library builds.

#include <cmath>
#include <cstdio>
#include <functional>
#include <string>
#include <vector>

namespace reftest
{

struct TestCase
{
    const char* name;
    std::function<void()> fn;
};

inline std::vector<TestCase>& registry()
{
    static std::vector<TestCase> r;
    return r;
}

inline int& failures()
{
    static int f = 0;
    return f;
}

struct Registrar
{
    Registrar (const char* name, std::function<void()> fn) { registry().push_back ({ name, std::move (fn) }); }
};

inline void fail (const char* file, int line, const std::string& msg)
{
    std::printf ("    FAIL %s:%d: %s\n", file, line, msg.c_str());
    ++failures();
}

inline int runAll (int argc, char** argv)
{
    const char* filter = argc > 1 ? argv[1] : nullptr;
    int run = 0, failedTests = 0;
    for (auto& t : registry())
    {
        if (filter != nullptr && std::string (t.name).find (filter) == std::string::npos)
            continue;
        const int before = failures();
        std::printf ("[ RUN  ] %s\n", t.name);
        std::fflush (stdout);
        t.fn();
        ++run;
        const bool ok = failures() == before;
        if (! ok)
            ++failedTests;
        std::printf ("[ %s ] %s\n", ok ? " OK " : "FAIL", t.name);
        std::fflush (stdout);
    }
    std::printf ("\n%d tests, %d failed\n", run, failedTests);
    return failedTests == 0 ? 0 : 1;
}

} // namespace reftest

#define REF_CONCAT2(a, b) a##b
#define REF_CONCAT(a, b) REF_CONCAT2 (a, b)

#define TEST_CASE(name)                                                                          \
    static void REF_CONCAT (test_fn_, __LINE__)();                                               \
    static reftest::Registrar REF_CONCAT (test_reg_, __LINE__) (name, REF_CONCAT (test_fn_, __LINE__)); \
    static void REF_CONCAT (test_fn_, __LINE__)()

#define CHECK(cond)                                                \
    do                                                             \
    {                                                              \
        if (! (cond))                                              \
            reftest::fail (__FILE__, __LINE__, "CHECK(" #cond ")"); \
    } while (0)

#define CHECK_MSG(cond, msg)                                       \
    do                                                             \
    {                                                              \
        if (! (cond))                                              \
            reftest::fail (__FILE__, __LINE__, std::string (msg)); \
    } while (0)

#define CHECK_NEAR(a, b, tol)                                                                              \
    do                                                                                                     \
    {                                                                                                      \
        const double va_ = (double) (a), vb_ = (double) (b);                                               \
        if (! (std::abs (va_ - vb_) <= (tol)))                                                             \
        {                                                                                                  \
            char buf_[256];                                                                                \
            std::snprintf (buf_, sizeof (buf_), "CHECK_NEAR(%s, %s): %.9g vs %.9g (tol %.3g)", #a, #b, va_, vb_, (double) (tol)); \
            reftest::fail (__FILE__, __LINE__, buf_);                                                      \
        }                                                                                                  \
    } while (0)

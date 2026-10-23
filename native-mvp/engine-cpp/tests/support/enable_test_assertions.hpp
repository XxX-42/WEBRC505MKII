#pragma once

// Release tests must execute assert(), without conflicting /DNDEBUG /UNDEBUG
// command-line options (MSVC reports that conflict under strict warnings).
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>

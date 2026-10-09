#!/bin/sh
# Builds and runs the protection tests on this computer (needs a C++17 compiler).
set -e
cd "$(dirname "$0")"
out="${TMPDIR:-/tmp}/vital-protection-test"
c++ -std=c++17 -Wall -Wextra -Werror -o "$out" protection_test.cpp ../../src/core/Protection.cpp
"$out"

#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_dir"

if command -v cmake >/dev/null 2>&1; then
  cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
  cmake --build build --parallel
else
  mkdir -p build
  cxx=${CXX:-c++}
  # Intentional word splitting: pkg-config returns compiler/linker arguments.
  # shellcheck disable=SC2046
  "$cxx" -O3 -DNDEBUG -std=c++17 -Wall -Wextra -Wpedantic \
    $(pkg-config --cflags sdl2 libjpeg) \
    native_viewer.cpp -o build/wifi_backup_viewer \
    $(pkg-config --libs sdl2 libjpeg) -pthread
fi

echo "Built: $script_dir/build/wifi_backup_viewer"

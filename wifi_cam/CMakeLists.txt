cmake_minimum_required(VERSION 3.16)
project(wifi_backup_viewer LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(PkgConfig REQUIRED)
find_package(Threads REQUIRED)
pkg_check_modules(SDL2 REQUIRED IMPORTED_TARGET sdl2)
pkg_check_modules(JPEG REQUIRED IMPORTED_TARGET libjpeg)

add_executable(wifi_backup_viewer native_viewer.cpp)
target_compile_options(wifi_backup_viewer PRIVATE -Wall -Wextra -Wpedantic)
target_link_libraries(
  wifi_backup_viewer
  PRIVATE
    PkgConfig::SDL2
    PkgConfig::JPEG
    Threads::Threads
)

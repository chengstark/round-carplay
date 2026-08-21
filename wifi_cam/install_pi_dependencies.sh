#!/bin/sh
set -eu

sudo apt-get update
sudo apt-get install -y \
  build-essential \
  cmake \
  pkg-config \
  libsdl2-dev \
  libjpeg-dev \
  iw

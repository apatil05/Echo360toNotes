#!/bin/sh
# Downloads a static arm64 ffmpeg for the worker's Lambda layer and checks its MD5.
set -eu
cd "$(dirname "$0")/.."
DEST=layers/ffmpeg/bin
URL=https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

curl -fsSL "$URL" -o "$TMP/ffmpeg.tar.xz"
curl -fsSL "$URL.md5" -o "$TMP/ffmpeg.tar.xz.md5"
expected=$(cut -d' ' -f1 "$TMP/ffmpeg.tar.xz.md5")
if command -v md5sum >/dev/null; then actual=$(md5sum "$TMP/ffmpeg.tar.xz" | cut -d' ' -f1); else actual=$(md5 -q "$TMP/ffmpeg.tar.xz"); fi
[ "$expected" = "$actual" ] || { echo "MD5 mismatch: expected $expected, got $actual" >&2; exit 1; }

tar -xJf "$TMP/ffmpeg.tar.xz" -C "$TMP"
mkdir -p "$DEST"
cp "$TMP"/ffmpeg-*-arm64-static/ffmpeg "$DEST/ffmpeg"
chmod 755 "$DEST/ffmpeg"
echo "ffmpeg ready in $DEST ($(du -h "$DEST/ffmpeg" | cut -f1))"

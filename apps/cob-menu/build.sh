#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT"
swift build -c release
BIN_DIR=$(swift build -c release --show-bin-path)
APP_DIR="$ROOT/.build/app/Cob Menu.app"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"
cp "$BIN_DIR/CobMenu" "$APP_DIR/Contents/MacOS/CobMenu"
cat > "$APP_DIR/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>cob</string>
<key>CFBundleExecutable</key><string>CobMenu</string>
<key>CFBundleIdentifier</key><string>dev.gencberke.cobmenu</string>
<key>CFBundleName</key><string>cob</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
</dict></plist>
PLIST
/usr/bin/codesign --force --sign - --identifier dev.gencberke.cobmenu "$APP_DIR"
/usr/bin/codesign --verify --deep --strict "$APP_DIR"
echo "$APP_DIR"

#!/bin/bash
# Builds app/libs/libbox.aar: a lean sing-box v1.14.2 libbox (core: VLESS, WebSocket, TLS, OpenVPN client; plus gVisor TUN stack and
# uTLS for the Chrome fingerprint) for arm64-v8a, armeabi-v7a and x86_64. sing-box is GPLv3 (owner-approved, task 1.4).
#
# Needs: git, a Go 1.25.x toolchain (sing-box v1.14.2 declares go 1.25; Go 1.26 changed the os internals libbox links
# to), JDK 17+, Android SDK + NDK. Usage: GO=/path/to/go/bin/go tools/build_libbox.sh
#
# Network notes for building inside Iran: proxy.golang.org / golang.org return 403, so modules come through
# goproxy.cn (checksums are still verified against the signed sum.golang.org database through that proxy).
# On Windows keep GOPATH short: deep paths break `git` inside the module cache ("'$GIT_DIR' too big").
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
WORK=${WORK:-$HOME/.nvgo}
SING_BOX_VERSION=v1.14.2
GOMOBILE_VERSION=v0.1.13

export GOPATH="$WORK" GOCACHE="$WORK/cache" GOMODCACHE="$WORK/mod" GOFLAGS=-mod=mod GOTOOLCHAIN=local
export GOPROXY=${GOPROXY:-https://goproxy.cn,https://goproxy.io,direct} GOSUMDB=sum.golang.org
export PATH="$(dirname "${GO:-$(command -v go)}"):$WORK/bin:$PATH"
export ANDROID_HOME=${ANDROID_HOME:-$HOME/AppData/Local/Android/Sdk}
export ANDROID_NDK_HOME=${ANDROID_NDK_HOME:-$(ls -d "$ANDROID_HOME"/ndk/* | sort -V | tail -1)}

go version | grep -q "go1.25" || { echo "need Go 1.25.x (have: $(go version))"; exit 1; }
command -v gomobile >/dev/null || go install github.com/sagernet/gomobile/cmd/gomobile@$GOMOBILE_VERSION
command -v gobind >/dev/null || go install github.com/sagernet/gomobile/cmd/gobind@$GOMOBILE_VERSION
gomobile init

SRC="$WORK/sing-box-$SING_BOX_VERSION"
[ -d "$SRC" ] || git clone -q --depth 1 --branch $SING_BOX_VERSION https://github.com/SagerNet/sing-box.git "$SRC"
cd "$SRC"
# Same linker flags as sing-box's own release build (cmd/internal/build_shared/flags.go); -checklinkname=0 is required.
gomobile bind -v -target android/arm,android/arm64,android/amd64 -androidapi 23 -javapkg=io.nekohasekai \
  -trimpath -buildvcs=false \
  -ldflags "-X github.com/sagernet/sing-box/constant.Version=${SING_BOX_VERSION#v} -X runtime.godebugDefault=multipathtcp=0,tlssha1=1 -checklinkname=0 -s -w -buildid=" \
  -tags with_gvisor,with_utls,with_openvpn,badlinkname,tfogo_checklinkname0 \
  -o "$HERE/app/libs/libbox.aar" ./experimental/libbox
ls -l "$HERE/app/libs/libbox.aar"
sha256sum "$HERE/app/libs/libbox.aar"

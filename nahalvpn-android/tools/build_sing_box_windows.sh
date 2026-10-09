#!/bin/bash
# Builds desktop/appResources/windows/sing-box.exe: the Windows engine of the desktop app, from the same sing-box
# v1.14.2 sources and build tags as app/libs/libbox.aar (VLESS, WebSocket, TLS, OpenVPN client, gVisor, uTLS).
# sing-box is GPLv3 (owner-approved, task 1.4). The binary is not committed (about 43 MB).
#
# Needs: git and a Go 1.25.x toolchain. Usage: GO=/path/to/go/bin/go tools/build_sing_box_windows.sh [output.exe]
# Network notes for building inside Iran: see build_libbox.sh (goproxy.cn, short GOPATH on Windows).
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
WORK=${WORK:-$HOME/.nvgo}
SING_BOX_VERSION=v1.14.2
OUT=${1:-$HERE/desktop/appResources/windows/sing-box.exe}

export GOPATH="$WORK" GOCACHE="$WORK/cache" GOMODCACHE="$WORK/mod" GOFLAGS=-mod=mod GOTOOLCHAIN=local
export GOPROXY=${GOPROXY:-https://goproxy.cn,https://goproxy.io,direct} GOSUMDB=sum.golang.org
export PATH="$(dirname "${GO:-$(command -v go)}"):$PATH"
go version | grep -q "go1.25" || { echo "need Go 1.25.x (have: $(go version))"; exit 1; }

SRC="$WORK/sing-box-$SING_BOX_VERSION"
[ -d "$SRC" ] || git clone -q --depth 1 --branch $SING_BOX_VERSION https://github.com/SagerNet/sing-box.git "$SRC"
cd "$SRC"
mkdir -p "$(dirname "$OUT")"
# Same linker flags as sing-box's own release build (cmd/internal/build_shared/flags.go); -checklinkname=0 is required.
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -buildvcs=false \
  -ldflags "-X github.com/sagernet/sing-box/constant.Version=${SING_BOX_VERSION#v} -X runtime.godebugDefault=multipathtcp=0,tlssha1=1 -checklinkname=0 -s -w -buildid=" \
  -tags with_gvisor,with_utls,with_openvpn,badlinkname,tfogo_checklinkname0 \
  -o "$OUT" ./cmd/sing-box
ls -l "$OUT"
sha256sum "$OUT"

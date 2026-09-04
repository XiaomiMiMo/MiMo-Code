#!/usr/bin/env bash

set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
package_dir="$repo_dir/packages/opencode"
install_dir="${MIMOCODE_INSTALL_DIR:-$HOME/.mimocode/bin}"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required but was not found in PATH" >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin)
    platform="darwin"
    ;;
  Linux)
    platform="linux"
    if ldd --version 2>&1 | grep -qi musl; then
      echo "musl-based Linux distributions such as Alpine are not supported" >&2
      exit 1
    fi
    ;;
  *)
    echo "Unsupported operating system: $(uname -s)" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

(
  cd "$package_dir"
  # Run the build script directly instead of through the `build:local` package
  # script: `bun run <package-script>` re-resolves the nested `bun` through a
  # PATH that has every ancestor node_modules/.bin prepended, so a stray bun
  # installed above this checkout would hijack the build and embed its own
  # (possibly broken) runtime into the compiled binary.
  MIMOCODE_CHANNEL=local MIMOCODE_VERSION=local bun run script/build.ts --single
)

binary="$package_dir/dist/mimocode-$platform-$arch/bin/mimo"
if [[ ! -f "$binary" ]]; then
  echo "Built binary not found: $binary" >&2
  exit 1
fi

mkdir -p "$install_dir"
temporary="$install_dir/.mimo.$$"
trap 'rm -f "$temporary"' EXIT
install -m 755 "$binary" "$temporary"
mv -f "$temporary" "$install_dir/mimo"
trap - EXIT

echo "Installed mimo to $install_dir/mimo"
"$install_dir/mimo" --version

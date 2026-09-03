#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  printf '%s\n' 'RUNPOD_BOOTSTRAP_NODE22=FAIL' 'ERROR_CODE=RUNPOD_BOOTSTRAP_ROOT_REQUIRED' >&2
  exit 1
fi

curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

NODE_VERSION="$(node --version)"
NODE_MAJOR="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
[[ "$NODE_MAJOR" == "22" ]] || {
  printf '%s\n' 'RUNPOD_BOOTSTRAP_NODE22=FAIL' "NODE_VERSION=$NODE_VERSION" >&2
  exit 1
}
printf '%s\n' 'RUNPOD_BOOTSTRAP_NODE22=PASS' "NODE_VERSION=$NODE_VERSION"

#!/usr/bin/env bash

set -euo pipefail

export AWS_DEFAULT_REGION='ap-northeast-1'

check_command() {
  if ! command -v "$1" &>/dev/null; then
    echo "ERROR: '$1' command not found."
    exit 1
  fi
}

check_variable() {
  if [ -z "${!1:-}" ]; then
    echo "ERROR: Variable '$1' not exported."
    exit 1
  fi
  echo "PROCESS: Checking environment variable '$(env | grep "$1")'"
}

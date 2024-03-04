#!/usr/bin/env bash

set -euo pipefail

if [ -z "$1" ]; then
  echo "Required deploy target path!"
  exit 1
fi

source "$(cd "$(dirname "$0")" && pwd)/common.sh"

for cmd in aws jq; do
  check_command "$cmd"
done

for var in BUCKET_NAME FRONTEND_VERSION; do
  check_variable "$var"
done

echo "PROCESS: Synchronizing contents to hosting bucket."

aws s3 sync "$1" "s3://$BUCKET_NAME/$FRONTEND_VERSION" --exact-timestamps --delete 1>/dev/null || {
  echo "ERROR: Failed to synchronize contents to hosting bucket."
  exit 1
}

echo "SUCCESS: Application deployment completed successfully."
exit 0

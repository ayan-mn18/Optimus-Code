#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_REGION:-ap-south-1}"
PARAMETER_NAME="${OPTIMUS_ENV_PARAMETER:-/optimus-code/prod/env}"
TARGET=/etc/optimus-code.env
TEMP_FILE=$(mktemp)
trap 'rm -f "$TEMP_FILE"' EXIT

if [ "$(id -u)" -ne 0 ]; then
  echo 'Run this script as root.' >&2
  exit 1
fi

aws ssm get-parameter \
  --region "$REGION" \
  --name "$PARAMETER_NAME" \
  --with-decryption \
  --output json | jq -jer '.Parameter.Value' > "$TEMP_FILE"

if [ ! -s "$TEMP_FILE" ]; then
  echo "Parameter $PARAMETER_NAME returned an empty environment." >&2
  exit 1
fi

install -o root -g optimus -m 640 "$TEMP_FILE" "$TARGET"

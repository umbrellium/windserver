#!/usr/bin/env bash

set -euo pipefail

NAME=umbrellium/windserver
VERSION=$(git describe --tags --always --dirty --abbrev=12)
IMG=$NAME:$VERSION
LATEST=$NAME:latest

DEBUG=${DEBUG:-false}
DO=

if [ "$DEBUG" == "true" ]; then
  DO=echo
fi

$DO docker build -t "$IMG" .
$DO docker tag "$IMG" "$LATEST"

$DO docker push "$IMG"
$DO docker push "$LATEST"
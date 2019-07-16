#!/usr/bin/env bash

set -euo pipefail

NAME=umbrellium/windserver
VERSION=$(git describe --tags --always --dirty --abbrev=12)
IMG=$NAME:$VERSION
LATEST=$NAME:latest

HEROKU_NAME=registry.heroku.com/alva-windserver/web

DEBUG=${DEBUG:-false}
DO=

if [ "$DEBUG" == "true" ]; then
  DO=echo
fi

build() {
  echo "Building image"
  $DO docker build -t "$IMG" .
  $DO docker tag "$IMG" "$LATEST"
  # $DO docker tag "$IMG" "$HEROKU_NAME"
}

push() {
  build

  echo "Pushing image"
  $DO docker push "$IMG"
  $DO docker push "$LATEST"
  # $DO docker push "$HEROKU_NAME"
}

# allow passing in function name as a trailing parameter to the script call
"$@"

#!/bin/sh
# Regenerates <case>/diff.patch from <case>/before and <case>/after, as a git
# commit would show it. Run it on the host: the server image has no git.
#
#   sh server/evals/make-patch.sh server/evals/cases/<id> [...]
set -eu
for dir in "$@"; do
  tmp=$(mktemp -d)
  git -C "$tmp" init -q
  if [ -d "$dir/before" ]; then cp -R "$dir/before/." "$tmp/"; fi
  git -C "$tmp" add -A
  git -C "$tmp" -c user.name=eval -c user.email=eval@localhost commit -q --allow-empty -m before
  find "$tmp" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
  if [ -d "$dir/after" ]; then cp -R "$dir/after/." "$tmp/"; fi
  git -C "$tmp" add -A
  git -C "$tmp" -c diff.noprefix=false -c diff.mnemonicPrefix=false \
    diff --cached -M --no-color --no-ext-diff > "$dir/diff.patch"
  rm -rf "$tmp"
done

#!/usr/bin/env bash
# Pre-commit hook: format the staged files with Prettier and stage them again.
# Git 2.54 or later runs it through `.gitconfig` at the root of the repository.

set -euo pipefail

# Staged files (added, copied, modified, renamed), separated by NUL so that a
# path with a space survives. Deleted files are left out.
mapfile -d '' -t staged_files < <(git diff --cached --name-only --diff-filter=ACMR -z)

if ((${#staged_files[@]} == 0)); then
    exit 0
fi

bunx prettier --write --ignore-unknown -- "${staged_files[@]}"
git add -- "${staged_files[@]}"

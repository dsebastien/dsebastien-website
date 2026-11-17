#!/usr/bin/env bash
# Pre-commit hook: format the staged files with Prettier.
# Git 2.54 or later runs it through `.gitconfig` at the root of the repository.
#
# A file can be staged in part (`git add -p`): the rest of its changes must
# stay out of the commit. So the hook has two paths:
#
#  - A file with no other change: Prettier formats the file, and the file is
#    staged again.
#  - A file with a change that is not staged: Prettier formats the staged
#    content only, inside the index. The file in the work tree is not touched,
#    so it keeps its own formatting until its next commit.

set -euo pipefail

# Staged files (added, copied, modified, renamed), separated by NUL so that a
# path with a space survives. Deleted files are left out.
mapfile -d '' -t staged_files < <(git diff --cached --name-only --diff-filter=ACMR -z)

whole_files=()
partial_files=()
for file in "${staged_files[@]}"; do
    if git diff --quiet -- "$file"; then
        whole_files+=("$file")
    else
        partial_files+=("$file")
    fi
done

if ((${#whole_files[@]} > 0)); then
    bunx prettier --write --ignore-unknown -- "${whole_files[@]}"
    git add -- "${whole_files[@]}"
fi

for file in "${partial_files[@]}"; do
    # Leave out what Prettier ignores or cannot read.
    info=$(bunx prettier --file-info "$file")
    if [[ "$info" == *'"ignored": true'* || "$info" == *'"inferredParser": null'* ]]; then
        continue
    fi

    mode=$(git ls-files --stage -- "$file" | cut -d' ' -f1)
    blob=$(git show ":$file" | bunx prettier --stdin-filepath "$file" | git hash-object -w --stdin)
    git update-index --cacheinfo "$mode" "$blob" "$file"
done

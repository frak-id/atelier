#!/usr/bin/env bash
# The PR's diff as files, for the review's sub-agents: they can read files, not
# run git (README.md). main.ts runs it in the sandbox, at the PR's head:
#
#   bash diff-files.sh <merge base> <head> <out> [<earlier head>]
#
# - <out>/files.tsv: one line per file the PR changes: its status (A, M, D, R,
#   or T: turned into a symlink or back), the lines it adds and removes, its
#   path (at the head; the base's for a deleted file) and, for a renamed file,
#   the path it had. A path is escaped as git quotes one: `\\` for a backslash,
#   `\t` for a tab, `\n` for a newline (an ordinary path is unchanged), so a
#   name can't split a row or shift the columns.
# - <out>/diff/<path>.patch: that file's diff, with `.d` added to each directory
#   of <path> (`src/app/x.ts` is `diff/src.d/app.d/x.ts.patch`): a file `X` and
#   a file under a directory `X.patch` (or a file replaced by a directory of the
#   same name) would otherwise want the same name for a file and for a
#   directory. A file's name always ends in `.patch` and a directory's in `.d`,
#   so no two paths meet. <path> is the escaped path, as files.tsv lists it.
# - With an earlier head (one an earlier review saw): what changed since, in
#   <out>/delta-files.tsv and <out>/delta/, on the PR's files only, since a
#   rebase brings the base's changes too. Always there then: empty when the PR
#   changes no file.
#
# Prints what it wrote, in one line. Bash 3 (macOS's, for the tests) and POSIX
# awk: no mapfile, no gawk.
set -euo pipefail

base=$1
head=$2
out=$3
since=${4:-}

# A path is a path: `*` or `:(` in a file's name is no pathspec magic.
export GIT_LITERAL_PATHSPECS=1
git_diff() { git diff --no-color --no-ext-diff -M "$@"; }
tab=$'\t'
newline=$'\n'
# A lone backslash, not an escaped quote.
# shellcheck disable=SC1003
backslash='\'

# escape <path>: sets `escaped` to the path with `\`, tab and newline written as
# `\\`, `\t` and `\n`.
escape() {
    escaped=${1//"$backslash"/"$backslash$backslash"}
    escaped=${escaped//"$tab"/"${backslash}t"}
    escaped=${escaped//"$newline"/"${backslash}n"}
}

rm -rf "$out"
mkdir -p "$out"

paths=()
summary=""

# write <name> <from> <to> [pathspec...]: <out>/<name>/<path>.patch per file
# (directories as `.d`, above) and <out>/<name>-files.tsv. The patch is made
# once and cut at each `diff --git` line: its sections come in the order
# --name-status lists the files, except that a file turned into a symlink or
# back (status T) has two, a deletion and a creation: together they are its
# patch.
write() {
    local name=$1 from=$2 to=$3
    shift 3
    local dir="$out/$name" work="$out/.$name"
    mkdir -p "$dir" "$work"
    git_diff --name-status -z "$from" "$to" -- "$@" >"$work/list"
    git_diff "$from" "$to" -- "$@" >"$work/patch"
    # Each section in its own file, and its added and removed lines (after its
    # first hunk header: before it, `+++` and `---` are the file names).
    awk -v dir="$work" '
        /^diff --git / {
            if (n) close(file)
            n++
            file = dir "/" n
            hunks = 0
            added[n] = 0
            removed[n] = 0
        }
        { print > file }
        /^@@ / { hunks = 1; next }
        hunks && /^\+/ { added[n]++ }
        hunks && /^-/ { removed[n]++ }
        END { for (i = 1; i <= n; i++) print added[i] "\t" removed[i] > (dir "/counts") }
    ' "$work/patch"
    touch "$work/counts"

    local i=0 section=0 first total status from_path path shown shown_from patch_dir patch_path added removed
    local more_added more_removed
    total=$(wc -l <"$work/counts" | tr -d ' ')
    : >"$out/$name-files.tsv"
    exec 3<"$work/counts"
    while IFS= read -r -d '' status; do
        from_path=""
        case $status in R* | C*) IFS= read -r -d '' from_path ;; esac
        IFS= read -r -d '' path
        i=$((i + 1))
        section=$((section + 1))
        first=$section
        IFS=$'\t' read -r added removed <&3
        if [ "${status:0:1}" = T ]; then
            section=$((section + 1))
            IFS=$'\t' read -r more_added more_removed <&3
            cat "$work/$section" >>"$work/$first"
            added=$((added + more_added))
            removed=$((removed + more_removed))
        fi
        escape "$path"
        shown=$escaped
        shown_from=""
        if [ -n "$from_path" ]; then
            escape "$from_path"
            shown_from=$escaped
        fi
        patch_path=$shown.patch
        case $shown in */*)
            patch_dir=${shown%/*}
            patch_dir=${patch_dir//\//.d/}.d
            mkdir -p "$dir/$patch_dir"
            patch_path=$patch_dir/${shown##*/}.patch
            ;;
        esac
        mv "$work/$first" "$dir/$patch_path"
        printf '%s\t+%s -%s\t%s%s\n' "${status:0:1}" "$added" "$removed" "$shown" "${shown_from:+$tab(was $shown_from)}" \
            >>"$out/$name-files.tsv"
        if [ "$name" = diff ]; then
            paths+=("$path")
            if [ -n "$from_path" ]; then paths+=("$from_path"); fi
        fi
    done <"$work/list"
    exec 3<&-
    if [ "$section" != "$total" ]; then
        echo "diff-files.sh: $i files listed ($section sections), $total sections in the patch" >&2
        exit 1
    fi
    rm -rf "$work"
    summary="$summary$name: $i files; "
}

write diff "$base" "$head"
mv "$out/diff-files.tsv" "$out/files.tsv"
if [ -n "$since" ] && [ "$since" != "$head" ]; then
    if [ ${#paths[@]} -gt 0 ]; then
        write delta "$since" "$head" "${paths[@]}"
    else
        # No pathspec would mean the whole tree, not no file: nothing to diff,
        # and an empty delta for the prompt to read.
        mkdir -p "$out/delta"
        : >"$out/delta-files.tsv"
        summary="${summary}delta: 0 files; "
    fi
fi
echo "${summary%; }"

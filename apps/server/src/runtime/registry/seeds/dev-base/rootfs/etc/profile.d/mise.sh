# mise shims on PATH for every login shell: the supervisor, exec and hooks
# all run `bash -l -c`, which never fires mise's prompt hook, and a shim
# resolves the project's pinned version at call time. Interactive bash also
# gets the full hook, which loads a project's [env] on cd.
export PATH="${MISE_DATA_DIR:-$HOME/.local/share/mise}/shims:$PATH"
if [ -n "${BASH_VERSION:-}" ]; then
    case $- in
        *i*) eval "$(mise activate bash)" ;;
    esac
fi

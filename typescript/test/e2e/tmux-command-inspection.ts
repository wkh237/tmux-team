// Shared shell fragment for fixture barriers and invocation tracing. Inspect
// supported global socket/config options without changing the forwarded argv.
export const TMUX_COMMAND_INSPECTION = `
tmux_command=""
tmux_command_arg_count=0
tmux_last_arg=""
skip_option_value=0
for arg in "${'$'}@"; do
  if [ -n "${'$'}tmux_command" ]; then
    tmux_command_arg_count=${'$'}((tmux_command_arg_count + 1))
    tmux_last_arg="${'$'}arg"
    continue
  fi
  if [ "${'$'}skip_option_value" = "1" ]; then skip_option_value=0; continue; fi
  case "${'$'}arg" in
    -S|-L|-f) skip_option_value=1 ;;
    -*) ;;
    *) tmux_command="${'$'}arg" ;;
  esac
done
`;

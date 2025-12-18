// ─────────────────────────────────────────────────────────────
// completion command - shell completion scripts
// ─────────────────────────────────────────────────────────────

import { colors } from '../ui.js';

const zshCompletion = `#compdef tmux-team

_tmux-team() {
  local -a commands agents

  commands=(
    'talk:Send message to an agent'
    'check:Capture output from agent pane'
    'list:List all configured agents'
    'add:Add a new agent'
    'update:Update agent config'
    'remove:Remove an agent'
    'init:Create empty tmux-team.json'
    'completion:Output shell completion script'
    'help:Show help message'
  )

  _get_agents() {
    if [[ -f ./tmux-team.json ]]; then
      agents=(\${(f)"$(node -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync('./tmux-team.json'))).join('\\\\n'))" 2>/dev/null)"})
    fi
  }

  if (( CURRENT == 2 )); then
    _describe -t commands 'tmux-team commands' commands
  elif (( CURRENT == 3 )); then
    case \${words[2]} in
      talk|check|update|remove|rm)
        _get_agents
        if [[ -n "\$agents" ]]; then
          _describe -t agents 'agents' agents
        fi
        if [[ "\${words[2]}" == "talk" ]]; then
          compadd "all"
        fi
        ;;
      completion)
        compadd "zsh" "bash"
        ;;
    esac
  elif (( CURRENT == 4 )); then
    case \${words[2]} in
      update)
        compadd -- "--pane" "--remark"
        ;;
      talk)
        compadd -- "--delay" "--wait" "--timeout"
        ;;
    esac
  fi
}

_tmux-team "\$@"`;

const bashCompletion = `_tmux_team() {
  local cur prev commands agents
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  commands="talk check list add update remove init completion help"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${commands}" -- \${cur}) )
  elif [[ \${COMP_CWORD} -eq 2 ]]; then
    case "\${prev}" in
      talk|check|update|remove|rm)
        if [[ -f ./tmux-team.json ]]; then
          agents=$(node -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync('./tmux-team.json'))).join(' '))" 2>/dev/null)
        fi
        if [[ "\${prev}" == "talk" ]]; then
          agents="\${agents} all"
        fi
        COMPREPLY=( $(compgen -W "\${agents}" -- \${cur}) )
        ;;
      completion)
        COMPREPLY=( $(compgen -W "zsh bash" -- \${cur}) )
        ;;
    esac
  elif [[ \${COMP_CWORD} -eq 3 ]]; then
    case "\${COMP_WORDS[1]}" in
      update)
        COMPREPLY=( $(compgen -W "--pane --remark" -- \${cur}) )
        ;;
      talk)
        COMPREPLY=( $(compgen -W "--delay --wait --timeout" -- \${cur}) )
        ;;
    esac
  fi
}

complete -F _tmux_team tmux-team`;

export function cmdCompletion(shell?: string): void {
  if (shell === 'bash') {
    console.log(bashCompletion);
  } else if (shell === 'zsh') {
    console.log(zshCompletion);
  } else {
    console.log(`
${colors.cyan('Shell Completion Setup')}

${colors.yellow('Zsh')} (add to ~/.zshrc):
  eval "$(tmux-team completion zsh)"

${colors.yellow('Bash')} (add to ~/.bashrc):
  eval "$(tmux-team completion bash)"

Then restart your shell or run: source ~/.zshrc (or ~/.bashrc)
`);
  }
}

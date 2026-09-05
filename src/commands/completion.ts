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
    'list:List active identities or pane status'
    'add:Add a new agent'
    'name:Bind the current pane identity'
    'this:Bind the current pane identity'
    'whoami:Show the current pane identity'
    'unbind:Remove the current pane identity'
    'install:Install agent skills'
    'upgrade:Upgrade tmux-team and refresh skills'
    'init:Create empty legacy tmux-team.json'
    'completion:Output shell completion script'
    'config:View or modify settings'
    'preamble:Manage identity preambles'
    'role:Manage durable identity role profiles'
    'learn:Show the learning guide'
    'help:Show help message'
  )

  _get_agents() {
    agents=(\${(f)"$(tmux-team list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(s); console.log((j.identities||[]).map(a=>a.name).join("\\n"))}catch{}})')"})
  }

  if (( CURRENT == 2 )); then
    _describe -t commands 'tmux-team commands' commands
  elif (( CURRENT == 3 )); then
    case \${words[2]} in
      talk|check)
        _get_agents
        if [[ -n "$agents" ]]; then
          _describe -t agents 'agents' agents
        fi
        ;;
      completion)
        compadd "zsh" "bash"
        ;;
      install)
        compadd "claude" "codex" "gemini" "all"
        ;;
      role)
        compadd "show" "set" "clear"
        ;;
    esac
  elif (( CURRENT == 4 )); then
    case \${words[2]} in
      talk)
        compadd -- "--delay" "--wait" "--timeout"
        ;;
      role)
        compadd -- "--identity"
        if [[ "\${words[3]}" == "set" ]]; then compadd -- "--file"; fi
        ;;
    esac
  fi
}

_tmux-team "$@"`;

const bashCompletion = `_tmux_team() {
  local cur prev commands agents
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  commands="talk check list add init completion help name this whoami unbind install upgrade config preamble role learn"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${commands}" -- \${cur}) )
  elif [[ \${COMP_CWORD} -eq 2 ]]; then
    case "\${prev}" in
      talk|check)
        agents=$(tmux-team list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(s); console.log((j.identities||[]).map(a=>a.name).join(" "))}catch{}})')
        COMPREPLY=( $(compgen -W "\${agents}" -- \${cur}) )
        ;;
      completion)
        COMPREPLY=( $(compgen -W "zsh bash" -- \${cur}) )
        ;;
      install)
        COMPREPLY=( $(compgen -W "claude codex gemini all" -- \${cur}) )
        ;;
      role)
        COMPREPLY=( $(compgen -W "show set clear" -- \${cur}) )
        ;;
    esac
  elif [[ \${COMP_CWORD} -eq 3 ]]; then
    case "\${COMP_WORDS[1]}" in
      talk)
        COMPREPLY=( $(compgen -W "--delay --wait --timeout" -- \${cur}) )
        ;;
      role)
        if [[ "\${COMP_WORDS[2]}" == "set" ]]; then
          COMPREPLY=( $(compgen -W "--identity --file" -- \${cur}) )
        else
          COMPREPLY=( $(compgen -W "--identity" -- \${cur}) )
        fi
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

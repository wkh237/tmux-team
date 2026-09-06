// ─────────────────────────────────────────────────────────────
// completion command - shell completion scripts
// ─────────────────────────────────────────────────────────────

import { getCliCommandMetadata, type CliCommandMetadata } from '../cli/parser.js';
import { ALL_SKILL_TARGET, SKILL_AGENTS } from '../skill-installation.js';
import { colors } from '../ui.js';

const INSTALL_TARGETS = [...SKILL_AGENTS, ALL_SKILL_TARGET];
const COMPLETION_SHELLS = ['zsh', 'bash'];
const IDENTITY_COMMANDS = new Set(['talk', 'send', 'check', 'read']);

function visibleCommands(root: CliCommandMetadata): readonly CliCommandMetadata[] {
  return root.commands.filter((command) => !command.hidden);
}

function visibleOptions(command: CliCommandMetadata, rootOnly = false): string[] {
  const words: string[] = [];
  const seen = new Set<string>();
  for (const option of command.options) {
    if (option.hidden) {
      continue;
    }
    if (rootOnly && !option.rootAllowed) continue;
    for (const word of [option.short, option.long]) {
      if (word && !seen.has(word)) {
        seen.add(word);
        words.push(word);
      }
    }
  }
  return words;
}

function commandWords(command: CliCommandMetadata): string[] {
  return [command.name, ...command.aliases];
}

function casePattern(command: CliCommandMetadata): string {
  return commandWords(command).join('|');
}

function shellWordList(words: readonly string[]): string {
  return words.join(' ');
}

function zshCommandRows(commands: readonly CliCommandMetadata[]): string {
  return commands
    .flatMap((command) =>
      commandWords(command).map((name) => {
        const description = command.description ? `:${command.description}` : '';
        return `    '${name}${description}'`;
      })
    )
    .join('\n');
}

function zshSubcommandWords(command: CliCommandMetadata): string {
  return command.commands
    .filter((child) => !child.hidden)
    .map((child) => child.name)
    .join(' ');
}

// Keep the existing fixed-position completion model; metadata supplies the
// registered words and options without introducing a second argv parser.
function zshCaseAtThirdWord(root: CliCommandMetadata): string {
  return visibleCommands(root)
    .flatMap((command) => {
      const options = visibleOptions(command);
      const words =
        command.commands.length > 0
          ? [zshSubcommandWords(command), ...options].filter(Boolean)
          : options;
      if (IDENTITY_COMMANDS.has(command.name)) {
        return `      ${casePattern(command)})
        _get_agents
        if [[ -n "$agents" ]]; then
          _describe -t agents 'agents' agents
        fi
        compadd -- ${options.join(' ')}
        ;;`;
      }
      if (command.name === 'completion') {
        return `      completion)
        compadd -- ${[...COMPLETION_SHELLS, ...options].join(' ')}
        ;;`;
      }
      if (command.name === 'install') {
        return `      install)
        compadd -- ${[...INSTALL_TARGETS, ...options].join(' ')}
        ;;`;
      }
      if (words.length === 0) return '';
      return `      ${casePattern(command)})
        compadd -- ${words.join(' ')}
        ;;`;
    })
    .filter(Boolean)
    .join('\n');
}

function zshCaseAtFourthWord(root: CliCommandMetadata): string {
  return visibleCommands(root)
    .flatMap((command) => {
      const parentOptions = visibleOptions(command);
      const childCases = command.commands
        .filter((child) => !child.hidden)
        .map((child) => {
          const options = visibleOptions(child);
          if (options.length === 0) return '';
          return `          ${child.name}) compadd -- ${options.join(' ')} ;;`;
        })
        .filter(Boolean);
      if (childCases.length > 0) {
        return `      ${casePattern(command)})
        case "\${words[3]}" in
${childCases.join('\n')}
        esac
        ;;`;
      }
      if (parentOptions.length === 0) return [];
      return [
        `      ${casePattern(command)})
        compadd -- ${parentOptions.join(' ')}
        ;;`,
      ];
    })
    .join('\n');
}

function bashCaseAtSecondWord(root: CliCommandMetadata): string {
  return visibleCommands(root)
    .map((command) => {
      const options = visibleOptions(command);
      if (IDENTITY_COMMANDS.has(command.name)) {
        return `      ${[command.name, ...command.aliases].join('|')})
        agents=$(tmux-team list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(s); console.log((j.identities||[]).map(a=>a.name).join(" "))}catch{}})')
        COMPREPLY=( $(compgen -W "\${agents} ${shellWordList(options)}" -- \${cur}) )
        ;;`;
      }
      const words =
        command.commands.length > 0
          ? [
              ...command.commands.filter((child) => !child.hidden).map((child) => child.name),
              ...options,
            ]
          : options;
      if (command.name === 'completion') words.push(...COMPLETION_SHELLS);
      if (command.name === 'install') words.push(...INSTALL_TARGETS);
      if (words.length === 0) return '';
      return `      ${casePattern(command)})
        COMPREPLY=( $(compgen -W "${shellWordList(words)}" -- \${cur}) )
        ;;`;
    })
    .filter(Boolean)
    .join('\n');
}

function bashCaseAtThirdWord(root: CliCommandMetadata): string {
  return visibleCommands(root)
    .map((command) => {
      const childCases = command.commands
        .filter((child) => !child.hidden)
        .map((child) => {
          const options = visibleOptions(child);
          if (options.length === 0) return '';
          return `          ${child.name})
            COMPREPLY=( $(compgen -W "${shellWordList(options)}" -- \${cur}) )
            ;;`;
        })
        .filter(Boolean);
      if (childCases.length > 0) {
        return `      ${casePattern(command)})
        case "\${COMP_WORDS[2]}" in
${childCases.join('\n')}
        esac
        ;;`;
      }
      const options = visibleOptions(command);
      if (options.length === 0) return [];
      return [
        `      ${casePattern(command)})
        COMPREPLY=( $(compgen -W "${shellWordList(options)}" -- \${cur}) )
        ;;`,
      ];
    })
    .join('\n');
}

function renderZshCompletion(root: CliCommandMetadata): string {
  const rootOptions = visibleOptions(root, true);
  return `#compdef tmux-team

_tmux-team() {
  local -a commands agents

  commands=(
${zshCommandRows(visibleCommands(root))}
  )

  _get_agents() {
    agents=(\${(f)"$(tmux-team list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(s); console.log((j.identities||[]).map(a=>a.name).join("\\n"))}catch{}})')"})
  }

  if (( CURRENT == 2 )); then
    _describe -t commands 'tmux-team commands' commands
    compadd -- ${rootOptions.join(' ')}
  elif (( CURRENT == 3 )); then
    case \${words[2]} in
${zshCaseAtThirdWord(root)}
    esac
  elif (( CURRENT == 4 )); then
    case \${words[2]} in
${zshCaseAtFourthWord(root)}
    esac
  fi
}

_tmux-team "$@"`;
}

function renderBashCompletion(root: CliCommandMetadata): string {
  const commandWordsList = visibleCommands(root).flatMap(commandWords);
  const rootOptions = visibleOptions(root, true);
  return `_tmux_team() {
  local cur prev commands agents
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  commands="${shellWordList(commandWordsList)}"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${commands} ${shellWordList(rootOptions)}" -- \${cur}) )
  elif [[ \${COMP_CWORD} -eq 2 ]]; then
    case "\${prev}" in
${bashCaseAtSecondWord(root)}
    esac
  elif [[ \${COMP_CWORD} -eq 3 ]]; then
    case "\${COMP_WORDS[1]}" in
${bashCaseAtThirdWord(root)}
    esac
  fi
}

complete -F _tmux_team tmux-team`;
}

export function cmdCompletion(shell?: string): void {
  const metadata = getCliCommandMetadata();
  if (shell === 'bash') {
    console.log(renderBashCompletion(metadata));
  } else if (shell === 'zsh') {
    console.log(renderZshCompletion(metadata));
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

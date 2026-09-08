//! Exact canonical skill viewing and a deliberately short native quick start.

use std::io::{self, Write};
use tmt_core::skill_provider::Provider;

pub fn execute(skill: bool) -> io::Result<u8> {
    let mut output = io::stdout().lock();
    if skill {
        output.write_all(tmt_adapters::skill_installation::bundled_skill())?;
    } else {
        writeln!(
            output,
            "TMT — collaborate with terminal agents through durable exchanges.\n"
        )?;
        writeln!(
            output,
            "Native development preview: use isolated state until native cutover.\n"
        )?;
        writeln!(
            output,
            "Start with tmt install, then reload your agent's skills."
        )?;
        writeln!(
            output,
            "Providers: {}. Use install all or install --dir <skills-root>.",
            Provider::ALL.map(Provider::as_str).join(", ")
        )?;
        writeln!(
            output,
            "Installation is non-interactive and does not install agent applications.\n"
        )?;
        writeln!(
            output,
            "  tmt name alice             Bind this pane temporarily; add -s to save it.\n  tmt add %14 reviewer       Bind another pane by stable ID.\n  tmt ls                     Show lifetime and verified presence.\n  tmt talk reviewer 'Review this patch' --timeout 300 --json\n  tmt talk reviewer 'Run the tests' --detach --json\n  tmt result <request-id> --json\n  tmt x ackall --identity coordinator\n  tmt config show --json\n"
        )?;
        writeln!(
            output,
            "Talk waits for tmt reply, not terminal output. Use exactly the supplied\nrequest ID and receipt with reply --message, --file or --stdin. Submit the\ncomplete result before showing a brief truthful user summary. Timeout ends\nonly the observer; preserve the request ID and do not automatically resend.\n"
        )?;
        writeln!(
            output,
            "Outside tmux, use an existing --identity for attributed talk or x.\nCreate saved identities with tmt identity create <name>. X reads never ack;\na later final reopens attention. Recipients still need a live tmux pane.\n"
        )?;
        writeln!(
            output,
            "Read tmt learn --skill for complete current safety and usage guidance.\nUse tmt help for options. Native network upgrade is not available yet."
        )?;
    }
    Ok(0)
}

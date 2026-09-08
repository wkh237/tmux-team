//! Managed local agent guidance; independent of identities, SQLite and tmux.

mod assets;
mod drift;
mod files;
mod providers;
mod refresh;
mod registry;
pub use refresh::{RefreshFailure, RefreshReport, RefreshedSkill, refresh};
#[cfg(test)]
mod refresh_tests;
pub use drift::inspect_local_drift;
pub use providers::ProviderEnvironment;
#[cfg(test)]
mod assets_tests;
#[cfg(test)]
mod files_tests;
#[cfg(test)]
mod install_tests;
#[cfg(test)]
mod publication_tests;

pub fn bundled_skill() -> &'static [u8] {
    assets::SKILL
}

use std::{
    error::Error,
    fmt, fs, io,
    path::{Path, PathBuf},
};
use tmt_core::skill_provider::Provider;

#[derive(Debug)]
pub struct InstalledSkill {
    pub agent: Option<Provider>,
    pub target: PathBuf,
    pub changed: bool,
    pub backup: Option<PathBuf>,
    pub legacy_backups: Vec<PathBuf>,
}

#[derive(Debug, Default)]
pub struct InstallReport {
    pub installed: Vec<InstalledSkill>,
    pub warnings: Vec<String>,
}

#[derive(Debug)]
pub struct InstallFailure {
    cause: io::Error,
    pub report: InstallReport,
    pub pending_backup: Option<PathBuf>,
}

impl fmt::Display for InstallFailure {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(output, "Skill installation failed: {}", self.cause)?;
        for item in &self.report.installed {
            write!(output, "; installed target: {}", item.target.display())?;
            for backup in item.backup.iter().chain(&item.legacy_backups) {
                write!(output, "; recoverable backup: {}", backup.display())?;
            }
        }
        if let Some(backup) = &self.pending_backup {
            write!(
                output,
                "; failed target's recoverable backup: {}",
                backup.display()
            )?;
        }
        Ok(())
    }
}
impl Error for InstallFailure {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(&self.cause)
    }
}

fn selected(
    env: &ProviderEnvironment,
    provider: Option<&str>,
    directory: Option<&Path>,
) -> io::Result<Vec<(Option<Provider>, PathBuf)>> {
    if let Some(directory) = directory {
        if provider.is_some() || directory.as_os_str().is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Use a non-empty --dir without a provider or all.",
            ));
        }
        return Ok(vec![(None, env.custom_target(directory))]);
    }
    let providers = match provider {
        None => env.detect(),
        Some(value) if value.eq_ignore_ascii_case("all") => Provider::ALL.to_vec(),
        Some(value) => vec![Provider::parse(value).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("Unknown agent: {value}"),
            )
        })?],
    };
    if providers.is_empty() {
        return Ok(vec![(None, env.universal_target())]);
    }
    Ok(providers
        .into_iter()
        .map(|provider| (Some(provider), env.target(provider)))
        .collect())
}

fn managed_link(target: &Path, assets: &assets::SkillAssets) -> io::Result<Option<PathBuf>> {
    if !files::exists(target)? || !fs::symlink_metadata(target)?.is_symlink() {
        return Ok(None);
    }
    let source = crate::config::normalize(
        &target
            .parent()
            .expect("selected target parent")
            .join(fs::read_link(target)?),
    );
    Ok(assets.owns(&source).then_some(source))
}

/// Materialize and publish only requested integrations. The lock covers all
/// cooperating native installers; this is not a hostile-filesystem sandbox.
pub fn install(
    env: &ProviderEnvironment,
    global: &Path,
    provider: Option<&str>,
    directory: Option<&Path>,
    force: bool,
) -> Result<InstallReport, InstallFailure> {
    install_with_publisher(env, global, provider, directory, force, files::link)
}

// Keep publication at the existing file boundary so failure tests exercise the
// real selection, backup, registry, report, and lock lifecycle around it.
fn install_with_publisher(
    env: &ProviderEnvironment,
    global: &Path,
    provider: Option<&str>,
    directory: Option<&Path>,
    force: bool,
    mut publish: impl FnMut(&Path, &Path) -> io::Result<()>,
) -> Result<InstallReport, InstallFailure> {
    let mut report = InstallReport::default();
    let mut pending_backup = None;
    let pending = (|| {
        let targets = selected(env, provider, directory)?;
        let global = files::resolved(global)?;
        let assets = assets::SkillAssets::new(&global);
        // These guards precede even lock/cache creation or forced backups.
        for (_, target) in &targets {
            files::safe_target(assets.root(), target)?;
        }
        files::with_lock(&global, || {
            registry::read(&global)?;
            let source = assets.materialize()?;
            registry::remember(&global, targets.iter().map(|(_, target)| target.clone()))?;
            for (agent, target) in targets {
                let prior = managed_link(&target, &assets)?;
                let changed = prior.as_ref() != Some(&source);
                if changed {
                    if prior.is_none() && files::exists(&target)? {
                        if !force {
                            return Err(io::Error::other(format!(
                                "Refusing to replace existing unmanaged path: {} (use --force)",
                                target.display()
                            )));
                        }
                        pending_backup = Some(files::backup(&target)?);
                    }
                    publish(&target, &source)?;
                }
                report.installed.push(InstalledSkill {
                    agent,
                    target: target.clone(),
                    changed,
                    backup: pending_backup.take(),
                    legacy_backups: Vec::new(),
                });
                if let Some(agent) = agent {
                    for legacy in env.legacy_targets(agent) {
                        if !files::exists(&legacy)?
                            || files::entry_location(&legacy)? == files::entry_location(&target)?
                        {
                            continue;
                        }
                        if force {
                            files::safe_target(assets.root(), &legacy)?;
                            let backup = files::backup(&legacy)?;
                            report
                                .installed
                                .last_mut()
                                .expect("published skill")
                                .legacy_backups
                                .push(backup);
                        } else {
                            report.warnings.push(format!("Legacy {} guidance found at {}; keeping it. Inspect before running tmt install {} --force.", agent.as_str(), legacy.display(), agent.as_str()));
                        }
                    }
                }
            }
            Ok(())
        })
    })();
    match pending {
        Ok(()) => Ok(report),
        Err(cause) => Err(InstallFailure {
            cause,
            report,
            pending_backup,
        }),
    }
}

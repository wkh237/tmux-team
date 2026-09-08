//! Provider-specific skill locations and environment detection.

use std::{
    env, fs,
    path::{Path, PathBuf},
};
use tmt_core::skill_provider::Provider;

#[derive(Debug, Clone)]
pub struct ProviderEnvironment {
    home: PathBuf,
    cwd: PathBuf,
    path: Vec<PathBuf>,
    codex_home: Option<PathBuf>,
    pi_coding_agent_dir: Option<PathBuf>,
    opencode_config_dir: Option<PathBuf>,
    xdg_config_home: Option<PathBuf>,
}

impl ProviderEnvironment {
    /// Capture process state once at the invocation boundary.
    pub fn capture() -> std::io::Result<Self> {
        Ok(Self::from_parts(
            env::home_dir().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "Cannot determine the home directory",
                )
            })?,
            env::current_dir()?,
            env::var_os("PATH")
                .map(|value| env::split_paths(&value).collect())
                .unwrap_or_default(),
            non_empty_env_path("CODEX_HOME"),
            non_empty_env_path("PI_CODING_AGENT_DIR"),
            non_empty_env_path("OPENCODE_CONFIG_DIR"),
            non_empty_env_path("XDG_CONFIG_HOME"),
        ))
    }

    pub fn from_parts(
        home: impl Into<PathBuf>,
        cwd: impl Into<PathBuf>,
        path: Vec<PathBuf>,
        codex_home: Option<PathBuf>,
        pi_coding_agent_dir: Option<PathBuf>,
        opencode_config_dir: Option<PathBuf>,
        xdg_config_home: Option<PathBuf>,
    ) -> Self {
        Self {
            home: home.into(),
            cwd: cwd.into(),
            path,
            codex_home: non_empty_path(codex_home),
            pi_coding_agent_dir: non_empty_path(pi_coding_agent_dir),
            opencode_config_dir: non_empty_path(opencode_config_dir),
            xdg_config_home: non_empty_path(xdg_config_home),
        }
    }

    pub fn detect(&self) -> Vec<Provider> {
        Provider::ALL
            .into_iter()
            .filter(|provider| self.detected(*provider))
            .collect()
    }

    pub fn target(&self, provider: Provider) -> PathBuf {
        let universal = self.universal_target();
        match provider {
            Provider::Claude => self.home.join(".claude/skills/tmux-team"),
            Provider::Codex | Provider::Gemini | Provider::Opencode => universal,
            Provider::Agy => self.home.join(".gemini/config/skills/tmux-team"),
            Provider::Pi => self.pi_coding_agent_directory().join("skills/tmux-team"),
        }
    }

    pub fn universal_target(&self) -> PathBuf {
        self.home.join(".agents/skills/tmux-team")
    }

    pub fn custom_target(&self, root: impl AsRef<Path>) -> PathBuf {
        self.resolve_path(root.as_ref()).join("tmux-team")
    }

    pub fn legacy_targets(&self, provider: Provider) -> Vec<PathBuf> {
        match provider {
            Provider::Claude => vec![self.home.join(".claude/commands/team.md")],
            Provider::Codex => {
                let active = self.universal_target();
                let candidates = [
                    self.codex_home().join("skills/tmux-team"),
                    self.home.join(".codex/skills/tmux-team"),
                ];
                let mut result = Vec::new();
                for candidate in candidates {
                    let candidate = self.resolve_path(&candidate);
                    if candidate == active || result.iter().any(|path| path == &candidate) {
                        continue;
                    }
                    result.push(candidate);
                }
                result
            }
            Provider::Gemini | Provider::Agy | Provider::Pi | Provider::Opencode => Vec::new(),
        }
    }

    fn detected(&self, provider: Provider) -> bool {
        let directory_found = match provider {
            Provider::Claude => self.exists(self.home.join(".claude")),
            Provider::Codex => {
                self.exists(self.home.join(".codex"))
                    || (self.resolve_path(&self.codex_home()) != self.home.join(".agents")
                        && self.exists(self.codex_home()))
            }
            Provider::Gemini => self.exists(self.home.join(".gemini")),
            Provider::Agy => self.exists(self.agy_config_directory()),
            Provider::Pi => self.exists(self.pi_coding_agent_directory()),
            Provider::Opencode => self.exists(self.opencode_config_directory()),
        };
        directory_found || self.command_exists(provider.as_str())
    }

    fn command_exists(&self, command: &str) -> bool {
        self.path.iter().any(|directory| {
            fs::metadata(self.resolve_path(&directory.join(command)))
                .map(|metadata| metadata.is_file())
                .unwrap_or(false)
        })
    }

    fn codex_home(&self) -> PathBuf {
        self.codex_home
            .clone()
            .map(|path| self.resolve_path(&path))
            .unwrap_or_else(|| self.home.join(".codex"))
    }

    fn agy_config_directory(&self) -> PathBuf {
        self.home.join(".gemini/config")
    }

    fn pi_coding_agent_directory(&self) -> PathBuf {
        let Some(configured) = self.pi_coding_agent_dir.as_deref() else {
            return self.home.join(".pi/agent");
        };
        if configured == Path::new("~") {
            return self.home.clone();
        }
        if let Ok(relative) = configured.strip_prefix("~/") {
            return self.home.join(relative);
        }
        self.resolve_path(configured)
    }

    fn opencode_config_directory(&self) -> PathBuf {
        if let Some(configured) = self.opencode_config_dir.as_deref() {
            return self.resolve_path(configured);
        }
        self.xdg_config_home
            .clone()
            .map(|path| self.resolve_path(&path).join("opencode"))
            .unwrap_or_else(|| self.home.join(".config/opencode"))
    }

    fn exists(&self, path: PathBuf) -> bool {
        self.resolve_path(&path).exists()
    }

    fn resolve_path(&self, path: &Path) -> PathBuf {
        crate::config::normalize(&self.cwd.join(path))
    }
}

fn non_empty_env_path(name: &str) -> Option<PathBuf> {
    non_empty_path(env::var_os(name).map(PathBuf::from))
}

fn non_empty_path(path: Option<PathBuf>) -> Option<PathBuf> {
    path.filter(|path| !path.as_os_str().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestDirectory;

    fn environment(directory: &TestDirectory) -> ProviderEnvironment {
        let home = directory.path.join("home");
        let cwd = directory.path.join("cwd");
        fs::create_dir(&home).unwrap();
        fs::create_dir(&cwd).unwrap();
        ProviderEnvironment::from_parts(home, cwd, Vec::new(), None, None, None, None)
    }

    #[test]
    fn target_paths_match_the_canonical_provider_locations() {
        let directory = TestDirectory::new();
        let environment = environment(&directory);
        let home = directory.path.join("home");
        let expected = [
            (Provider::Claude, home.join(".claude/skills/tmux-team")),
            (Provider::Codex, home.join(".agents/skills/tmux-team")),
            (Provider::Gemini, home.join(".agents/skills/tmux-team")),
            (Provider::Agy, home.join(".gemini/config/skills/tmux-team")),
            (Provider::Pi, home.join(".pi/agent/skills/tmux-team")),
            (Provider::Opencode, home.join(".agents/skills/tmux-team")),
        ];
        for (provider, target) in expected {
            assert_eq!(environment.target(provider), target, "{provider:?}");
        }
        assert_eq!(
            environment.universal_target(),
            home.join(".agents/skills/tmux-team")
        );
        assert_eq!(
            environment.custom_target("custom skills"),
            directory.path.join("cwd/custom skills/tmux-team")
        );
    }

    #[test]
    fn pi_directory_expands_home_forms_and_relative_overrides_from_cwd() {
        let directory = TestDirectory::new();
        let base = environment(&directory);
        let home = directory.path.join("home");
        let cwd = directory.path.join("cwd");
        for (configured, expected) in [
            (PathBuf::from("~"), home.join("skills/tmux-team")),
            (
                PathBuf::from("~/custom-pi"),
                home.join("custom-pi/skills/tmux-team"),
            ),
            (
                PathBuf::from("relative-pi"),
                cwd.join("relative-pi/skills/tmux-team"),
            ),
        ] {
            let environment = ProviderEnvironment::from_parts(
                &home,
                &cwd,
                Vec::new(),
                None,
                Some(configured),
                None,
                None,
            );
            assert_eq!(environment.target(Provider::Pi), expected);
        }
        assert_eq!(
            base.target(Provider::Pi),
            home.join(".pi/agent/skills/tmux-team")
        );
    }

    #[test]
    fn legacy_targets_preserve_claude_and_codex_migration_candidates() {
        let directory = TestDirectory::new();
        let home = directory.path.join("home");
        let cwd = directory.path.join("cwd");
        fs::create_dir(&home).unwrap();
        fs::create_dir(&cwd).unwrap();
        let codex_home = home.join("custom-codex");
        let environment = ProviderEnvironment::from_parts(
            &home,
            &cwd,
            Vec::new(),
            Some(codex_home.clone()),
            None,
            None,
            None,
        );
        assert_eq!(
            environment.legacy_targets(Provider::Claude),
            vec![home.join(".claude/commands/team.md")]
        );
        assert_eq!(
            environment.legacy_targets(Provider::Codex),
            vec![
                codex_home.join("skills/tmux-team"),
                home.join(".codex/skills/tmux-team"),
            ]
        );

        let shared = ProviderEnvironment::from_parts(
            &home,
            &cwd,
            Vec::new(),
            Some(home.join(".agents")),
            None,
            None,
            None,
        );
        assert_eq!(
            shared.legacy_targets(Provider::Codex),
            vec![home.join(".codex/skills/tmux-team")]
        );
    }

    #[test]
    fn detection_is_ordered_and_shared_agents_state_is_neutral() {
        let directory = TestDirectory::new();
        let environment = environment(&directory);
        let home = directory.path.join("home");
        fs::create_dir(home.join(".agents")).unwrap();
        assert!(environment.detect().is_empty());

        fs::create_dir(home.join(".claude")).unwrap();
        fs::create_dir(home.join(".codex")).unwrap();
        fs::create_dir(home.join(".gemini")).unwrap();
        fs::create_dir_all(home.join(".gemini/config")).unwrap();
        fs::create_dir_all(home.join(".pi/agent")).unwrap();
        fs::create_dir_all(home.join(".config/opencode")).unwrap();
        assert_eq!(
            environment.detect(),
            vec![
                Provider::Claude,
                Provider::Codex,
                Provider::Gemini,
                Provider::Agy,
                Provider::Pi,
                Provider::Opencode,
            ]
        );
    }

    #[test]
    fn detection_supports_executables_and_provider_directory_overrides() {
        let directory = TestDirectory::new();
        let home = directory.path.join("home");
        let cwd = directory.path.join("cwd");
        let bin = directory.path.join("bin");
        fs::create_dir(&home).unwrap();
        fs::create_dir(&cwd).unwrap();
        fs::create_dir(&bin).unwrap();
        fs::write(bin.join("opencode"), b"regular executable marker").unwrap();
        let executable =
            ProviderEnvironment::from_parts(&home, &cwd, vec![bin.clone()], None, None, None, None);
        assert_eq!(executable.detect(), vec![Provider::Opencode]);

        let pi_root = directory.path.join("pi-override");
        let pi = ProviderEnvironment::from_parts(
            &home,
            &cwd,
            Vec::new(),
            None,
            Some(pi_root.clone()),
            None,
            None,
        );
        fs::create_dir(&pi_root).unwrap();
        assert_eq!(pi.detect(), vec![Provider::Pi]);
        assert_eq!(pi.target(Provider::Pi), pi_root.join("skills/tmux-team"));

        let opencode_root = directory.path.join("opencode-override");
        let opencode = ProviderEnvironment::from_parts(
            &home,
            &cwd,
            Vec::new(),
            None,
            None,
            Some(opencode_root.clone()),
            None,
        );
        fs::create_dir(&opencode_root).unwrap();
        assert_eq!(opencode.detect(), vec![Provider::Opencode]);

        let xdg_root = directory.path.join("xdg");
        fs::create_dir_all(xdg_root.join("opencode")).unwrap();
        let xdg = ProviderEnvironment::from_parts(
            &home,
            &cwd,
            Vec::new(),
            None,
            None,
            None,
            Some(xdg_root),
        );
        assert_eq!(xdg.detect(), vec![Provider::Opencode]);
    }

    #[test]
    fn codex_home_under_shared_agents_does_not_create_codex_detection() {
        let directory = TestDirectory::new();
        let home = directory.path.join("home");
        let cwd = directory.path.join("cwd");
        fs::create_dir(&home).unwrap();
        fs::create_dir(&cwd).unwrap();
        let shared = home.join(".agents");
        fs::create_dir(&shared).unwrap();
        let environment = ProviderEnvironment::from_parts(
            &home,
            &cwd,
            Vec::new(),
            Some(shared),
            None,
            None,
            None,
        );
        assert!(environment.detect().is_empty());
    }
}

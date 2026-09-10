//! Fixed artifact identities for the CLI and its optional Office companion.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Product {
    Cli,
    Office,
}

impl Product {
    pub const fn tag_prefix(self) -> &'static str {
        match self {
            Self::Cli => "v",
            Self::Office => "tmt-office-v",
        }
    }
    pub const ALL: [Self; 2] = [Self::Cli, Self::Office];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Cli => "cli",
            Self::Office => "office",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|product| product.as_str() == value)
    }

    pub const fn executable(self) -> &'static str {
        match self {
            Self::Cli => "tmt",
            Self::Office => "tmt-office",
        }
    }

    pub const fn package(self) -> &'static str {
        match self {
            Self::Cli => "tmt-cli",
            Self::Office => "tmt-office",
        }
    }

    pub const fn namespace(self) -> &'static str {
        match self {
            Self::Cli => "lib/tmux-team",
            Self::Office => "lib/tmt-office",
        }
    }

    pub const fn links(self) -> &'static [&'static str] {
        match self {
            Self::Cli => &["tmt", "tmux-team"],
            Self::Office => &["tmt-office"],
        }
    }

    pub fn link_target(self) -> String {
        format!("../{}/current/{}", self.namespace(), self.executable())
    }

    pub const fn files(self) -> [&'static str; 4] {
        [
            self.executable(),
            "LICENSE",
            "NATIVE-INSTALL.md",
            "THIRD-PARTY-NOTICES.txt",
        ]
    }
}

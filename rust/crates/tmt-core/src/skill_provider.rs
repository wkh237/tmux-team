//! Supported agent providers for the native installer boundary.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Provider {
    Claude,
    Codex,
    Gemini,
    Agy,
    Pi,
    Opencode,
}

impl Provider {
    /// Stable provider order used by detection and `install all`.
    pub const ALL: [Self; 6] = [
        Self::Claude,
        Self::Codex,
        Self::Gemini,
        Self::Agy,
        Self::Pi,
        Self::Opencode,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Gemini => "gemini",
            Self::Agy => "agy",
            Self::Pi => "pi",
            Self::Opencode => "opencode",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|provider| provider.as_str().eq_ignore_ascii_case(value))
    }
}

#[cfg(test)]
mod tests {
    use super::Provider;

    #[test]
    fn all_has_stable_install_order_and_names() {
        assert_eq!(
            Provider::ALL.map(Provider::as_str),
            ["claude", "codex", "gemini", "agy", "pi", "opencode"]
        );
    }

    #[test]
    fn parse_is_case_insensitive_and_rejects_unknown_values() {
        for (value, expected) in [
            ("claude", Provider::Claude),
            ("CODEX", Provider::Codex),
            ("GeMiNi", Provider::Gemini),
            ("agy", Provider::Agy),
            ("PI", Provider::Pi),
            ("OpenCode", Provider::Opencode),
        ] {
            assert_eq!(Provider::parse(value), Some(expected));
        }
        assert_eq!(Provider::parse(""), None);
        assert_eq!(Provider::parse("all"), None);
        assert_eq!(Provider::parse("unknown"), None);
    }
}

//! Configuration filesystem boundary. One raw-document implementation preserves
//! opaque user fields while shared core policy validates every known setting.

mod document;
mod paths;

pub use paths::ConfigPaths;
use std::{fmt, path::Path};
pub use tmt_core::settings::Scope;
use tmt_core::settings::{LocalClear, ResolvedSettings, Setting};

#[derive(Debug)]
pub struct ConfigError {
    pub code: &'static str,
    pub message: String,
}

impl ConfigError {
    fn internal(message: impl Into<String>) -> Self {
        Self {
            code: "INTERNAL_ERROR",
            message: message.into(),
        }
    }

    fn validation(path: &Path, field: &str, expected: &str) -> Self {
        Self {
            code: "CONFIG_ERROR",
            message: format!(
                "Invalid configuration in {} ({field}): must be {expected}.",
                path.display()
            ),
        }
    }

    fn parse(path: &Path, cause: impl fmt::Display) -> Self {
        Self {
            code: "CONFIG_ERROR",
            message: format!("Invalid JSON in {}: {cause}", path.display()),
        }
    }
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ConfigError {}

pub struct ConfigFiles {
    pub paths: ConfigPaths,
}

impl ConfigFiles {
    pub fn load(&self) -> Result<ResolvedSettings, ConfigError> {
        let read_layer = |scope| {
            let path = self.path(scope);
            let document = document::read(path, scope)?;
            document::project(&document, path, scope)
        };
        Ok(ResolvedSettings::from_layers(
            read_layer(Scope::Global)?,
            read_layer(Scope::Local)?,
        ))
    }

    pub fn set(&self, setting: Setting, scope: Scope) -> Result<(), ConfigError> {
        let path = self.path(scope);
        let mut value = document::read(path, scope)?;
        document::set(&mut value, setting, scope)?;
        document::write(path, &value, scope)
    }

    pub fn clear_local(&self, clear: LocalClear) -> Result<(), ConfigError> {
        let path = self.path(Scope::Local);
        let mut value = document::read(path, Scope::Local)?;
        if document::clear(&mut value, clear.key()) {
            document::write(path, &value, Scope::Local)?;
        }
        Ok(())
    }

    fn path(&self, scope: Scope) -> &Path {
        match scope {
            Scope::Global => &self.paths.global_config,
            Scope::Local => &self.paths.local_config,
        }
    }
}

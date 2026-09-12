//! Shared native-domain contracts for tmux-team.

pub mod binding;
pub mod endpoint;
pub mod exact_text;
pub mod identity;
pub mod identity_hooks;
pub mod limits;
pub mod names;
pub mod native_install;
pub mod office_protocol;
pub mod profile;
pub mod request;
pub mod retention;
pub mod settings;
pub mod skill_provider;

#[cfg(test)]
mod identity_tests;
#[cfg(test)]
mod settings_tests;

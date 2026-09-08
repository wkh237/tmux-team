//! Shared native-domain contracts for tmux-team.

pub mod binding;
pub mod endpoint;
pub mod exact_text;
pub mod identity;
pub mod limits;
pub mod names;
pub mod request;
pub mod retention;
pub mod settings;

#[cfg(test)]
mod identity_tests;
#[cfg(test)]
mod settings_tests;

//! Shared native-domain contracts for tmux-team.

pub mod endpoint;
pub mod identity;
pub mod limits;
pub mod names;
pub mod settings;

#[cfg(test)]
mod identity_tests;
#[cfg(test)]
mod settings_tests;

//! Concrete native adapters. Application policy must not depend on this crate.

pub mod config;
mod json_document;
#[cfg(unix)]
pub mod process;
pub mod reply_receipt;
#[cfg(unix)]
pub mod response_input;
pub mod storage;
#[cfg(unix)]
pub mod tmux;

#[cfg(test)]
mod test_support;

#[cfg(all(test, unix))]
mod process_tests;

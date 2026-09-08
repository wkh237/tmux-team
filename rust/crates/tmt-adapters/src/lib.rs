//! Concrete native adapters. Application policy must not depend on this crate.

#[cfg(unix)]
pub mod bounded_file;
pub mod config;
#[cfg(unix)]
pub mod interrupt;
mod json_document;
#[cfg(unix)]
pub mod process;
pub mod reply_receipt;
pub mod request_runtime;
#[cfg(unix)]
pub mod response_input;
pub mod storage;
#[cfg(unix)]
pub mod tmux;

#[cfg(test)]
mod test_support;

#[cfg(all(test, unix))]
mod process_tests;

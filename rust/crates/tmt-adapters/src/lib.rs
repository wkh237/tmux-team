//! Concrete native adapters. Application policy must not depend on this crate.

#[cfg(unix)]
pub mod bounded_file;
pub mod config;
mod content_digest;
#[cfg(unix)]
mod file_lock;
#[cfg(unix)]
pub mod interrupt;
mod json_document;
#[cfg(unix)]
pub mod native_install;
#[cfg(unix)]
pub mod office_companion;
#[cfg(feature = "office")]
pub mod office_deployment;
#[cfg(feature = "office")]
mod office_http;
#[cfg(feature = "office")]
pub mod office_pairing;
#[cfg(unix)]
pub mod process;
#[cfg(unix)]
mod release_http;
pub mod reply_receipt;
pub mod request_runtime;
#[cfg(unix)]
pub mod response_input;
#[cfg(unix)]
pub mod skill_installation;
pub mod storage;
#[cfg(unix)]
pub mod tmux;

#[cfg(test)]
mod test_support;

#[cfg(all(test, unix))]
mod process_tests;

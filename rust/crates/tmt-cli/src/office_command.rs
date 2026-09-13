//! Optional Office composition; no application database, implicit service or PATH dispatch.

use crate::{
    invocation::{OfficeOperation, OutputMode},
    output::Failure,
};
use serde_json::json;
use std::{
    fs,
    io::{self, BufRead, IsTerminal, Read, Write},
    path::{Path, PathBuf},
};
use tmt_adapters::{
    native_install::{self, InstallRequest, Product, UpgradeRequest},
    office_companion::probe_office_companion,
};
use tmt_core::native_install::{Channel, PinAction};

const INSTALL_HINT: &str = "Install Office with: tmt office install --yes";

fn consent(yes: bool, mode: OutputMode, action: &str) -> Result<bool, Failure> {
    if yes {
        return Ok(true);
    }
    if mode.json || !io::stdin().is_terminal() || !io::stderr().is_terminal() {
        return Err(Failure::new(
            "OFFICE_CONSENT_REQUIRED",
            format!("{action} requires explicit --yes; no changes were made."),
            1,
        ));
    }
    let mut stderr = io::stderr().lock();
    write!(stderr, "{action}? [y/N] ")
        .and_then(|()| stderr.flush())
        .map_err(|e| failure("OFFICE_IO_ERROR", e))?;
    let mut answer = Vec::new();
    io::stdin()
        .lock()
        .take(256)
        .read_until(b'\n', &mut answer)
        .map_err(|e| failure("OFFICE_IO_ERROR", e))?;
    Ok(matches!(
        std::str::from_utf8(&answer)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "y" | "yes"
    ))
}

fn failure(code: &'static str, error: impl std::error::Error + 'static) -> Failure {
    Failure::new(code, error.to_string(), 1).caused_by(error)
}

fn report(value: serde_json::Value, human: &str, mode: OutputMode) -> io::Result<u8> {
    writeln!(
        io::stdout().lock(),
        "{}",
        if mode.json {
            value.to_string()
        } else {
            human.into()
        }
    )?;
    Ok(0)
}

fn installed(executable: &Path) -> Result<bool, Failure> {
    match fs::symlink_metadata(executable) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            // A missing command link is recoverable partial removal, not proof
            // that the owned activation disappeared.
            let prefix = executable
                .parent()
                .and_then(Path::parent)
                .expect("Office command prefix");
            match fs::symlink_metadata(prefix.join(Product::Office.namespace()).join("current")) {
                Ok(_) => Err(Failure::new(
                    "OFFICE_INSTALLATION_INVALID",
                    "Office has an activation but no command link. Finish removal with office uninstall --yes, then reinstall.",
                    1,
                )),
                Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
                Err(e) => Err(failure("OFFICE_INSTALLATION_INVALID", e)),
            }
        }
        Err(e) => Err(failure("OFFICE_INSTALLATION_INVALID", e)),
    }
}

fn install(
    prefix: &Path,
    archive: Option<&str>,
    manifest: Option<&str>,
    channel: Channel,
) -> Result<native_install::InstallReport, Failure> {
    let interrupt = tmt_adapters::interrupt::Interrupt::install()
        .map_err(|e| failure("OFFICE_INSTALL_FAILED", e))?;
    let checkpoint = || {
        if interrupt.is_interrupted() {
            Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "Office installation interrupted. Inspect office status before retrying.",
            ))
        } else {
            Ok(())
        }
    };
    let target =
        tmt_core::native_install::native_target(std::env::consts::OS, std::env::consts::ARCH)
            .ok_or_else(|| {
                Failure::new(
                    "OFFICE_UNSUPPORTED",
                    "No Office artifact supports this platform.",
                    1,
                )
            })?;
    let result = match (archive, manifest) {
        (Some(archive), Some(manifest)) => native_install::install_product(
            Product::Office,
            InstallRequest {
                archive: Path::new(archive),
                manifest: Path::new(manifest),
                prefix,
                target,
                channel,
                pin: PinAction::Preserve,
            },
            checkpoint,
        ),
        (None, None) => {
            let executable = prefix.join("bin/tmt-office");
            if installed(&executable)? {
                native_install::upgrade_product(
                    Product::Office,
                    UpgradeRequest {
                        executable: &executable,
                        channel: Some(channel),
                        exact: None,
                        unpin: false,
                    },
                    checkpoint,
                )
                .map(|report| report.installation)
                .map_err(|error| io::Error::new(error.kind(), error))
            } else {
                native_install::install_release(
                    Product::Office,
                    prefix,
                    target,
                    channel,
                    checkpoint,
                )
            }
        }
        _ => {
            return Err(Failure::new(
                "USAGE_ERROR",
                "Archive and manifest must be supplied together.",
                1,
            ));
        }
    };
    result.map_err(|e| {
        Failure::new(
            if archive.is_none() && e.kind() == io::ErrorKind::NotFound {
                "OFFICE_RELEASE_UNAVAILABLE"
            } else {
                "OFFICE_INSTALL_FAILED"
            },
            format!("{e} Inspect office status before retrying."),
            if e.kind() == io::ErrorKind::Interrupted {
                130
            } else {
                1
            },
        )
        .caused_by(e)
    })
}

pub fn execute(
    prefix: Option<String>,
    operation: OfficeOperation,
    mode: OutputMode,
) -> io::Result<u8> {
    match run(prefix, operation, mode) {
        Ok(code) => Ok(code),
        Err(error) => error.publish(mode),
    }
}

fn run(
    prefix: Option<String>,
    operation: OfficeOperation,
    mode: OutputMode,
) -> Result<u8, Failure> {
    let prefix = prefix
        .map(PathBuf::from)
        .map_or_else(native_install::default_install_prefix, Ok)
        .map_err(|e| failure("OFFICE_LOCATION_INVALID", e))?;
    if prefix.as_os_str().is_empty() {
        return Err(Failure::new(
            "OFFICE_LOCATION_INVALID",
            "Installation prefix must not be empty.",
            1,
        ));
    }
    let executable = prefix.join("bin/tmt-office");
    match operation {
        OfficeOperation::Pair { .. }
        | OfficeOperation::PairStatus { .. }
        | OfficeOperation::Unpair { .. }
        | OfficeOperation::Inspect { .. }
        | OfficeOperation::Sync => {
            if !installed(&executable)? {
                return Err(Failure::new("OFFICE_NOT_INSTALLED", INSTALL_HINT, 1));
            }
            crate::office_pairing_command::run(&executable, operation, mode)
        }
        OfficeOperation::Status | OfficeOperation::Open => {
            if !installed(&executable)? {
                if matches!(operation, OfficeOperation::Status)
                    || mode.json
                    || !io::stdin().is_terminal()
                    || !io::stderr().is_terminal()
                {
                    return Err(Failure::new("OFFICE_NOT_INSTALLED", INSTALL_HINT, 1));
                }
                if !consent(
                    false,
                    mode,
                    "Install the verified optional Office companion",
                )? {
                    return Ok(0);
                }
                install(&prefix, None, None, Channel::Alpha)?;
            }
            let interrupt = tmt_adapters::interrupt::Interrupt::install()
                .map_err(|e| failure("OFFICE_IO_ERROR", e))?;
            let result = probe_office_companion(&executable);
            if interrupt.is_interrupted() {
                return Err(Failure::new(
                    "OFFICE_INTERRUPTED",
                    "Office inspection interrupted; no connection was started.",
                    130,
                ));
            }
            let version = result.map_err(|e| failure("OFFICE_INCOMPATIBLE", e))?;
            if matches!(operation, OfficeOperation::Open) {
                return Err(Failure::new(
                    "OFFICE_NOT_PAIRED",
                    "Office is installed. World pairing and opening are not available in this build.",
                    1,
                ));
            }
            report(json!({"installed": true, "version": version, "protocolVersion": tmt_core::office_protocol::OFFICE_PROTOCOL_VERSION, "executable": executable}), &format!("Office {version} is installed and compatible. No connection was started."), mode).map_err(|e| failure("OFFICE_IO_ERROR", e))
        }
        OfficeOperation::Install {
            yes,
            archive,
            manifest,
            channel,
        } => {
            if !consent(yes, mode, "Install the verified optional Office companion")? {
                return Ok(0);
            }
            let current = if installed(&executable)? {
                Some(
                    native_install::inspect_product(Product::Office, &executable)
                        .map_err(|e| failure("OFFICE_INSTALLATION_INVALID", e))?,
                )
            } else {
                None
            };
            let channel = channel
                .or_else(|| current.as_ref().map(|current| current.state.channel))
                .unwrap_or(Channel::Alpha);
            let result = install(&prefix, archive.as_deref(), manifest.as_deref(), channel)?;
            report(json!({"installed":true,"changed":result.changed,"version":result.version,"executable":result.executable}), &format!("Office {} installed. Pairing is separate.", result.version), mode).map_err(|e| failure("OFFICE_IO_ERROR", e))
        }
        OfficeOperation::Upgrade { channel } => {
            if !installed(&executable)? {
                return Err(Failure::new("OFFICE_NOT_INSTALLED", INSTALL_HINT, 1));
            }
            let interrupt = tmt_adapters::interrupt::Interrupt::install()
                .map_err(|e| failure("OFFICE_UPGRADE_FAILED", e))?;
            let result = native_install::upgrade_product(
                Product::Office,
                UpgradeRequest {
                    executable: &executable,
                    channel,
                    exact: None,
                    unpin: false,
                },
                || {
                    if interrupt.is_interrupted() {
                        Err(io::Error::new(
                            io::ErrorKind::Interrupted,
                            "Office update interrupted.",
                        ))
                    } else {
                        Ok(())
                    }
                },
            )
            .map_err(|e| {
                Failure::new(
                    "OFFICE_UPGRADE_FAILED",
                    format!("{e} Inspect office status before retrying."),
                    if e.kind() == io::ErrorKind::Interrupted {
                        130
                    } else {
                        1
                    },
                )
                .caused_by(e)
            })?;
            report(json!({"installed":true,"changed":result.installation.changed,"version":result.installation.version,"skippedPinned":result.skipped_pinned}), &format!("Office {} is current.", result.installation.version), mode).map_err(|e| failure("OFFICE_IO_ERROR", e))
        }
        OfficeOperation::Uninstall { yes } => {
            if !consent(
                yes,
                mode,
                "Deactivate Office (retained releases and user data will be kept)",
            )? {
                return Ok(0);
            }
            let changed = native_install::uninstall_office(&prefix)
                .map_err(|e| failure("OFFICE_UNINSTALL_FAILED", e))?;
            report(
                json!({"installed":false,"changed":changed,"retainedReleases":true}),
                "Office is deactivated. Release bytes and user data were retained.",
                mode,
            )
            .map_err(|e| failure("OFFICE_IO_ERROR", e))
        }
    }
}

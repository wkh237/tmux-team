//! Hostile protocol fixtures exercise the managed execution boundary, not release artifacts.

use super::{install_fixture, office_fixture_with_payload};
use crate::{native_install::Product, office_companion::probe_office_companion};
use std::fs;

#[test]
fn verified_probe_uses_the_installed_executable_and_preserves_its_receipt() {
    let fixture = office_fixture_with_payload(b"#!/bin/sh\nprintf 'TMT-OFFICE/1\\n1.2.3\\n'\n");
    let prefix = fixture.directory.path.join("prefix");
    let report = install_fixture(&fixture, &prefix, Product::Office).unwrap();
    let receipt = report
        .active_executable
        .parent()
        .unwrap()
        .join("receipt.json");
    let before = fs::read(&receipt).unwrap();
    assert_eq!(probe_office_companion(&report.executable).unwrap(), "1.2.3");
    assert_eq!(fs::read(receipt).unwrap(), before);
}

#[test]
fn incompatible_noisy_and_nonzero_companions_are_not_successful_handshakes() {
    for (payload, expected) in [
        (
            b"#!/bin/sh\nprintf 'TMT-OFFICE/2\\n1.2.3\\n'\n".as_slice(),
            "Incompatible Office handshake.",
        ),
        (
            b"#!/bin/sh\nprintf 'TMT-OFFICE/1\\n9.0.0\\n'\n",
            "Office executable and installation versions disagree.",
        ),
        (
            b"#!/bin/sh\nprintf 'TMT-OFFICE/1\\n1.2.3\\n'; printf 'warning' >&2\n",
            "Office handshake produced unexpected diagnostics.",
        ),
        (
            b"#!/bin/sh\nprintf 'TMT-OFFICE/1\\n1.2.3\\n'; exit 1\n",
            "External command failed: Exit",
        ),
    ] {
        let fixture = office_fixture_with_payload(payload);
        let prefix = fixture.directory.path.join("prefix");
        let error = install_fixture(&fixture, &prefix, Product::Office).unwrap_err();
        assert!(error.to_string().starts_with(expected), "{error}");
        assert!(!prefix.join("lib/tmt-office/current").exists());
        assert_eq!(
            fs::read_dir(prefix.join("lib/tmt-office/releases"))
                .unwrap()
                .count(),
            0
        );
    }
}

#[test]
fn changed_payload_is_rejected_before_executing_it() {
    let fixture = office_fixture_with_payload(b"#!/bin/sh\nprintf 'TMT-OFFICE/1\\n1.2.3\\n'\n");
    let report = install_fixture(
        &fixture,
        &fixture.directory.path.join("prefix"),
        Product::Office,
    )
    .unwrap();
    // If executed, this replacement would produce a distinct protocol failure.
    fs::write(&report.active_executable, b"#!/bin/sh\nprintf 'tampered'\n").unwrap();
    let error = probe_office_companion(&report.executable).unwrap_err();
    assert_eq!(
        error.to_string(),
        "Installed release file has changed; refusing replacement."
    );
}

#[test]
fn incompatible_upgrade_preserves_the_previous_working_release() {
    let good = super::office_fixture();
    let prefix = good.directory.path.join("prefix");
    let previous = install_fixture(&good, &prefix, Product::Office).unwrap();
    let before = fs::read(&previous.active_executable).unwrap();
    let pointer = fs::read_link(prefix.join("lib/tmt-office/current")).unwrap();
    let bad = office_fixture_with_payload(b"#!/bin/sh\nprintf 'TMT-OFFICE/2\\n1.2.4\\n'\n");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&bad.manifest).unwrap()).unwrap();
    manifest["releases"][0]["app_version"] = serde_json::json!("1.2.4");
    fs::write(&bad.manifest, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let error = install_fixture(&bad, &prefix, Product::Office).unwrap_err();
    assert_eq!(error.to_string(), "Incompatible Office handshake.");
    assert_eq!(
        fs::read_link(prefix.join("lib/tmt-office/current")).unwrap(),
        pointer
    );
    assert_eq!(fs::read(&previous.active_executable).unwrap(), before);
    assert_eq!(
        probe_office_companion(&previous.executable).unwrap(),
        "1.2.3"
    );
    assert_eq!(
        fs::read_dir(prefix.join("lib/tmt-office/releases"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn uninstall_preserves_unmanaged_links_and_tampered_releases() {
    use std::os::unix::fs::symlink;
    let fixture = super::office_fixture();
    let prefix = fixture.directory.path.join("prefix");
    let report = install_fixture(&fixture, &prefix, Product::Office).unwrap();
    let original_link = fs::read_link(&report.executable).unwrap();
    let pointer = fs::read_link(prefix.join("lib/tmt-office/current")).unwrap();
    let user_file = fixture.directory.path.join("user-command");
    fs::write(&user_file, b"user content").unwrap();
    fs::remove_file(&report.executable).unwrap();
    symlink(&user_file, &report.executable).unwrap();
    assert!(crate::native_install::uninstall_office(&prefix).is_err());
    assert_eq!(fs::read_link(&report.executable).unwrap(), user_file);
    assert_eq!(fs::read(&user_file).unwrap(), b"user content");
    assert_eq!(
        fs::read_link(prefix.join("lib/tmt-office/current")).unwrap(),
        pointer
    );
    fs::remove_file(&report.executable).unwrap();
    symlink(&original_link, &report.executable).unwrap();
    fs::write(&report.active_executable, b"user edited executable").unwrap();
    let error = crate::native_install::uninstall_office(&prefix).unwrap_err();
    assert_eq!(
        error.to_string(),
        "Installed release file has changed; refusing replacement."
    );
    assert_eq!(fs::read_link(&report.executable).unwrap(), original_link);
    assert_eq!(
        fs::read(&report.active_executable).unwrap(),
        b"user edited executable"
    );
}

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
    for payload in [
        b"#!/bin/sh\nprintf 'TMT-OFFICE/2\\n1.2.3\\n'\n".as_slice(),
        b"#!/bin/sh\nprintf 'TMT-OFFICE/1\\n9.0.0\\n'\n",
        b"#!/bin/sh\nprintf 'TMT-OFFICE/1\\n1.2.3\\n'; printf 'warning' >&2\n",
        b"#!/bin/sh\nprintf 'TMT-OFFICE/1\\n1.2.3\\n'; exit 1\n",
    ] {
        let fixture = office_fixture_with_payload(payload);
        let report = install_fixture(
            &fixture,
            &fixture.directory.path.join("prefix"),
            Product::Office,
        )
        .unwrap();
        assert!(probe_office_companion(&report.executable).is_err());
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

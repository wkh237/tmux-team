//! Deactivate only verified Office links; retained releases and app data are untouched.

use super::{Product, invalid, publication::Layout};
use std::{fs, io, path::Path};

pub fn uninstall_office(prefix: &Path) -> io::Result<bool> {
    let root = prefix.join(Product::Office.namespace());
    match fs::symlink_metadata(&root) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return match fs::symlink_metadata(prefix.join("bin/tmt-office")) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
                Err(error) => Err(error),
                Ok(_) => Err(invalid("Unmanaged Office command; refusing removal.")),
            };
        }
        Err(error) => return Err(error),
        Ok(_) => {}
    }
    let layout = Layout::existing_product(prefix, Product::Office)?;
    let _lock = crate::file_lock::exclusive(&layout.root.join("install.lock"))?;
    let current = layout.current()?;
    layout.check_links(current.is_some())?;
    if current.is_none() {
        return Ok(false);
    }
    for name in Product::Office.links() {
        match fs::remove_file(layout.prefix.join("bin").join(name)) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            result => result?,
        }
    }
    fs::File::open(layout.prefix.join("bin"))?.sync_all()?;
    fs::remove_file(layout.root.join("current"))?;
    fs::File::open(&layout.root)?.sync_all()?;
    Ok(true)
}

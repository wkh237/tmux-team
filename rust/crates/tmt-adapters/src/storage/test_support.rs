//! Bounded SQLite race fixtures shared across storage service tests.

use super::Storage;
use std::{path::Path, sync::mpsc, thread, time::Duration};

pub(super) type Operation<T> = Box<dyn FnOnce(&mut Storage) -> T + Send>;

/// Open before racing: this targets request transactions, not cold-WAL startup.
/// Scoped workers finish before fixture deletion; channel waits are bounded.
pub(super) fn concurrent_pair<T: Send>(database: &Path, operations: [Operation<T>; 2]) -> [T; 2] {
    let connections = [
        Storage::open(database).unwrap(),
        Storage::open(database).unwrap(),
    ];
    thread::scope(|scope| {
        let mut starts = Vec::new();
        let mut results = Vec::new();
        let mut handles = Vec::new();
        for (mut storage, operation) in connections.into_iter().zip(operations) {
            let (start_tx, start_rx) = mpsc::sync_channel(1);
            let (result_tx, result_rx) = mpsc::sync_channel(1);
            starts.push(start_tx);
            results.push(result_rx);
            handles.push(scope.spawn(move || {
                start_rx
                    .recv_timeout(Duration::from_secs(10))
                    .expect("request worker start");
                let result = operation(&mut storage);
                storage.close().expect("close request worker storage");
                assert!(
                    result_tx.send(result).is_ok(),
                    "request worker receiver disappeared"
                );
            }));
        }
        for start in starts {
            start.send(()).unwrap();
        }
        let values: Vec<T> = results
            .into_iter()
            .map(|result| {
                result
                    .recv_timeout(Duration::from_secs(15))
                    .expect("bounded request worker result")
            })
            .collect();
        for handle in handles {
            handle.join().expect("request worker panicked");
        }
        values.try_into().ok().expect("exactly two worker results")
    })
}

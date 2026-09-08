//! Version-2 correlation preimage. Field order and lengths are wire protocol.
//! This unkeyed digest is not authentication and cannot add entropy to weak IDs.

use super::RequestEndpoint;
use sha2::{Digest, Sha256};

pub fn response_token(request_id: &str, attempt_id: &str, endpoint: &RequestEndpoint) -> [u8; 16] {
    let mut digest = Sha256::new();
    digest.update(b"tmux-team/reply-receipt/v2\0");
    append_string(&mut digest, request_id);
    append_string(&mut digest, attempt_id);
    append_string(&mut digest, &endpoint.server.server_id);
    append_string(&mut digest, &endpoint.server.socket_path);
    digest.update(endpoint.server.server_pid.to_be_bytes());
    append_string(&mut digest, &endpoint.server.server_start_time);
    append_string(&mut digest, &endpoint.pane_id);
    digest.update(endpoint.pane_pid.to_be_bytes());
    let hash = digest.finalize();
    let mut token = [0; 16];
    token.copy_from_slice(&hash[..16]);
    token
}

fn append_string(digest: &mut Sha256, value: &str) {
    digest.update((value.len() as u64).to_be_bytes());
    digest.update(value.as_bytes());
}

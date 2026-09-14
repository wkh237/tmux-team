use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    io::{self, Read, Write},
    net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream},
    process::ExitCode,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tmt_adapters::{
    config::ConfigPaths,
    office_local::local_snapshot,
    office_profile::{
        mutation_value as local_profile_mutation, snapshot_value as local_profile_snapshot,
    },
    office_profile_wire,
    office_prop::{PACK_INPUT_LIMIT, ValidatedPropPack, validate_pack},
    office_service::{self, ServiceReceipt},
    storage::{LocalOfficeError, LocalProfileError, Storage},
    tmux::{BindingSession, CallerEnvironment, Tmux},
};
use tmt_core::binding::{self, Presence};
use tmt_core::office_protocol::OfficeInvocation;

use crate::local_assets;

const HEADER_LIMIT: usize = 16 * 1024;
const BODY_LIMIT: usize = 64 * 1024;
const PREVIEW_LIMIT: usize = 4;
const PREVIEW_LIFETIME: Duration = Duration::from_secs(5 * 60);
const MAX_CONNECTIONS: usize = 16;
const REQUEST_DEADLINE: Duration = Duration::from_secs(3);
const RESPONSE_DEADLINE: Duration = Duration::from_secs(15);

enum ServeError {
    PortUnavailable(io::Error),
    Other(io::Error),
}

impl From<io::Error> for ServeError {
    fn from(error: io::Error) -> Self {
        Self::Other(error)
    }
}

struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

struct ActiveConnection(Arc<AtomicUsize>);

struct PreviewEntry {
    pack: ValidatedPropPack,
    expires: Instant,
    expires_at_ms: u64,
}

type Previews = Arc<Mutex<HashMap<String, PreviewEntry>>>;

impl Drop for ActiveConnection {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        let mut values = self
            .headers
            .iter()
            .filter(|(key, _)| key.eq_ignore_ascii_case(name));
        let value = values.next()?.1.as_str();
        values.next().is_none().then_some(value)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApplyInput {
    expected_revision: u64,
    layout: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApplyProfileInput {
    expected_revision: u64,
    profile: Value,
}

pub fn run() -> ExitCode {
    match serve() {
        Ok(()) => ExitCode::SUCCESS,
        Err(ServeError::PortUnavailable(error)) => {
            let mut stdout = io::stdout().lock();
            let _ = writeln!(stdout, "TMT-OFFICE-SERVICE/1 PORT-UNAVAILABLE");
            let _ = stdout.flush();
            let _ = writeln!(io::stderr().lock(), "Local Office service failed: {error}");
            ExitCode::FAILURE
        }
        Err(ServeError::Other(error)) => {
            let _ = writeln!(io::stderr().lock(), "Local Office service failed: {error}");
            ExitCode::FAILURE
        }
    }
}

fn serve() -> Result<(), ServeError> {
    let paths = ConfigPaths::discover().map_err(io::Error::other)?;
    let _service_lock = office_service::service_lock(&paths)?;
    let requested = std::env::var("TMT_OFFICE_SERVICE_PORT")
        .map_err(io::Error::other)?
        .parse::<u16>()
        .map_err(io::Error::other)?;
    let listener =
        TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, requested)).map_err(|error| {
            if matches!(
                error.kind(),
                io::ErrorKind::AddrInUse | io::ErrorKind::PermissionDenied
            ) {
                ServeError::PortUnavailable(error)
            } else {
                ServeError::Other(error)
            }
        })?;
    let port = listener.local_addr()?.port();
    let receipt = ServiceReceipt {
        schema_version: 1,
        pid: std::process::id(),
        port,
        nonce: secret()?,
        browser_token: secret()?,
        control_token: secret()?,
        running_version: env!("CARGO_PKG_VERSION").to_owned(),
    };
    office_service::write_receipt(&paths, &receipt)?;
    writeln!(io::stdout().lock(), "TMT-OFFICE-SERVICE/1 READY")?;
    io::stdout().lock().flush()?;
    let stopping = Arc::new(AtomicBool::new(false));
    let active = Arc::new(AtomicUsize::new(0));
    let previews: Previews = Arc::new(Mutex::new(HashMap::new()));
    let mut workers: Vec<std::thread::JoinHandle<()>> = Vec::new();
    listener.set_nonblocking(true)?;
    while !stopping.load(Ordering::Acquire) {
        let mut index = 0;
        while index < workers.len() {
            if workers[index].is_finished() {
                let worker: std::thread::JoinHandle<()> = workers.swap_remove(index);
                let _ = worker.join();
            } else {
                index += 1;
            }
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                if stopping.load(Ordering::Acquire) {
                    continue;
                }
                // Listener nonblocking mode is platform-specific for accepted
                // sockets. Normalize each bounded worker stream before writing
                // assets larger than the kernel send buffer.
                if stream.set_nonblocking(false).is_err() {
                    continue;
                }
                if active
                    .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                        (count < MAX_CONNECTIONS).then_some(count + 1)
                    })
                    .is_err()
                {
                    continue;
                }
                let guard = ActiveConnection(Arc::clone(&active));
                let paths = paths.clone();
                let receipt = receipt.clone();
                let stopping = Arc::clone(&stopping);
                let previews = Arc::clone(&previews);
                workers.push(std::thread::spawn(move || {
                    let _guard = guard;
                    let _ = stream.set_write_timeout(Some(RESPONSE_DEADLINE));
                    if let Err(error) = handle(&mut stream, &paths, &receipt, &stopping, &previews)
                    {
                        let _ = response(
                            &mut stream,
                            400,
                            "application/json",
                            br#"{"error":"BAD_REQUEST"}"#,
                        );
                        let _ = error;
                    }
                }));
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error.into()),
        }
    }
    drop(listener);
    for worker in workers {
        let _ = worker.join();
    }
    office_service::remove_matching_receipt(&paths, &receipt)
        .map_err(io::Error::other)
        .map_err(ServeError::Other)
}

fn handle(
    stream: &mut TcpStream,
    paths: &ConfigPaths,
    receipt: &ServiceReceipt,
    stopping: &AtomicBool,
    previews: &Previews,
) -> io::Result<()> {
    let request = read_request(stream, Instant::now() + REQUEST_DEADLINE)?;
    if request.method == "GET" && !request.body.is_empty() {
        return response(
            stream,
            400,
            "application/json",
            br#"{"error":"BAD_REQUEST"}"#,
        );
    }
    let host = format!("127.0.0.1:{}", receipt.port);
    if request.header("host") != Some(host.as_str()) {
        return response(
            stream,
            421,
            "application/json",
            br#"{"error":"HOST_REJECTED"}"#,
        );
    }
    if request.path.starts_with("/control/v1/") {
        return control(stream, &request, receipt, stopping, previews);
    }
    if request.path.starts_with("/api/v1/") {
        return api(stream, request, paths, receipt, previews);
    }
    if request.method != "GET" {
        return response(
            stream,
            405,
            "text/plain; charset=utf-8",
            b"Method not allowed",
        );
    }
    let asset = local_assets::find(&request.path).or_else(|| {
        (request.path == "/" || request.path.starts_with("/local/")).then(local_assets::index)
    });
    match asset {
        Some((content_type, bytes)) => response(stream, 200, content_type, bytes),
        None => response(stream, 404, "text/plain; charset=utf-8", b"Not found"),
    }
}

fn control(
    stream: &mut TcpStream,
    request: &Request,
    receipt: &ServiceReceipt,
    stopping: &AtomicBool,
    previews: &Previews,
) -> io::Result<()> {
    let authorization = format!("Bearer {}", receipt.control_token);
    if request.method != "POST"
        || request.header("authorization") != Some(authorization.as_str())
        || request.header("x-tmt-office-nonce") != Some(receipt.nonce.as_str())
    {
        return response(
            stream,
            401,
            "application/json",
            br#"{"error":"UNAUTHORIZED"}"#,
        );
    }
    match request.path.as_str() {
        "/control/v1/health" if request.body.is_empty() => {
            response(stream, 200, "application/json", br#"{"ok":true}"#)
        }
        "/control/v1/stop" if request.body.is_empty() => {
            let result = response(stream, 200, "application/json", br#"{"ok":true}"#);
            if result.is_ok() {
                stopping.store(true, Ordering::Release);
            }
            result
        }
        "/control/v1/prop-previews"
            if request.header("content-type") == Some("application/json") =>
        {
            create_preview(stream, request, receipt, previews)
        }
        _ => response(stream, 404, "application/json", br#"{"error":"NOT_FOUND"}"#),
    }
}

fn create_preview(
    stream: &mut TcpStream,
    request: &Request,
    receipt: &ServiceReceipt,
    previews: &Previews,
) -> io::Result<()> {
    let pack = match validate_pack(&request.body) {
        Ok(pack) => pack,
        Err(_) => {
            return response(
                stream,
                400,
                "application/json",
                br#"{"error":"OFFICE_PROP_INVALID"}"#,
            );
        }
    };
    let mut previews = previews
        .lock()
        .map_err(|_| io::Error::other("preview lock poisoned"))?;
    let now = Instant::now();
    previews.retain(|_, entry| entry.expires > now);
    if let Some((preview_id, entry)) = previews
        .iter()
        .find(|(_, entry)| entry.pack.digest() == pack.digest())
    {
        return preview_response(
            stream,
            receipt,
            preview_id,
            &entry.pack,
            entry.expires_at_ms,
        );
    }
    if previews.len() >= PREVIEW_LIMIT {
        return response(
            stream,
            429,
            "application/json",
            br#"{"error":"OFFICE_PROP_PREVIEW_LIMIT"}"#,
        );
    }
    let preview_id = secret()?;
    let expires_at_ms = unix_time_ms()?.saturating_add(
        u64::try_from(PREVIEW_LIFETIME.as_millis()).expect("preview lifetime fits u64"),
    );
    previews.insert(
        preview_id.clone(),
        PreviewEntry {
            pack: pack.clone(),
            expires: now + PREVIEW_LIFETIME,
            expires_at_ms,
        },
    );
    preview_response(stream, receipt, &preview_id, &pack, expires_at_ms)
}

fn preview_response(
    stream: &mut TcpStream,
    receipt: &ServiceReceipt,
    preview_id: &str,
    pack: &ValidatedPropPack,
    expires_at_ms: u64,
) -> io::Result<()> {
    let url = format!(
        "{}/local/props/preview/{preview_id}#token={}",
        receipt.endpoint(),
        receipt.browser_token
    );
    let body = serde_json::to_vec(&json!({
        "digest":pack.digest(),
        "previewId":preview_id,
        "expiresAtMs":expires_at_ms,
        "url":url
    }))?;
    response(stream, 200, "application/json", &body)
}

fn unix_time_ms() -> io::Result<u64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_millis()
        .try_into()
        .map_err(io::Error::other)
}

fn api(
    stream: &mut TcpStream,
    request: Request,
    paths: &ConfigPaths,
    receipt: &ServiceReceipt,
    previews: &Previews,
) -> io::Result<()> {
    let authorization = format!("Bearer {}", receipt.browser_token);
    if request.header("authorization") != Some(authorization.as_str()) {
        return response(
            stream,
            401,
            "application/json",
            br#"{"error":"UNAUTHORIZED"}"#,
        );
    }
    if let Some(preview_id) = request.path.strip_prefix("/api/v1/local/prop-previews/") {
        if request.method != "GET" || preview_id.is_empty() || preview_id.contains('/') {
            return response(stream, 404, "application/json", br#"{"error":"NOT_FOUND"}"#);
        }
        let mut previews = previews
            .lock()
            .map_err(|_| io::Error::other("preview lock poisoned"))?;
        previews.retain(|_, entry| entry.expires > Instant::now());
        let Some(entry) = previews.get(preview_id) else {
            return response(stream, 404, "application/json", br#"{"error":"NOT_FOUND"}"#);
        };
        let body = serde_json::to_vec(&json!({
            "digest":entry.pack.digest(),
            "pack":entry.pack.pack()
        }))?;
        return response(stream, 200, "application/json", &body);
    }
    if request.method == "POST" && request.path == "/api/v1/local/props/resolve" {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct ResolveInput {
            digests: Vec<String>,
        }
        let input: ResolveInput = match serde_json::from_slice::<ResolveInput>(&request.body) {
            Ok(input) if input.digests.len() <= 16 => input,
            _ => {
                return response(
                    stream,
                    400,
                    "application/json",
                    br#"{"error":"OFFICE_PROP_INVALID"}"#,
                );
            }
        };
        let unique = input.digests.iter().collect::<HashSet<_>>();
        if unique.len() != input.digests.len()
            || input
                .digests
                .iter()
                .any(|digest| tmt_adapters::office_prop::parse_pack_digest(digest).is_none())
        {
            return response(
                stream,
                400,
                "application/json",
                br#"{"error":"OFFICE_PROP_INVALID"}"#,
            );
        }
        let mut storage = match Storage::open(&paths.database) {
            Ok(storage) => storage,
            Err(_) => {
                return response(
                    stream,
                    500,
                    "application/json",
                    br#"{"error":"STORAGE_UNAVAILABLE"}"#,
                );
            }
        };
        let resolution = match storage.resolve_local_prop_packs(&input.digests) {
            Ok(resolution) => resolution,
            Err(_) => {
                return response(
                    stream,
                    500,
                    "application/json",
                    br#"{"error":"STORAGE_UNAVAILABLE"}"#,
                );
            }
        };
        let packs = resolution
            .packs
            .iter()
            .map(|snapshot| json!({"digest":snapshot.pack.digest(),"pack":snapshot.pack.pack()}))
            .collect::<Vec<_>>();
        let body = serde_json::to_vec(&json!({
            "catalogRevision":resolution.catalog_revision,
            "packs":packs,
            "unavailable":resolution.unavailable
        }))?;
        if storage.close().is_err() {
            return response(
                stream,
                500,
                "application/json",
                br#"{"error":"STORAGE_UNAVAILABLE"}"#,
            );
        }
        return response(stream, 200, "application/json", &body);
    }
    if request.path.starts_with("/api/v1/local/board/") {
        return board_api(stream, request, paths, receipt);
    }
    if request.path == "/api/v1/local/profiles"
        || request.path.starts_with("/api/v1/local/profiles/")
    {
        return profile_api(stream, request, paths, receipt);
    }
    if request.method == "GET" && request.path == "/api/v1/local/blocks" {
        let mut storage = match Storage::open(&paths.database) {
            Ok(storage) => storage,
            Err(_) => {
                return response(
                    stream,
                    500,
                    "application/json",
                    br#"{"error":"STORAGE_UNAVAILABLE"}"#,
                );
            }
        };
        let blocks = match storage.list_active_local_blocks() {
            Ok(blocks) => blocks,
            Err(_) => {
                let _ = storage.close();
                return response(
                    stream,
                    500,
                    "application/json",
                    br#"{"error":"STORAGE_UNAVAILABLE"}"#,
                );
            }
        };
        let body = serde_json::to_vec(
            &blocks
                .into_iter()
                .map(|snapshot| local_snapshot(snapshot, false))
                .collect::<Vec<_>>(),
        )?;
        if storage.close().is_err() {
            return response(
                stream,
                500,
                "application/json",
                br#"{"error":"STORAGE_UNAVAILABLE"}"#,
            );
        }
        return response(stream, 200, "application/json", &body);
    }
    let Some(block_id) = request.path.strip_prefix("/api/v1/local/blocks/") else {
        return response(stream, 404, "application/json", br#"{"error":"NOT_FOUND"}"#);
    };
    if uuid::Uuid::parse_str(block_id)
        .ok()
        .is_none_or(|id| id.to_string() != block_id)
    {
        return response(stream, 404, "application/json", br#"{"error":"NOT_FOUND"}"#);
    }
    let put = request.method == "PUT";
    if request.method != "GET" && !put {
        return response(
            stream,
            405,
            "application/json",
            br#"{"error":"METHOD_NOT_ALLOWED"}"#,
        );
    }
    if put {
        let origin = format!("http://127.0.0.1:{}", receipt.port);
        if request.header("origin") != Some(origin.as_str())
            || request
                .header("content-type")
                .is_none_or(|value| value.split(';').next() != Some("application/json"))
        {
            return response(
                stream,
                403,
                "application/json",
                br#"{"error":"ORIGIN_REJECTED"}"#,
            );
        }
    }
    let edit = if put {
        let input: ApplyInput = serde_json::from_slice(&request.body).map_err(io::Error::other)?;
        if input.expected_revision >= tmt_core::office_block::MAX_REVISION {
            return response(
                stream,
                400,
                "application/json",
                br#"{"error":"LAYOUT_INVALID"}"#,
            );
        }
        let layout =
            tmt_adapters::office_block::decode_local_layout(&serde_json::to_vec(&input.layout)?)
                .map_err(io::Error::other)?;
        Some((input.expected_revision, layout))
    } else {
        None
    };
    let mut storage = match Storage::open(&paths.database) {
        Ok(storage) => storage,
        Err(_) => {
            return response(
                stream,
                500,
                "application/json",
                br#"{"error":"STORAGE_UNAVAILABLE"}"#,
            );
        }
    };
    let result = match edit {
        None => storage.show_active_local_block_by_block_id(block_id),
        Some((expected_revision, layout)) => {
            storage.apply_active_local_block_by_block_id(block_id, expected_revision, &layout)
        }
    };
    let status = match &result {
        Ok(_) => 200,
        Err(LocalOfficeError::RevisionConflict | LocalOfficeError::RevisionExhausted) => 409,
        Err(LocalOfficeError::LayoutInvalid) => 400,
        Err(LocalOfficeError::PropNotFound | LocalOfficeError::PropCorrupt) => 404,
        Err(LocalOfficeError::IdentityInactive) => 404,
        Err(_) => 500,
    };
    let body = match result {
        Ok(block) => serde_json::to_vec(&local_snapshot(block, put))?,
        Err(LocalOfficeError::RevisionConflict | LocalOfficeError::RevisionExhausted) => {
            br#"{"error":"REVISION_CONFLICT"}"#.to_vec()
        }
        Err(LocalOfficeError::IdentityInactive) => br#"{"error":"NOT_FOUND"}"#.to_vec(),
        Err(LocalOfficeError::LayoutInvalid) => br#"{"error":"OFFICE_LAYOUT_INVALID"}"#.to_vec(),
        Err(LocalOfficeError::PropNotFound) => br#"{"error":"OFFICE_PROP_NOT_FOUND"}"#.to_vec(),
        Err(LocalOfficeError::PropCorrupt) => br#"{"error":"OFFICE_PROP_CORRUPT"}"#.to_vec(),
        Err(_) => br#"{"error":"STORAGE_UNAVAILABLE"}"#.to_vec(),
    };
    let close = storage.close();
    if status == 200 && close.is_err() {
        return response(
            stream,
            500,
            "application/json",
            br#"{"error":"STORAGE_UNAVAILABLE"}"#,
        );
    }
    response(stream, status, "application/json", &body)
}

fn profile_api(
    stream: &mut TcpStream,
    request: Request,
    paths: &ConfigPaths,
    receipt: &ServiceReceipt,
) -> io::Result<()> {
    if request.method == "GET" && request.path == "/api/v1/local/profiles" {
        let mut storage = match Storage::open(&paths.database) {
            Ok(storage) => storage,
            Err(_) => {
                return response(
                    stream,
                    500,
                    "application/json",
                    br#"{"error":"STORAGE_UNAVAILABLE"}"#,
                );
            }
        };
        // A persisted binding is not presence: verify the recorded tmux
        // endpoints and treat unknown evidence conservatively as offline.
        let tmux = Tmux::default();
        let environment = CallerEnvironment::current();
        let mut endpoint = BindingSession::new(&tmux);
        let online = match binding::list_presence(
            &mut storage,
            &mut endpoint,
            environment.selected_socket(),
        ) {
            Ok(rows) => rows
                .into_iter()
                .filter(|row| row.presence == Presence::Active)
                .map(|row| row.identity.id)
                .collect::<HashSet<_>>(),
            Err(_) => {
                return response(
                    stream,
                    500,
                    "application/json",
                    br#"{"error":"PRESENCE_UNAVAILABLE"}"#,
                );
            }
        };
        let profiles = match storage.list_active_local_profiles() {
            Ok(profiles) => profiles,
            Err(_) => {
                return response(
                    stream,
                    500,
                    "application/json",
                    br#"{"error":"STORAGE_UNAVAILABLE"}"#,
                );
            }
        };
        let mut values = Vec::with_capacity(profiles.len());
        for profile in profiles {
            let is_online = online.contains(&profile.identity_id);
            let mut value = local_profile_snapshot(profile);
            value["online"] = json!(is_online);
            values.push(value);
        }
        let body = serde_json::to_vec(&values)?;
        if storage.close().is_err() {
            return response(
                stream,
                500,
                "application/json",
                br#"{"error":"STORAGE_UNAVAILABLE"}"#,
            );
        }
        return response(stream, 200, "application/json", &body);
    }
    let Some(identity_id) = request.path.strip_prefix("/api/v1/local/profiles/") else {
        return response(stream, 404, "application/json", br#"{"error":"NOT_FOUND"}"#);
    };
    if uuid::Uuid::parse_str(identity_id)
        .ok()
        .is_none_or(|id| id.to_string() != identity_id)
    {
        return response(stream, 404, "application/json", br#"{"error":"NOT_FOUND"}"#);
    }
    let put = request.method == "PUT";
    if request.method != "GET" && !put {
        return response(
            stream,
            405,
            "application/json",
            br#"{"error":"METHOD_NOT_ALLOWED"}"#,
        );
    }
    let edit = if put {
        let origin = format!("http://127.0.0.1:{}", receipt.port);
        if request.header("origin") != Some(origin.as_str())
            || request
                .header("content-type")
                .is_none_or(|value| value.split(';').next() != Some("application/json"))
        {
            return response(
                stream,
                403,
                "application/json",
                br#"{"error":"ORIGIN_REJECTED"}"#,
            );
        }
        if request.body.len() > tmt_core::office_profile::MAX_PROFILE_FILE_BYTES {
            return response(
                stream,
                400,
                "application/json",
                br#"{"error":"PROFILE_INVALID"}"#,
            );
        }
        let input: ApplyProfileInput = match serde_json::from_slice(&request.body) {
            Ok(input) => input,
            Err(_) => {
                return response(
                    stream,
                    400,
                    "application/json",
                    br#"{"error":"PROFILE_INVALID"}"#,
                );
            }
        };
        if input.expected_revision > tmt_core::office_profile::MAX_REVISION {
            return response(
                stream,
                400,
                "application/json",
                br#"{"error":"PROFILE_INVALID"}"#,
            );
        }
        let profile = match office_profile_wire::decode_value(input.profile) {
            Ok(profile) => profile,
            Err(_) => {
                return response(
                    stream,
                    400,
                    "application/json",
                    br#"{"error":"PROFILE_INVALID"}"#,
                );
            }
        };
        Some((input.expected_revision, profile))
    } else {
        None
    };
    let mut storage = match Storage::open(&paths.database) {
        Ok(storage) => storage,
        Err(_) => {
            return response(
                stream,
                500,
                "application/json",
                br#"{"error":"STORAGE_UNAVAILABLE"}"#,
            );
        }
    };
    let result = match edit {
        Some((expected_revision, profile)) => storage
            .apply_local_profile(identity_id, expected_revision, &profile)
            .map(local_profile_mutation),
        None => storage
            .show_local_profile(identity_id)
            .map(local_profile_snapshot),
    };
    let (status, body) = match result {
        Ok(profile) => (200, serde_json::to_vec(&profile)?),
        Err(LocalProfileError::ProfileInvalid) => (400, br#"{"error":"PROFILE_INVALID"}"#.to_vec()),
        Err(LocalProfileError::RevisionConflict | LocalProfileError::RevisionExhausted) => {
            (409, br#"{"error":"REVISION_CONFLICT"}"#.to_vec())
        }
        Err(LocalProfileError::IdentityInactive) => (404, br#"{"error":"NOT_FOUND"}"#.to_vec()),
        Err(_) => (500, br#"{"error":"STORAGE_UNAVAILABLE"}"#.to_vec()),
    };
    let close = storage.close();
    if status == 200 && close.is_err() {
        return response(
            stream,
            500,
            "application/json",
            br#"{"error":"STORAGE_UNAVAILABLE"}"#,
        );
    }
    response(stream, status, "application/json", &body)
}

fn board_api(
    stream: &mut TcpStream,
    request: Request,
    paths: &ConfigPaths,
    receipt: &ServiceReceipt,
) -> io::Result<()> {
    let origin = format!("http://127.0.0.1:{}", receipt.port);
    let (operation, value) = match prepare_board_request(&request, &origin) {
        Ok(value) => value,
        Err((status, body)) => return response(stream, status, "application/json", body),
    };
    let body = tmt_adapters::office_board::execute_at(
        operation,
        &serde_json::to_vec(&value)?,
        &paths.database,
    );
    let code = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_owned));
    let status = match code.as_deref() {
        None => 200,
        Some("BOARD_THREAD_NOT_FOUND" | "BOARD_ENTRY_NOT_FOUND") => 404,
        Some("BOARD_FORBIDDEN") => 403,
        Some(
            "BOARD_REVISION_CONFLICT"
            | "BOARD_IDEMPOTENCY_CONFLICT"
            | "BOARD_CURSOR_INVALID"
            | "BOARD_CURSOR_STALE",
        ) => 409,
        Some("BOARD_INVALID") => 400,
        _ => 500,
    };
    response(stream, status, "application/json", &body)
}

fn prepare_board_request(
    request: &Request,
    origin: &str,
) -> Result<(OfficeInvocation, Value), (u16, &'static [u8])> {
    if request.header("origin") != Some(origin)
        || request
            .header("content-type")
            .is_none_or(|value| value.split(';').next() != Some("application/json"))
    {
        return Err((403, br#"{"error":"ORIGIN_REJECTED"}"#));
    }
    let (operation, actor, path_id) = match (request.method.as_str(), request.path.as_str()) {
        ("POST", "/api/v1/local/board/categories/list") => {
            (OfficeInvocation::BoardCategories, false, None)
        }
        ("POST", "/api/v1/local/board/threads/list") => (OfficeInvocation::BoardList, false, None),
        ("POST", "/api/v1/local/board/threads/show") => (OfficeInvocation::BoardShow, false, None),
        ("POST", "/api/v1/local/board/threads") => (OfficeInvocation::BoardPost, true, None),
        ("POST", path)
            if path.starts_with("/api/v1/local/board/threads/") && path.ends_with("/replies") =>
        {
            let id = &path[28..path.len() - 8];
            (OfficeInvocation::BoardReply, true, Some(("threadId", id)))
        }
        ("PUT", path) if path.starts_with("/api/v1/local/board/entries/") => (
            OfficeInvocation::BoardEdit,
            true,
            Some(("entryId", &path[28..])),
        ),
        ("DELETE", path) if path.starts_with("/api/v1/local/board/entries/") => (
            OfficeInvocation::BoardDelete,
            true,
            Some(("entryId", &path[28..])),
        ),
        _ => return Err((404, br#"{"error":"NOT_FOUND"}"#)),
    };
    let mut value: Value = match serde_json::from_slice(&request.body) {
        Ok(Value::Object(object)) => Value::Object(object),
        _ => {
            return Err((400, br#"{"error":"BOARD_INVALID"}"#));
        }
    };
    let object = value.as_object_mut().expect("validated object");
    if actor {
        object.insert("actor".into(), json!({"kind":"owner"}));
    }
    if let Some((key, id)) = path_id {
        if uuid::Uuid::parse_str(id)
            .ok()
            .is_none_or(|parsed| parsed.to_string() != id)
        {
            return Err((404, br#"{"error":"NOT_FOUND"}"#));
        }
        object.insert(key.into(), json!(id));
    }
    Ok((operation, value))
}

fn read_request(stream: &mut TcpStream, deadline: Instant) -> io::Result<Request> {
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 2048];
    let header_end = loop {
        if bytes.len() >= HEADER_LIMIT {
            return Err(io::Error::other("request headers too large"));
        }
        let read = read_before(stream, &mut chunk, deadline)?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "request ended",
            ));
        }
        bytes.extend_from_slice(&chunk[..read]);
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            let end = index + 4;
            if end > HEADER_LIMIT {
                return Err(io::Error::other("request headers too large"));
            }
            break end;
        }
    };
    let mut headers = [httparse::EMPTY_HEADER; 32];
    let mut parsed = httparse::Request::new(&mut headers);
    if parsed
        .parse(&bytes[..header_end])
        .map_err(io::Error::other)?
        != httparse::Status::Complete(header_end)
    {
        return Err(io::Error::other("incomplete request"));
    }
    if parsed.version != Some(1) {
        return Err(io::Error::other("HTTP/1.1 is required"));
    }
    let method = parsed
        .method
        .ok_or_else(|| io::Error::other("missing method"))?
        .to_owned();
    let path = parsed
        .path
        .ok_or_else(|| io::Error::other("missing path"))?
        .to_owned();
    if !path.starts_with('/') || path.contains('?') || path.contains('#') {
        return Err(io::Error::other("invalid path"));
    }
    let headers = parsed
        .headers
        .iter()
        .map(|header| {
            let value = std::str::from_utf8(header.value).map_err(io::Error::other)?;
            Ok((header.name.to_owned(), value.trim().to_owned()))
        })
        .collect::<io::Result<Vec<_>>>()?;
    let transfer = headers
        .iter()
        .any(|(key, _)| key.eq_ignore_ascii_case("transfer-encoding"));
    if transfer {
        return Err(io::Error::other("transfer encoding is unsupported"));
    }
    let lengths = headers
        .iter()
        .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
        .map(|(_, value)| value.parse::<usize>().map_err(io::Error::other))
        .collect::<io::Result<Vec<_>>>()?;
    if lengths.len() > 1 {
        return Err(io::Error::other("duplicate content length"));
    }
    let content_length = lengths.first().copied().unwrap_or(0);
    let body_limit = if method == "POST" && path == "/control/v1/prop-previews" {
        PACK_INPUT_LIMIT
    } else {
        BODY_LIMIT
    };
    if content_length > body_limit {
        return Err(io::Error::other("request body too large"));
    }
    while bytes.len() < header_end + content_length {
        let read = read_before(stream, &mut chunk, deadline)?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "request body ended",
            ));
        }
        bytes.extend_from_slice(&chunk[..read]);
        if bytes.len() > header_end + body_limit {
            return Err(io::Error::other("request body too large"));
        }
    }
    if bytes.len() != header_end + content_length {
        return Err(io::Error::other("unexpected bytes after request body"));
    }
    Ok(Request {
        method,
        path,
        headers,
        body: bytes[header_end..header_end + content_length].to_vec(),
    })
}

fn read_before(stream: &mut TcpStream, buffer: &mut [u8], deadline: Instant) -> io::Result<usize> {
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "request deadline exceeded"))?;
    stream.set_read_timeout(Some(remaining.max(Duration::from_millis(1))))?;
    stream.read(buffer)
}

fn response(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        421 => "Misdirected Request",
        429 => "Too Many Requests",
        _ => "Internal Server Error",
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nCross-Origin-Resource-Policy: same-origin\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)
}

fn secret() -> io::Result<String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(io::Error::other)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    fn parse_wire(wire: &'static [u8]) -> io::Result<Request> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let sender = thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            stream.write_all(wire).unwrap();
        });
        let (mut stream, _) = listener.accept().unwrap();
        let result = read_request(&mut stream, Instant::now() + REQUEST_DEADLINE);
        sender.join().unwrap();
        result
    }

    fn wire_with_body(path: &str, body_len: usize) -> &'static [u8] {
        let mut wire = format!(
            "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:1\r\nContent-Type: application/json\r\nContent-Length: {body_len}\r\n\r\n"
        )
        .into_bytes();
        wire.resize(wire.len() + body_len, b' ');
        Box::leak(wire.into_boxed_slice())
    }

    #[test]
    fn preview_route_alone_raises_the_parser_body_cap_to_128_kib() {
        assert!(parse_wire(wire_with_body("/control/v1/prop-previews", BODY_LIMIT + 1)).is_ok());
        assert!(parse_wire(wire_with_body("/api/v1/local/profiles", BODY_LIMIT + 1)).is_err());
        assert!(
            parse_wire(wire_with_body(
                "/control/v1/prop-previews",
                PACK_INPUT_LIMIT + 1
            ))
            .is_err()
        );
    }

    fn board_request(method: &str, path: &str, body: Value) -> Request {
        Request {
            method: method.into(),
            path: path.into(),
            headers: vec![
                ("Origin".into(), "http://127.0.0.1:1234".into()),
                ("Content-Type".into(), "application/json".into()),
            ],
            body: serde_json::to_vec(&body).unwrap(),
        }
    }

    #[test]
    fn board_routes_are_exact_and_browser_authority_overwrites_spoofs() {
        let id = "11111111-1111-4111-8111-111111111111";
        for (method, path, operation) in [
            (
                "POST",
                "/api/v1/local/board/categories/list",
                OfficeInvocation::BoardCategories,
            ),
            (
                "POST",
                "/api/v1/local/board/threads/list",
                OfficeInvocation::BoardList,
            ),
            (
                "POST",
                "/api/v1/local/board/threads/show",
                OfficeInvocation::BoardShow,
            ),
            (
                "POST",
                "/api/v1/local/board/threads",
                OfficeInvocation::BoardPost,
            ),
            (
                "POST",
                &format!("/api/v1/local/board/threads/{id}/replies"),
                OfficeInvocation::BoardReply,
            ),
            (
                "PUT",
                &format!("/api/v1/local/board/entries/{id}"),
                OfficeInvocation::BoardEdit,
            ),
            (
                "DELETE",
                &format!("/api/v1/local/board/entries/{id}"),
                OfficeInvocation::BoardDelete,
            ),
        ] {
            let request = board_request(
                method,
                path,
                json!({"actor":{"kind":"identity"},"threadId":"22222222-2222-4222-8222-222222222222","entryId":"22222222-2222-4222-8222-222222222222"}),
            );
            let (actual, value) = prepare_board_request(&request, "http://127.0.0.1:1234").unwrap();
            assert_eq!(actual, operation);
            if matches!(
                operation,
                OfficeInvocation::BoardPost
                    | OfficeInvocation::BoardReply
                    | OfficeInvocation::BoardEdit
                    | OfficeInvocation::BoardDelete
            ) {
                assert_eq!(value["actor"], json!({"kind":"owner"}));
            }
            if matches!(operation, OfficeInvocation::BoardReply) {
                assert_eq!(value["threadId"], id);
            }
            if matches!(
                operation,
                OfficeInvocation::BoardEdit | OfficeInvocation::BoardDelete
            ) {
                assert_eq!(value["entryId"], id);
            }
        }
    }

    #[test]
    fn board_routes_require_exact_origin_json_uuid_and_known_route() {
        let mut request = board_request("POST", "/api/v1/local/board/categories/list", json!({}));
        request.headers.clear();
        assert_eq!(
            prepare_board_request(&request, "http://127.0.0.1:1234")
                .unwrap_err()
                .0,
            403
        );
        for path in [
            "/api/v1/local/board/unknown",
            "/api/v1/local/board/entries/not-a-uuid",
        ] {
            assert_eq!(
                prepare_board_request(
                    &board_request("PUT", path, json!({})),
                    "http://127.0.0.1:1234"
                )
                .unwrap_err()
                .0,
                404
            );
        }
    }

    fn call_api(request: Request, paths: &ConfigPaths, receipt: &ServiceReceipt) -> String {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let receiver = thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            let mut bytes = Vec::new();
            stream.read_to_end(&mut bytes).unwrap();
            String::from_utf8(bytes).unwrap()
        });
        let (mut stream, _) = listener.accept().unwrap();
        api(&mut stream, request, paths, receipt).unwrap();
        drop(stream);
        receiver.join().unwrap()
    }

    #[test]
    fn authenticated_http_board_survives_handler_restart_and_storage_reopen() {
        let root = std::env::temp_dir().join(format!("tmt-board-http-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let paths = ConfigPaths::resolve(&root, &root, Some(&root), None);
        let receipt = ServiceReceipt {
            schema_version: 1,
            pid: std::process::id(),
            port: 1234,
            nonce: "n".into(),
            browser_token: "browser".into(),
            control_token: "control".into(),
            running_version: "test".into(),
        };
        let headers = || {
            vec![
                ("Authorization".into(), "Bearer browser".into()),
                ("Origin".into(), "http://127.0.0.1:1234".into()),
                ("Content-Type".into(), "application/json".into()),
            ]
        };
        let post=Request{method:"POST".into(),path:"/api/v1/local/board/threads".into(),headers:headers(),body:serde_json::to_vec(&json!({"category":{"kind":"general"},"actor":{"kind":"identity","identityId":"11111111-1111-4111-8111-111111111111","name":"spoof"},"title":"hello","body":"body","operationId":"22222222-2222-4222-8222-222222222222"})).unwrap()};
        let posted = call_api(post, &paths, &receipt);
        assert!(posted.starts_with("HTTP/1.1 200"));
        let body = posted.split("\r\n\r\n").nth(1).unwrap();
        let value: Value = serde_json::from_str(body).unwrap();
        let thread = value["threadId"].as_str().unwrap();
        let show = Request {
            method: "POST".into(),
            path: "/api/v1/local/board/threads/show".into(),
            headers: headers(),
            body: serde_json::to_vec(
                &json!({"threadId":thread,"replyLimit":20,"replyCursor":null}),
            )
            .unwrap(),
        };
        let shown = call_api(show, &paths, &receipt);
        assert!(shown.starts_with("HTTP/1.1 200"));
        assert!(shown.contains("\"title\":\"hello\""));
        assert!(shown.contains("\"kind\":\"owner\""));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn protected_profile_http_uses_shared_cas_and_survives_reopen() {
        let root = std::env::temp_dir().join(format!("tmt-profile-http-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let paths = ConfigPaths::resolve(&root, &root, Some(&root), None);
        let mut storage = Storage::open(&paths.database).unwrap();
        let id = tmt_core::identity::create_or_resolve(
            &mut storage,
            "Alice",
            tmt_core::identity::Lifetime::Saved,
        )
        .unwrap()
        .identity
        .id;
        storage.close().unwrap();
        let receipt = ServiceReceipt {
            schema_version: 1,
            pid: std::process::id(),
            port: 1234,
            nonce: "n".into(),
            browser_token: "browser".into(),
            control_token: "control".into(),
            running_version: "test".into(),
        };
        let headers = || {
            vec![
                ("Authorization".into(), "Bearer browser".into()),
                ("Origin".into(), "http://127.0.0.1:1234".into()),
                ("Content-Type".into(), "application/json".into()),
            ]
        };
        let unauthorized = Request {
            method: "GET".into(),
            path: format!("/api/v1/local/profiles/{id}"),
            headers: vec![],
            body: vec![],
        };
        assert!(call_api(unauthorized, &paths, &receipt).starts_with("HTTP/1.1 401"));
        let get = Request {
            method: "GET".into(),
            path: format!("/api/v1/local/profiles/{id}"),
            headers: headers(),
            body: vec![],
        };
        let missing = call_api(get, &paths, &receipt);
        assert!(missing.starts_with("HTTP/1.1 200"));
        assert!(missing.contains("\"exists\":false"));
        let profile = json!({"displayLabel":"","description":"Architecture review","appearance":{"hairStyle":"short","hairColor":"ink","skinTone":"medium","shirtColor":"blue","shirtMark":"AI"}});
        let rejected = Request {
            method: "PUT".into(),
            path: format!("/api/v1/local/profiles/{id}"),
            headers: vec![
                ("Authorization".into(), "Bearer browser".into()),
                ("Origin".into(), "https://attacker.invalid".into()),
                ("Content-Type".into(), "application/json".into()),
            ],
            body: serde_json::to_vec(&json!({"expectedRevision":0,"profile":profile})).unwrap(),
        };
        assert!(call_api(rejected, &paths, &receipt).starts_with("HTTP/1.1 403"));
        let put = Request {
            method: "PUT".into(),
            path: format!("/api/v1/local/profiles/{id}"),
            headers: headers(),
            body: serde_json::to_vec(&json!({"expectedRevision":0,"profile":profile})).unwrap(),
        };
        let created = call_api(put, &paths, &receipt);
        assert!(created.starts_with("HTTP/1.1 200"));
        let json_body = |response: &str| {
            serde_json::from_str::<Value>(response.split("\r\n\r\n").nth(1).unwrap()).unwrap()
        };
        let created_body = json_body(&created);
        assert_eq!(created_body["revision"], 1);
        assert_eq!(created_body["changed"], true);
        let created_at = created_body["updatedAtMs"].as_u64().unwrap();
        let retry = Request {
            method: "PUT".into(),
            path: format!("/api/v1/local/profiles/{id}"),
            headers: headers(),
            body: serde_json::to_vec(&json!({"expectedRevision":0,"profile":profile})).unwrap(),
        };
        let retried = call_api(retry, &paths, &receipt);
        assert!(retried.starts_with("HTTP/1.1 200"));
        let retried_body = json_body(&retried);
        assert_eq!(retried_body["revision"], 1);
        assert_eq!(retried_body["changed"], false);
        assert_eq!(retried_body["updatedAtMs"], created_at);
        let noop = Request {
            method: "PUT".into(),
            path: format!("/api/v1/local/profiles/{id}"),
            headers: headers(),
            body: serde_json::to_vec(&json!({"expectedRevision":1,"profile":profile})).unwrap(),
        };
        let noop_body = json_body(&call_api(noop, &paths, &receipt));
        assert_eq!(noop_body["changed"], false);
        assert_eq!(noop_body["updatedAtMs"], created_at);
        let updated_profile = json!({"displayLabel":"Lead","description":"Architecture review","appearance":{"hairStyle":"short","hairColor":"ink","skinTone":"medium","shirtColor":"blue","shirtMark":"AI"}});
        let update = Request {
            method: "PUT".into(),
            path: format!("/api/v1/local/profiles/{id}"),
            headers: headers(),
            body: serde_json::to_vec(&json!({"expectedRevision":1,"profile":updated_profile}))
                .unwrap(),
        };
        let updated_body = json_body(&call_api(update, &paths, &receipt));
        assert_eq!(updated_body["revision"], 2);
        assert_eq!(updated_body["changed"], true);
        let stale = Request {
            method: "PUT".into(),
            path: format!("/api/v1/local/profiles/{id}"),
            headers: headers(),
            body: serde_json::to_vec(&json!({"expectedRevision":1,"profile":profile})).unwrap(),
        };
        assert!(call_api(stale, &paths, &receipt).starts_with("HTTP/1.1 409"));
        let list = Request {
            method: "GET".into(),
            path: "/api/v1/local/profiles".into(),
            headers: headers(),
            body: vec![],
        };
        let listed = call_api(list, &paths, &receipt);
        assert!(listed.contains("\"online\":false"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn request_parser_rejects_ambiguous_framing_and_headers() {
        let duplicate_host =
            parse_wire(b"GET /local HTTP/1.1\r\nHost: 127.0.0.1:1\r\nHost: attacker\r\n\r\n")
                .unwrap();
        assert_eq!(duplicate_host.header("host"), None);
        assert!(parse_wire(
            b"PUT /api/v1/local/blocks/x HTTP/1.1\r\nHost: 127.0.0.1:1\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n"
        )
        .is_err());
        assert!(parse_wire(
            b"PUT /api/v1/local/blocks/x HTTP/1.1\r\nHost: 127.0.0.1:1\r\nTransfer-Encoding: chunked\r\n\r\n"
        )
        .is_err());
    }

    #[test]
    fn every_response_has_private_browser_security_headers() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let receiver = thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            let mut bytes = Vec::new();
            stream.read_to_end(&mut bytes).unwrap();
            String::from_utf8(bytes).unwrap()
        });
        let (mut stream, _) = listener.accept().unwrap();
        response(&mut stream, 200, "application/json", b"{}").unwrap();
        drop(stream);
        let output = receiver.join().unwrap();
        assert!(output.contains("Cache-Control: no-store\r\n"));
        assert!(output.contains("Content-Security-Policy:"));
        assert!(output.contains("Referrer-Policy: no-referrer\r\n"));
        assert!(!output.contains("Access-Control-Allow-Origin"));
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Invocation {
    Help,
    Version,
    Completion(Option<String>),
    Learn {
        skill: bool,
    },
    Init,
    List {
        target: Option<String>,
    },
    Bind {
        pane: Option<String>,
        name: String,
        save: bool,
    },
    Remove {
        name: String,
        force: bool,
    },
    Whoami,
    Unbind,
    Talk {
        target: String,
        message: String,
        originator: Option<String>,
        options: TalkOptions,
    },
    Check {
        target: String,
        lines: Option<u64>,
    },
    Config(ConfigRequest),
    Identity(IdentityRequest),
    Preamble(PreambleRequest),
    Role {
        identity: Option<String>,
        operation: RoleOperation,
    },
    Exchange {
        identity: Option<String>,
        operation: ExchangeOperation,
    },
    Reply {
        request_id: String,
        receipt: String,
        input: ContentInput,
    },
    Result {
        request_id: String,
    },
    Install {
        target: Option<String>,
        directory: Option<String>,
        force: bool,
    },
    Upgrade {
        channel: Option<tmt_core::native_install::Channel>,
        exact: Option<String>,
        unpin: bool,
    },
    NativeRefreshSkills,
    Office {
        prefix: Option<String>,
        operation: OfficeOperation,
    },
    NativeInstall {
        product: tmt_core::native_install::Product,
        archive: String,
        manifest: String,
        prefix: String,
        channel: tmt_core::native_install::Channel,
        pin: tmt_core::native_install::PinAction,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum OfficeOperation {
    Open,
    Status,
    Install {
        yes: bool,
        archive: Option<String>,
        manifest: Option<String>,
        channel: Option<tmt_core::native_install::Channel>,
    },
    Upgrade {
        channel: Option<tmt_core::native_install::Channel>,
    },
    Uninstall {
        yes: bool,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct TalkOptions {
    pub force: bool,
    pub detach: bool,
    pub delay_seconds: Option<f64>,
    pub timeout_seconds: Option<f64>,
    pub no_preamble: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ContentInput {
    Inline(String),
    File(String),
    Stdin,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ConfigRequest {
    Show,
    Set {
        key: String,
        value: String,
        global: bool,
    },
    Clear {
        key: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum IdentityRequest {
    Create(String),
    Show(String),
    List,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PreambleRequest {
    Show(Option<String>),
    Set { name: String, content: String },
    Clear(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum RoleOperation {
    Show,
    Set(ContentInput),
    Clear,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ExchangeOperation {
    List {
        limit: Option<u64>,
        after: Option<u64>,
    },
    Show(String),
    Ack {
        request_id: String,
        revision: u64,
    },
    Ackall,
}

#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct OutputMode {
    pub json: bool,
}

#[derive(Debug, PartialEq)]
pub struct Parsed {
    pub invocation: Invocation,
    pub mode: OutputMode,
}

#[derive(Debug, PartialEq)]
pub struct ParseError {
    pub code: &'static str,
    pub message: String,
    pub mode: OutputMode,
}

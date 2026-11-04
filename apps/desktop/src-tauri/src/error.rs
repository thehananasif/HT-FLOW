use htflow_auth::AuthError;
use serde::Serialize;

/// Error shape returned to the UI: `{ code, message }`. Never contains secrets.
#[derive(Debug, Serialize)]
pub struct CmdError {
    pub code: String,
    pub message: String,
}

impl CmdError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl From<AuthError> for CmdError {
    fn from(e: AuthError) -> Self {
        Self {
            code: e.code().into(),
            message: e.to_string(),
        }
    }
}

impl From<htflow_connector_binance::ConnectorError> for CmdError {
    fn from(e: htflow_connector_binance::ConnectorError) -> Self {
        Self {
            code: "market.connector".into(),
            message: e.to_string(),
        }
    }
}

pub type CmdResult<T> = Result<T, CmdError>;

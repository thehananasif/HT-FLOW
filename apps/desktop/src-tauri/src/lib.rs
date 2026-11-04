//! HT Flow desktop shell (Tauri 2). Exposes the Rust core to the UI through a typed IPC
//! allow-list: local accounts + encrypted settings/vault (P03) and live market data (P05/P06).

mod auth_cmds;
mod error;
mod market_cmds;
mod paths;

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use htflow_auth::{KdfParams, ProfileStore};
use tauri::Manager;

pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .try_init();

    tauri::Builder::default()
        .setup(|app| {
            let root = paths::data_root(app.path().app_data_dir().ok());
            std::fs::create_dir_all(&root)?;
            tracing::info!(root = %root.display(), "HT Flow data root");
            app.manage(auth_cmds::AuthState {
                store: Arc::new(ProfileStore::new(root, KdfParams::PRODUCTION)),
                session: Arc::new(Mutex::new(None)),
                locked: AtomicBool::new(false),
            });
            app.manage(market_cmds::MarketState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            auth_cmds::auth_list_profiles,
            auth_cmds::auth_create_account,
            auth_cmds::auth_login,
            auth_cmds::auth_auto_login,
            auth_cmds::auth_unlock_pin,
            auth_cmds::auth_set_pin,
            auth_cmds::auth_change_password,
            auth_cmds::auth_recover,
            auth_cmds::auth_lock,
            auth_cmds::auth_logout,
            auth_cmds::auth_export_profile,
            auth_cmds::auth_import_profile,
            auth_cmds::settings_get,
            auth_cmds::settings_set,
            auth_cmds::vault_put,
            auth_cmds::vault_get,
            market_cmds::market_history,
            market_cmds::market_subscribe,
            market_cmds::market_unsubscribe,
        ])
        .run(tauri::generate_context!())
        .expect("error while running HT Flow");
}

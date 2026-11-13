//! HT Flow desktop shell (Tauri 2). Exposes the Rust core to the UI through a typed IPC
//! allow-list: local accounts + encrypted settings/vault (P03) and live market data (P05/P06).

mod auth_cmds;
mod crash;
mod data_cmds;
mod error;
mod history;
mod history_cache;
mod market_cmds;
mod net_cmds;
mod openfile;
mod paths;
mod updater_cmds;

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

    // Local-only crash reports (<data>/crashes/), also for panics during start-up.
    crash::install_panic_hook(paths::data_root(None));

    tauri::Builder::default()
        // A second launch (e.g. double-clicking a .htprofile) hands its arguments to this instance.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            openfile::dispatch(app, openfile::paths_from_args(args));
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let root = paths::data_root(app.path().app_data_dir().ok());
            std::fs::create_dir_all(&root)?;
            app.manage(crash::CrashState(crash::crash_dir(&root)));
            app.manage(openfile::OpenFileState::default());
            openfile::dispatch(
                app.handle(),
                openfile::paths_from_args(std::env::args().skip(1)),
            );
            tracing::info!(root = %root.display(), "HT Flow data root");
            app.manage(data_cmds::DataState(data_cmds::RecorderService::start(
                &root,
            )?));
            app.manage(auth_cmds::AuthState {
                store: Arc::new(ProfileStore::new(root.clone(), KdfParams::PRODUCTION)),
                session: Arc::new(Mutex::new(None)),
                locked: AtomicBool::new(false),
            });
            app.manage(history_cache::CacheState(Arc::new(
                history_cache::HistoryCache::open(
                    root.join("cache").join("history"),
                    u64::from(history_cache::DEFAULT_MAX_MB) * 1024 * 1024,
                ),
            )));
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
            market_cmds::market_history_range,
            history_cache::history_cache_set,
            history_cache::history_cache_status,
            history_cache::history_cache_clear,
            market_cmds::market_subscribe,
            market_cmds::market_unsubscribe,
            net_cmds::net_fetch_text,
            net_cmds::net_post_json,
            market_cmds::market_test,
            market_cmds::market_options_chain,
            data_cmds::recorder_set,
            data_cmds::recorder_status,
            data_cmds::data_list,
            data_cmds::data_delete,
            data_cmds::data_export_csv,
            data_cmds::data_replay,
            crash::crash_save,
            crash::crash_list,
            crash::crash_summary,
            crash::crash_open_folder,
            openfile::open_file_ready,
            updater_cmds::update_status,
            updater_cmds::update_check,
            updater_cmds::update_install,
        ])
        .run(tauri::generate_context!())
        .expect("error while running HT Flow");
}

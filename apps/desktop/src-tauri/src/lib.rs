//! HT Flow desktop shell (Tauri 2). Exposes the Rust core to the UI through a typed IPC
//! allow-list: local accounts + encrypted settings/vault (P03) and live market data (P05/P06).

mod auth_cmds;
mod backup;
mod crash;
mod custom_ws;
mod data_cmds;
mod error;
mod feed_cmds;
mod file_log;
mod history;
mod history_cache;
mod instruments_cmds;
mod market_cmds;
mod native_prefs;
mod net_cmds;
mod openfile;
mod paths;
mod updater_cmds;
mod vps_cmds;
mod webpage_cmds;

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use htflow_auth::{KdfParams, ProfileStore};
use tauri::{Manager, WebviewWindowBuilder};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

pub fn run() {
    // Settings the native side needs before any profile is unlocked (native-prefs.json).
    let boot_root = paths::data_root(None);
    let prefs = native_prefs::load(&boot_root);
    let log_dir =
        file_log::resolve_log_dir(&boot_root, &prefs.logs_folder, |k| std::env::var(k).ok());
    file_log::sweep(&log_dir, prefs.logs_keep_days);
    let file_layer = file_log::maker(&log_dir).map(|m| {
        tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .with_writer(m)
    });
    let _ = tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .with(file_layer)
        .try_init();

    // Local-only crash reports (<data>/crashes/), also for panics during start-up.
    crash::install_panic_hook(boot_root.clone());

    tauri::Builder::default()
        // A second launch (e.g. double-clicking a .htprofile) hands its arguments to this instance.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            openfile::dispatch(app, openfile::paths_from_args(args));
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            let root = paths::data_root(app.path().app_data_dir().ok());
            std::fs::create_dir_all(&root)?;
            app.manage(crash::CrashState(crash::crash_dir(&root)));
            app.manage(native_prefs::NativeState {
                root: root.clone(),
                log_dir: log_dir.clone(),
                prefs: Mutex::new(prefs.clone()),
            });
            backup::spawn_scheduler(app.handle().clone());
            // The main window is built here (not from tauri.conf.json alone) so the WebView2
            // GPU adapter chosen in Settings -> Performance can be passed as a browser argument.
            if let Some(cfg) = app.config().app.windows.first() {
                #[allow(unused_mut)]
                let mut win = WebviewWindowBuilder::from_config(app.handle(), cfg)?;
                #[cfg(windows)]
                {
                    win = win
                        .additional_browser_args(&native_prefs::browser_args(&prefs.video_adapter));
                }
                win.build()?;
            }
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
                store: Arc::new(
                    ProfileStore::new(root.clone(), KdfParams::PRODUCTION)
                        .with_pin_pepper(Arc::new(auth_cmds::KeyringPepper)),
                ),
                session: Arc::new(Mutex::new(None)),
                locked: AtomicBool::new(false),
            });
            app.manage(history_cache::CacheState(Arc::new(
                history_cache::HistoryCache::open(
                    root.join("cache").join("history"),
                    u64::from(history_cache::DEFAULT_MAX_MB) * 1024 * 1024,
                ),
            )));
            app.manage(instruments_cmds::InstrumentsState::new(&root.join("cache")));
            app.manage(market_cmds::MarketState::default());
            app.manage(custom_ws::CustomWsState::default());
            app.manage(feed_cmds::FeedState::new(&root));
            app.manage(vps_cmds::VpsState::default());
            app.manage(webpage_cmds::WebpageState::default());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Web Page windows never outlive the main window.
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                webpage_cmds::close_all(window.app_handle());
            }
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
            feed_cmds::feed_fetch,
            feed_cmds::feed_allow_add,
            feed_cmds::feed_allow_remove,
            feed_cmds::feed_allow_list,
            feed_cmds::calendar_fetch,
            custom_ws::custom_ws_open,
            custom_ws::custom_ws_send,
            custom_ws::custom_ws_close,
            market_cmds::market_test,
            market_cmds::market_options_chain,
            instruments_cmds::instruments_cached,
            instruments_cmds::instruments_list,
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
            file_log::open_log_folder,
            backup::profile_backup_now,
            backup::profile_backup_prune,
            backup::open_backups_folder,
            native_prefs::native_prefs_set,
            openfile::open_file_ready,
            updater_cmds::update_status,
            updater_cmds::update_check,
            updater_cmds::update_install,
            vps_cmds::vps_host_key,
            vps_cmds::vps_key_info,
            vps_cmds::vps_connect,
            vps_cmds::vps_disconnect,
            vps_cmds::vps_probe,
            vps_cmds::vps_op,
            vps_cmds::vps_exec,
            webpage_cmds::webpage_open,
            webpage_cmds::webpage_navigate,
            webpage_cmds::webpage_back,
            webpage_cmds::webpage_forward,
            webpage_cmds::webpage_reload,
            webpage_cmds::webpage_close,
            webpage_cmds::webpage_set_bounds,
            webpage_cmds::webpage_set_always_on_top,
            webpage_cmds::webpage_set_policy,
            webpage_cmds::webpage_open_external,
        ])
        .run(tauri::generate_context!())
        .expect("error while running HT Flow");
}

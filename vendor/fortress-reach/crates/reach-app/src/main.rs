mod profile;

slint::include_modules!();

use profile::UserProfile;
use reach_browser::BrowserController;
use reach_core::config::AppConfig;
use reach_core::model::ChannelHealth;
use reach_router::Router;
use reach_server::{JsonRpcHandler, McpServer, TunnelManager};
use slint::{ComponentHandle, Model, ModelRc, SharedString, VecModel};
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio::runtime::Runtime;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

fn current_time_str() -> String {
    let now = chrono::Local::now();
    now.format("%H:%M:%S").to_string()
}

fn main() -> Result<(), slint::PlatformError> {
    // Initialize tracing
    let _ = tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with(tracing_subscriber::fmt::layer())
        .try_init();

    let config = AppConfig::default();
    let rt = Arc::new(Runtime::new().expect("Failed to create Tokio runtime"));

    // Core server setup
    let router = Arc::new(Router::new());
    let browser = Arc::new(BrowserController::new(config.cdp_host.clone(), config.cdp_port));
    let handler = Arc::new(JsonRpcHandler::new(router, browser));
    let server = Arc::new(McpServer::new(handler, &config.server_host, config.server_port));
    let tunnel_manager = Arc::new(TunnelManager::new());

    // Health state
    let health_state = Arc::new(Mutex::new(Vec::<ChannelHealth>::new()));
    let health_clone = health_state.clone();
    let rt_clone = rt.clone();

    // Start background health probe
    std::thread::spawn(move || {
        let r = Router::new();
        let report = rt_clone.block_on(r.check_channels());
        if let Ok(mut guard) = health_clone.lock() {
            *guard = report;
        }
    });

    // Start background MCP server
    let server_clone = server.clone();
    rt.spawn(async move {
        let _ = server_clone.start().await;
    });

    // Load or initialize user profile
    let profile = UserProfile::load();

    // Launch Slint Window
    let ui = MainWindow::new()?;
    let bridge = ui.global::<Bridge>();

    // Initial log buffer
    let initial_logs = Rc::new(VecModel::<LogRow>::default());
    initial_logs.push(LogRow {
        text: SharedString::from(format!("[{}] Fortress-Reach native engine online.", current_time_str())),
        is_error: false,
        is_success: true,
    });
    initial_logs.push(LogRow {
        text: SharedString::from(format!("[{}] Local MCP server listening on port {}.", current_time_str(), config.server_port)),
        is_error: false,
        is_success: false,
    });

    // Apply loaded profile to UI
    bridge.set_is_registered(profile.is_registered);
    bridge.set_user_name(SharedString::from(&profile.name));
    bridge.set_user_email(SharedString::from(&profile.email));
    bridge.set_user_phone(SharedString::from(&profile.phone));
    bridge.set_permanent_domain(SharedString::from(&profile.permanent_domain));
    bridge.set_cloudflare_token(SharedString::from(&profile.cloudflare_token));
    bridge.set_logs(ModelRc::from(initial_logs.clone()));

    // If already registered, launch persistent tunnel immediately
    if profile.is_registered {
        let token = if profile.cloudflare_token.trim().is_empty() {
            None
        } else {
            Some(profile.cloudflare_token.as_str())
        };
        tunnel_manager.start_tunnel_with_token(
            config.server_port,
            token,
            Some(&profile.permanent_domain),
        );

        let endpoint = format!("https://{}/sse", profile.permanent_domain);
        bridge.set_endpoint_url(SharedString::from(&endpoint));

        initial_logs.push(LogRow {
            text: SharedString::from(format!(
                "[{}] Persistent domain active: {}",
                current_time_str(),
                profile.permanent_domain
            )),
            is_error: false,
            is_success: true,
        });
    }

    // Register User Callback
    let tunnel_mgr_reg = tunnel_manager.clone();
    let port_reg = config.server_port;
    let logs_reg = initial_logs.clone();
    let ui_weak = ui.as_weak();

    bridge.on_register_user(move |name_s, email_s, phone_s, token_s| {
        let name = name_s.to_string();
        let email = email_s.to_string();
        let phone = phone_s.to_string();
        let token = token_s.to_string();

        let (slug, permanent_domain) = UserProfile::generate_slug_and_domain(&name, &email);

        let new_profile = UserProfile {
            name: name.clone(),
            email: email.clone(),
            phone: phone.clone(),
            slug,
            permanent_domain: permanent_domain.clone(),
            cloudflare_token: token.clone(),
            is_registered: true,
            created_at: current_time_str(),
        };

        let _ = new_profile.save();

        let token_opt = if token.trim().is_empty() {
            None
        } else {
            Some(token.as_str())
        };
        tunnel_mgr_reg.start_tunnel_with_token(port_reg, token_opt, Some(&permanent_domain));

        if let Some(ui_app) = ui_weak.upgrade() {
            let b = ui_app.global::<Bridge>();
            b.set_is_registered(true);
            b.set_user_name(SharedString::from(&name));
            b.set_user_email(SharedString::from(&email));
            b.set_user_phone(SharedString::from(&phone));
            b.set_permanent_domain(SharedString::from(&permanent_domain));
            b.set_cloudflare_token(SharedString::from(&token));

            let endpoint = format!("https://{}/sse", permanent_domain);
            b.set_endpoint_url(SharedString::from(&endpoint));
        }

        logs_reg.push(LogRow {
            text: SharedString::from(format!(
                "[{}] Profile registered. Permanent domain assigned: {}",
                current_time_str(),
                permanent_domain
            )),
            is_error: false,
            is_success: true,
        });
    });

    // Copy endpoint callback
    let ui_copy = ui.as_weak();
    let copy_timer_instant = Rc::new(Mutex::new(None::<Instant>));
    let copy_timer_ref = copy_timer_instant.clone();

    bridge.on_copy_endpoint(move || {
        if let Some(ui_app) = ui_copy.upgrade() {
            let b = ui_app.global::<Bridge>();
            let text = b.get_endpoint_url().to_string();
            // Copy to clipboard via arboard or clipboard
            let mut ctx = arboard::Clipboard::new();
            if let Ok(ref mut cb) = ctx {
                let _ = cb.set_text(text);
            }
            b.set_copied_active(true);
            if let Ok(mut guard) = copy_timer_ref.lock() {
                *guard = Some(Instant::now());
            }
        }
    });

    // Toggle server callback
    let ui_toggle = ui.as_weak();
    let logs_toggle = initial_logs.clone();
    bridge.on_toggle_server(move || {
        if let Some(ui_app) = ui_toggle.upgrade() {
            let b = ui_app.global::<Bridge>();
            let current = b.get_server_running();
            let new_state = !current;
            b.set_server_running(new_state);

            let msg = if new_state {
                format!("[{}] MCP Server resumed by operator.", current_time_str())
            } else {
                format!("[{}] MCP Server paused by operator.", current_time_str())
            };
            logs_toggle.push(LogRow {
                text: SharedString::from(msg),
                is_error: !new_state,
                is_success: new_state,
            });
        }
    });

    // Periodic timer for telemetry, tunnel URL update, and health sync
    let ui_timer = ui.as_weak();
    let tunnel_mgr_timer = tunnel_manager.clone();
    let health_timer = health_state.clone();
    let channels_model = Rc::new(VecModel::<ChannelInfo>::default());
    let channels_model_ref = channels_model.clone();
    let timer = slint::Timer::default();

    timer.start(
        slint::TimerMode::Repeated,
        std::time::Duration::from_millis(500),
        move || {
            let Some(ui_app) = ui_timer.upgrade() else { return };
            let b = ui_app.global::<Bridge>();

            // Check if copied state expired
            if let Ok(guard) = copy_timer_instant.lock() {
                if let Some(instant) = *guard {
                    if instant.elapsed().as_secs() >= 2 {
                        b.set_copied_active(false);
                    }
                }
            }

            // Sync tunnel URL if dynamic tunnel assigned
            if let Some(url) = tunnel_mgr_timer.get_public_url_sync() {
                let sse_url = format!("{}/sse", url.trim_end_matches('/'));
                if b.get_endpoint_url().as_str() != sse_url {
                    b.set_endpoint_url(SharedString::from(&sse_url));
                }
            }

            // Sync channels from health probe
            if let Ok(health_list) = health_timer.lock() {
                if !health_list.is_empty() && channels_model_ref.row_count() == 0 {
                    for entry in health_list.iter() {
                        let latency = if let Some(ms) = entry.latency_ms {
                            format!("{:>4} ms", ms)
                        } else {
                            "   -   ".to_string()
                        };

                        channels_model_ref.push(ChannelInfo {
                            name: SharedString::from(&entry.name),
                            latency: SharedString::from(latency),
                            message: SharedString::from(&entry.message),
                            tier: SharedString::from(entry.tier.label().to_uppercase()),
                            is_ready: entry.available,
                        });
                    }
                    b.set_channels(ModelRc::from(channels_model_ref.clone()));
                }
            }
        },
    );

    ui.run()
}

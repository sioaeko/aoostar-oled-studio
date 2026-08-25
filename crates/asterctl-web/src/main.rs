// SPDX-License-Identifier: MIT OR Apache-2.0

use std::net::SocketAddr;

use anyhow::Context;
use asterctl_lcd::AooScreenBuilder;
use asterctl_web::{BridgeRuntime, build_router};
use clap::Parser;
use env_logger::Env;
use log::{info, warn};

#[derive(Debug, Parser)]
#[command(version, about = "AOOSTAR display web UI and HTTP bridge")]
struct Args {
    /// HTTP listen address.
    #[arg(long, default_value = "127.0.0.1:8787")]
    bind: SocketAddr,

    /// Serial device path or Windows COM port. Takes priority over --usb.
    #[arg(long)]
    device: Option<String>,

    /// USB UART VID:PID in hexadecimal notation.
    #[arg(long)]
    usb: Option<String>,

    /// Use the in-process simulated serial port instead of hardware.
    #[arg(long)]
    simulate: bool,

    /// Write without requiring the display's initialization response.
    #[arg(long)]
    write_only: bool,

    /// Switch the display off when the server shuts down.
    #[arg(long)]
    off_on_exit: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    env_logger::Builder::from_env(Env::default().default_filter_or("info")).init();
    let args = Args::parse();
    let listener = tokio::net::TcpListener::bind(args.bind)
        .await
        .with_context(|| format!("failed to bind {}", args.bind))?;

    let mut builder = AooScreenBuilder::new();
    builder.no_init_check(args.write_only);
    let (mut screen, device_name) = if args.simulate {
        warn!("SIMULATION mode: no physical display will be touched");
        (builder.simulate()?, "simulated".to_string())
    } else if let Some(device) = args.device.as_deref() {
        (builder.open_device(device)?, device.to_string())
    } else if let Some(usb) = args.usb.as_deref() {
        (builder.open_usb_id(usb)?, format!("usb:{usb}"))
    } else {
        (builder.open_default()?, "usb:0416:90a1".to_string())
    };
    if let Err(init_error) = screen.init() {
        if let Err(off_error) = screen.off() {
            warn!("failed to switch display off after initialization error: {off_error:#}");
        }
        return Err(init_error).context("failed to initialize display");
    }

    let runtime = BridgeRuntime::spawn(Box::new(screen), args.simulate, device_name, true);
    let app = build_router(runtime.handle());
    info!("OLED Studio listening on http://{}", args.bind);

    let server_result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("HTTP server failed");
    let shutdown_result = runtime.shutdown(args.off_on_exit).await;

    server_result?;
    shutdown_result?;
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};

        let mut terminate =
            signal(SignalKind::terminate()).expect("failed to install SIGTERM handler");
        tokio::select! {
            result = tokio::signal::ctrl_c() => {
                result.expect("failed to install Ctrl+C handler");
            }
            _ = terminate.recv() => {}
        }
    }

    #[cfg(not(unix))]
    tokio::signal::ctrl_c()
        .await
        .expect("failed to install Ctrl+C handler");
}

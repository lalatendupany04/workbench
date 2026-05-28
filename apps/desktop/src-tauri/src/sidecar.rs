use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use tauri::async_runtime::Mutex as AsyncMutex;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::oneshot;
use tokio::time::timeout;

use crate::AppError;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(50);

/// One JSON-line event emitted by the sidecar on its stdout. Mirrors
/// `apps/desktop/sidecar/src/main.ts`. We use `untagged` so we don't have
/// to enumerate every field in this Rust file.
#[derive(Debug, Deserialize)]
#[serde(tag = "event", rename_all = "lowercase")]
enum SidecarEvent {
    Ready {
        port: u16,
        queues: u32,
        #[serde(default)]
        #[serde(rename = "discoveryTotal")]
        discovery_total: Option<u32>,
        #[serde(default)]
        #[serde(rename = "discoveryCapped")]
        discovery_capped: bool,
    },
    Error {
        code: String,
        message: String,
    },
}

pub struct SidecarManager {
    app: AppHandle,
}

impl SidecarManager {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    pub async fn spawn(
        &self,
        redis_url: String,
        prefix: Option<String>,
        max_queues: Option<u32>,
        username: Option<String>,
        password: Option<String>,
    ) -> Result<SidecarHandle, AppError> {
        let shell = self.app.shell();

        let mut cmd = shell
            .sidecar("workbench-sidecar")
            .map_err(|e| AppError::new("SIDECAR_NOT_FOUND", e.to_string()))?;

        // Non-sensitive config is fine via env vars. The password goes
        // through stdin (below) so it doesn't appear in `ps`.
        cmd = cmd.env("REDIS_URL", &redis_url);
        if let Some(prefix) = prefix {
            cmd = cmd.env("WORKBENCH_PREFIX", prefix);
        }
        if let Some(max) = max_queues {
            cmd = cmd.env("WORKBENCH_MAX_QUEUES", max.to_string());
        }
        if let Some(username) = username {
            cmd = cmd.env("REDIS_USERNAME", username);
        }

        let (mut rx, mut child) = cmd
            .spawn()
            .map_err(|e| AppError::new("SIDECAR_SPAWN_FAILED", e.to_string()))?;

        // Write the handshake JSON line — sidecar reads exactly the first
        // newline-terminated line, then ignores stdin for the rest of its
        // lifetime, so we don't need to close the pipe.
        let handshake = match password.as_deref() {
            Some(p) => serde_json::json!({ "password": p }),
            None => serde_json::json!({}),
        };
        let mut line = handshake.to_string();
        line.push('\n');
        if let Err(e) = child.write(line.as_bytes()) {
            let _ = child.kill();
            return Err(AppError::new(
                "SIDECAR_SPAWN_FAILED",
                format!("failed to write handshake to sidecar stdin: {e}"),
            ));
        }

        let child = Arc::new(AsyncMutex::new(Some(child)));
        let (ready_tx, ready_rx) = oneshot::channel::<Result<ReadyPayload, AppError>>();
        let mut ready_tx = Some(ready_tx);

        let app_handle = self.app.clone();
        let child_for_watcher = Arc::clone(&child);

        // Spawn the stdout reader as a background task. It does double duty:
        // surfaces the structured `ready` / `error` events for the
        // handshake (oneshot), and watches for unexpected exit afterwards
        // (emits `sidecar:crashed`).
        tauri::async_runtime::spawn(async move {
            let mut handshake_complete = false;

            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(line) => {
                        let line = String::from_utf8_lossy(&line);
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        if let Ok(evt) = serde_json::from_str::<SidecarEvent>(trimmed) {
                            match evt {
                                SidecarEvent::Ready {
                                    port,
                                    queues,
                                    discovery_total,
                                    discovery_capped,
                                } => {
                                    if let Some(tx) = ready_tx.take() {
                                        let _ = tx.send(Ok(ReadyPayload {
                                            port,
                                            queues,
                                            discovery_total,
                                            discovery_capped,
                                        }));
                                        handshake_complete = true;
                                    }
                                }
                                SidecarEvent::Error { code, message } => {
                                    if let Some(tx) = ready_tx.take() {
                                        let _ = tx.send(Err(AppError::new(code, message)));
                                    }
                                }
                            }
                        }
                    }
                    CommandEvent::Stderr(line) => {
                        log::warn!("sidecar stderr: {}", String::from_utf8_lossy(&line));
                    }
                    CommandEvent::Terminated(payload) => {
                        if !handshake_complete {
                            if let Some(tx) = ready_tx.take() {
                                let _ = tx.send(Err(AppError::new(
                                    "CRASH",
                                    format!("Sidecar exited with code {:?}", payload.code),
                                )));
                            }
                        } else {
                            // Unexpected exit after we had a ready connection.
                            // Drop the child and notify the UI so it can offer
                            // a one-click reconnect.
                            let mut guard = child_for_watcher.lock().await;
                            *guard = None;
                            let _ = app_handle.emit(
                                "workbench://sidecar-crashed",
                                serde_json::json!({ "code": payload.code }),
                            );
                        }
                        break;
                    }
                    _ => {}
                }
            }
        });

        let payload = match timeout(HANDSHAKE_TIMEOUT, ready_rx).await {
            Err(_) => {
                // Handshake didn't complete in time — kill the child so we
                // don't leak it, then surface the timeout to the UI.
                if let Some(child) = child.lock().await.take() {
                    let _ = child.kill();
                }
                return Err(AppError::new(
                    "TIMEOUT",
                    "Sidecar did not become ready within 8 seconds",
                ));
            }
            Ok(Err(_canceled)) => {
                // Sender dropped — process likely exited before emitting.
                return Err(AppError::new("CRASH", "Sidecar exited before ready"));
            }
            Ok(Ok(Err(e))) => {
                if let Some(child) = child.lock().await.take() {
                    let _ = child.kill();
                }
                return Err(e);
            }
            Ok(Ok(Ok(payload))) => payload,
        };

        Ok(SidecarHandle {
            port: payload.port,
            queues: payload.queues,
            discovery_total: payload.discovery_total,
            discovery_capped: payload.discovery_capped,
            child,
        })
    }
}

struct ReadyPayload {
    port: u16,
    queues: u32,
    discovery_total: Option<u32>,
    discovery_capped: bool,
}

/// Owned handle to a running sidecar. Dropping the handle does NOT kill the
/// child automatically — call `shutdown()` (async) or `shutdown_blocking()`
/// (used from the sync exit-requested handler).
pub struct SidecarHandle {
    pub port: u16,
    pub queues: u32,
    pub discovery_total: Option<u32>,
    pub discovery_capped: bool,
    child: Arc<AsyncMutex<Option<CommandChild>>>,
}

impl SidecarHandle {
    pub async fn shutdown(self) {
        if let Some(child) = self.child.lock().await.take() {
            let _ = child.kill();
        }
    }

    /// Sync variant used from the `RunEvent::ExitRequested` handler. Tries
    /// to acquire the async mutex without blocking; if contended, falls
    /// back to a short spin so we don't leak the process on quit.
    pub fn shutdown_blocking(self) {
        match self.child.try_lock() {
            Ok(mut guard) => {
                if let Some(child) = guard.take() {
                    let _ = child.kill();
                }
            }
            Err(_) => {
                // Contended — process the kill via a fresh runtime handle.
                tauri::async_runtime::block_on(async {
                    if let Some(child) = self.child.lock().await.take() {
                        let _ = child.kill();
                    }
                });
            }
        }
    }
}

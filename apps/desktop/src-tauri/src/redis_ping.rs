use crate::AppError;

/// Lightweight reachability check used by the onboarding "Reach Redis" pill.
/// Runs in Rust before we bother spawning the sidecar, so the user sees a
/// fast failure for common cases (refused, DNS).
///
/// Returns the same `AppError.code` taxonomy as the sidecar so the UI has
/// one switch statement.
pub async fn ping(url: &str) -> Result<(), AppError> {
    // Some managed Redis endpoints (notably AWS ElastiCache config endpoints)
    // require TLS even when users type redis://. Mirror sidecar behavior:
    // if the first ping looks like a TLS/closed-socket failure, retry once
    // with rediss:// transparently.
    match ping_once(url).await {
        Ok(()) => Ok(()),
        Err(first) => {
            if should_retry_with_tls(url, &first) {
                let tls_url = force_tls_url(url);
                ping_once(&tls_url).await
            } else {
                Err(first)
            }
        }
    }
}

async fn ping_once(url: &str) -> Result<(), AppError> {
    let client = redis::Client::open(url).map_err(|e| AppError::new("REDIS_URL_INVALID", e.to_string()))?;

    let connect_fut = client.get_multiplexed_async_connection();
    let timeout = std::time::Duration::from_secs(5);

    let mut conn = match tokio::time::timeout(timeout, connect_fut).await {
        Err(_) => return Err(AppError::new("REDIS_TIMEOUT", "Timed out connecting to Redis")),
        Ok(Err(e)) => return Err(classify(e)),
        Ok(Ok(conn)) => conn,
    };

    let pong: Result<String, _> = redis::cmd("PING").query_async(&mut conn).await;
    match pong {
        Ok(_) => Ok(()),
        Err(e) => Err(classify(e)),
    }
}

fn should_retry_with_tls(url: &str, err: &AppError) -> bool {
    url.starts_with("redis://")
        && (err.code == "REDIS_TLS" || err.message.to_lowercase().contains("connection is closed"))
}

fn force_tls_url(url: &str) -> String {
    url.replacen("redis://", "rediss://", 1)
}

fn classify(err: redis::RedisError) -> AppError {
    let kind = err.kind();
    let msg = err.to_string();
    let lower = msg.to_lowercase();

    if lower.contains("connection is closed") {
        return AppError::new("REDIS_TLS", msg);
    }

    let code = match kind {
        redis::ErrorKind::AuthenticationFailed => "REDIS_AUTH",
        redis::ErrorKind::IoError => {
            if lower.contains("connection refused") {
                "REDIS_REFUSED"
            } else if lower.contains("name") || lower.contains("dns") || lower.contains("not known") {
                "REDIS_DNS"
            } else if lower.contains("tls") || lower.contains("ssl") || lower.contains("certificate")
            {
                "REDIS_TLS"
            } else if lower.contains("timed out") {
                "REDIS_TIMEOUT"
            } else {
                "REDIS_IO"
            }
        }
        _ => {
            if lower.contains("noauth") || lower.contains("wrongpass") {
                "REDIS_AUTH"
            } else {
                "UNKNOWN"
            }
        }
    };

    AppError::new(code, msg)
}

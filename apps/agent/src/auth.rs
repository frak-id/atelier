//! Bearer-token auth for every agent listener. The runtime injects a
//! per-sandbox `AGENT_PASSWORD` into the pod env and sends it as
//! `Authorization: Bearer <token>` on every HTTP request and WS upgrade
//! (HTTP :9998, and the attach/terminal WS on :9997). Only `GET /health`
//! stays open (it carries no sensitive data and backs the boot liveness
//! poll). Without a token the agent serves nothing else: an unset password
//! must not degrade to "open to the pod network".
//!
//! WS upgrades also accept `?token=`: the server's relays dial the agent with
//! a bare URL string.

use hyper::StatusCode;
use hyper::header::{AUTHORIZATION, HeaderMap};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};

pub const TOKEN_ENV: &str = "AGENT_PASSWORD";

#[derive(Debug, PartialEq, Eq)]
pub enum Denied {
    /// No `AGENT_PASSWORD` configured: nothing but `/health` is served.
    NotConfigured,
    /// Missing or wrong token.
    Unauthorized,
}

pub struct Auth {
    token: Option<String>,
}

impl Auth {
    pub fn new(token: Option<String>) -> Self {
        Self {
            token: token.filter(|t| !t.is_empty()),
        }
    }

    pub fn from_env() -> Self {
        let auth = Self::new(std::env::var(TOKEN_ENV).ok());
        if auth.token.is_none() {
            eprintln!(
                "atelier-agent: ERROR: {TOKEN_ENV} is not set; refusing every route but GET /health"
            );
        }
        auth
    }

    /// HTTP: `Authorization: Bearer <token>`.
    pub fn check_http(&self, headers: &HeaderMap) -> Result<(), Denied> {
        self.check(bearer(headers))
    }

    /// WS upgrade: the bearer header, else `?token=`.
    pub fn check_ws(&self, headers: &HeaderMap, query: &str) -> Result<(), Denied> {
        self.check(bearer(headers).or_else(|| query_param(query, "token")))
    }

    /// `accept_hdr_async` callback: a failed check becomes the HTTP response
    /// of the refused upgrade (401, or 503 when no token is configured).
    // The callback signature fixes the (large) error type.
    #[allow(clippy::result_large_err)]
    pub fn upgrade_guard(
        &self,
    ) -> impl FnOnce(&Request, Response) -> Result<Response, ErrorResponse> + '_ {
        |req, resp| {
            let query = req.uri().query().unwrap_or("");
            self.check_ws(req.headers(), query)
                .map(|()| resp)
                .map_err(|denied| {
                    let (status, message) = match denied {
                        Denied::NotConfigured => (
                            StatusCode::SERVICE_UNAVAILABLE,
                            "agent token not configured",
                        ),
                        Denied::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
                    };
                    let mut resp = ErrorResponse::new(Some(message.to_string()));
                    *resp.status_mut() = status;
                    resp
                })
        }
    }

    fn check(&self, presented: Option<&str>) -> Result<(), Denied> {
        let Some(expected) = &self.token else {
            return Err(Denied::NotConfigured);
        };
        match presented {
            Some(p) if constant_time_eq(p.as_bytes(), expected.as_bytes()) => Ok(()),
            _ => Err(Denied::Unauthorized),
        }
    }
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    scheme
        .eq_ignore_ascii_case("bearer")
        .then_some(token.trim())
}

fn query_param<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query
        .split('&')
        .find_map(|pair| pair.strip_prefix(key)?.strip_prefix('='))
}

/// Compare without an early exit on the first differing byte. Runs over the
/// expected length only, so the one thing timing can reveal is that length.
fn constant_time_eq(presented: &[u8], expected: &[u8]) -> bool {
    let mut diff = presented.len() ^ expected.len();
    for (i, e) in expected.iter().enumerate() {
        diff |= usize::from(presented.get(i).copied().unwrap_or(0) ^ e);
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::header::HeaderValue;

    fn headers(value: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(AUTHORIZATION, HeaderValue::from_str(value).unwrap());
        h
    }

    #[test]
    fn accepts_only_the_right_bearer_token() {
        let auth = Auth::new(Some("s3cret".into()));
        assert_eq!(auth.check_http(&headers("Bearer s3cret")), Ok(()));
        assert_eq!(auth.check_http(&headers("bearer s3cret")), Ok(()));
        for bad in [
            "Bearer wrong",
            "Bearer s3cre",
            "Bearer s3crets",
            "s3cret",
            "Basic s3cret",
        ] {
            assert_eq!(
                auth.check_http(&headers(bad)),
                Err(Denied::Unauthorized),
                "{bad}"
            );
        }
        assert_eq!(
            auth.check_http(&HeaderMap::new()),
            Err(Denied::Unauthorized)
        );
    }

    #[test]
    fn no_token_configured_denies_everything() {
        for auth in [Auth::new(None), Auth::new(Some(String::new()))] {
            assert_eq!(
                auth.check_http(&headers("Bearer ")),
                Err(Denied::NotConfigured)
            );
            assert_eq!(
                auth.check_http(&HeaderMap::new()),
                Err(Denied::NotConfigured)
            );
        }
    }

    #[test]
    fn ws_accepts_the_token_query_param() {
        let auth = Auth::new(Some("s3cret".into()));
        let none = HeaderMap::new();
        assert_eq!(auth.check_ws(&none, "mode=rw&token=s3cret"), Ok(()));
        assert_eq!(
            auth.check_ws(&none, "token=nope"),
            Err(Denied::Unauthorized)
        );
        assert_eq!(auth.check_ws(&none, "mode=rw"), Err(Denied::Unauthorized));
        // The header wins over a bad query token.
        assert_eq!(
            auth.check_ws(&headers("Bearer s3cret"), "token=nope"),
            Ok(())
        );
    }

    #[test]
    fn constant_time_eq_matches_plain_equality() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"ab", b"abc"));
        assert!(!constant_time_eq(b"abcd", b"abc"));
        assert!(constant_time_eq(b"", b""));
    }
}

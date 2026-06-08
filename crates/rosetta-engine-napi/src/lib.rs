//! NAPI bindings for rosetta-engine.
//!
//! Two API modes:
//!
//! 1. **Stateless** (legacy): `translate(catalogsJson, key, ...)` — parses the
//!    full catalog JSON on every call. Kept for backward compat.
//!
//! 2. **Stateful** (Story 37.9): `RosettaEngine` class — loads the catalog once
//!    via `loadCatalogs(json)`, then `translate(key, ...)` reuses the parsed
//!    in-memory catalog. Eliminates the per-call JSON.stringify + parse overhead
//!    that dominated hot translation paths.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::panic::catch_unwind;
use std::sync::Mutex;

// ─── Stateful API (recommended) ────────────────────────────────

/// Resident translation engine — holds parsed catalogs in Rust memory.
/// Created once per `Rosetta` instance on the TS side.
#[napi]
pub struct RosettaEngine {
    catalogs: Mutex<rosetta_engine::engine::Catalogs>,
}

#[napi]
impl RosettaEngine {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            catalogs: Mutex::new(Default::default()),
        }
    }

    /// Replace the in-memory catalogs. Called when the TS side detects a dirty
    /// flag (new locale loaded, catalog edited). Only then is `JSON.stringify`
    /// performed — not on every `t()` call.
    #[napi]
    pub fn load_catalogs(&self, catalogs_json: String) -> Result<()> {
        let parsed: rosetta_engine::engine::Catalogs = serde_json::from_str(&catalogs_json)
            .map_err(|e| Error::from_reason(format!("Invalid catalogs JSON: {}", e)))?;
        let mut guard = self.catalogs.lock()
            .map_err(|_| Error::from_reason("Catalog lock poisoned"))?;
        *guard = parsed;
        Ok(())
    }

    /// Translate a key using the resident catalogs.
    #[napi]
    pub fn translate(
        &self,
        key: String,
        params_json: Option<String>,
        chain_json: String,
        default_value: Option<String>,
    ) -> Result<String> {
        let result = catch_unwind(std::panic::AssertUnwindSafe(|| -> std::result::Result<String, String> {
            let guard = self.catalogs.lock()
                .map_err(|_| "Catalog lock poisoned".to_string())?;
            let params = parse_params(params_json.as_deref())?;
            let chain: Vec<String> = serde_json::from_str(&chain_json)
                .map_err(|e| format!("Invalid chain JSON: {}", e))?;
            Ok(rosetta_engine::translate(&guard, &key, params.as_ref(), &chain, default_value.as_deref()))
        }));
        match result {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(e)) => Err(Error::from_reason(e)),
            Err(_) => Err(Error::from_reason("Internal panic in rosetta engine")),
        }
    }

    /// Check if a key exists in the resident catalogs.
    #[napi]
    pub fn has(&self, key: String, chain_json: String) -> Result<bool> {
        let result = catch_unwind(std::panic::AssertUnwindSafe(|| -> std::result::Result<bool, String> {
            let guard = self.catalogs.lock()
                .map_err(|_| "Catalog lock poisoned".to_string())?;
            let chain: Vec<String> = serde_json::from_str(&chain_json)
                .map_err(|e| format!("Invalid chain JSON: {}", e))?;
            Ok(rosetta_engine::has_key(&guard, &key, &chain))
        }));
        match result {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(e)) => Err(Error::from_reason(e)),
            Err(_) => Err(Error::from_reason("Internal panic in rosetta engine")),
        }
    }
}

// ─── Stateless API (legacy compat) ─────────────────────────────

#[napi]
pub fn translate(
    catalogs_json: String,
    key: String,
    params_json: Option<String>,
    chain_json: String,
    default_value: Option<String>,
) -> Result<String> {
    let result = catch_unwind(|| -> std::result::Result<String, String> {
        let catalogs: rosetta_engine::engine::Catalogs =
            serde_json::from_str(&catalogs_json).map_err(|e| format!("Invalid catalogs JSON: {}", e))?;
        let params = parse_params(params_json.as_deref())?;
        let chain: Vec<String> =
            serde_json::from_str(&chain_json).map_err(|e| format!("Invalid chain JSON: {}", e))?;
        Ok(rosetta_engine::translate(&catalogs, &key, params.as_ref(), &chain, default_value.as_deref()))
    });
    match result {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(e)) => Err(Error::from_reason(e)),
        Err(_) => Err(Error::from_reason("Internal panic in rosetta engine")),
    }
}

#[napi]
pub fn has(catalogs_json: String, key: String, chain_json: String) -> Result<bool> {
    let result = catch_unwind(|| -> std::result::Result<bool, String> {
        let catalogs: rosetta_engine::engine::Catalogs =
            serde_json::from_str(&catalogs_json).map_err(|e| format!("Invalid catalogs JSON: {}", e))?;
        let chain: Vec<String> =
            serde_json::from_str(&chain_json).map_err(|e| format!("Invalid chain JSON: {}", e))?;
        Ok(rosetta_engine::has_key(&catalogs, &key, &chain))
    });
    match result {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(e)) => Err(Error::from_reason(e)),
        Err(_) => Err(Error::from_reason("Internal panic in rosetta engine")),
    }
}

// ─── Shared helpers ────────────────────────────────────────────

fn parse_params(raw: Option<&str>) -> std::result::Result<Option<std::collections::HashMap<String, serde_json::Value>>, String> {
    match raw {
        Some(json) => {
            let map: std::collections::HashMap<String, serde_json::Value> =
                serde_json::from_str(json).map_err(|e| format!("Invalid params JSON: {}", e))?;
            Ok(Some(map))
        }
        None => Ok(None),
    }
}

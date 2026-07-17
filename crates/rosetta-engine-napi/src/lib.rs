//! NAPI bindings for rosetta-engine.
//!
//! Parsing only: an ICU message or a translation catalog is parsed and
//! validated in Rust, and returned as JSON for JavaScript to cache. Rendering
//! stays in JavaScript on ECMA-402 — see the crate root for why.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::panic::catch_unwind;

/// Parse and validate an ICU MessageFormat string in Rust. JavaScript keeps the
/// locale-sensitive ECMA-402 rendering, but no longer reparses message syntax.
#[napi]
pub fn parse_message(message: String) -> Result<String> {
    let result = catch_unwind(|| {
        let ast = rosetta_engine::parse_message(&message)?;
        serde_json::to_string(&ast).map_err(|error| error.to_string())
    });
    match result {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(Error::from_reason(error)),
        Err(_) => Err(Error::from_reason("Internal panic in rosetta engine")),
    }
}

/// Parse a JSON/YAML translation catalog in Rust and return normalized JSON.
#[napi]
pub fn parse_catalog(input: String, format: String) -> Result<String> {
    let result = catch_unwind(|| {
        let catalog = rosetta_engine::parse_catalog(&input, &format)?;
        serde_json::to_string(&catalog).map_err(|error| error.to_string())
    });
    match result {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(Error::from_reason(error)),
        Err(_) => Err(Error::from_reason("Internal panic in rosetta engine")),
    }
}

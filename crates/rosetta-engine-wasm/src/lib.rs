use std::collections::HashMap;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn translate(
    catalogs_json: &str,
    key: &str,
    params_json: Option<String>,
    chain_json: &str,
    default_value: Option<String>,
) -> Result<String, JsValue> {
    let catalogs: rosetta_engine::engine::Catalogs = serde_json::from_str(catalogs_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid catalogs: {}", e)))?;
    let params: Option<HashMap<String, serde_json::Value>> = match params_json {
        Some(raw) => Some(
            serde_json::from_str(&raw)
                .map_err(|e| JsValue::from_str(&format!("Invalid params: {}", e)))?,
        ),
        None => None,
    };
    let chain: Vec<String> = serde_json::from_str(chain_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid chain: {}", e)))?;
    // Guard the engine call so an internal panic surfaces as a catchable JS error
    // instead of trapping the whole wasm module (RO8 — parity with the napi binding).
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        rosetta_engine::translate(
            &catalogs,
            key,
            params.as_ref(),
            &chain,
            default_value.as_deref(),
        )
    }))
    .map_err(|_| JsValue::from_str("Internal panic in rosetta engine"))
}

#[wasm_bindgen]
pub fn has(catalogs_json: &str, key: &str, chain_json: &str) -> Result<bool, JsValue> {
    let catalogs: rosetta_engine::engine::Catalogs = serde_json::from_str(catalogs_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid catalogs: {}", e)))?;
    let chain: Vec<String> = serde_json::from_str(chain_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid chain: {}", e)))?;
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        rosetta_engine::has_key(&catalogs, key, &chain)
    }))
    .map_err(|_| JsValue::from_str("Internal panic in rosetta engine"))
}

#[wasm_bindgen]
pub fn parse_message(message: &str) -> Result<String, JsValue> {
    let ast = rosetta_engine::parse_message(message).map_err(|error| JsValue::from_str(&error))?;
    serde_json::to_string(&ast)
        .map_err(|error| JsValue::from_str(&format!("Cannot serialize ICU AST: {}", error)))
}

#[wasm_bindgen]
pub fn parse_catalog(input: &str, format: &str) -> Result<String, JsValue> {
    let catalog =
        rosetta_engine::parse_catalog(input, format).map_err(|error| JsValue::from_str(&error))?;
    serde_json::to_string(&catalog)
        .map_err(|error| JsValue::from_str(&format!("Cannot serialize catalog: {}", error)))
}

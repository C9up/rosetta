use wasm_bindgen::prelude::*;
use std::collections::HashMap;

#[wasm_bindgen]
pub fn translate(
    catalogs_json: &str,
    key: &str,
    params_json: Option<String>,
    chain_json: &str,
    default_value: Option<String>,
) -> Result<String, JsValue> {
    let catalogs: rosetta_engine::engine::Catalogs =
        serde_json::from_str(catalogs_json).map_err(|e| JsValue::from_str(&format!("Invalid catalogs: {}", e)))?;
    let params: Option<HashMap<String, serde_json::Value>> = match params_json {
        Some(raw) => Some(serde_json::from_str(&raw).map_err(|e| JsValue::from_str(&format!("Invalid params: {}", e)))?),
        None => None,
    };
    let chain: Vec<String> =
        serde_json::from_str(chain_json).map_err(|e| JsValue::from_str(&format!("Invalid chain: {}", e)))?;
    Ok(rosetta_engine::translate(&catalogs, key, params.as_ref(), &chain, default_value.as_deref()))
}

#[wasm_bindgen]
pub fn has(catalogs_json: &str, key: &str, chain_json: &str) -> Result<bool, JsValue> {
    let catalogs: rosetta_engine::engine::Catalogs =
        serde_json::from_str(catalogs_json).map_err(|e| JsValue::from_str(&format!("Invalid catalogs: {}", e)))?;
    let chain: Vec<String> =
        serde_json::from_str(chain_json).map_err(|e| JsValue::from_str(&format!("Invalid chain: {}", e)))?;
    Ok(rosetta_engine::has_key(&catalogs, key, &chain))
}

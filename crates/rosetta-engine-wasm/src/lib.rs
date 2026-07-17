use wasm_bindgen::prelude::*;

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

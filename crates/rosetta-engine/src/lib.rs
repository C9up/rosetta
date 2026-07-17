//! Rosetta engine — Rust translation helpers.
//!
//! Scope: parsing only. ICU messages and translation catalogs are parsed and
//! validated here; rendering stays in JavaScript, on the runtime's ECMA-402
//! implementation, so CLDR plural rules and number/date formatting track the
//! platform instead of a table maintained by hand.

pub mod catalog;
pub mod message_ast;
mod skeleton;

pub use catalog::parse_catalog;
pub use message_ast::{parse_message, MessageNode};

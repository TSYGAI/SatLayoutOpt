//! 文件说明：SQLite 连接与通用行解码；只用于 Rust 业务持久化，在阻塞线程执行。
use crate::{config::Config, error::Result};
use rusqlite::{types::ValueRef, Connection, Row};
use serde_json::{json, Map, Value};
use std::path::Path;

/// 打开短生命周期连接并启用外键及集中配置的锁等待时间。
pub fn connect(path: &Path, config: &Config) -> Result<Connection> {
    let _logging_step =
        crate::monitoring::Step::new("database::connect", serde_json::json!({"path":path}));
    let connection = Connection::open(path)?;
    connection.busy_timeout(std::time::Duration::from_secs(
        config.integer("rust_backend", "database_timeout_seconds"),
    ))?;
    connection.execute_batch("PRAGMA foreign_keys=ON")?;
    Ok(connection)
}
/// 按列名解码标量行；JSON 列由领域存储层单独解析。
pub fn row(row: &Row<'_>) -> rusqlite::Result<Value> {
    let _logging_step = crate::monitoring::Step::new("database::row", serde_json::json!({}));
    let mut result = Map::new();
    for (index, name) in row.as_ref().column_names().iter().enumerate() {
        let value = match row.get_ref(index)? {
            ValueRef::Null => Value::Null,
            ValueRef::Integer(v) => json!(v),
            ValueRef::Real(v) => json!(v),
            ValueRef::Text(v) => json!(String::from_utf8_lossy(v)),
            ValueRef::Blob(_) => Value::Null,
        };
        result.insert((*name).into(), value);
    }
    Ok(Value::Object(result))
}

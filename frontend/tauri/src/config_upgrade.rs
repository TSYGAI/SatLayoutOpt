//! 文件说明：为旧安装配置补齐当前版本缺项并移除已废弃日志路径，保留其余用户值和注释。

use std::path::Path;
use toml_edit::{Document, Table};

/// 仅递归添加缺失的键和表，已有用户值保持原样；类型不兼容由启动校验明确报错。
fn fill_missing(current: &mut Table, defaults: &Table) {
    for (name, item) in defaults.iter() {
        if let Some(existing) = current.get_mut(name) {
            if let (Some(current), Some(defaults)) = (existing.as_table_mut(), item.as_table()) {
                fill_missing(current, defaults);
            }
        } else {
            let (key, _) = defaults.get_key_value(name).expect("遍历中的配置键存在");
            current.insert_formatted(key, item.clone());
        }
    }
}

/// 返回补齐缺项后的 TOML；编译时嵌入唯一集中配置，无需另维护默认配置文件。
pub fn merge(text: &str) -> Result<String, Box<dyn std::error::Error>> {
    let mut current: Document = text.parse()?;
    if let Some(backend) = current
        .get_mut("rust_backend")
        .and_then(|item| item.as_table_mut())
    {
        backend.remove("log_dir");
    }
    let defaults: Document = include_str!("../../../config/sat_layout_opt.toml").parse()?;
    fill_missing(current.as_table_mut(), defaults.as_table());
    Ok(current.to_string())
}

/// 配置确有变化才先备份再写入；备份位于用户数据根目录，写入失败可从日志提示的位置恢复。
pub fn save(path: &Path, before: &str, after: &str, data: &Path) -> std::io::Result<()> {
    if before == after {
        return Ok(());
    }
    let backups = data.join("config-backups");
    std::fs::create_dir_all(&backups)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(std::io::Error::other)?
        .as_nanos();
    let backup = backups.join(format!("sat_layout_opt-{stamp}.toml"));
    std::fs::write(&backup, before)?;
    let temporary = path.with_extension(format!("{stamp}.tmp"));
    std::fs::write(&temporary, after)?;
    std::fs::rename(temporary, path)
}

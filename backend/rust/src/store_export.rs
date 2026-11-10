//! 文件说明：为固化正式包络生成按记录名称命名的下载资源；STL 转换委托独立计算引擎。
//! 输入复制在固化锁内完成，派生结果仅存于任务暂存目录，不修改 NPZ、数据库或原始模型。

use crate::{
    blocking,
    compute::{Engine, Outcome, Task},
    error::{Error, Result},
    store::Store,
};
use std::{path::PathBuf, sync::Arc};
use tokio_util::sync::CancellationToken;

/// 保留记录名称中的中文与合法字符，替换文件系统禁用字符；基础包络无后缀，历史方向附角度。
pub fn download_filename(name: &str, rotation: i64, extension: &str) -> String {
    let _logging_step =
        crate::monitoring::Step::new("store_export::download_filename", serde_json::json!({}));
    let clean: String = name
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_control() || "<>:\"/\\|?*".contains(ch) {
                '_'
            } else {
                ch
            }
        })
        .collect();
    let mut stem = clean.trim_end_matches([' ', '.']).to_string();
    for suffix in [".step", ".stp", ".npz", ".stl", ".glb"] {
        if stem.to_ascii_lowercase().ends_with(suffix) {
            stem.truncate(stem.len() - suffix.len());
            break;
        }
    }
    if stem.is_empty() {
        stem = "未命名模型".into();
    }
    let reserved = stem.split('.').next().unwrap_or("").to_ascii_uppercase();
    if [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ]
    .contains(&reserved.as_str())
    {
        stem.insert(0, '_');
    }
    if rotation == 0 {
        format!("{stem}.{extension}")
    } else {
        format!("{stem}_Rz{rotation}.{extension}")
    }
}

impl Store {
    /// 校验记录与历史方向，返回正式 NPZ 路径和按保存名称命名的文件名；缺失时返回 404。
    pub fn variant_download(
        &self,
        id: &str,
        rotation: i64,
        extension: &str,
    ) -> Result<(PathBuf, String)> {
        let _logging_step = crate::monitoring::Step::new(
            "store_export::variant_download",
            serde_json::json!({"id":id}),
        );
        let record = self.get(id)?;
        let variant = record["envelope"]["variants"]
            .as_array()
            .and_then(|items| items.iter().find(|variant| variant["rot_z"] == rotation))
            .ok_or_else(|| Error::missing("固化记录中没有该方向的包络变体"))?;
        let path = self.asset(&record, variant["asset_name"].as_str().unwrap_or(""))?;
        let filename = download_filename(
            record["device_name"].as_str().unwrap_or(""),
            rotation,
            extension,
        );
        Ok((path, filename))
    }

    /// 复制不可变输入后在受资源预算约束的独立进程导出 STL，返回持有暂存目录的结果及文件名。
    pub async fn export_stl(
        self: &Arc<Self>,
        engine: &Arc<Engine>,
        id: &str,
        rotation: i64,
    ) -> Result<(Outcome, String)> {
        let _logging_step =
            crate::monitoring::Step::new("store_export::export_stl", serde_json::json!({"id":id}));
        let this = self.clone();
        let key = id.to_string();
        let (task, filename) = blocking(move || {
            let _guard = this.lock.lock().unwrap();
            let (source, filename) = this.variant_download(&key, rotation, "stl")?;
            let mut task = Task::new(&this.config, "envelope.export-stl", &serde_json::json!({}))?;
            task.add("envelope", "envelope.npz", &source)?;
            Ok((task, filename))
        })
        .await?;
        let outcome = engine
            .run(task, id, CancellationToken::new(), None)
            .await
            .map_err(|error| Error::conflict(error.message))?;
        if outcome.cancelled {
            return Err(Error::conflict("包络导出已取消"));
        }
        Ok((outcome, filename))
    }
}

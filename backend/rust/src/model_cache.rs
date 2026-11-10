//! 文件说明：包络浏览资源与前端运行缓存；复用已验证几何，缓存写入采用生成标识的乐观校验。
use crate::{
    blocking,
    compute::Task,
    error::{Error, Result},
    files,
    models::Models,
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio_util::sync::CancellationToken;

impl Models {
    /// 返回双 LOD 的生成标识；缺失任何一档时禁止写入运行缓存。
    pub fn cache_signature(&self, model: &Value) -> Option<Value> {
        let _logging_step =
            crate::monitoring::Step::new("model_cache::cache_signature", serde_json::json!({}));
        let interaction = self.current_preview(model, "interaction")?;
        let detail = self.current_preview(model, "detail")?;
        Some(json!([
            interaction["generated_at"].as_str()?,
            detail["generated_at"].as_str()?
        ]))
    }
    /// 查找仍有效的浏览器二进制缓存；缓存未就绪立即返回 404。
    pub fn cache_path(&self, id: &str) -> Result<PathBuf> {
        let _logging_step =
            crate::monitoring::Step::new("model_cache::cache_path", serde_json::json!({"id":id}));
        let model = self.get(id)?;
        let path = self.root(id).join("runtime-preview.bin");
        if !path.is_file() || self.cache_signature(&model).is_none() {
            return Err(Error::cache_miss("模型预览运行缓存尚未就绪"));
        }
        Ok(path)
    }
    /// 在流式缓存接收完成后重新校验两档标识，再原子发布；格式及大小在 HTTP 层检查。
    pub fn publish_cache(&self, id: &str, path: &Path, signature: &Value) -> Result<()> {
        let _logging_step = crate::monitoring::Step::new(
            "model_cache::publish_cache",
            serde_json::json!({"id":id,"path":path}),
        );
        let state = self.state.lock().unwrap();
        let model = self.find(&state, id)?;
        if self.cache_signature(&model).as_ref() != Some(signature) {
            return Err(Error::bad("模型预览产物已更新，请重新加载后再保存缓存"));
        }
        files::replace(path, &self.root(id).join("runtime-preview.bin"))
    }
    /// 从有效包络生成 GLB 并缓存数组规模；固化记录复用此规模，避免 Rust 重写 NPZ 算法。
    pub async fn envelope_preview(self: &Arc<Self>, id: &str) -> Result<PathBuf> {
        let _logging_step = crate::monitoring::Step::new(
            "model_cache::envelope_preview",
            serde_json::json!({"id":id}),
        );
        let _gate = self.gate(id, "envelope").await;
        let this = self.clone();
        let key = id.to_string();
        let (task, expected) = blocking(move || {
            let state = this.state.lock().unwrap();
            let model = this.find(&state, &key)?;
            let envelope = this
                .current_envelope(&model)
                .ok_or_else(|| Error::missing("包络尚未生成或已失效，请先生成包络"))?;
            let root = this.root(&key).join("envelope");
            if root.join("preview.glb").is_file() && root.join("preview-counts.json").is_file() {
                return Ok((None, envelope));
            }
            let preview = this
                .current_preview(&model, "detail")
                .or_else(|| this.current_preview(&model, "interaction"))
                .ok_or_else(|| Error::missing("模型预览网格已失效，请重新生成包络"))?;
            let mut task = Task::new(
                &this.config,
                "envelope.preview",
                &json!({"settings":model["settings"]}),
            )?;
            let variant = envelope["variants"]
                .as_array()
                .unwrap()
                .iter()
                .find(|v| v["rot_z"] == 0)
                .ok_or_else(|| Error::bad("缺少基础包络"))?;
            task.add(
                "envelope",
                "envelope.npz",
                &files::within(&root, variant["file_name"].as_str().unwrap_or(""))?,
            )?;
            task.add(
                "preview",
                "preview.glb",
                &files::within(
                    &this
                        .root(&key)
                        .join(preview["quality"].as_str().unwrap_or("")),
                    preview["browser_asset"]["file_name"].as_str().unwrap_or(""),
                )?,
            )?;
            Ok((Some(task), envelope))
        })
        .await?;
        let Some(task) = task else {
            return Ok(self.root(id).join("envelope/preview.glb"));
        };
        let outcome = self
            .engine
            .run(task, id, CancellationToken::new(), None)
            .await?;
        if outcome.cancelled {
            return Err(Error::bad("包络预览已取消"));
        }
        let this = self.clone();
        let key = id.to_string();
        blocking(move || {
            let state = this.state.lock().unwrap();
            let current = this.find(&state, &key)?;
            if this.current_envelope(&current).as_ref() != Some(&expected) {
                return Err(Error::missing("包络在加载期间已失效，请重新生成"));
            }
            let root = this.root(&key).join("envelope");
            let preview = root.join("preview.glb");
            files::replace(&outcome.task.output.join("artifacts/preview.glb"), &preview)?;
            files::write_json(&root.join("preview-counts.json"), &outcome.result["counts"])?;
            Ok(preview)
        })
        .await
    }
}

//! 文件说明：按 STEP 内容摘要复用已有双 LOD 产物；只共享不可变几何，重写记录归属，不复制模型业务设置或包络。
use crate::{
    error::{Error, Result},
    files, model_manifests as manifests,
    models::Models,
    prepared_cache,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
};

/// 源摘要仅在进程内按路径和文件指纹记忆；旧索引无需迁移，重启后按需计算。
#[derive(Default)]
pub struct SourceDigests(Mutex<HashMap<PathBuf, (Value, String)>>);

impl SourceDigests {
    /// 流式计算内容 SHA-256；文件大小或修改时间变化后重新计算，读取期间变化拒绝命中。
    pub fn get(&self, path: &Path) -> Result<(Value, String)> {
        let source = manifests::source(path)?;
        if let Some((stamp, digest)) = self.0.lock().unwrap().get(path) {
            if *stamp == source {
                return Ok((source, digest.clone()));
            }
        }
        let digest = files::hash(path)?;
        if manifests::source(path)? != source {
            return Err(Error::conflict("模型源文件在摘要校验期间发生变化，请重试"));
        }
        self.0
            .lock()
            .unwrap()
            .insert(path.into(), (source.clone(), digest.clone()));
        Ok((source, digest))
    }

    /// 删除上传记录时同步释放摘要记忆，不修改其他模型的摘要。
    pub fn forget(&self, path: &Path) {
        self.0.lock().unwrap().remove(path);
    }
}

/// 暂存目录只由本模块随机创建，退出或失败时回收，发布后不再存在。
struct Staging(PathBuf);
impl Drop for Staging {
    /// 清理本次复用的未发布文件；正式发布目录不属于此对象。
    fn drop(&mut self) {
        if self.0.exists() {
            if let Err(error) = fs::remove_dir_all(&self.0) {
                warn(&format!("预览复用暂存清理失败：{error}"));
            }
        }
    }
}

/// 缓存异常只记录诊断，由调用方回到原有生成流程。
fn warn(message: &str) {
    crate::logging::issue(
        crate::runtime_logging::Level::Warn,
        format_args!("{message}"),
    );
}

/// 列出本档实际参与复用的资源；固定文件名限制派生文件的共享边界。
fn resources(tier: &Path, manifest: &Value) -> Result<Vec<&'static str>> {
    if manifest["browser_asset"]["file_name"] != "preview.glb" {
        return Err(Error::bad("预览网格文件名不兼容"));
    }
    let mut names = vec!["manifest.json", "shell-map.json", "preview.glb"];
    if manifest["face_mapping"].is_object() {
        if manifest["face_mapping"]["file_name"] != "face-map.json" {
            return Err(Error::bad("预览面映射文件名不兼容"));
        }
        names.push("face-map.json");
    }
    if tier.join("faces.brep").is_file() {
        names.push("faces.brep");
    }
    Ok(names)
}

/// 给新生成或兼容的旧产物补充独立摘要凭据；不改变现有清单及上传索引格式。
pub fn record(tier: &Path, manifest: &Value, digest: &str) -> Result<()> {
    let references: Result<Vec<_>> = resources(tier, manifest)?
        .iter()
        .map(|name| files::reference(tier, &tier.join(name)))
        .collect();
    files::write_json(
        &tier.join("reuse.json"),
        &json!({"source_sha256":digest,"resources":references?}),
    )
}

/// 校验 GLB 头、长度及映射归属；有摘要凭据时再校验每份资源，旧产物通过后惰性补齐凭据。
fn validate(tier: &Path, manifest: &Value, digest: &str) -> Result<()> {
    let names = resources(tier, manifest)?;
    let glb = tier.join("preview.glb");
    let length = fs::metadata(&glb)?.len();
    let mut header = [0u8; 12];
    fs::File::open(&glb)?.read_exact(&mut header)?;
    if &header[..4] != b"glTF"
        || u32::from_le_bytes(header[4..8].try_into().unwrap()) != 2
        || u32::from_le_bytes(header[8..12].try_into().unwrap()) as u64 != length
        || manifest["browser_asset"]["byte_size"].as_u64() != Some(length)
    {
        return Err(Error::bad("预览网格格式或长度校验失败"));
    }
    if manifest["face_mapping"].is_object() {
        let mapping = files::read_json(&tier.join("face-map.json"))?;
        if mapping["model_id"] != manifest["model"]["id"]
            || mapping["quality"] != manifest["quality"]
            || mapping["entries"].as_array().map(|a| a.len() as u64)
                != manifest["face_mapping"]["entry_count"].as_u64()
        {
            return Err(Error::bad("预览面映射归属或条目数校验失败"));
        }
    }
    let receipt = tier.join("reuse.json");
    if receipt.exists() {
        let index = files::read_json(&receipt)?;
        let refs = index["resources"]
            .as_array()
            .ok_or_else(|| Error::bad("预览摘要凭据缺失"))?;
        if index["source_sha256"] != digest || refs.len() != names.len() {
            return Err(Error::bad("预览摘要凭据不匹配"));
        }
        for (reference, name) in refs.iter().zip(names) {
            if reference["path"] != name {
                return Err(Error::bad("预览摘要资源不匹配"));
            }
            files::verify(tier, reference)?;
        }
        Ok(())
    } else {
        record(tier, manifest, digest)
    }
}

impl Models {
    /// 等待同内容的生成结果时响应当前记录的删除和应用退出，不能让删除等待其他记录的 CAD。
    pub(crate) async fn wait_preview_content(
        &self,
        id: &str,
        key: &str,
        quality: &str,
    ) -> Result<tokio::sync::OwnedMutexGuard<()>> {
        let pending = self
            .resource_gate(&format!("preview-content-{key}"), quality)
            .lock_owned();
        tokio::pin!(pending);
        loop {
            tokio::select! {
                guard = &mut pending => { self.get(id)?; return Ok(guard); }
                _ = self.engine.shutdown.cancelled() => return Err(Error::conflict("服务正在退出")),
                _ = tokio::time::sleep(std::time::Duration::from_secs_f64(
                    self.config.number("compute_engine", "poll_interval_seconds"))) => { self.get(id)?; }
            }
        }
    }

    /// 在大小相同的已有记录中寻找内容和生成参数都匹配的预览；调用方持有目标档位锁。
    pub(crate) fn reuse_preview(
        &self,
        id: &str,
        quality: &str,
        digest: &str,
    ) -> Result<Option<Value>> {
        let model = self.get(id)?;
        if let Some(manifest) = self.current_preview(&model, quality) {
            return Ok(Some(manifest));
        }
        let (source, current_digest) = self.preview_sources.get(&self.source_path(&model)?)?;
        if current_digest != digest {
            return Err(Error::conflict("模型源文件在等待预览期间发生变化，请重试"));
        }
        let candidates: Vec<_> = self
            .state
            .lock()
            .unwrap()
            .entries
            .iter()
            .filter(|candidate| candidate["id"] != id && candidate["size"] == model["size"])
            .cloned()
            .collect();
        for candidate in candidates {
            let Some(other) = candidate["id"].as_str() else {
                continue;
            };
            if self.get(other).is_err() {
                continue;
            }
            let Some(manifest) = self.current_preview(&candidate, quality) else {
                continue;
            };
            let path = self.source_path(&candidate)?;
            let Ok((stamp, other_digest)) = self.preview_sources.get(&path) else {
                continue;
            };
            if other_digest != digest {
                continue;
            }
            let result = (|| {
                let tier = self.root(other).join(quality);
                validate(&tier, &manifest, digest)?;
                if manifests::source(&path)? != stamp
                    || self.current_preview(&candidate, quality).as_ref() != Some(&manifest)
                {
                    return Ok(None);
                }
                self.clone_preview(&model, &source, quality, &tier, &manifest, digest)
            })();
            match result {
                Ok(Some(manifest)) => {
                    if let Some(operation) = crate::monitoring::current() {
                        operation.remember(json!({"preview_reused_from":other,"model_id":id,"quality":quality,"source_sha256":digest}));
                    }
                    // 运行缓存只携带几何；重写内部归属后再发布，失败仍可直接加载已复用的 GLB。
                    if let Err(error) = crate::preview_runtime_reuse::restore(self, id, other) {
                        warn(&format!("运行预览缓存复用失败，改用已有 GLB：{error}"));
                    }
                    return Ok(Some(manifest));
                }
                Ok(None) => {}
                Err(error) => warn(&format!("预览缓存不可复用，将继续查找或重新生成：{error}")),
            }
        }
        Ok(None)
    }

    /// 为新记录创建独立清单、外壳表和面映射；GLB/BRep 用硬链接共享，不支持时复制。
    fn clone_preview(
        &self,
        model: &Value,
        source: &Value,
        quality: &str,
        tier: &Path,
        original: &Value,
        digest: &str,
    ) -> Result<Option<Value>> {
        let id = model["id"]
            .as_str()
            .ok_or_else(|| Error::bad("缺少模型标识"))?;
        let root = self.root(id);
        let staging = Staging(root.join(format!(".reuse-{}", files::identifier())));
        fs::create_dir_all(&staging.0)?;
        let mut manifest = original.clone();
        manifest["model"] = self.public(model);
        manifest["source"] = source.clone();
        let mut shell = files::read_json(&tier.join("shell-map.json"))?;
        shell["source"] = source.clone();
        files::write_json(&staging.0.join("shell-map.json"), &shell)?;
        for name in resources(tier, original)? {
            match name {
                "manifest.json" | "shell-map.json" => {}
                "face-map.json" => {
                    let mut mapping = files::read_json(&tier.join(name))?;
                    mapping["model_id"] = json!(id);
                    files::write_json(&staging.0.join(name), &mapping)?;
                }
                _ => prepared_cache::share(&tier.join(name), &staging.0.join(name))?,
            }
        }
        files::write_json(&staging.0.join("manifest.json"), &manifest)?;
        manifests::preview_files(
            &self.config,
            &staging.0,
            &staging.0.join("shell-map.json"),
            source,
            quality,
        )
        .ok_or_else(|| Error::bad("复用预览未通过目标模型校验"))?;
        record(&staging.0, &manifest, digest)?;
        let state = self.state.lock().unwrap();
        let current = self.find(&state, id)?;
        if manifests::source(&self.source_path(&current)?)? != *source {
            return Err(Error::conflict("模型源文件在预览复用期间发生变化"));
        }
        files::publish_with(&staging.0, &root.join(quality), || {
            if manifest["parameters"]["shell_policy"] != "all_faces_interaction" {
                files::write_json(&root.join("common/shell-map.json"), &shell)?;
            }
            Ok(())
        })?;
        let _ = fs::remove_file(root.join("runtime-preview.bin"));
        Ok(Some(manifest))
    }

    /// 上传成功后尽力恢复已有两档预览；锁被使用时交由后续预览请求处理，不等待 CAD 计算。
    pub(crate) fn warm_uploaded_preview(&self, id: &str) {
        let Ok(_detail) = self.resource_gate(id, "detail").try_lock_owned() else {
            return;
        };
        let Ok(_interaction) = self.resource_gate(id, "interaction").try_lock_owned() else {
            return;
        };
        let result = (|| {
            let model = self.get(id)?;
            let (_, digest) = self.preview_sources.get(&self.source_path(&model)?)?;
            self.reuse_preview(id, "interaction", &digest)?;
            self.reuse_preview(id, "detail", &digest)?;
            Ok::<_, Error>(())
        })();
        if let Err(error) = result {
            warn(&format!("上传预览预热失败，保留按需生成：{error}"));
        }
    }
}

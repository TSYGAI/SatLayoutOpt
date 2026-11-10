//! 文件说明：编排微调快照、实时校验替换及独立版本管理；会话代次取消旧计算，任务锁保护持久化，数值仍从来源重放并完整验收。
use crate::{
    blocking,
    compute::Task,
    error::{Error, Result},
    files,
    jobs::{is_active, Jobs},
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// 从原始候选或人工版本读取指定来源，不混入优化排名。
pub fn candidate(job: &Value, id: &str) -> Result<Value> {
    job["candidates"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(job["refinements"].as_array().into_iter().flatten())
        .find(|entry| entry["candidate_id"] == id)
        .cloned()
        .ok_or_else(|| Error::missing("找不到指定布局方案或微调版本"))
}

/// 从现存默认版本名称的最大编号续号，避免删除中间版本后与保留版本重名。
fn next_refinement_name(job: &Value) -> Result<String> {
    let maximum = job["refinements"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry["refinement"]["name"].as_str())
        .filter_map(|name| name.strip_prefix("微调版本 "))
        .filter(|suffix| !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit()))
        .filter_map(|suffix| suffix.parse::<u64>().ok())
        .max()
        .unwrap_or(0);
    let next = maximum
        .checked_add(1)
        .ok_or_else(|| Error::conflict("默认微调版本编号已达上限，请重命名后重试"))?;
    Ok(format!("微调版本 {next}"))
}

impl Jobs {
    /// 在任务锁内修改或移除指定人工版本，返回原版本或改名结果；不修改原候选、派生版本及共享模型快照。
    pub fn update_refinement(&self, id: &str, version: &str, name: Option<&str>) -> Result<Value> {
        files::safe_id(id)?;
        files::safe_id(version)?;
        let state = self.state.lock().unwrap();
        let mut job = self.read(id)?;
        if is_active(&job) || state.active.as_ref().is_some_and(|(active, _)| active == id) {
            return Err(Error::conflict("任务仍在运行或收尾，请结束后再管理微调版本"));
        }
        let versions = job["refinements"]
            .as_array_mut()
            .ok_or_else(|| Error::missing("找不到指定微调版本，原始候选不支持此操作"))?;
        let index = versions
            .iter()
            .position(|entry| entry["candidate_id"] == version)
            .ok_or_else(|| Error::missing("找不到指定微调版本，原始候选不支持此操作"))?;
        let updated = if let Some(name) = name {
            versions[index]["refinement"]["name"] = json!(name);
            versions[index].clone()
        } else {
            versions.remove(index)
        };
        self.save(&job)?;
        Ok(updated)
    }

    /// 在任务锁内校验历史并复制协议资源；缺少安装快照的旧历史明确拒绝，不回读当前模型。
    fn refinement_task(
        &self,
        id: &str,
        source: &str,
        body: &Value,
        cancel: &CancellationToken,
    ) -> Result<(Task, String)> {
        if cancel.is_cancelled() {
            return Err(Error::conflict("微调校核已取消"));
        }
        files::safe_id(id)?;
        files::safe_id(source)?;
        let _guard = self.state.lock().unwrap();
        let job = self.read(id)?;
        if is_active(&job) {
            return Err(Error::conflict("任务仍在运行，请结束后再进行人工微调"));
        }
        let selected = candidate(&job, source)?;
        if selected["validation"]["valid"] != true {
            return Err(Error::conflict("来源方案尚未通过完整验收"));
        }
        let commands = body["commands"]
            .as_array()
            .ok_or_else(|| Error::invalid("commands 必须为数组"))?;
        let limit = self
            .config
            .integer("layout_optimization", "refinement_command_limit");
        if commands.len() as u64 > limit {
            return Err(Error::invalid("微调操作数量超限，请先保存版本"));
        }
        let fingerprint = files::fingerprint(&selected);
        if body
            .get("source_fingerprint")
            .is_some_and(|v| v != &json!(fingerprint))
        {
            return Err(Error::conflict("来源方案已变化，请重新打开人工微调页面"));
        }
        let history = files::within(&self.directory, id)?;
        if !history.is_dir() {
            return Err(Error::conflict("历史数值快照已丢失"));
        }
        let snapshot_root = files::within(&history, "refinement-input")?;
        let snapshot = snapshot_root.join("snapshot.json");
        if !snapshot.is_file() {
            return Err(Error::conflict(
                "该历史缺少人工微调所需的数值安装快照；仍可查看和导出，请重新优化后微调",
            ));
        }
        let manifest = files::read_json(&snapshot)?;
        let mut task = Task::new(
            &self.config,
            "layout.refine",
            &json!({"candidate":selected,"commands":commands,"command_limit":limit}),
        )?;
        task.add("snapshot", "snapshot/snapshot.json", &snapshot)?;
        for (key, reference) in manifest["arrays"]
            .as_object()
            .ok_or_else(|| Error::conflict("历史数值快照缺少数组"))?
        {
            if cancel.is_cancelled() {
                return Err(Error::conflict("微调校核已取消"));
            }
            let array =
                files::verify(&snapshot_root, reference).map_err(|e| Error::conflict(e.message))?;
            task.add(
                key,
                &format!(
                    "snapshot/{}",
                    reference["path"]
                        .as_str()
                        .ok_or_else(|| Error::conflict("历史数组路径无效"))?
                ),
                &array,
            )?;
        }
        Ok((task, fingerprint))
    }

    /// 执行完整正式校核；预览保留几何违规，保存只接受有效结果并向单独数组追加版本。
    pub async fn refine(
        self: &Arc<Self>,
        id: &str,
        source: &str,
        body: Value,
        save: bool,
    ) -> Result<Value> {
        let allowed = if save {
            vec!["commands", "source_fingerprint", "name"]
        } else {
            vec!["commands", "source_fingerprint", "validation"]
        };
        if body
            .as_object()
            .is_none_or(|v| v.keys().any(|k| !allowed.contains(&k.as_str())))
        {
            return Err(Error::invalid("微调请求包含未知字段"));
        }
        if save && body["source_fingerprint"].as_str().is_none() {
            return Err(Error::invalid("保存必须提交来源指纹"));
        }
        if body.get("name").is_some_and(|v| !v.is_string()) {
            return Err(Error::invalid("版本名称必须为字符串"));
        }
        files::safe_id(id)?;
        files::safe_id(source)?;
        let validation = if let Some(value) = body.get("validation") {
            if value.as_object().is_none_or(|object| {
                object.len() != 2
                    || !object.contains_key("session_id")
                    || !object.contains_key("revision")
            }) {
                return Err(Error::invalid("实时校验身份字段无效"));
            }
            Some(self.refinement_validations.begin(
                id,
                source,
                value["session_id"]
                    .as_str()
                    .ok_or_else(|| Error::invalid("实时校验会话必须为 UUID"))?,
                value["revision"]
                    .as_u64()
                    .ok_or_else(|| Error::invalid("实时校验版本必须为正整数"))?,
            )?)
        } else {
            None
        };
        let cancel = validation
            .as_ref()
            .map(|run| run.cancel.clone())
            .unwrap_or_default();
        let this = self.clone();
        let key = id.to_string();
        let selected = source.to_string();
        let input = body.clone();
        let preparing_cancel = cancel.clone();
        let (task, fingerprint) =
            blocking(move || this.refinement_task(&key, &selected, &input, &preparing_cancel)).await?;
        let outcome = self
            .engine
            .run(task, id, cancel.clone(), None)
            .await
            .map_err(|e| {
                if e.computation_code.as_deref() == Some("invalid_input") {
                    Error::invalid(e.message)
                } else {
                    Error::conflict(e.message)
                }
            })?;
        if outcome.cancelled || cancel.is_cancelled() {
            return Err(Error::conflict("微调校核已取消"));
        }
        let mut result = outcome.result.clone();
        result["source_fingerprint"] = json!(fingerprint);
        if validation.is_some() {
            result["validation"] = body["validation"].clone();
        }
        result["settings"] = json!({"debounce_ms":self.config.integer("layout_optimization","refinement_debounce_ms"),
            "command_limit":self.config.integer("layout_optimization","refinement_command_limit"),
            "angle_step":self.config.number("layout_optimization","refinement_angle_step_deg"),
            "height_step":self.config.number("layout_optimization","refinement_height_step_mm"),
            "translation_step":self.config.number("layout_optimization","refinement_translation_step_mm"),
            "suspension_step":self.config.number("layout_optimization","refinement_suspension_step_mm")});
        if !save {
            return Ok(result);
        }
        if result["candidate"]["validation"]["valid"] != true {
            return Err(Error::conflict(
                "当前微调未通过完整验收，请处理约束问题后保存",
            ));
        }
        let this = self.clone();
        let key = id.to_string();
        let source = source.to_string();
        blocking(move || {
            let _guard = this.state.lock().unwrap();
            let mut job = this.read(&key)?;
            if is_active(&job) || files::fingerprint(&candidate(&job, &source)?) != fingerprint {
                return Err(Error::conflict("来源方案或任务状态已变化，请重新载入"));
            }
            if !job["refinements"].is_array() {
                job["refinements"] = json!([]);
            }
            let name = body
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|name| Ok(name.to_string()))
                .unwrap_or_else(|| next_refinement_name(&job))?;
            if name.chars().count()
                > this
                    .config
                    .integer("layout_optimization", "history_name_max_length")
                    as usize
            {
                return Err(Error::invalid("微调版本名称过长"));
            }
            let mut saved = result["candidate"].clone();
            saved["candidate_id"] = json!(format!("manual-{}", files::identifier()));
            saved["refinement"]["name"] = json!(name);
            saved["refinement"]["source_candidate_id"] = json!(source);
            saved["refinement"]["created_at"] = json!(files::now());
            saved["refinement"]["source_fingerprint"] = json!(fingerprint);
            job["refinements"]
                .as_array_mut()
                .unwrap()
                .push(saved.clone());
            this.save(&job)?;
            result["candidate"] = saved;
            Ok(result)
        })
        .await
    }
}

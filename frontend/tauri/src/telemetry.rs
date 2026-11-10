//! 文件说明：仅桌面同源接收 WebView 操作状态；有界登记、宿主监测，不写业务数据。
use crate::{
    runtime_logging::{Level, Operation},
    session_logging::SessionLog,
};
use serde_json::{Map, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

/// 只接收诊断所需的标量；不把任意内部字段、嵌套对象或序列化步骤写入日志。
fn details(value: &Value) -> Value {
    let keys = [
        "step",
        "model",
        "model_id",
        "model_name",
        "models",
        "record",
        "record_id",
        "job",
        "job_id",
        "task",
        "task_id",
        "file",
        "path",
        "url",
        "page",
        "action",
        "bytes",
        "vertices",
        "quality",
        "backend",
        "boundary",
        "status",
        "stack",
        "failure_kind",
    ];
    let mut selected = Map::new();
    for key in keys {
        if let Some(value) = value
            .get(key)
            .filter(|value| value.is_string() || value.is_number() || value.is_boolean())
        {
            selected.insert(key.into(), value.clone());
        }
    }
    Value::Object(selected)
}

/// 固定身份只保留模型、任务和资源关联，当前步骤、栈与客户端传输字段另行处理。
fn identity(value: &Value) -> Value {
    let mut selected = details(value);
    if let Some(fields) = selected.as_object_mut() {
        for key in ["step", "stack", "status", "bytes", "vertices", "boundary"] {
            fields.remove(key);
        }
    }
    selected
}

/// 每个桌面进程的前端操作登记表；前端终态立即移除。
pub struct Telemetry {
    log: Arc<SessionLog>,
    active: Mutex<HashMap<String, Arc<Operation>>>,
}
impl Telemetry {
    /// 使用当前会话日志创建接收器。
    pub fn new(log: Arc<SessionLog>) -> Self {
        Self {
            log,
            active: Mutex::new(HashMap::new()),
        }
    }
    /// 返回集中配置中的 HTTP 接收字节上限。
    pub fn max_bytes(&self) -> usize {
        self.log.policy.telemetry_max_bytes
    }
    /// 代理失败由宿主直接记录，即使 WebView 已卡住仍保留连接原因和关联编号。
    pub fn proxy_failure(&self, trace: &str, path: &str, reason: &str) {
        let _ = self.log.writer.event(
            Level::Error,
            "前端·API代理",
            "代理请求失败",
            &[
                ("操作", trace.into()),
                ("路径", path.into()),
                ("原因", reason.into()),
            ],
        );
    }
    /// 校验并消费有限事件批次；不接受用户任意文件路径和日志级别注入。
    pub fn accept(&self, value: Value) -> Result<(), &'static str> {
        let events = value
            .as_array()
            .filter(|items| items.len() <= self.log.policy.telemetry_batch_size)
            .ok_or("遥测批次无效")?;
        let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        for event in events {
            let id = event["id"]
                .as_str()
                .filter(|id| {
                    !id.is_empty()
                        && id.len() <= 80
                        && id
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
                })
                .ok_or("操作编号无效")?;
            match event["kind"].as_str() {
                Some("reset") => {
                    for (_, operation) in active.drain() {
                        operation.finish(Level::Info, "页面重载，旧操作已中断", None);
                    }
                }
                Some("start") => {
                    if active.contains_key(id) {
                        continue;
                    }
                    if active.len() >= self.log.policy.queue_capacity {
                        return Err("活动遥测操作已达上限");
                    }
                    let name = event["name"]
                        .as_str()
                        .filter(|v| v.len() <= 512)
                        .ok_or("操作名称无效")?;
                    let trace = event["trace"]
                        .as_str()
                        .filter(|value| {
                            value.len() <= 80
                                && value
                                    .bytes()
                                    .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
                        })
                        .unwrap_or(id);
                    let operation = self.log.operation(
                        trace.into(),
                        format!("前端·{name}"),
                        event["quiet"] == true,
                        event["long"] == true,
                    );
                    operation.stage("host", details(&event["details"]), true);
                    operation.context(identity(&event["details"]));
                    if let Some(parent) = event["details"]["parent"]
                        .as_str()
                        .and_then(|id| active.get(id))
                    {
                        operation.set_parent(parent);
                    }
                    active.insert(id.into(), operation);
                }
                Some("step") => {
                    if let Some(operation) = active.get(id) {
                        operation.stage(
                            "host",
                            details(&event["details"]),
                            event["progress"] == true,
                        );
                    }
                }
                Some("progress") => {
                    if let Some(operation) = active.get(id) {
                        operation.progress("host");
                    }
                }
                Some("finish") => {
                    if let Some(operation) = active.remove(id) {
                        let elapsed = event["elapsed_ms"].as_u64().ok_or("客户端耗时无效")?;
                        let level = match event["level"].as_str() {
                            Some("ERROR") => Level::Error,
                            Some("WARN") => Level::Warn,
                            _ if elapsed >= self.log.policy.slow_request_ms
                                && event["result"] != "已取消" =>
                            {
                                Level::Warn
                            }
                            _ => Level::Info,
                        };
                        if matches!(level, Level::Error | Level::Warn) {
                            let context = details(&event["details"]);
                            if context.as_object().is_some_and(|value| !value.is_empty()) {
                                operation.remember(context);
                            }
                        }
                        operation.finish_client(
                            level,
                            event["result"].as_str().unwrap_or("完成"),
                            event["reason"].as_str(),
                            elapsed,
                        );
                    }
                }
                Some("message") => {
                    let level = if event["level"] == "WARN" {
                        Level::Warn
                    } else {
                        Level::Error
                    };
                    let mut fields = vec![("操作", id.into())];
                    for (key, label) in [
                        ("action", "用户操作"),
                        ("page", "页面"),
                        ("stack", "调用栈"),
                    ] {
                        if let Some(value) = event["details"][key]
                            .as_str()
                            .filter(|value| !value.is_empty())
                        {
                            fields.push((label, value.into()));
                        }
                    }
                    let _ = self.log.writer.event(
                        level,
                        "前端·异常",
                        event["reason"].as_str().unwrap_or("未知异常"),
                        &fields,
                    );
                }
                _ => return Err("遥测事件类型无效"),
            }
        }
        Ok(())
    }
}

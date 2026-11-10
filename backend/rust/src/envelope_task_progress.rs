//! 文件说明：汇总单模型及批量包络任务的实际工作进度；只操作内存任务快照，不计时或发布几何资源。
use serde_json::{json, Value};

/// 创建尚未开始计算的进度快照；批量任务稍后以固定模型列表确定总数。
pub fn initial(total: usize) -> Value {
    json!({"phase":"preparing","message":"正在准备包络生成","percent":0,
        "model_percent":0,"completed_models":0,"total_models":total,"current_model_id":null})
}

/// 合并已验证的计算事件，按模型等权汇总；过期任务、非法进度和倒退事件不会覆盖新状态。
pub fn update(
    task: &mut Value,
    task_id: &str,
    model_id: &str,
    index: usize,
    total: usize,
    incoming: &Value,
) {
    if task["id"] != task_id || task["state"] != "running" || total == 0 || index >= total {
        return;
    }
    let Some(percent) = incoming["percent"]
        .as_f64()
        .filter(|v| v.is_finite() && *v >= 0.0 && *v < 100.0)
    else {
        return;
    };
    let (Some(phase), Some(message)) = (incoming["phase"].as_str(), incoming["message"].as_str())
    else {
        return;
    };
    let previous = &task["progress"];
    if previous["current_model_id"] == model_id
        && percent < previous["model_percent"].as_f64().unwrap_or(0.0)
    {
        return;
    }
    let overall = (((index as f64 + percent / 100.0) / total as f64) * 100.0).floor();
    if overall < previous["percent"].as_f64().unwrap_or(0.0) {
        return;
    }
    task["progress"] = json!({"phase":phase,"message":message,"percent":overall,
        "model_percent":percent,"completed_models":index,"total_models":total,"current_model_id":model_id});
}

/// 记录已处理模型数量，失败项同样计入已处理；所有产物发布完成前最多显示 99%。
pub fn complete_model(task: &mut Value, completed: usize, total: usize) {
    let percent = if total == 0 {
        0
    } else {
        (completed * 100 / total).min(99)
    };
    task["progress"]["percent"] = json!(percent);
    task["progress"]["completed_models"] = json!(completed);
    task["progress"]["total_models"] = json!(total);
}

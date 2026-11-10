//! 文件说明：固定预览按行发布待校验位姿和正式结果；断开即取消计算，初始显示不能写入正式缓存或替代保存验收。
use crate::{api::App, blocking, fixed_constraints, layout_config};
use axum::{body::Body, response::Response};
use bytes::Bytes;
use serde_json::{json, Value};
use std::{convert::Infallible, sync::Arc};
use tokio::sync::mpsc;

/// 返回有界 NDJSON 响应；队列容量沿用计算进度配置，HTTP 已开启后的错误通过 error 帧携带状态码。
pub fn preview(app: Arc<App>, value: Value) -> Response {
    let _logging_step =
        crate::monitoring::Step::new("fixed_stream::preview", serde_json::json!({}));
    let capacity = app
        .config
        .integer("layout_optimization", "progress_history_size") as usize;
    let (sender, receiver) = mpsc::channel::<Value>(capacity);
    crate::monitoring::spawn(async move {
        let (events, mut progress) = mpsc::channel(capacity);
        let fingerprint = value["config_fingerprint"].clone();
        let work = fixed_constraints::calculate(app.clone(), value, false, Some(events));
        tokio::pin!(work);
        loop {
            tokio::select! {
                _ = sender.closed() => break,
                result = &mut work => {
                    let frame = match result {
                        Ok(result) => json!({"type":"result", "result":result}),
                        Err(error) => {
                            if let Some(operation) = crate::monitoring::current() {
                                operation.remember(error.diagnostic());
                                operation.finish(if error.internal || error.status.as_u16()>=500 {crate::runtime_logging::Level::Error} else {crate::runtime_logging::Level::Warn},"固定预览流失败",Some(&error.to_string()));
                            }
                            json!({"type":"error", "status":error.status.as_u16(), "detail":error.message})
                        },
                    };
                    let _ = sender.send(frame).await;
                    break;
                }
                Some(event) = progress.recv() => {
                    let mut display = event["verified_candidates"][0]["fixed_display"].clone();
                    if display.is_null() { continue; }
                    let this = app.clone();
                    let current = blocking(move || layout_config::configuration(&this.pre)).await;
                    if current.as_ref().is_ok_and(|c| c["config_fingerprint"] == fingerprint) {
                        display["config_fingerprint"] = fingerprint.clone();
                        if sender.send(json!({"type":"display", "result":display})).await.is_err() { break; }
                    }
                }
            }
        }
    });
    let body = futures_util::stream::unfold(receiver, |mut receiver| async move {
        receiver.recv().await.map(|value| {
            let bytes = Bytes::from(format!("{value}\n"));
            (Ok::<_, Infallible>(bytes), receiver)
        })
    });
    Response::builder()
        .header("Content-Type", "application/x-ndjson; charset=utf-8")
        .header("Cache-Control", "no-store")
        .body(Body::from_stream(body))
        .unwrap()
}

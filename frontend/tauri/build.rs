//! 文件说明：使用集中 TOML 派生的构建配置生成 Tauri 上下文，不维护第二份运行参数。

/// 读取构建入口提供的派生配置路径；缺失或无效时中止构建并提示统一入口。
fn main() {
    println!("cargo:rerun-if-env-changed=SAT_LAYOUT_TAURI_CONFIG");
    let config = std::env::var("SAT_LAYOUT_TAURI_CONFIG")
        .expect("请通过 scripts/desktop/tauri.py 构建桌面应用");
    let schema_output = std::path::Path::new(&config)
        .parent()
        .expect("派生配置必须位于构建目录")
        .join("schemas");
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .config_path(config)
            .codegen(tauri_build::CodegenContext::new()),
    )
    .expect("Tauri 派生配置或 Windows 资源编译失败");
    // tauri-build 固定在 crate 下生成这些中间文件；上下文已使用 OUT_DIR 副本，随后归档到构建目录。
    std::fs::create_dir_all(&schema_output).expect("无法创建 schema 构建目录");
    for name in [
        "acl-manifests.json",
        "capabilities.json",
        "desktop-schema.json",
        "windows-schema.json",
    ] {
        let generated = std::path::Path::new("gen/schemas").join(name);
        if generated.is_file() {
            std::fs::copy(&generated, schema_output.join(name)).expect("无法归档派生 schema");
            std::fs::remove_file(generated).expect("无法清理已归档的派生 schema");
        }
    }
    // 只删除空目录；意外出现的其他文件必须保留。
    let _ = std::fs::remove_dir("gen/schemas");
    let _ = std::fs::remove_dir("gen");
}

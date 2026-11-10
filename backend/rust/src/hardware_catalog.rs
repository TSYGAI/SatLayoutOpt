//! 文件说明：硬件配置 API 的字段契约与模块说明；仅公开实际消费的性能参数，不暴露路径或密钥。
//! 字段值始终来自唯一 TOML，本模块只定义类型、单位、边界、可见性及展示说明。
use serde::Serialize;

/// 可编辑字段的类型与边界；scale 只用于将字节或比例换算为界面单位。
#[derive(Clone, Serialize)]
pub struct Field {
    pub key: &'static str,
    pub module: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub kind: &'static str,
    pub unit: &'static str,
    pub min: f64,
    pub max: f64,
    pub step: f64,
    pub scale: f64,
    pub advanced: bool,
    /// 页面隐藏的显示细节仍保留保存校验和运行配置同步。
    pub visible: bool,
    pub options: Vec<(&'static str, &'static str)>,
}

/// 构造数值字段；整数约束作用于原始配置值，界面按 scale 换算。
fn number(
    key: &'static str,
    module: &'static str,
    text: (&'static str, &'static str),
    format: (&'static str, &'static str),
    bounds: (f64, f64, f64),
    scale: f64,
    advanced: bool,
) -> Field {
    Field {
        key,
        module,
        label: text.0,
        description: text.1,
        kind: format.0,
        unit: format.1,
        min: bounds.0,
        max: bounds.1,
        step: bounds.2,
        scale,
        advanced,
        visible: !matches!(
            key,
            "frontend.preview_interaction_pixel_ratio"
                | "frontend.preview_idle_pixel_ratio_cap"
                | "frontend.preview_interaction_min_pixel_ratio"
                | "frontend.preview_idle_delay_ms"
                | "frontend.preview_webgpu_init_timeout_ms"
                | "frontend.pre_config_pixel_ratio_cap"
                | "frontend.fixed_validation_debounce_ms"
                | "frontend.data_management_pixel_ratio_cap"
        ),
        options: vec![],
    }
}

/// 定义整数数量，不引入独立的运行默认值。
fn count(
    key: &'static str,
    module: &'static str,
    label: &'static str,
    description: &'static str,
    min: f64,
    max: f64,
    advanced: bool,
) -> Field {
    number(
        key,
        module,
        (label, description),
        ("integer", ""),
        (min, max, 1.0),
        1.0,
        advanced,
    )
}

/// 内存字段统一以 MiB 展示，原配置保持精确字节整数。
fn memory(
    key: &'static str,
    module: &'static str,
    label: &'static str,
    description: &'static str,
    advanced: bool,
) -> Field {
    let maximum = if key == "rust_backend.fixed_display_max_bytes" {
        4095.0
    } else {
        16777216.0
    };
    number(
        key,
        module,
        (label, description),
        ("integer", "MiB"),
        (1.0, maximum, 1.0),
        1048576.0,
        advanced,
    )
}

/// 返回所有可写字段；白名单同时用于保存、运行值比较和前端配置同步。
pub fn fields() -> Vec<Field> {
    let mut fields = vec![
        count(
            "rust_backend.compute_cpu_reserve",
            "shared",
            "保留逻辑处理器",
            "留给系统、界面及其他程序。可运行线程还会扣除正在执行的任务。",
            0.0,
            4096.0,
            false,
        ),
        count(
            "hardware.max_concurrent_tasks",
            "shared",
            "同时运行任务上限",
            "限制同时执行的计算宿主；等待中的任务不占名额。CPU 或内存不足时继续排队。",
            1.0,
            256.0,
            false,
        ),
        memory(
            "hardware.application_memory_overhead_bytes",
            "shared",
            "界面与服务基础内存",
            "从全软件总预算中扣除；预览缓存与显示工作空间另外计入，余量才供计算任务共享。",
            true,
        ),
        memory(
            "rust_backend.compute_memory_reserve_bytes",
            "shared",
            "系统保留内存",
            "计算准入先从当前可用物理内存扣除此值；保留过多会使任务等待。",
            false,
        ),
        number(
            "rust_backend.compute_memory_fraction",
            "shared",
            (
                "全软件内存预算占比",
                "界面、缓存、显示工作空间与全部计算任务共享的估计预算，同时受当前可用内存限制；不是进程硬限制。",
            ),
            ("number", "%"),
            (1.0, 100.0, 1.0),
            0.01,
            false,
        ),
        count(
            "rust_backend.compute_worker_cap",
            "shared",
            "布局数值进程上限",
            "布局优化使用，实际值取引擎上限、CPU 槽位和可用内存允许值中的最小值。",
            1.0,
            256.0,
            false,
        ),
        count(
            "compute_engine.numeric_threads_per_worker",
            "shared",
            "每数值进程线程数",
            "BLAS/OpenMP 线程。进程数乘线程数会共同占用 CPU，通常从 1 开始。",
            1.0,
            256.0,
            false,
        ),
        count(
            "compute_engine.max_workers",
            "shared",
            "引擎进程硬上限",
            "必须不小于布局数值进程上限；由独立 Python 引擎再次校验。",
            1.0,
            256.0,
            true,
        ),
        count(
            "compute_engine.prefetch_per_worker",
            "shared",
            "每进程预取批次",
            "待派发与待归并结果的缓冲倍数；提高可减少等待，也会增加内存占用。",
            1.0,
            64.0,
            true,
        ),
        memory(
            "rust_backend.compute_worker_memory_bytes",
            "shared",
            "每数值进程内存估计",
            "用于计算准入，不是进程硬限制；运行时还会参考实测峰值。",
            true,
        ),
        memory(
            "rust_backend.compute_host_memory_bytes",
            "shared",
            "计算宿主基础内存",
            "准入时还会叠加输入体积估计；设置过低可能低估峰值。",
            true,
        ),
        count(
            "rust_backend.compute_input_memory_factor",
            "shared",
            "输入内存放大倍数",
            "输入文件体积乘此倍数，计入几何和数组工作空间估计。",
            1.0,
            64.0,
            true,
        ),
        count(
            "rust_backend.compute_cad_threads",
            "shared",
            "其他 CAD 任务线程数",
            "未单独分配的 CAD 操作使用此上限；各业务模块可单独设置。",
            1.0,
            256.0,
            true,
        ),
        memory(
            "compute_engine.mount_cache_bytes",
            "shared",
            "每数值进程姿态缓存",
            "每个布局工作进程各有一份，进程越多总缓存内存越大。",
            true,
        ),
        count(
            "hardware.upload_interaction_threads",
            "upload-interaction",
            "快速预览 CAD 线程数",
            "模型上传第一阶段的三维建模引擎原生线程上限；实际数量还受全局 CPU 预算限制。",
            1.0,
            256.0,
            false,
        ),
        count(
            "hardware.upload_detail_threads",
            "upload-detail",
            "细节预览 CAD 线程数",
            "第二阶段网格化的原生线程上限；外壳筛选中的串行部分不会随线程数等比例加速。",
            1.0,
            256.0,
            false,
        ),
        count(
            "frontend.preview_cache_model_limit",
            "preview",
            "后台常驻模型数",
            "仅计非当前场景。超过数量或内存预算后淘汰，再次访问复用磁盘资源。",
            1.0,
            1000.0,
            false,
        ),
        memory(
            "frontend.preview_cache_max_bytes",
            "preview",
            "预览数组缓存预算",
            "CPU 侧网格数组预算，不等于显存上限；当前场景另有开销。",
            false,
        ),
        memory(
            "backend.model_preview_runtime_cache_max_bytes",
            "preview",
            "单模型磁盘预览缓存上限",
            "浏览器合并后的二进制缓存写入上限；不代表全部磁盘缓存总量。",
            true,
        ),
        number(
            "frontend.preview_interaction_pixel_ratio",
            "preview",
            (
                "交互像素比",
                "模型拖动时的初始画布像素比，越低越省 GPU 与显存。",
            ),
            ("number", "倍"),
            (0.25, 4.0, 0.05),
            1.0,
            false,
        ),
        number(
            "frontend.preview_idle_pixel_ratio_cap",
            "preview",
            (
                "静止像素比上限",
                "模型静止时的清晰度上限；实际值同时受屏幕像素比限制。",
            ),
            ("number", "倍"),
            (0.25, 4.0, 0.05),
            1.0,
            false,
        ),
        number(
            "frontend.preview_interaction_min_pixel_ratio",
            "preview",
            (
                "交互最低像素比",
                "连续慢帧时自动降到此值；不得大于初始交互像素比。",
            ),
            ("number", "倍"),
            (0.25, 4.0, 0.05),
            1.0,
            true,
        ),
        count(
            "frontend.preview_idle_delay_ms",
            "preview",
            "恢复细节等待时间",
            "停止交互后多久恢复细节画面，单位毫秒。",
            1.0,
            10000.0,
            true,
        ),
        count(
            "frontend.preview_webgpu_init_timeout_ms",
            "preview",
            "GPU 初始化等待时间",
            "WebGPU 初始化超时后自动回退 WebGL，单位毫秒。",
            100.0,
            60000.0,
            true,
        ),
        count(
            "hardware.envelope_threads",
            "envelope",
            "包络 CAD 线程数",
            "控制 STEP 读取后的 CAD 原生并行阶段；体素流程仍按批次执行。",
            1.0,
            256.0,
            false,
        ),
        memory(
            "backend.model_envelope_process_memory_limit_bytes",
            "envelope",
            "包络进程内存上限",
            "实际分配不超过全局剩余预算；Windows 进程树限制会阻止无限增长。",
            false,
        ),
        memory(
            "backend.model_envelope_workspace_memory_bytes",
            "envelope",
            "单批工作空间",
            "缩小可降低数组峰值，可能增加批次数；不改变模型分辨率。",
            false,
        ),
        memory(
            "backend.model_envelope_memory_reserve_bytes",
            "envelope",
            "包络系统保留内存",
            "与全局系统保留内存取较大值；包络仅使用剩余可用空间。",
            true,
        ),
        count(
            "backend.model_envelope_voxel_max_cells",
            "envelope",
            "体素批次单元上限",
            "限制每批占据网格大小；超出后分批融合，不减少总单元数。",
            32768.0,
            1073741824.0,
            false,
        ),
        count(
            "backend.model_envelope_surface_batch_cells",
            "envelope",
            "表面提取批次单元",
            "限制原生几何库每块表面提取的工作集，包含保护边。",
            32768.0,
            1073741824.0,
            true,
        ),
        count(
            "backend.model_envelope_raster_triangle_batch",
            "envelope",
            "每批源三角面数",
            "限制源三角面索引数组，调小可降低栅格化内存峰值。",
            1.0,
            1048576.0,
            true,
        ),
        count(
            "backend.model_envelope_raster_batch_cells",
            "envelope",
            "栅格化批次单元",
            "二维投影单元枚举上限；巨大三角面按条带处理。",
            1024.0,
            1073741824.0,
            true,
        ),
        count(
            "hardware.pre_config_threads",
            "pre-config",
            "前置配置 CPU 线程数",
            "用于罩体构建和安装参考的 CAD 线程，以及固定预览、显示资源准备的数值库线程上限。",
            1.0,
            256.0,
            false,
        ),
        number(
            "frontend.pre_config_pixel_ratio_cap",
            "pre-config",
            (
                "前置预览像素比",
                "降低可减少固定卫星、安装筒与整流罩画布的 GPU 开销。",
            ),
            ("number", "倍"),
            (0.25, 4.0, 0.05),
            1.0,
            false,
        ),
        count(
            "frontend.fixed_validation_debounce_ms",
            "pre-config",
            "编辑后校验等待",
            "停止编辑后再发起正式后端校验，减少频繁操作产生的重复计算，单位毫秒。",
            1.0,
            10000.0,
            false,
        ),
        memory(
            "rust_backend.fixed_preview_cache_max_bytes",
            "pre-config",
            "固定预览结果缓存",
            "单槽磁盘缓存容量；超出后仍返回正式结果，仅跳过缓存。",
            false,
        ),
        memory(
            "frontend.layout_mesh_geometry_max_bytes",
            "pre-config",
            "共享显示几何预算",
            "前置配置与布局预览共用，只统计共享顶点、法向、索引及边线。",
            true,
        ),
        memory(
            "frontend.layout_mesh_worker_max_bytes",
            "pre-config",
            "网格 Worker 工作空间",
            "用于几何派生与边线构建的工作集估计，必须不小于共享显示几何预算。",
            true,
        ),
        memory(
            "frontend.fixed_display_download_max_bytes",
            "pre-config",
            "固定显示下载上限",
            "必须不大于后端固定显示资源上限；大资源可走既有内存判断与回退。",
            true,
        ),
        memory(
            "rust_backend.fixed_display_max_bytes",
            "pre-config",
            "固定显示资源上限",
            "后端生成单个固定显示二进制文件的上限，最多 4095 MiB。",
            true,
        ),
        count(
            "hardware.data_management_threads",
            "data-management",
            "数据资源 CPU 线程数",
            "用于固化包络预览和导出的数值库线程上限；串行文件写入和列表查询不会随此值并行。",
            1.0,
            256.0,
            false,
        ),
        number(
            "frontend.data_management_pixel_ratio_cap",
            "data-management",
            (
                "包络预览像素比",
                "用于数据管理小窗和放大预览，降低可减少 GPU 开销。",
            ),
            ("number", "倍"),
            (0.25, 4.0, 0.05),
            1.0,
            false,
        ),
        memory(
            "frontend.data_management_cache_max_bytes",
            "data-management",
            "最近记录预览缓存",
            "限制跨页面保留的最近一条 GLB 原始字节；解码网格与 GPU 资源另计。",
            false,
        ),
        memory(
            "rust_backend.mesh_cache_max_bytes",
            "data-management",
            "显示网格磁盘缓存",
            "与布局、固定显示共用；超限按最近访问淘汰，可由正式资源重新生成。",
            true,
        ),
        memory(
            "rust_backend.prepared_cache_max_bytes",
            "shared",
            "布局准备磁盘缓存",
            "保存可复用的只读数值输入；超限淘汰旧条目，减少重复准备耗时。",
            true,
        ),
    ];
    let mut renderer = count(
        "frontend.preview_renderer",
        "preview",
        "三维渲染后端",
        "自动优先 WebGPU，设备不支持或初始化失败时回退 WebGL；只影响显示，不加速 CAD 或包络计算。",
        0.0,
        0.0,
        false,
    );
    renderer.kind = "select";
    renderer.options = vec![
        ("auto", "自动（优先 WebGPU）"),
        ("webgl", "WebGL（兼容模式）"),
    ];
    fields.insert(15, renderer);
    fields
}

/// 返回侧栏模块及跨模块资源关系，避免同一个全局参数重复编辑。
pub fn modules() -> serde_json::Value {
    serde_json::json!([
        {"id":"shared","label":"全局资源","description":"先确定整机预算，再分配各模块并发。CPU 线程和内存预算同时满足时，任务才会开始。","note":"布局工作进程数 × 每进程线程数，与其他 CAD 任务共同占用 CPU；各进程缓存也会叠加。"},
        {"id":"upload-interaction","label":"模型上传 · 第一阶段","description":"快速生成完整交互预览，让模型尽快可见。","note":"使用 CPU / OpenCascade；线程上限控制并行网格化，STEP 读取中的串行工作仍需等待。任务同时受全局并发和内存预算限制。"},
        {"id":"upload-detail","label":"模型上传 · 第二阶段","description":"生成细节预览并执行保守外壳筛选。","note":"使用 CPU；与第一阶段分开分配线程。增加线程不会让所有步骤等比例加速，也不改变网格精度。"},
        {"id":"preview","label":"预览与缓存","description":"平衡三维显示流畅度、清晰度与模型切换速度。","note":"GPU 负责渲染，缓存预算控制 CPU 侧数组或磁盘文件。浏览器无法可靠获取可用显存，因此不提供虚假的显存限额。"},
        {"id":"envelope","label":"包络生成","description":"通过内存预算与分批大小控制计算峰值，保留既有模型分辨率。","note":"先限制进程内存，再调整单批空间。批次过大可能增加峰值，过小会增加调度次数；分辨率仍在卫星设置中管理。"},
        {"id":"pre-config","label":"前置配置","description":"调整固定约束校验、显示资源准备及三维画布的资源使用。","note":"显示几何和 Worker 预算与布局预览共用；下载上限不能超过对应后端资源上限。"},
        {"id":"data-management","label":"数据管理","description":"调整固化资源准备、包络显示与最近记录缓存。","note":"列表读写由数据库处理；CPU 线程设置只作用于需要派生或导出的计算资源。"}
    ])
}

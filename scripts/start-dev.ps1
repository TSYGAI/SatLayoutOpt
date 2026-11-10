<#
文件说明：从统一 TOML 配置读取项目环境，调用现有 Rust 后端或 Tauri 构建入口。
只编排启动，不实现业务逻辑；依赖 Windows PowerShell、项目 Conda、Rust/MSVC，以及网页和桌面模式所需的 Node.js。
#>
[CmdletBinding()]
param(
    [ValidateSet('dev', 'rust', 'tauri')]
    [string]$Mode = 'dev',
    [switch]$Release
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-BootstrapPath {
    <# 从 packaging 节读取单行字符串路径；参数为节文本与键名，缺少配置或使用转义路径时抛出错误。 #>
    param([string]$Section, [string]$Key)
    $pattern = '(?m)^\s*{0}\s*=\s*(?:"([^"\r\n]+)"|''([^''\r\n]+)'')[ \t]*(?:#.*)?\r?$' -f [regex]::Escape($Key)
    $value = [regex]::Match($Section, $pattern)
    if (-not $value.Success) {
        throw "config/sat_layout_opt.toml 缺少有效的 packaging.$Key 路径。"
    }
    if ($value.Groups[1].Success) {
        $result = $value.Groups[1].Value
        if ($result.Contains('\')) {
            throw "packaging.$Key 的双引号路径请使用正斜杠，例如 D:/Conda_envs/payload-opt。"
        }
        return $result
    }
    return $value.Groups[2].Value
}

$exitCode = 1
$enteredProject = $false
try {
    $projectRoot = Split-Path -Parent $PSScriptRoot
    $configPath = Join-Path $projectRoot 'config\sat_layout_opt.toml'
    $content = [System.IO.File]::ReadAllText($configPath, [System.Text.Encoding]::UTF8)
    # PowerShell 仅解析引导所需的两个路径；完整 TOML 仍由现有 Python/Rust 入口读取和校验。
    $section = [regex]::Match($content, '(?ms)^\[packaging\][ \t]*\r?$(.*?)(?=^\[|\z)').Groups[1].Value
    $environmentPath = Get-BootstrapPath $section 'python_environment'
    $conda = Get-BootstrapPath $section 'conda_executable'
    $python = Join-Path $environmentPath 'python.exe'
    foreach ($required in @($conda, $python)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
            throw "未找到必需程序：$required，请检查 packaging 配置及项目环境。"
        }
    }

    $entry = 'scripts\rust_backend.py'
    $action = 'dev'
    if ($Mode -eq 'rust') { $action = 'run' }
    if ($Mode -eq 'tauri') { $entry = 'scripts\desktop\tauri.py'; $action = 'run' }
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $entry) -PathType Leaf)) {
        throw "启动入口不存在：$entry"
    }
    if ($Mode -ne 'rust' -and -not (Test-Path -LiteralPath (Join-Path $projectRoot 'frontend\node_modules\vite\bin\vite.js'))) {
        throw "缺少前端依赖，请在项目 Conda 环境中执行 npm --prefix frontend ci。"
    }

    Push-Location -LiteralPath $projectRoot
    $enteredProject = $true
    $env:PYTHONUTF8 = '1'
    $env:PYTHONIOENCODING = 'utf-8'
    $env:SAT_LAYOUT_OPT_PROJECT_ROOT = $projectRoot
    $arguments = @('run', '--no-capture-output', '-p', $environmentPath, $python, $entry, $action)
    if ($Release) { $arguments += '--release' }
    Write-Host "[SatLayoutOpt] 启动模式：$Mode；项目目录：$projectRoot"
    Write-Host "[SatLayoutOpt] 正在检查并构建 Rust 程序；缓存有效时会复用，失效时先清理旧产物。按 Ctrl+C 停止。"
    & $conda @arguments
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) { Write-Host "[SatLayoutOpt] 构建或启动失败，退出码：$exitCode，请查看上方错误。" -ForegroundColor Red }
} catch {
    Write-Host "[SatLayoutOpt] 启动失败：$($_.Exception.Message)" -ForegroundColor Red
} finally {
    if ($enteredProject) { Pop-Location }
}
exit $exitCode

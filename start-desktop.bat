@echo off
goto :start
@rem 文件说明：桌面端双击启动入口；直接委托 PowerShell 的 Tauri 模式，保留项目环境检查、构建、退出码与暂停逻辑。
:start
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-dev.ps1" -Mode tauri
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%SAT_LAYOUT_OPT_NO_PAUSE%"=="1" pause
endlocal & exit /b %EXIT_CODE%

@echo off
goto :start
@rem 文件说明：在可见终端中运行前后端开发服务，并在服务退出后保留窗口供排查。
:start
setlocal EnableExtensions DisableDelayedExpansion
title SatLayoutOpt Development Server
set "SAT_LAYOUT_OPT_PYTHON=D:\Conda_envs\payload-opt\python.exe"
pushd "%~dp0" >nul 2>&1 || goto :failed
node scripts\dev-supervisor.js
set "EXIT_CODE=%ERRORLEVEL%"
popd
goto :done

:failed
set "EXIT_CODE=1"
echo [ERROR] Project directory is not accessible: %~dp0

:done
echo.
pause
endlocal & exit /b %EXIT_CODE%

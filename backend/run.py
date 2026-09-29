"""文件说明：使用统一 TOML 地址和端口启动 SatLayoutOpt FastAPI 开发服务。"""

import uvicorn

from app.core.config import runtime_config


def main() -> None:
    """启动本地 FastAPI 服务，应用包路径固定为 backend。"""

    uvicorn.run(
        "app.main:app",
        host=runtime_config.backend_host,
        port=runtime_config.backend_port,
        app_dir="backend",
    )


if __name__ == "__main__":
    main()

/**
 * 文件说明：使用 Vite 客户端环境预热指定首页模块及其静态依赖，减少浏览器首次访问的转换等待。
 * 模块 URL 由统一 TOML 提供；不执行页面代码或请求业务 API，依赖当前锁定的 Vite 环境接口。
 */

/** 转换入口并等待静态依赖处理完成；入口不存在或转换失败时抛出异常，禁止报告假就绪。 */
export async function prepareDevServer(server, moduleUrls) {
  const client = server.environments.client;
  await Promise.all(moduleUrls.map(async (url) => {
    const result = await client.transformRequest(url);
    if (!result) throw new Error(`前端预热模块不存在：${url}`);
  }));
  await client.waitForRequestsIdle();
  // 静态依赖扫描完成后，预构建可能仍在运行；必须等待输出可读再向编排器报告就绪。
  const optimizer = client.depsOptimizer;
  await optimizer?.scanProcessing;
  const dependencies = Object.values({ ...optimizer?.metadata.optimized, ...optimizer?.metadata.discovered });
  await Promise.all(dependencies.map(async (dependency) => {
    await dependency.processing;
    await client.transformRequest(`/@fs/${dependency.file}`);
  }));
}

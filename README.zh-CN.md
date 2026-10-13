# Orbitalis

基于 Three.js 与 TypeScript 的交互星球与环形空间站。默认场景名为 **Pelagia**。

[在线演示](https://winrisef.github.io/Orbitalis/) · [下载](https://github.com/WinriseF/Orbitalis/releases/latest) · [English](README.md)

![Pelagia 场景](public/media/cinematic/planet_fallback.webp)

## 功能

- 星球独立旋转；空间站绕星球公转，圆环相对固定的中心与长桅杆独立自转。
- 拖动星球旋转，拖动可见空间站可前后环绕并改变轨道倾角。
- 滚轮、双指缩放，Shift 拖动平移，支持键盘、暂停与复位。
- 不支持完整场景的设备会显示明确标注的静态预览。

首个公开版保留 v14 的视觉、模型细节、完整贴图与固定 4K 画布请求。这是艺术化轨道场景。

## 本地启动

需要 Node.js 22 或更新版本、npm 和 `tar` 命令（当前 Windows、macOS、Linux 通常自带）。

```sh
git clone https://github.com/WinriseF/Orbitalis.git
cd Orbitalis
npm ci
npm run setup:assets
npm run dev
```

打开 **http://localhost:4173/**。源码修改后自动重新打包，刷新页面查看。首次下载完整资源较大，之后会校验并复用。

```sh
npm run build
npm run preview
```

`dist/` 可部署在网站根目录或 `/Orbitalis/` 子目录。请通过 HTTP(S) 访问；生产环境使用 HTTPS，模型 SHA-256 校验依赖 Web Crypto。

也可以直接下载 Release 中的 `orbitalis-v0.1.0-web.zip`，解压后用静态 HTTP 服务打开。

## 操作

| 操作 | 效果 |
| --- | --- |
| 拖动星球 | 只旋转星球 |
| 拖动可见空间站 | 调整轨道平面并前后环绕 |
| 滚轮 / 双指 | 缩放；双指移动中点可平移 |
| Shift 拖动 | 平移视角 |
| 方向键 | 调整星球角度 |
| + / − | 缩放 |
| Home / 复位 | 恢复初始视图并停止动态 |

## 设备要求

当前完整运行资源约 **195 MiB**，星球贴图为 **15360 × 7680**，完整 PNG 原样嵌入模型；空间站约 **43 万三角面**。仅贴图及 mipmap 就可能占用约 **600 MiB 显存**，画布请求长边 **3840 像素**。

v0.1.0 保留高清效果，不提供自动降级的低分辨率三维版本。设备纹理上限不足或显存分配失败时显示静态预览。减少动态和省流量偏好会延后加载，直至明确交互。

## 开发与素材

源码、场景配置和预览图位于 Git；大型模型通过 Release 下载，下载脚本校验资源包和模型分片的 SHA-256。

[架构说明](ARCHITECTURE.md) · [素材来源与编辑说明](docs/assets.md)

开发者需要时可运行 `npm test`，构建后可运行 `npm run check`。已有测试包含真实 Three.js 变换及模型解析，部分 WebGL 与图像解码使用 mock。本次发布未主动重跑测试，历史离线验证不代表浏览器 GPU 或跨设备性能验证。

## 许可证

项目代码及随本版发布的场景素材采用 [MIT](LICENSE)，第三方依赖保留各自许可证。素材的已记录来源与原始输入缺失情况见 [素材说明](docs/assets.md)。

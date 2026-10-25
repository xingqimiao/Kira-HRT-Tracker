# 自部署 Kira HRT：先选择安装场景

[English](README.en.md) · [项目首页](https://github.com/xingqimiao/Kira-HRT-Tracker)

提供账号、同步、分享、MCP 和离线化验单识别。无需注册 Oracle、Firebase、Cloudflare 或第三方登录账号，无需安装 Node、编译代码或手写数据库密码。

**只打开下面与你情况相符的一篇，从第 1 步开始。两篇安装教程不需要来回切换。**

| 你的情况 | 应该打开哪篇 |
|---|---|
| 有公网 Linux 服务器和自己的域名，希望通过互联网访问 | **[公网服务器部署教程](SERVER.md)**：域名解析、服务器终端、自动 HTTPS |
| 在家里的 NAS / Windows / macOS / Linux 电脑上运行 | **[局域网 / NAS 部署教程](LAN.md)**：固定 IP、本地证书、每台设备信任 |
| 已安装，想备份、升级、恢复或排查通用错误 | [维护与故障处理](MAINTENANCE.md) |

## 下载什么？

**[下载 2.3.2 部署包](https://github.com/xingqimiao/Kira-HRT-Tracker/releases/download/self-host-v2.3.2/kira-hrt-self-host-2.3.2.tar.gz)**

两种场景使用同一个包，各自教程已提供完整下载、解压和安装命令。解压后先看本文件，再打开 `SERVER.md` 或 `LAN.md`。中英文安装及维护文档均包含在包内。

部署包内含应用镜像版本、脚本和中英文教程。**已有实例不需要重新安装或初始化**，按[维护文档](MAINTENANCE.md)的升级命令切到 2.3.2 即可；旧版本的部署包仍保留。

## GitHub 两个 package 是什么？

| 名称 | 作用 | 需要手动下载吗？ |
|---|---|---|
| [`kira-hrt-web`](https://github.com/users/xingqimiao/packages/container/package/kira-hrt-web) | 网页和 HTTPS 入口 | 不需要，安装命令自动下载 |
| [`kira-hrt-api`](https://github.com/users/xingqimiao/packages/container/package/kira-hrt-api) | 账号、同步、分享、MCP 后端 | 不需要，安装命令自动下载 |
| PostgreSQL 官方镜像 | 数据库 | 同样自动下载，不用单独安装 |

不是二选一，也不用分别安装。Docker 自动选择 Linux amd64 或 arm64，无需 GitHub 登录。你只需下载部署压缩包，按自己场景的教程操作。

备份、密钥保护、源码构建、可选集成和加密边界见 [维护手册](MAINTENANCE.md)。[验证记录](https://github.com/xingqimiao/Kira-HRT-Tracker/blob/rewrite/deploy/self-host/VERIFICATION.md) 区分已验证和仍需真机验收的内容。保留 GPL 许可和上游署名。

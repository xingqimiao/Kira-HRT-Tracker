# 自部署 Kira HRT

[English](README.en.md)

完整 Web/PWA 版，包含账号、同步、分享、MCP 和本机化验单识别。默认无需 Oracle、Firebase、Cloudflare 或 OAuth 账号。主项目的算法署名与 GPL 许可继续适用。

## 首次启动

需要 Docker Engine 或 Docker Desktop，以及支持 `up --wait` 的 Compose v2。Linux 容器支持 amd64 与 arm64。预构建包仅在对应的 **self-host-v版本号** Release 发布并完成镜像流水线后可用；仓库中的工作版本不代表镜像已发布。

从本项目 GitHub Releases 下载 `kira-hrt-self-host-版本号.tar.gz`，解压进入目录。公网域名先解析到服务器并开放 TCP 80、443；NAS 请先固定局域网 IP，确保这两个端口没有被其他服务占用。

Linux/macOS：

```sh
sh hrt.sh init https://hrt.example.com
sh hrt.sh start
sh hrt.sh check
```

Windows PowerShell：

```powershell
./hrt.ps1 init https://hrt.example.com
./hrt.ps1 start
./hrt.ps1 check
```

将地址改为自己的域名。初始化会生成 `.env`、`secrets/master.key`、`Caddyfile`，重复运行会拒绝覆盖。访问网站后直接注册账号；默认允许多用户注册，保留登录及注册限流。API 和数据库不开放宿主机端口，仅 Caddy 接收入口流量。当前端口固定为 80/443，不支持 URL 子路径。

## NAS、局域网与 PWA

初始化时填写 `https://192.168.1.20`、`https://hrt.local` 等固定地址即可自动使用本地 CA。域名必须在客户端解析到 NAS；手机与 NAS 应处于可互访网络。

1. 启动后执行 `sh hrt.sh cert`（Windows：`./hrt.ps1 cert`），导出公开根证书 `local-root.crt`。
2. 通过可信的本地传输方式将证书交给自己的设备。iOS/iPadOS 在“设置 → 通用 → VPN 与设备管理”安装描述文件，再在“关于本机 → 证书信任设置”启用完全信任；Android 在系统安全设置中安装 CA 证书，各厂商入口不同。
3. Windows 导入当前用户的“受信任的根证书颁发机构”，macOS 在钥匙串中导入并设置信任。部分浏览器使用独立证书库，也需要导入。
4. 确认浏览器能正常验证 HTTPS，再通过浏览器菜单“安装应用”或“添加到主屏幕”安装 PWA。浏览器对后台提醒的支持不同，服务端 FCM 补推默认关闭。

只安装自己生成且确认来源的 CA。私钥留在 Docker 的 Caddy 数据卷中，`cert` 命令只导出公开证书。忽略证书警告不等于建立信任，也不能保证 PWA 可用。公网证书不需要这些安装步骤。

## 日常维护

下列命令的 Windows 对应形式是 `./hrt.ps1 命令 参数`。

| 命令 | 用途 |
|---|---|
| `sh hrt.sh status` / `logs` / `check` | 查看容器、跟踪日志、等待健康检查通过 |
| `sh hrt.sh stop` / `start` | 停止或启动，不删除数据卷 |
| `sh hrt.sh backup` | 暂停 API，生成一致的数据库快照和独立的配置、密钥、CA 文件，再恢复 API |
| `sh hrt.sh restore 20261024T120000Z` | 从 `backups/名字` 恢复到未初始化的目录及新数据卷 |
| `sh hrt.sh upgrade 2.2.2` | 拉取指定版本，备份当前实例，再升级并等待健康检查 |

备份完成后会显示目录，其中 `database.dump` 是数据库快照，`master.key` 是独立的主密钥备份，`config.env` 含数据库密码，`caddy/` 含证书与私钥，`manifest.json` 校验所有文件是否配对。备份没有额外加密；请通过受限的加密存储离线保存，密钥副本与数据库副本分开保管。Linux 脚本限制文件权限；Windows 用户应限制目录 NTFS ACL，仅允许自己的账号与管理员访问。

恢复时，在另一个新解压目录中创建 `backups/` 并复制完整备份目录，不要执行 `init`，直接运行 `restore 名字`。工具先校验备份、拒绝已有配置，创建独立 Compose 项目，并要求目标数据库无表。原访问地址必须仍可用；局域网恢复会保留原 CA 信任。恢复完成后，原有账号、会话及 MCP 令牌保持原有生命周期。若导入失败，保留失败目录供诊断，使用另一个空目录重试，不要手工清空现有实例。

升级不接受 `latest`，不自动升级 PostgreSQL 主版本。升级失败会返回非零退出码，不报告成功；保留备份和日志。涉及不兼容数据库变更时，应使用升级前备份恢复到新实例，不能只回退镜像。不要运行 `docker compose down -v`，它会删除数据库和证书卷。

## 密钥、迁移与可选功能

本地提供方使用随机 32 字节主密钥，以 AES-256-GCM 封装逐账号密钥及 pad，并绑定账号和用途。数据库仍保存密文，但本地密钥与运行服务器在同一管理边界，**不具备独立 OCI HSM 的密钥隔离能力，也不是端到端加密**。密钥缺失或数据库与密钥不匹配时，API 拒绝启动。不要编辑或重新生成已有 `master.key`。

首版仅支持新数据库。从官网或 OCI 部署迁移，请在原应用导出，在新实例导入，再抽查记录。不要直接复制官网数据库并切换 `KEY_PROVIDER`。

OAuth、Turnstile、FCM、赞助 webhook 默认关闭。高级配置通过另建 Compose override 文件完成；更改后必须将 override 一并用于所有维护命令，并备份该文件。OAuth/FCM 需要为 API 增加可出站网络，仍不得映射 API 端口。认证配置参考 `server/.env.example`；启用 Turnstile 或 FCM 还需要自行构建匹配的前端及 Service Worker，预构建的默认镜像不包含这些集成。官网构建必须显式设置自己的 `VITE_TURNSTILE_SITE_KEY`；代码不再隐式使用官网 key。

Android 官网安装包仍连接官网；本发行版通过手机浏览器/PWA 访问。源码和上游署名链接仍可见，点击外部链接会访问相应站点。

## 从源码构建与发布

在完整源码仓库的 `deploy/self-host/` 执行 `init` 后运行 `sh hrt.sh build`，再 `start`。它使用 `compose.build.yaml`，不需要宿主机 Node。部署压缩包不含完整源码，不能直接执行源码构建。

维护者执行 `node scripts/package-self-host.mjs` 生成白名单部署包；版本取自主项目 `package.json`。推送匹配版本的 `self-host-v版本号` 标签触发流水线，在 amd64、arm64 验证后发布 GHCR 镜像及 Release 压缩包。默认镜像前缀为 `ghcr.io/xingqimiao/kira-hrt`，fork 维护者需在初始化后的 `.env` 中设置自己的 `IMAGE_PREFIX`，并将 GHCR 包设为公开。

容器流水线通过不等于手机验收已完成；正式宣布可用前还需要实际验证公网证书、手机 CA 信任、PWA、备份恢复及一次版本升级。

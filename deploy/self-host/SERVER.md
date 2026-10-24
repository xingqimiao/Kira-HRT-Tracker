# 公网服务器部署：域名与自动 HTTPS

[部署入口](README.md) · [局域网 / NAS 教程](LAN.md) · [English](SERVER.en.md)

适合已经有公网 Linux 服务器和自己域名、希望在互联网访问的用户。本教程以 Ubuntu 服务器为例，amd64、arm64 均可。按五步完成：准备域名 → 登录服务器 → 准备 Docker → 下载安装 → 打开网页。

**本教程使用公开可信 HTTPS，不需要导入自签证书。** 账号、同步、分享、MCP 和离线化验单识别均保留，不需要 Oracle、Firebase 或 OAuth 账号。

## 第 1 步：准备域名和端口

假设你希望使用 `https://hrt.example.com`，服务器公网 IP 是 `203.0.113.10`。**这两个都是示例，请替换成自己的实际值。**

| 在哪里操作 | 要做什么 | 完成标准 |
|---|---|---|
| 域名的 DNS 管理页面 | 增加 A 记录，主机名填 `hrt`，值填服务器公网 IPv4 | `hrt.你的域名` 解析到这台服务器 |
| 云服务器安全组 / 防火墙 | 放行入站 TCP 80 和 443 | 浏览器和证书签发服务能连接 Caddy |
| 服务器上的其他网站 / 容器 | 确认没有占用 80、443 | 两个端口可供本安装包使用 |

如果域名有 AAAA 记录，IPv6 也必须能正确到达这台服务器；没有可用 IPv6 时不要留下错误的 AAAA 记录。若 DNS 平台提供代理/CDN 模式，先使用直接解析，等网站正常后再考虑代理定制。

当前安装包不支持 `:8443` 等自定义入口端口，也不支持 `/hrt` URL 子路径。不要开放 API 的 8788 或数据库的 5432 端口。

## 第 2 步：从电脑登录服务器

Windows 打开 PowerShell，macOS / Linux 打开终端。在自己的电脑上输入：

```sh
ssh ubuntu@203.0.113.10
```

把 `ubuntu` 换成云平台提供的实际用户名，把 IP 换成服务器公网 IP。按云平台要求用密码或 SSH 密钥登录；输入密码时不显示字符是正常的。也可以使用云平台的网页终端。

**从现在起，所有安装命令都在这个服务器终端执行。** 不需要在自己的电脑安装 Docker Desktop；关闭 SSH 窗口不会关闭已启动的网站。

## 第 3 步：在服务器准备 Docker

若服务器已有 Docker，先执行：

```sh
docker info
docker compose version
```

第一行应包含 `Server` 信息，第二行应显示 Compose v2；Compose 还需支持 `up --wait`。两条都成功即可继续第 4 步。

未安装时，按 [Docker 官方 Ubuntu 安装教程](https://docs.docker.com/engine/install/ubuntu/)的 **Install using the apt repository** 一节安装 Engine 和 Compose 插件；其他系统使用对应发行版的官方教程。安装后重新执行上面两条命令。

如果普通用户提示 `permission denied`，按 [Docker 用户权限说明](https://docs.docker.com/engine/install/linux-postinstall/)配置权限并重新登录 SSH。后续使用同一用户，不要混用普通用户和 `sudo` 创建部署文件。如果提示 `Cannot connect to the Docker daemon`，先启动 Docker 服务。

## 第 4 步：下载、解压，然后运行一条安装命令

本教程下载 **2.2.2 setup.2**。应用镜像仍为 2.2.2，后缀只表示部署文档修订。已有实例不需要重新安装。

先选一个长期保留、有写入权限的目录，例如自己的主目录。下面的目标目录若已存在，先确认是不是旧实例，不要覆盖。在服务器终端逐行执行，**有一行报错就先停止处理，不要继续粘贴后面的命令**：

```sh
cd ~
curl -fL --retry 3 -o kira-hrt-self-host-2.2.2-setup.2.tar.gz https://github.com/xingqimiao/Kira-HRT-Tracker/releases/download/self-host-v2.2.2/kira-hrt-self-host-2.2.2-setup.2.tar.gz
tar -xzf kira-hrt-self-host-2.2.2-setup.2.tar.gz
cd kira-hrt-self-host-2.2.2
ls
```

应看到 `hrt.sh`、`compose.yaml`、`manage.mjs`、`VERSION` 和这些教程。不要下载 APK、Source code 或单独的 GitHub Packages；脚本会自动拉取网页、后端和 PostgreSQL 镜像，无需 GitHub 登录。

将下一行的域名替换成第 1 步配置的真实域名：

```sh
sh hrt.sh install https://hrt.example.com
```

脚本自动生成密码和主密钥，下载镜像、创建数据库、启动三个服务并等待健康检查。首次可能需要几分钟；`Pulling`、`Downloading`、`Starting` 是正常进度，不要重复安装。

正常结束会显示 `[1/3]`、`[2/3]`、`[3/3]`，然后是 `Services are running. Open https://你的域名`。公网部署没有 `local-root.crt` 是正常的，证书由 Caddy 自动申请。

如果已有配置或上次安装只完成一半，**不要删 `.env` 或主密钥**。修正错误后在同一目录执行 `sh hrt.sh start`，不要再次执行 `install` / `init`。

## 第 5 步：在浏览器打开，注册并验证

在电脑或手机浏览器输入安装时的完整地址，例如 `https://hrt.example.com`。证书申请可能稍晚于容器启动，稍等后重试。不要跳过证书错误，也不需要手动导入根证书。

1. 确认地址正确、没有 HTTPS 证书错误。
2. 点击注册，创建自己实例的账号；官网账号不会自动迁移。
3. 添加一条记录，刷新页面，确认记录仍在。
4. 在手机上打开同一域名，登录并确认记录；需要时通过浏览器“安装应用”或“添加到主屏幕”安装 PWA。
5. 按 [维护手册](MAINTENANCE.md) 创建第一份备份，保管好配置、主密钥及数据库。

三个容器健康不等于公网证书已经签发，以浏览器实际通过 HTTPS 验证为准。手机上的官网 APK 仍连接官网，自部署使用这里的 Web/PWA。

## 公网访问失败时，按这个顺序检查

| 现象 | 下一步 |
|---|---|
| 域名打不开 / 连接超时 | 检查 A/AAAA 记录、安全组、服务器防火墙及 TCP 80/443 |
| 证书错误或一直申请失败 | 检查域名是否实际到达 Caddy，查看 web 日志里的证书错误；不要给设备安装局域网证书来绕过公网问题 |
| `port is already allocated` | 找到占用 80/443 的网站、代理或容器，安排好端口后执行 `start` |
| `Already initialized` | 保留原配置和密钥，执行 `start`；不要重新生成密钥 |
| Docker、镜像拉取或健康检查报错 | 按 [通用故障处理](MAINTENANCE.md) 检查 |

查看状态 / 日志，在原部署目录执行：

```sh
sh hrt.sh status
sh hrt.sh logs
```

日志窗口按 Ctrl+C 只退出查看，不会停止网站。分享日志前遮盖密码、令牌和个人数据。后续备份、升级、恢复都在 [维护手册](MAINTENANCE.md)。

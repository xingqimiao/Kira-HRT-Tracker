# 自部署 Kira HRT：从下载到打开网页

[English](README.en.md) · [项目首页](https://github.com/xingqimiao/Kira-HRT-Tracker)

这份教程面向第一次使用 Docker 的人。你将得到自己的 HRT 网站，包含账号、同步、分享、MCP 和离线化验单识别。**不用注册 Oracle、Firebase、Cloudflare 或第三方登录账号，不用安装 Node、编译代码或手写数据库密码。**

你需要准备一台能运行 Docker 的设备，选定访问地址，下载部署包，然后运行安装命令。局域网访问还需要在手机/电脑上信任一次证书。

## 先解释：GitHub 上为什么有两个 package？

它们是供 Docker 下载的程序，**不是让你二选一，也不用分别点击下载**。

| 名称 | 作用 | 你需要做什么 |
|---|---|---|
| [`kira-hrt-web`](https://github.com/users/xingqimiao/packages/container/package/kira-hrt-web) | 网页 + Caddy，负责浏览器入口和 HTTPS | 安装命令自动下载 |
| [`kira-hrt-api`](https://github.com/users/xingqimiao/packages/container/package/kira-hrt-api) | 后端，负责账号、同步、分享、MCP | 安装命令自动下载 |
| PostgreSQL | 数据库，使用 PostgreSQL 官方镜像 | 同样自动下载，不用自己安装 |

Docker 自动选择 amd64 或 arm64。你真正要下载的是第 3 步的**部署压缩包**，里面已写好如何把这些程序一起启动。

## 第 1 步：在运行网站的设备上安装 Docker

**所有命令都在“准备存放数据、运行网站的那台设备”上执行。** 网站放在 NAS，就在 NAS 终端执行；放在云服务器，就先 SSH 登录服务器。在笔记本上执行命令不会自动给云服务器安装。

| 你的设备 | 先做什么 |
|---|---|
| Windows | 安装并打开 [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/)，使用 Linux 容器，等待引擎启动 |
| macOS | 安装并打开 [Docker Desktop](https://docs.docker.com/desktop/setup/install/mac-install/)，等待引擎启动 |
| Ubuntu 服务器 | 按 [Docker 官方 Ubuntu 教程](https://docs.docker.com/engine/install/ubuntu/)安装 Engine 和 Compose 插件；其他 Linux 选择对应发行版教程 |
| 群晖 / 威联通 / 其他 NAS | 应用中心安装 Container Manager / Container Station / Docker，开启 SSH；设备须支持 Linux amd64 或 arm64 容器 |

Windows：右键开始按钮，打开 PowerShell。macOS：打开“终端”。NAS / 云服务器：打开 SSH 终端。

若从电脑连接 NAS / 云服务器，先在电脑终端执行 SSH，例如 `ssh kira@192.168.1.20`：把 `kira` 换成设备的实际登录用户名，把 IP 换成设备地址；它不是本项目预设的账号。按提示输入设备密码，**输入时不显示字符是正常的**。登录成功后，后续命令才是在远端执行。NAS 需先在控制面板的终端/SSH 设置中开启 SSH；云服务器也可用云平台提供的终端。接着验证 Docker：

```sh
docker info
docker compose version
```

第一行应显示 `Server` 信息；第二行应显示 Compose v2 的版本号，并且该版本需支持 `up --wait`。**两个都成功再继续。** 只有 Docker 客户端版本不能证明引擎已运行。

`permission denied` 表示当前用户无 Docker 权限，按设备说明或 [Docker 权限说明](https://docs.docker.com/engine/install/linux-postinstall/)修正；后续始终使用同一用户，不要混用普通用户和 `sudo`。找不到 `compose` 时安装 Compose v2 插件，不是旧的 `docker-compose` v1。

## 第 2 步：选定访问地址

这是以后在浏览器输入的地址，**先选好再安装，不要直接照抄示例**。

| 场景 | 示例 | 安装前必须做 |
|---|---|---|
| 在家里使用，装在 NAS / 家用电脑 | `https://192.168.1.20` | 在路由器给运行 Docker 的设备固定 IP；换成该设备的实际 IP |
| 已有局域网域名 | `https://hrt.local` | 确认手机、电脑能把它解析到服务器；脚本不会创建 DNS 记录 |
| 使用公网域名 | `https://hrt.example.com` | 换成自己的域名，设置 DNS A 记录指向服务器公网 IP，在安全组/防火墙放行 TCP 80、443 |

家用首次安装推荐固定局域网 IP，省掉域名解析。手机须在同一局域网，或通过你自行配置的 VPN 互通；局域网 IP 不会自动变成公网地址。

此安装包需要占用 **80 和 443 端口**。NAS 的网页服务或其他反向代理已占用时，应先安排空闲的设备/IP，或由熟悉代理的人定制部署。不能直接加 `:8443`，也不支持 `/hrt` 这样的 URL 子路径。公网部署先让域名直接连到 Caddy，验证成功后再考虑外层代理/CDN。

## 第 3 步：下载、解压，进入包含脚本的目录

本教程使用 **2.2.2 安装脚本修订包 setup.1**。应用镜像仍固定为 2.2.2；后缀只表示脚本和教程修订。已有实例不用重新初始化。

**[点击下载 kira-hrt-self-host-2.2.2-setup.1.tar.gz](https://github.com/xingqimiao/Kira-HRT-Tracker/releases/download/self-host-v2.2.2/kira-hrt-self-host-2.2.2-setup.1.tar.gz)**

也可以到 [自部署 Release](https://github.com/xingqimiao/Kira-HRT-Tracker/releases/tag/self-host-v2.2.2) 的 Assets 中找这个文件。不要选 APK、Source code 或 Packages 页的镜像。`.sha256` 只是可选的文件校验信息，不是安装程序。

### Windows

把文件保存到“下载”文件夹，然后在 PowerShell 逐行执行：

```powershell
cd "$HOME\Downloads"
tar -xzf .\kira-hrt-self-host-2.2.2-setup.1.tar.gz
cd .\kira-hrt-self-host-2.2.2
Get-ChildItem
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

应看到 `hrt.ps1`、`hrt.sh`、`compose.yaml`、`manage.mjs`、`VERSION`。最后一行只允许**当前窗口**运行脚本，不会修改全局策略；如询问是否执行，请阅读并确认。公司策略禁止运行脚本时联系设备管理员。

### Linux / macOS / NAS

先进入一个有写入权限、准备长期保留的目录。NAS 可用你的 `docker` 共享文件夹，**不要用重启会清空的临时目录**。逐行执行：

```sh
curl -fL --retry 3 -o kira-hrt-self-host-2.2.2-setup.1.tar.gz https://github.com/xingqimiao/Kira-HRT-Tracker/releases/download/self-host-v2.2.2/kira-hrt-self-host-2.2.2-setup.1.tar.gz
tar -xzf kira-hrt-self-host-2.2.2-setup.1.tar.gz
cd kira-hrt-self-host-2.2.2
ls
```

应看到 `hrt.sh`、`compose.yaml`、`manage.mjs`、`VERSION`。NAS 没有 `curl` 时，可以在电脑下载，通过 NAS 文件管理器上传并解压，然后 SSH 中 `cd` 到包含 `hrt.sh` 的那一层。

**目录已存在时先停下，确认是不是之前的部署；不要在已有实例里重新解压、安装或删除文件。**

## 第 4 步：只运行一条安装命令

按你的情况**选择一条**，把地址换成第 2 步选好的真实地址：

| 场景 | Linux / macOS / NAS | Windows PowerShell |
|---|---|---|
| 家里 / NAS | `sh hrt.sh install https://192.168.1.20` | `./hrt.ps1 install https://192.168.1.20` |
| 公网服务器 | `sh hrt.sh install https://hrt.example.com` | `./hrt.ps1 install https://hrt.example.com` |

脚本自动生成密码和主密钥、下载镜像、创建数据库、启动三个服务并等待健康检查。首次可能需要几分钟；`Pulling`、`Downloading`、`Starting` 是正常进度，**不要反复运行 `install`**。

正常结束时可看到：

```text
[1/3] Creating configuration and encryption key...
[2/3] Downloading images and starting services ...
[3/3] Preparing your access instructions...
Services are running. Open https://你的地址
```

局域网会自动生成 `local-root.crt`，继续第 5 步。公网直接用浏览器打开地址；证书可能还在申请，稍等后重试。**容器健康不代表公网 HTTPS 已成功，以浏览器能正常验证证书为准。**

旧的 `kira-hrt-self-host-2.2.2.tar.gz` 没有 `install`。可换用上方 setup.1 包，或在旧包的新目录依次执行 `sh hrt.sh init 你的地址`、`sh hrt.sh start`，局域网再执行 `sh hrt.sh cert`。Windows 换成 `./hrt.ps1`。已有配置只执行 `start`，不再执行 `init`。

## 第 5 步：局域网设备信任证书，然后打开网页

**公网 HTTPS 已正常工作的人跳过证书安装。** 局域网每台手机/电脑需要信任一次自己的根证书。“继续访问不安全的网站”不能替代此步骤。

找到部署目录里的 `local-root.crt`。在 NAS 上部署，就用 NAS 文件管理器把它复制给手机/电脑。通过可信的文件传输方式只传这个公开证书，**不要传 `secrets/master.key` 或整个 Caddy 数据卷**。

| 打开网页的设备 | 信任证书的操作 |
|---|---|
| Windows | 双击证书 → 安装证书 → 当前用户 → 将所有证书放入下列存储 → 浏览 → **受信任的根证书颁发机构** → 完成，重开浏览器 |
| macOS | “钥匙串访问”导入证书 → 打开证书 → 信任 → 使用此证书时选择“始终信任”，重开浏览器 |
| iPhone / iPad | 在“文件”中打开证书 → 设置 → 通用 → VPN 与设备管理 → 安装描述文件；再到通用 → 关于本机 → **证书信任设置**，启用该根证书的完全信任 |
| Android | 设置搜索“CA 证书”或“安装证书” → 安装 CA 证书 → 选中 `local-root.crt`，重开浏览器；各品牌入口不同 |
| Firefox / Linux 桌面 | 若仍不信任，在浏览器设置 → 隐私与安全 → 证书 → 查看证书 → 证书颁发机构中导入，允许用于识别网站；入口依版本而异 |

只信任自己部署生成的证书。在浏览器输入**安装时同一个 HTTPS 地址**，例如 `https://192.168.1.20`，确认没有证书错误；不要随意换域名或改成 `http://`。

网页打开后点击注册，创建自己的账号。官网账号不会自动出现在你的实例里。默认可以继续创建多个账号，并保留注册/登录限流。

像 App 一样使用：Android / 桌面 Chrome 或 Edge 在菜单选择“安装应用”或“添加到主屏幕”；iPhone / iPad 用 Safari 分享 → 添加到主屏幕。**官网 APK 仍连接官网，自部署手机端使用这个 PWA。**

## 怎样算成功？

1. 安装命令正常结束，没有错误退出。
2. 浏览器能打开选定的 HTTPS 地址，没有证书错误。
3. 能注册、登录、添加一条记录，刷新后记录仍存在。
4. 如需手机访问，手机上输入同一地址也能打开；需要 PWA 时再安装到主屏幕。

`sh hrt.sh status`（Windows：`./hrt.ps1 status`）应显示 web、api、db 三个服务运行并健康。API 和数据库没有对外端口是正常设计，不需要开放 8788 或 5432。

## 遇到问题：看见什么，就做什么

| 现象 | 下一步 |
|---|---|
| 找不到 docker | 回到第 1 步安装 Docker，再重新打开终端 |
| `Cannot connect to the Docker daemon` | 打开 Docker Desktop，或启动服务器上的 Docker 服务，再执行 `docker info` |
| `permission denied` / 无法访问 Docker socket | 修正当前用户权限，再用同一用户操作；不要删除配置重试 |
| 找不到 `hrt.sh` / `hrt.ps1` | 用 `ls` / `Get-ChildItem` 查看当前目录，进入包含脚本的那一层 |
| PowerShell 禁止运行脚本 | 在当前窗口执行第 3 步的进程级执行策略命令 |

| 安装阶段的现象 | 下一步 |
|---|---|
| `Already initialized` / `refusing to overwrite` | 配置已经存在，**不要删密钥**；执行 `start`，局域网再执行 `cert` |
| `port is already allocated` / `address already in use` | 检查 NAS 网页服务、其他代理或容器是否占用 80/443，先解决端口冲突 |
| 拉取镜像出现 `denied` / `unauthorized` / `manifest unknown` | 官方镜像公开，无需 GitHub 登录；检查网络和 `.env` 中版本/镜像前缀，只用已发布版本，不用 `latest` |
| 下载超时 / connection reset / TLS 错误 | 检查这台设备到 GHCR、Docker Hub、GitHub 的网络和 Docker 代理，恢复后执行 `start`；不要关闭 TLS 校验 |
| 启动超时 / `unhealthy` | 执行下方 `status` 和 `logs` 看哪个服务报错；不要删数据卷或重建主密钥 |

如果提示 `unknown flag: --wait`，更新 Docker/Compose v2 后执行 `start`，不必重新初始化。

| 浏览器的现象 | 下一步 |
|---|---|
| 公网打不开 / 证书申请失败 | 检查 DNS、80/443、安全组和 web 日志；如有 AAAA 记录，IPv6 也必须能到该服务器 |
| NAS 正常，手机打不开 | 确认手机连接家中 Wi-Fi、地址正确、网络可互访，未启用访客隔离，再检查证书 |
| 证书不受信任 | 回到第 5 步；iOS 还要开启“完全信任” |
| 没有“安装应用” | 先确认 HTTPS 可信，再确认浏览器支持 PWA；可先使用网页，后台提醒支持依浏览器而异 |
| 账号 / 数据和官网不同 | 正常；在原应用导出，在新实例导入并抽查。不能直接复制 OCI 数据库后切换密钥提供方 |

查看状态和日志，Windows 将 `sh hrt.sh` 换为 `./hrt.ps1`：

```sh
sh hrt.sh status
sh hrt.sh logs
```

日志持续显示时按 **Ctrl+C 只退出查看，不会停止网站**。求助附上状态、错误和相关日志，先遮盖令牌、密码、密钥与个人数据。

## 日常维护：始终在原部署目录操作

电脑睡眠/关机、NAS 关机或 Docker 停止，网站也会离线。设备和 Docker 正常启动后，容器有自动重启策略。不要换目录重新 `install`。

| 目的 | Linux / macOS / NAS | Windows PowerShell |
|---|---|---|
| 状态 / 健康检查 | `sh hrt.sh status` / `sh hrt.sh check` | `./hrt.ps1 status` / `./hrt.ps1 check` |
| 停止 / 启动 | `sh hrt.sh stop` / `sh hrt.sh start` | `./hrt.ps1 stop` / `./hrt.ps1 start` |
| 再次导出公开证书 | `sh hrt.sh cert` | `./hrt.ps1 cert` |
| 备份 | `sh hrt.sh backup` | `./hrt.ps1 backup` |

### 备份：第一次存入重要数据后就做

`backup` 短暂停止网页和 API，生成一致快照，然后恢复服务。等待命令结束，会显示 `Backup complete: backups/某个名字`。到该目录查看：

```text
backups/20261025T120000Z/  ← 实际名字以输出为准
  database.dump          ← 数据库快照
  master.key             ← 恢复必需的主密钥
  config.env             ← 含数据库密码的配置
  Caddyfile、caddy/、manifest.json
```

保留**整套**备份，包括 CA。备份没有额外加密，放在受限的加密存储中；主密钥副本与数据库副本分开保管，恢复时再组成完整目录。Linux 工具限制权限；Windows 在目录属性 → 安全中限制 NTFS 权限，仅允许自己的账号和管理员。只有数据库、没有主密钥，无法恢复。

### 升级：指定已发布版本，不追踪 latest

假设未来发布了 2.2.3，才运行 `sh hrt.sh upgrade 2.2.3`；Windows：`./hrt.ps1 upgrade 2.2.3`。**这里只演示格式，不表示 2.2.3 已发布。** 工具先拉镜像，再备份当前数据、更新版本、等待健康检查；成功才显示 `Upgrade healthy`。

不自动升级 PostgreSQL 主版本。失败时保留日志与备份；数据库不兼容时需从升级前备份恢复，不能保证只换回旧镜像即可恢复。

### 恢复：只在新的空目录操作

1. 保留原实例和备份。将与备份版本匹配的部署包解压到另一个空目录，**不要执行 `install` / `init`**。
2. 新目录创建 `backups`，放入整套备份，形成 `backups/你的备份名字/database.dump` 等文件。
3. 在新目录执行 `sh hrt.sh restore 你的备份名字`，Windows 用 `./hrt.ps1 restore 你的备份名字`。参数是目录名，不是完整路径。
4. 工具检查文件校验、密钥配对和空数据库后恢复。继续使用原地址；确保地址可用，原实例不同时争用同一端口。
5. 浏览器确认原账号、记录、未过期令牌可用。局域网 CA 随备份恢复。失败时保留失败目录，另找空目录重试，不要清空已有数据库。

**不要用 `docker compose down -v`“修复”问题：`-v` 会删除数据库和证书卷。不要编辑、删除或重新生成已有的 `secrets/master.key`。**

## 可选：定制与源码构建

普通使用者不需要下面的步骤。源码构建需要完整源码仓库，部署压缩包不含源码。进入源码的 `deploy/self-host/`，依次执行 `sh hrt.sh init 你的地址` → `sh hrt.sh build` → `sh hrt.sh start`；Windows 使用相同 `./hrt.ps1` 子命令。不要先 `install`，它使用预构建镜像。编译在容器中进行，不要求宿主机 Node。

OAuth、Turnstile、FCM、赞助集成及官网更新默认关闭，不影响基础功能。配置参考 [server/.env.example](https://github.com/xingqimiao/Kira-HRT-Tracker/blob/rewrite/server/.env.example)；启用验证码/推送还需构建匹配前端和 Service Worker。维护脚本显式加载 `compose.yaml`，**不会自动加载 `compose.override.yaml`**；定制者须统一调整所有维护命令的文件列表，备份自己的 override 并验证恢复。OAuth/FCM 需 API 出站网络，但仍不得暴露 API / 数据库端口。

本地提供方用随机 32 字节主密钥，以 AES-256-GCM 包裹逐账号密钥及 pad，绑定账号和用途。数据库保存密文，但密钥与服务器在同一管理边界，**没有 OCI HSM 的隔离能力，也不是端到端加密**。密钥缺失或不匹配时 API 拒绝启动。掌握服务器及主密钥的管理员仍在信任边界内。

保留 GPL 和上游署名。默认运行无需官网 API、验证码或 Firebase；主动点击署名、源码等外部链接仍会访问相应站点。

维护者：`node scripts/package-self-host.mjs` 生成标准包；本次修订包用 `node scripts/package-self-host.mjs setup.1`。应用版本取自 `package.json`，修订后缀不改变镜像版本。完整版本发布使用匹配的 `self-host-v版本号` 标签触发双架构流水线；fork 需发布自己的公开镜像并配置 `IMAGE_PREFIX`。实际公网 ACME、手机证书/PWA 验收范围见 [验证记录](https://github.com/xingqimiao/Kira-HRT-Tracker/blob/rewrite/deploy/self-host/VERIFICATION.md)。

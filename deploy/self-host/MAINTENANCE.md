# 自部署维护：备份、升级、恢复与定制

[部署入口](README.md) · [公网服务器](SERVER.md) · [局域网 / NAS](LAN.md) · [English](MAINTENANCE.en.md)

## 遇到问题：看见什么，就做什么

| 现象 | 下一步 |
|---|---|
| 找不到 docker | 按自己的 [服务器](SERVER.md) 或 [局域网](LAN.md) 教程安装 Docker，再重新打开终端 |
| `Cannot connect to the Docker daemon` | 打开 Docker Desktop，或启动服务器上的 Docker 服务，再执行 `docker info` |
| `permission denied` / 无法访问 Docker socket | 修正当前用户权限，再用同一用户操作；不要删除配置重试 |
| 找不到 `hrt.sh` / `hrt.ps1` | 用 `ls` / `Get-ChildItem` 查看当前目录，进入包含脚本的那一层 |
| PowerShell 禁止运行脚本 | 在当前窗口执行 [局域网教程](LAN.md) 第 3 步的进程级执行策略命令 |

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
| 局域网证书不受信任 | 按 [局域网教程](LAN.md) 第 5 步操作；iOS 还要开启“完全信任”。公网证书错误按 [服务器教程](SERVER.md) 排查 |
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
| 再次导出根证书（仅局域网） | `sh hrt.sh cert` | `./hrt.ps1 cert` |
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

维护者：`node scripts/package-self-host.mjs` 生成标准包；仅修改脚本或文档时可加 `setup.N` 生成修订包。应用版本取自 `package.json`，修订后缀不改变镜像版本。完整版本发布使用匹配的 `self-host-v版本号` 标签触发双架构流水线；fork 需发布自己的公开镜像并配置 `IMAGE_PREFIX`。实际公网 ACME、手机证书/PWA 验收范围见 [验证记录](https://github.com/xingqimiao/Kira-HRT-Tracker/blob/rewrite/deploy/self-host/VERIFICATION.md)。

# 局域网 / NAS 部署：固定 IP 与本地证书

[部署入口](README.md) · [公网服务器教程](SERVER.md) · [English](LAN.en.md)

适合家里的 NAS 或 Windows/macOS/Linux 电脑。本教程只讲局域网：准备 Docker → 固定 IP → 下载 → 安装 → 每台设备信任证书。

## 第 1 步：在运行网站的设备上安装 Docker

**所有命令都在“准备存放数据、运行网站的那台设备”上执行。** 网站放在 NAS，就在 NAS 终端执行；放在家用电脑，就在那台电脑上执行。

| 你的设备 | 先做什么 |
|---|---|
| Windows | 安装并打开 [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/)，使用 Linux 容器，等待引擎启动 |
| macOS | 安装并打开 [Docker Desktop](https://docs.docker.com/desktop/setup/install/mac-install/)，等待引擎启动 |
| Linux 家用电脑 | 按 [Docker Linux 安装入口](https://docs.docker.com/engine/install/)选择自己的发行版，安装 Engine 和 Compose v2 插件 |
| 群晖 / 威联通 / 其他 NAS | 应用中心安装 Container Manager / Container Station / Docker，开启 SSH；设备须支持 Linux amd64 或 arm64 容器 |

Windows：右键开始按钮，打开 PowerShell。macOS：打开“终端”。NAS：打开 SSH 终端。

若从电脑连接 NAS，先在电脑终端执行 SSH，例如 `ssh kira@192.168.1.20`：把 `kira` 换成设备的实际登录用户名，把 IP 换成设备地址；它不是本项目预设的账号。按提示输入设备密码，**输入时不显示字符是正常的**。登录成功后，后续命令才是在远端执行。NAS 需先在控制面板的终端/SSH 设置中开启 SSH。接着验证 Docker：

```sh
docker info
docker compose version
```

第一行应显示 `Server` 信息；第二行应显示 Compose v2 的版本号，并且该版本需支持 `up --wait`。**两个都成功再继续。** 只有 Docker 客户端版本不能证明引擎已运行。

`permission denied` 表示当前用户无 Docker 权限，按设备说明或 [Docker 权限说明](https://docs.docker.com/engine/install/linux-postinstall/)修正；后续始终使用同一用户，不要混用普通用户和 `sudo`。找不到 `compose` 时安装 Compose v2 插件，不是旧的 `docker-compose` v1。


## 第 2 步：固定局域网 IP

打开路由器管理页面，在 DHCP / 地址保留中找到运行 Docker 的 NAS/电脑，为它保留当前 IP，例如 `192.168.1.20`。换成你的设备实际地址，不是手机地址。

以后访问地址就是 `https://192.168.1.20`。手机和电脑需连接可互访的家庭网络，访客 Wi-Fi 隔离可能阻止访问。不需要购买域名、设置公网 DNS 或在路由器上向公网转发端口。

设备上的 80、443 端口必须空闲；先解决 NAS 网页服务、其他代理或容器的占用。不能加 `:8443` 或使用 URL 子路径。若已有自己配置的局域网 DNS，也可用 `https://hrt.local`，但须保证每台设备均能解析它。

## 第 3 步：下载、解压，进入包含脚本的目录

本教程使用 **2.3.2 部署包**。已有实例不用重新初始化，按[维护文档](MAINTENANCE.md)升级即可。

**[点击下载 kira-hrt-self-host-2.3.2.tar.gz](https://github.com/xingqimiao/Kira-HRT-Tracker/releases/download/self-host-v2.3.2/kira-hrt-self-host-2.3.2.tar.gz)**

也可以到 [自部署 Release](https://github.com/xingqimiao/Kira-HRT-Tracker/releases/tag/self-host-v2.3.2) 的 Assets 中找这个文件。不要选 APK、Source code 或 Packages 页的镜像。`.sha256` 只是可选的文件校验信息，不是安装程序。

### Windows

把文件保存到“下载”文件夹，然后在 PowerShell 逐行执行：

```powershell
cd "$HOME\Downloads"
tar -xzf .\kira-hrt-self-host-2.3.2.tar.gz
cd .\kira-hrt-self-host-2.3.2
Get-ChildItem
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

应看到 `hrt.ps1`、`hrt.sh`、`compose.yaml`、`manage.mjs`、`VERSION`。最后一行只允许**当前窗口**运行脚本，不会修改全局策略；如询问是否执行，请阅读并确认。公司策略禁止运行脚本时联系设备管理员。

### Linux / macOS / NAS

先进入一个有写入权限、准备长期保留的目录。NAS 可用你的 `docker` 共享文件夹，**不要用重启会清空的临时目录**。逐行执行：

```sh
curl -fL --retry 3 -o kira-hrt-self-host-2.3.2.tar.gz https://github.com/xingqimiao/Kira-HRT-Tracker/releases/download/self-host-v2.3.2/kira-hrt-self-host-2.3.2.tar.gz
tar -xzf kira-hrt-self-host-2.3.2.tar.gz
cd kira-hrt-self-host-2.3.2
ls
```

应看到 `hrt.sh`、`compose.yaml`、`manage.mjs`、`VERSION`。NAS 没有 `curl` 时，可以在电脑下载，通过 NAS 文件管理器上传并解压，然后 SSH 中 `cd` 到包含 `hrt.sh` 的那一层。

**目录已存在时先停下，确认是不是之前的部署；不要在已有实例里重新解压、安装或删除文件。**

## 第 4 步：运行安装命令

假设实际固定 IP 是 192.168.1.20，在上一步包含脚本的目录选择一条：

Linux / macOS / NAS：

```sh
sh hrt.sh install https://192.168.1.20
```

Windows PowerShell：

```powershell
./hrt.ps1 install https://192.168.1.20
```

脚本自动生成配置与主密钥、下载镜像、创建数据库并等待三个服务健康。首次可能需几分钟，`Pulling`、`Downloading`、`Starting` 是正常进度，不要重复安装。

正常结束显示 `[1/3]`、`[2/3]`、`[3/3]`，以及 `Services are running. Open https://192.168.1.20`。当前目录应出现 `local-root.crt`，接着做第 5 步，不要跳过浏览器证书警告。

已有配置时不要删密钥：用 `sh hrt.sh start`（Windows：`./hrt.ps1 start`），健康后执行 `cert` 导出证书。新安装请使用当前部署包；已有实例无需重新初始化。

## 第 5 步：局域网设备信任证书，然后打开网页

局域网每台手机/电脑需要信任一次自己的根证书。“继续访问不安全的网站”不能替代此步骤。

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

## 出现问题后做什么

手机打不开时先检查 Wi-Fi、地址和访客隔离；证书不信任时重做第 5 步，iOS 还要开启“完全信任”。其他 Docker、下载、端口或健康检查问题见 [故障与维护手册](MAINTENANCE.md)。

成功后按 [维护手册](MAINTENANCE.md) 立即做第一份备份；官网数据请先导出再导入。

# Windows 电脑部署

电脑同时运行 SyncClipboard 内置服务器和网页代理，手机等设备通过局域网浏览器访问；不需要 NAS、Docker、Node.js 或前端构建工具。

## 工作原理

```text
局域网浏览器 → 电脑 nginx :5034 → html/ 中的网页文件
                             → 127.0.0.1:5033 上的 SyncClipboard 接口
```

nginx 提供网页并转发接口，网页与接口同源，无需配置 CORS。账号验证、剪贴板内容、历史、收藏和附件由 SyncClipboard 管理。根路径的 WebDAV 请求也会转发给后端；网页接口隐藏 Basic 认证挑战头，避免浏览器额外弹出登录框。

## 1. 准备 SyncClipboard

1. 安装 Windows 版 [SyncClipboard](https://github.com/jerick/SyncClipboard)。
2. 在软件中开启内置服务器，端口设为 `5033`，设置服务器账号和密码。
3. 确认本机可访问 `http://127.0.0.1:5033/`。网页需要真实的 SyncClipboard 历史接口，普通 WebDAV 存储不能替代。

不需要把本仓库复制进 SyncClipboard 安装目录，也不用替换它的配置。已有 NAS 数据不会自动迁移。具体历史保存能力取决于使用的 SyncClipboard 版本和配置。

## 2. 启动网页

将仓库下载或克隆到准备长期保留的目录，在**仓库根目录**打开 PowerShell：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows.ps1 -Action Start
```

首次执行会联网从 `https://nginx.org/download/nginx-1.30.6.zip` 下载 Windows nginx，并解压到 `.runtime/`。后续启动复用该程序。脚本检查配置和端口后隐藏窗口运行 nginx，重复启动不会重复创建进程。

- 本机访问：`http://localhost:5034/`。
- 手机或其他局域网设备：`http://电脑局域网IP:5034/`，地址可在电脑上通过 `ipconfig` 查看。
- 网页设置填写 **SyncClipboard 内置服务器账号密码**，不是 GitHub 账号。
- 不要加 `/web/` 或 `/api/` 后缀，网页部署在根路径。

建议在路由器为电脑保留 DHCP 地址。电脑休眠、关机、断网或后端退出后，其他设备无法正常使用。

## 3. 登录后自动启动

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows.ps1 -Action EnableStartup
```

命令在当前用户的启动文件夹创建 `ClipWeb.lnk`：

```text
Windows 用户登录
  → ClipWeb.lnk
  → wscript.exe 运行 deploy/start-hidden.vbs
  → 隐藏运行 deploy/windows.ps1 -Action Start
  → nginx 在后台监听 5034
```

可以按 `Win+R` 输入 `shell:startup` 查看快捷方式。这里是**用户登录启动项，不是 Windows 系统服务**，未登录前不会启动，也不会在崩溃后自动恢复。

nginx 与 SyncClipboard 独立启动、独立退出，没有绑定关系。请在 SyncClipboard 中另行开启自启动和内置服务器。即使网页代理先启动，后端就绪后网页即可继续连接；若 SyncClipboard 退出，网页仍可打开，但接口会报错。

## 4. 停止、取消启动和更新

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows.ps1 -Action Stop
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows.ps1 -Action DisableStartup
```

这两个操作相互独立：停止不会取消下次登录启动，取消启动也不会停止当前进程。都不影响 SyncClipboard。

修改 `html/` 后刷新网页即可。修改代理配置后先 `Stop` 再 `Start`。运行期间不要移动或删除仓库；需要搬目录时，先在旧目录停止并取消启动，搬完后在新目录重新启动并启用登录启动。

## 文件位置

以下路径均相对于仓库根目录：

| 路径 | 用途 | 提交 GitHub |
| --- | --- | --- |
| `html/` | 网页、脚本和图标 | 是 |
| `deploy/windows.ps1` | 下载 nginx、检查配置、启停及管理启动项 | 是 |
| `deploy/nginx.windows.conf` | Windows nginx 配置 | 是 |
| `deploy/start-hidden.vbs` | 登录时隐藏启动窗口 | 是 |
| `.runtime/nginx-1.30.6/` | 下载的 nginx 运行程序 | 否 |
| `.runtime/nginx.pid` | 运行进程编号 | 否 |
| `.runtime/error.log` | nginx 错误日志 | 否 |
| `.runtime/*_temp/` | 临时目录 | 否 |

`.runtime/` 已由 `.gitignore` 排除。不要上传实际账号密码、浏览器登录数据或 SyncClipboard 的个人数据。网页账号保存在当前浏览器的 localStorage，不在仓库里。

## 排障与安全

- **本机可打开、手机不行**：确认连接同一局域网、没有访客网络隔离，使用正确的电脑 IP；检查 Windows 防火墙，仅对专用网络放行 TCP 5034，来源限制为本地子网，不要关闭防火墙。
- **页面可打开但接口报 502**：确认 SyncClipboard 正在运行、内置服务器开启，端口为 `5033`。若后端端口不同，修改 `deploy/nginx.windows.conf` 的两处 `proxy_pass` 并重启网页代理。
- **401 或认证失败**：检查网页设置中的内置服务器账号密码；未登录接口返回 401 属正常行为。
- **5034 被占用**：查明占用程序；如需更换网页端口，修改代理配置中的 `listen`，同时修改 `windows.ps1` 中的端口检查及访问提示，然后重新启动。
- **启动失败**：手动执行 `Start` 查看报错，检查 `.runtime/error.log`；首次启动需要访问 nginx.org。若 Windows 策略禁用 VBScript，登录隐藏启动入口不可用，可手动执行 PowerShell 启动命令。
- **无法直接读取系统剪贴板**：局域网 IP 的 HTTP 页面通常不属于安全上下文，可手动粘贴文字和选择文件；完整剪贴板权限需要受设备信任的 HTTPS。

HTTP 不加密账号密码和内容，仅限可信局域网。不要向公网转发 5034；如需跨不可信网络访问，应另行配置认证及可信 HTTPS。nginx 的 5034 监听所有本机 IPv4 网卡，访问范围应由防火墙控制；SyncClipboard 的 5033 访问范围由其自身监听配置和防火墙决定。

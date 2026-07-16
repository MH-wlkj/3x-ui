 [中文](/README.zh_CN.md)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./media/3x-ui-dark.png">
    <img alt="3x-ui" src="./media/3x-ui-light.png">
  </picture>
</p>

</p>

**3X-UI** 是一个先进的开源 Web 控制面板，用于管理服务器。它提供简洁、多语言的界面，用于部署、配置和监控各种代理与 VPN 协议——从单台 VPS 到多节点部署。

3X-UI 作为原始 X-UI 项目的增强分支（fork），增加了更广泛的协议支持、更好的稳定性、按客户端的流量统计以及许多提升使用体验的功能。

> [!IMPORTANT]
> 本项目仅供个人使用。请勿将其用于非法目的，也请勿在生产环境中使用。

## 功能特性

- **多协议入站** — VLESS、VMess、Trojan、Shadowsocks、WireGuard、Hysteria2、HTTP、SOCKS (Mixed)、Dokodemo-door / Tunnel 和 TUN。
- **现代传输与安全** — TCP (Raw)、mKCP、WebSocket、gRPC、HTTPUpgrade 和 XHTTP，并通过 TLS、XTLS 和 REALITY 加密。
- **回落 (Fallback)** — 通过 Xray 的 fallback 功能在单个端口上提供多种协议（例如在 443 端口上同时使用 VLESS 和 Trojan）。
- **按客户端管理** — 流量配额、到期日期、IP 限制、实时在线状态，以及一键分享链接、二维码和订阅。
- **流量统计** — 按入站、按客户端、按出站统计，并支持重置控制。
- **多节点支持** — 从单一面板管理并扩展到多台服务器。
- **出站与路由** — WARP、NordVPN、自定义路由规则、负载均衡器和出站代理链。
- **内置订阅服务器**，支持多种输出格式和[自定义页面模板]。
- **Telegram 机器人**，用于远程监控和管理。
- **RESTful API**，带有面板内置的 Swagger 文档。
- **灵活的存储** — SQLite（默认）或 PostgreSQL。
- **13 种界面语言**，支持深色和浅色主题。
- **Fail2ban 集成**，用于强制执行按客户端的 IP 限制。
- **一键部署客户端**，输入sk5信息，一键部署客户端以及出、入站规则。

## 截图

<details>
<summary>点击展开</summary>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./media/01-overview-dark.png">
  <img alt="Overview" src="./media/01-overview-light.png">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./media/02-add-inbound-dark.png">
  <img alt="Inbounds" src="./media/02-add-inbound-light.png">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./media/03-add-client-dark.png">
  <img alt="Add client" src="./media/03-add-client-light.png">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./media/05-add-nodes-dark.png">
  <img alt="Configs" src="./media/05-add-nodes-light.png">
</picture>

</details>

## 服务器一键安装脚本

```bash
bash <(curl -Ls https://raw.githubusercontent.com/MH-wlkj/3x-ui/main/install.sh)
```


安装过程中会生成随机的用户名、密码和访问路径。安装完成后，运行 `x-ui` 打开管理菜单，您可以在其中启动/停止服务、查看或重置登录凭据、管理 SSL 证书等。

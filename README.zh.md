# DeepSeek Harness

[English](README.md) | 中文

## 当前 Fork 说明与官方版本差异

**当前版本：** 基于官方 `master` 在 2026-09-10 的 `0.1.5-rc.2` 快照
`c291e7961a`，Fork 分支为 `feat/multiuser-web-deployment`。官方 README
主体保留在下方；本 Fork 新增的是可选的多用户 Web 部署层，不改变未安装该部署层时的
官方单机运行方式。

### 与官方版本的主要差异

1. **多用户统一入口。** 在同一个 HTTPS 地址上按不同密码区分用户，不要求用户输入
   用户名。登录成功后签发绑定用户和客户端 IP 的 30 天 Cookie，更换 IP 后需要重新
   登录，并包含连续失败锁定保护。
2. **按需启动的独立实例。** 每位用户对应一个独立的 `DSH_HOME`、设置、会话、
   workspace 和 loopback 端口。实例在首次登录时启动，无活动连接达到配置时长后自动
   停止；管理器重启时会安全恢复后端认证。
3. **应用层目录隔离。** 路径策略限制用户只能写自己的 workspace，禁止写入其他用户、
   Harness 源码、凭据、日志和共享资源目录，同时允许按只读方式访问共享资源。
4. **共享插件、Skill 和 Agent 资源。** 所有用户共享只读的 Skills、profiles、
   plugins、Agent presets 和 shared projects；每个用户目录中的 `AGENTS.md` 指向同一份
   全局共享策略。
5. **管理员维护与更新。** 新增用户管理、密码轮换、启停用户、Skill 快照导入、
   workspace 迁移和官方源码更新脚本。更新失败时会恢复源码、依赖和构建产物。
6. **远程设置与部署工具。** 提供 Nginx TLS 反向代理参考配置、systemd 用户服务和
   macOS 本地管理工具，支持状态查看、日志、SFTP 工作区同步和共享 Skill 发布。

### 主要文件

- `deploy/multiuser/README.md`：部署架构、安装步骤、管理命令和限制说明。
- `deploy/multiuser/server/`：认证管理器、反向代理、用户实例、路径策略和更新脚本。
- `deploy/multiuser/local-manager/`：macOS 状态、日志、同步和 Skill 发布工具。
- `deploy/multiuser/nginx/`：HTTPS 反向代理参考配置。
- `deploy/multiuser/patches/`：构建期间使用、构建后恢复的远程设置补丁。

### 限制

- 当前部署层针对单台 Linux ECS 和小规模使用设计，默认路径和系统服务以
  `/home/dsh` 为基准。
- 多用户隔离属于同一 Unix 账号下的应用层隔离，用于隔离正常 Web 数据和目录，不构成
  恶意用户之间的内核级安全边界。
- 官方源码、插件行为和许可证保持不变；部署层及其运维方式由本 Fork 维护。

运行部署层测试：

```sh
node --test \
  deploy/multiuser/server/*.test.mjs \
  deploy/multiuser/tools/*.test.mjs
```

---

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

它构建于**一切皆插件**的架构之上，由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512)。

文档：[https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## 开发者预览

DeepSeek Harness 处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

运行本项目前，请阅读[安全说明](SAFETY.zh.md)。

<a id="run"></a>

## 运行

### 通过 `npm` 运行

安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令默认会在 `http://localhost:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。详见 [Web UI 指南](docs/user/guide/index.zh.md)。

<a id="run-from-source"></a>

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 会准备仓库产物。`pnpm dsh web` 会直接使用这些已构建产物，不会重新构建。

## 社区与支持

- 通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群：扫码添加企微小助手并填写入群问卷，完成后小助手会邀请你入群。

<table>
  <thead>
    <tr>
      <th align="center">企微小助手</th>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-assistant.png" alt="DeepSeek Harness 企微小助手二维码" width="180" height="180"></td>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 引用

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

# DeepSeek Harness

English | [中文](README.zh.md)

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

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

Documentation: [https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## Developer preview

DeepSeek Harness is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](SAFETY.md) before running the project.

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding.

## Community and support

- Submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## Citation

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

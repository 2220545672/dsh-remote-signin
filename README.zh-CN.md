[English](README.md) · **中文**

# dsh-remote-signin

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：让**DeepSeek 账号**登录能在**不跑在 DSH 机器上**的浏览器里完成——局域网、Tailscale、反向代理后面都行。没有它，这种登录连开始都开始不了。

```
[entrypoint] remote sign-in: on — a remote browser finishes the sign-in in the DSH page
[remote-signin] active — v0.2.0, claim http://127.0.0.1:47821, panel at /remote-signin/inpage.js
[remote-signin] active — claim http://127.0.0.1:47821, panel at /remote-signin/inpage.js
```

## 问题（实测）

上游把**浏览器自己的 origin** 当作 OAuth `redirect_uri` 交给平台，而 `@deepseek-ai/dsh-deepseek-account-platform` 只接受「带显式端口的回环 HTTP origin」。2026-10-16 对真实平台实测（`POST /auth-api/v0/dsh/auth_init`）：

| `redirect_uri` | 平台返回 |
|---|---|
| `http://127.0.0.1:47821/oauth/callback` | `{"code":0, … "authorize_url": …}`，`expires_in: 600` |
| `https://dsh.example.com/oauth/callback` | `{"code":50005,"msg":"PAYLOAD_SCHEMA_MISMATCH"}` |

也就是说：请求在登录页打开之前就被拒了。以前只有两条路——用 API Key，或者开 `ssh -L` 隧道把浏览器搬到能访问回环地址的地方。

## 插件做了什么

把这道检查的两半拆开：平台校验的是一个**字符串**，而真正必须访问到那个地址的是**浏览器**。

```
1. 浏览器（https://dsh.example.com）      你点「登录」
2. DSH 宿主 + 本插件                      不是回环 → 换成声明的回环 origin
   └─ auth_init(redirect_uri = http://127.0.0.1:47821/oauth/callback)
3. platform.deepseek.com                  接受，返回 authorize_url
4. 浏览器                                 你在那里完成登录
5. 浏览器                                 平台重定向到 127.0.0.1:47821 → 打不开，
                                          但地址栏里留着 code 与 state
6. DSH 页面里本插件的面板                 有登录等待时**自动出现**：
                                          把那个地址粘进去 → 发到本 origin 的
                                          /oauth/callback
7. DSH 宿主，上游自己的回调路由           一次性 state 校验 + 内存里的 PKCE verifier
                                          → 凭据落盘，对话框变已登录
```

两部分，都在本包内：

| 部件 | 说明 |
|---|---|
| `src/index.js` | 服务端插件：包装 `deepseekAccount.startSignIn`，把非回环的浏览器 origin 注册成声明的回环 origin；提供面板脚本；把它注入 DSH 文档。 |
| `assets/inpage.js` | 面板：有登录等待时出现在 DSH 页面里，接收粘贴的回调地址，并把服务器的回答显示出来。**它是唯一的回传入口**，没有第二个页面要找。 |

## 安装

**Unraid / `dsh-unraid` 镜像**：不用做任何事——镜像会安装本插件，并由 `REMOTE_SIGNIN` 控制（默认 `on`；设 `off` 回到上游行为）。

**任意 DSH profile**：装进 profile 即可（包的 `dsh.bundle` 声明会让它带上 `cordis.patch.yml`）：

```bash
dsh plugin --profile web add github:2220545672/dsh-remote-signin
```

**或以 patch overlay 方式加载**（不动 profile）：

```bash
dsh --profile web --patch "$(node -p "require.resolve('dsh-remote-signin/cordis.patch.yml')")"
```

### 一个关于"包装在哪"的坑

patch 条目的 `name` 只从两个锚点解析：`@deepseek-ai/dsh` **安装**所携带的包（它的依赖闭包），以及 **profile** 目录（`$DSH_HOME/profiles/<name>/node_modules`）。装在别处的包（你自己 runtime manifest 的依赖、或镜像里的一份拷贝）两个锚点都不占，于是 `name: dsh-remote-signin` 会报 `ERR_MODULE_NOT_FOUND`。两条出路，实践中都在用：

* 装进 profile（上面的 `dsh plugin … add …`），名字就能解析；
* 或者让条目直接指向文件——`dsh-unraid` 镜像就是这么做的：

  ```yaml
  - insert:
      - id: remote-signin
        name: file:///app/node_modules/dsh-remote-signin/src/index.js
  ```

唯一的设置是「声明用哪个回环 origin」，有合理默认值：

| 来源 | 含义 |
|---|---|
| patch 条目里的 `config.claimOrigin` | 优先级最高。 |
| `REMOTE_SIGNIN_ORIGIN` | 环境变量兜底。必须是 `http://` + `127.0.0.1` / `localhost` / `[::1]` + 显式端口。 |
| 默认 | `http://127.0.0.1:47821`。 |

## 它刻意不做的事

* **不放松任何校验。** 结束登录的是上游自己的路由，用上游的一次性 `state` 校验和内存里的 PKCE verifier；本插件只决定「注册哪个回环**字符串**」。
* **不改动已经在回环上的浏览器**（`ssh -L`、桌面端）：这些 origin 原样放行。
* **不自造视觉风格。** 面板完全用 harness 自己的设计令牌（`--dsw-*`：surface、圆角、投影、文字与状态色、主按钮填充色）来写样式，因此会跟随应用主题（包括用户自己选的深色模式）与将来的重构；一旦有人写回硬编码颜色，测试就会失败。
* **不保存、不打印 code / state / token。** 它每次尝试只写一行日志：本次声明用的 origin。粘贴的地址在浏览器里解析，只有 `code` 与 `state` 被重新编码后发到**本 origin 自己的** `/oauth/callback`，不发给任何其它地方——所以面板不可能被当成跳板。
* **不开放任何端口。** 声明只是一个字符串：服务器和你本机都没有任何东西监听它。端口刻意取生僻值，避免你本机某个服务意外收到授权码。
* **绝不会成为容器起不来的原因。** 资源缺失、声明不可用、或将来上游改名，都只会退回上游行为并在日志里留一行。

## 排障

| 现象 | 含义 |
|---|---|
| 面板一直不出现 | 插件没加载：`docker logs <容器名> \| grep remote-signin` 会说明原因（`off`、包缺失、`INACTIVE`）。没有兜底页面——排除原因后刷新即可。 |
| 登录标签页显示 DeepSeek 报错而不是登录表单 | 同样是声明没生效，上游拒了这个 origin。 |
| 面板说**没有正在等待的登录**（`404`） | 这次登录已过期（约 10 分钟），或者它属于**另一个 DSH 实例**——重建容器会作废它，而前一个实例遗留的标签页看上去还停在"等待登录"。请在**你正在用的那个标签页**里重新点一次 **Sign in**。 |
| 面板说 state 不匹配（`400`） | 地址来自另一次尝试，或这个 code 已经被用掉了。 |
| `/remote-signin/inpage.js` 返回 404 | 这个路由由本插件注册；插件没加载，面板就永远不会出现。看上面的日志行。 |
| 想回到旧行为 | 移除插件（或 dsh-unraid 镜像上设 `REMOTE_SIGNIN=off`）。 |

## 开发

```bash
node --test        # 15 个测试，零依赖，不需要浏览器
```

* `src/claim.js` 是纯函数，所以声明规则不用启动 DSH 就能测。
* `test-support/dom.mjs` 是一个小 DOM 桩，足以让面板在 `node --test` 下跑起来：探测节奏、关闭行为、地址提取规则、以及它报出的每一种状态。
* 上游处于开发者预览阶段。插件只依赖两个契约——`deepseekAccount.startSignIn` 与 web server 的路由/index API——任一变化时它都只降级、不致命。

MIT 许可，见 [CHANGELOG.md](CHANGELOG.md)。

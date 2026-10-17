# 参与 Air Drawing 开发

感谢参与。这个项目是一个浏览器端手部追踪、隔空绘画和 3D 模型操作工具，默认使用原生 HTML、CSS、JavaScript，便于直接阅读和修改。

## 开始开发

需要 Node.js 18.18 或更新版本。克隆仓库后，在项目根目录运行：

```bash
npm run check
npm start
```

然后打开 `http://localhost:8000/`。首次使用需要允许摄像头权限。项目已经包含 `vendor/` 中的浏览器依赖，不需要把 API Key 写进前端。

如果要测试 Hyper3D，请在本机创建 `.env` 并设置 `RODIN_API_KEY`。`.env` 已被 Git 忽略，禁止提交到仓库、Issue 或 PR。

## 分支和提交

从默认分支创建短分支：

```bash
git switch -c feat/gesture-hysteresis
# 或 bug/axis-center、docs/setup-guide
```

建议一个分支只处理一个问题。提交前运行：

```bash
npm run check
```

提交信息可以使用以下格式：

```text
feat: improve fist rotation stability
fix: keep transform gizmo centered
docs: update gesture guide
```

## 提交合并请求

1. 将分支推送到远程仓库。
2. 创建 Pull Request，说明问题、改动和实际验证方式。
3. 如果涉及摄像头、手势或 3D 模型，请附上浏览器、操作系统和复现步骤。
4. 等待至少一位成员检查；确认 `npm run check` 通过后再合并。

不要在 PR 中上传 `.env`、摄像头录像、临时截图或未经许可的大型模型压缩包。大型 OBJ/GLB 资源建议使用 Git LFS 或单独的资源发布包。

## 目录约定

- `app.js`：摄像头、MediaPipe、手势状态机和 3D 操作。
- `index.html`：页面结构和控件。
- `styles.css`：界面样式。
- `server.mjs`：本地静态服务和 Hyper3D 代理。
- `USER_GUIDE.md`：面向使用者的操作说明。
- `scripts/`：资源索引和开发辅助脚本。

新增功能时，同时更新用户指南和必要的界面提示。涉及手势判定时，应说明进入条件、退出条件和误识别保护。

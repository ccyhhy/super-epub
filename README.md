# super-epub

Obsidian 的 EPUB 阅读插件，支持阅读进度、反链高亮与阅读统计。

## 功能亮点

- 打开 `.epub` 文件并在 Obsidian 中阅读
- 记住阅读进度，自动续读
- 选中文本可复制带 CFI 的跳转链接
- 反向链接高亮（来自笔记中的 `#cfi64=` 链接）
- 阅读时长与次数统计
- 跟随 Obsidian 主题与字体

## 安装

### 手动安装

1. 运行 `npm install` 并执行 `npm run build`
2. 将 `manifest.json`、`main.js`、`styles.css` 复制到你的 Vault：
   - `Vault/.obsidian/plugins/super-epub/`
3. 在 Obsidian 中启用插件

## 使用方法

1. 把 `.epub` 文件放入 Vault
2. 点击 epub 文件打开阅读视图
3. 选中文本时会出现工具栏，可复制跳转链接
4. 复制得到的链接可在笔记中使用，点击即可跳转到书中相应位置

## 设置说明

- **滚动阅读**：开启后可连续滚动阅读
- **默认字号**：阅读器字体大小（百分比）
- **跟随 Obsidian 主题/字体**：阅读器与 Obsidian 同步
- **高亮颜色与透明度**：控制选区高亮和反链高亮
- **笔记位置与标签**：创建 epub 笔记时使用

## 开发

- 启动开发构建：`npm run dev`
- 生产构建：`npm run build`

## 发布

仓库包含 GitHub Actions 的发布流程（`.github/workflows/release.yml`），推送 tag 后会自动构建并生成 release 资源。

## 许可证

MIT

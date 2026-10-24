# 看板 · 项目管理（Kanban Board）

纯静态看板项目管理单页应用。**不使用任何构建工具和后端**，只有 `index.html`、`style.css`、`app.js` 三个文件，浏览器直接打开 `index.html` 即可使用。

## 功能一览

- **多看板**：新建 / 重命名 / 删除多个看板（如工作、学习、生活），顶栏页签切换。
- **看板列**：默认「待办 / 进行中 / 已完成」三列，支持新增、重命名、删除列；每列可标记为「完成列」（计入完成率，不再计逾期）。
- **卡片**：
  - 标题、描述；
  - 多标签（8 种内置标签，颜色区分）；
  - 优先级（高 / 中 / 低）；
  - 截止日期（**逾期红色高亮**，临近 3 天内橙色提醒）；
  - 子任务清单（可勾选，卡片上显示 `已完成 x/y` 进度条）。
- **拖拽**：桌面端鼠标拖拽卡片，可跨列移动，也可在列内重排顺序；**移动端/触屏**用卡片上的 ↑↓ 按钮跨列移动（列在窄屏下纵向堆叠，←/→ 按钮自动显示为 ↑/↓）。
- **筛选与搜索**：按关键词（标题 / 描述 / 子任务文本）、标签、优先级、逾期状态筛选；列标题计数与摘要随筛选变化。
- **统计面板**：各列卡片数、本周到期数、逾期数、完成率。
- **数据本地存储**：全部数据保存在浏览器 `localStorage`，刷新不丢；支持**整板 JSON 导出 / 导入恢复**（导出包含全部看板）；首次打开自动播种一个示例看板（日期相对当天生成，方便体验逾期 / 本周到期效果）。

## 使用方法

1. 下载本目录的 `index.html`、`style.css`、`app.js`（及本 README）到任意文件夹；
2. 双击用现代浏览器（Chrome / Edge / Firefox / Safari）打开 `index.html` 即可。

也可以本地起一个静态服务器访问（可选）：

```bash
# 任选其一
python3 -m http.server 8080
npx serve .
# 然后浏览器打开 http://localhost:8080
```

### 统计口径说明

| 指标 | 口径 |
| --- | --- |
| 逾期 | 截止日期早于**今天**、且不在「完成列」的卡片；卡片上的红色日期同样按此口径 |
| 本周到期 | 今天到**本周日**（含）之间到期、且不在「完成列」的卡片 |
| 完成率 | 「完成列」卡片数 ÷ 全部卡片数（无卡片时显示 —） |
| 统计面板 | 展示**整板**数据，不受筛选影响；列标题上的计数则跟随筛选（显示 `可见/总数`） |

### 数据说明

- 存储键：`kanban-board.v1`（正式数据）、`kanban-board.corrupt.v1`（检测到损坏时自动备份的原文）。
- 数据按浏览器 + 域名隔离：换浏览器 / 换设备 / 清除浏览器数据都会丢失，请用「导出 JSON」备份、在新环境「导入 JSON」恢复。
- 想重置所有数据：清除该网站的 localStorage（或导入一份新备份覆盖）即可，下次打开会重新播种示例看板。
- 导出文件为带版本号的 JSON 信封（`{app:"kanban-board", version, exportedAt, boards, activeBoardId}`），导入时兼容信封与裸 `boards` 数组，格式不符会拒绝并提示，导入前需二次确认（覆盖当前数据）。

## 部署到 GitHub Pages

1. 在 GitHub 上创建一个**公开**仓库（例如 `kanban-board`）。
2. 把本目录文件推上去（网页上传或命令行均可）：

   ```bash
   git init
   git add index.html style.css app.js README.md
   git commit -m "init: kanban board"
   git branch -M main
   git remote add origin https://github.com/<你的用户名>/kanban-board.git
   git push -u origin main
   ```

3. 打开仓库 **Settings → Pages**：
   - Source 选择 **Deploy from a branch**；
   - Branch 选 `main`、目录选 `/(root)`，点 **Save**。
4. 等待 1–2 分钟构建完成后，访问：

   ```
   https://<你的用户名>.github.io/kanban-board/
   ```

进阶（可选）：改用 GitHub Actions 自动部署。在仓库 `.github/workflows/pages.yml` 中放入：

```yaml
name: Deploy to Pages
on:
  push: { branches: [main] }
permissions: { contents: read, pages: write, id-token: write }
concurrency: { group: pages, cancel-in-progress: true }
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with: { path: . }
      - id: deployment
        uses: actions/deploy-pages@v4
```

然后在 Settings → Pages 中把 Source 改为 **GitHub Actions**。本项目是纯静态文件，无需任何构建步骤。

## 目录结构

```
kanban-board/
├── index.html   # 页面结构（顶栏/看板操作/筛选/统计/看板区/弹窗与提示挂载点）
├── style.css    # 全部样式（桌面多列横向滚动，≤720px 纵向堆叠为移动端布局）
├── app.js       # 全部逻辑（数据模型、筛选统计、拖拽、弹窗、导入导出）
└── README.md
```

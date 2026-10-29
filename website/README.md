# Bots 介绍站

`website/` 是这个仓库的产品介绍页：静态文件，默认中文，可以切到英文，跟随系统的浅色 / 深色，也可以手动切换。

它不参与上层应用的安装、类型检查、`pnpm test` 或 `pnpm build`。根目录的 TypeScript 只编译 `src/`，桌面打包也只带 `desktop/` 和 `dist/`。

## 本地预览

不需要安装依赖。在本目录起一个静态服务器：

```bash
cd website
python3 -m http.server 4173
```

打开 <http://localhost:4173>。

## 部署到 Vercel

1. 导入仓库 <https://github.com/proto1994/grok-bot>。
2. **Root Directory** 设为 `website`。
3. **Framework Preset** 选 Other。
4. **Build Command** 留空。没有构建步骤。
5. **Output Directory** 用 `.`（这个目录本身就是站点根）。
6. 不需要环境变量。

`vercel.json` 只加了安全和静态资源缓存头。页面、样式和脚本都是相对路径，所以站点挂在域名根上即可。

社交分享用的 `og:image` 指向 `main` 分支上的 `website/og.png`。如果介绍站用了自己的域名，可以把 `index.html` 里的 `og:image` / `twitter:image` 改成那个域名下的绝对地址。

## 截图

`assets/*.webp` 来自项目浏览器测试拍下的 12 张 PNG，只做了 WebP 压缩，没有改画面。产品界面本身是中文；这个介绍站的英文是页面文案，不是应用里的另一套界面。

## English

This folder is a static product site. It does not take part in the app's install, typecheck, `pnpm test`, or `pnpm build`.

Preview with any static server (`python3 -m http.server 4173` from this directory). On Vercel, set **Root Directory** to `website`, framework preset to **Other**, and leave the build command empty. The output is this directory. No environment variables.

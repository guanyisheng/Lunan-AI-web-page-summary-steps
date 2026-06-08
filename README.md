# 路南网页总结AI

<p align="center">
  <img src="https://tc.lunan.cloud/i/2026/05/31/lsz1xk.png" width="72" alt="路南网页总结AI">
</p>

<p align="center">
  基于 Tampermonkey 的网页 AI 总结助手 · 读取当前页面内容 · 支持多 API 容灾
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Tampermonkey-用户脚本-00a67e" alt="Tampermonkey">
  <img src="https://img.shields.io/badge/OpenAI-兼容接口-412991" alt="OpenAI Compatible">
  <img src="https://img.shields.io/badge/版本-v1.7.0-blue" alt="Version">
</p>

---

## 简介

在任意网页右下角唤起 AI 面板，**直接读取浏览器当前页面内容**进行总结，无需重新抓取 URL，降低被反爬拦截的风险。总结完成后可继续追问，支持 Markdown 渲染（标题、列表、表格、代码块等）。

## 目录

- [功能亮点](#功能亮点)
- [截图预览](#截图预览)
- [环境要求](#环境要求)
- [安装](#安装)
- [快速上手](#快速上手)
- [使用指南](#使用指南)
- [配置说明](#配置说明)
- [常见问题](#常见问题)
- [隐私说明](#隐私说明)
- [更新日志](#更新日志)

## 功能亮点

| 分类 | 能力 |
| --- | --- |
| 核心 | 页面 DOM 直读、Markdown 结构化总结、多轮追问 |
| API | 多配置管理（OpenAI / DeepSeek / Ollama）、默认选择、容灾自动切换 |
| 模型 | `/v1/models` 自动检测、显示名与请求模型映射 |
| 交互 | 可拖动悬浮面板、圆角按钮边缘吸附、总结/追问可中断 |
| 配置 | 自动保存、JSON 导出导入（v2 多 API 格式） |

## 截图预览

<details>
<summary><b>展开查看截图</b></summary>

<br>

**总结效果**

<img width="100%" alt="总结效果" src="https://github.com/user-attachments/assets/9c64361b-864b-48b0-ad5b-c339f64cb0ad">

**继续提问**

<img width="420" alt="继续提问" src="https://github.com/user-attachments/assets/92f52976-506c-4b9a-9d77-b90ceb818859">

**多 API 设置**

<img width="420" alt="多 API 设置" src="https://github.com/user-attachments/assets/5f1cd42d-1b38-4953-86e4-60003e245d5f">

**模型映射**

<img width="420" alt="模型映射" src="https://github.com/user-attachments/assets/573ac7ad-aacf-490c-aa29-5be00bf635ce">

**悬浮面板**

<img width="420" alt="悬浮面板" src="https://github.com/user-attachments/assets/52976d12-f6c7-47a2-a0d1-4f2ca9681801">

**悬浮按钮**

<img width="88" alt="悬浮按钮" src="https://github.com/user-attachments/assets/c2f39d7f-f014-4e3b-9aad-a3eefcca63f5">

**配置导出**

<img width="420" alt="配置导出" src="https://github.com/user-attachments/assets/caa42878-4cdd-4e39-a02c-5716aa0b20c1">

</details>

## 环境要求

| 项目 | 要求 |
| --- | --- |
| 浏览器 | Chrome / Edge / Firefox 等现代浏览器 |
| 扩展 | [Tampermonkey](https://www.tampermonkey.net/) |
| AI 接口 | 任意 OpenAI Chat Completions 兼容服务 |

## 安装

**手动安装（推荐）**

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)
2. 新建脚本，粘贴 [`页面AI总结.user.js`](./页面AI总结.user.js) 全部内容并保存
3. 刷新任意网页，右下角出现悬浮按钮即安装成功

**从 Release 安装**

下载 Release 中的 `页面AI总结.user.js`，在 Tampermonkey → 实用工具 → 导入。

## 快速上手

```
打开面板 → 设置 API → 获取模型 → 开始总结 → 继续提问
```

1. 点击右下角悬浮按钮，打开面板
2. 进入 **设置**，点击 `+ DeepSeek` / `+ Ollama` / `+ OpenAI` 添加 API
3. 填写 API Key，点击 **获取模型列表** 并选择模型
4. 设置 **默认 API**，按需开启 **容灾切换**
5. 回到 **总结**，选择 **当前 API**，点击 **开始总结**

## 使用指南

### 悬浮按钮

| 操作 | 效果 |
| --- | --- |
| 单击 | 打开面板 |
| 拖动 | 移动位置 |
| 松手 | 吸附到最近屏幕边缘 |

### 总结操作

| 操作 | 效果 |
| --- | --- |
| 开始总结 | 使用当前 API 总结页面 |
| 中断 | 立即停止进行中的总结 |
| 当前 API | 总结页顶部下拉，临时切换接口 |

### 内容来源

| 模式 | 适用场景 |
| --- | --- |
| 页面可见文本 | 文章、新闻（推荐） |
| HTML 去噪 | 需要结构但去掉 script/style |
| 完整 HTML | 类似「查看源代码」 |

### 继续提问

- `Enter` 发送，`Shift + Enter` 换行
- 追问中可点击 **中断** 停止生成
- **清空对话** 仅清除追问，不影响总结结果
- 重新总结会重置对话

### Tampermonkey 菜单

- 打开路南网页总结AI
- 路南网页总结AI - 打开设置

## 配置说明

### 多 API 管理

<img width="360" alt="API 配置管理" src="https://github.com/user-attachments/assets/3f89347f-3db4-4e5b-a922-fe2ee7209802">

| 选项 | 说明 |
| --- | --- |
| 预设按钮 | 一键添加 DeepSeek / Ollama / OpenAI 模板 |
| 配置名称 | 自定义别名，如「DeepSeek 主力」 |
| 默认 API | 打开面板时的默认接口 |
| 参与容灾 | 勾选后，失败时会被自动尝试 |
| 胶囊标签 | 快速切换要编辑的 API |

### 容灾切换

开启后：优先使用当前选中的 API → 失败则依次尝试其他**已启用**的 API，界面会显示正在使用的接口名称。

关闭后：仅使用当前 API，失败直接报错。

### API 参考

| 服务商 | API 地址 | 模型示例 | Key |
| --- | --- | --- | --- |
| OpenAI | `https://api.openai.com/v1/chat/completions` | `gpt-4o-mini` | 必填 |
| DeepSeek | `https://api.deepseek.com/v1/chat/completions` | `deepseek-chat` | 必填 |
| Ollama | `http://localhost:11434/v1/chat/completions` | `llama3` | 可留空 |

> API 地址请填写完整的 `chat/completions` 路径。

### 配置备份

- **导出**：生成 `路南网页总结AI-配置-YYYY-MM-DD.json`（v2 格式，含全部 API）
- **导入**：支持 v2 多 API 配置，兼容旧版单 API 格式

## 常见问题

<details>
<summary><b>图标在 GitHub 等网站不显示？</b></summary>

部分网站 CSP 限制外部图片。脚本会通过 `GM_xmlhttpRequest` 将图标转为 `data:` 格式并本地缓存。请确认脚本已启用。

</details>

<details>
<summary><b>总结失败 / API 报错？</b></summary>

1. 确认 API 地址为完整 `chat/completions` 路径
2. 检查 API Key 与余额
3. 确认模型名称正确
4. 开启容灾并配置备用 API
5. 在 Tampermonkey 中允许对应域名访问

</details>

<details>
<summary><b>Ollama 本地连不上？</b></summary>

1. 启动服务：`ollama serve`
2. 地址：`http://localhost:11434/v1/chat/completions`
3. API Key 通常可留空

</details>

<details>
<summary><b>配置会自动保存吗？</b></summary>

会。API 配置、默认项、容灾开关、模型映射、面板与按钮位置均会自动保存到 Tampermonkey 本地存储。

</details>

## 隐私说明

- 页面内容经你配置的 API 发送至对应 AI 服务商
- API Key 仅存于本地，不会上传至本仓库
- 导出配置文件含敏感信息，请妥善保管

## 项目结构

```
.
├── README.md
└── 页面AI总结.user.js
```

## 更新日志

| 版本 | 更新内容 |
| --- | --- |
| **v1.7.0** | 中断总结/追问、多 API 配置、默认选择与容灾切换、配置导出 v2 |
| v1.6.1 | 正方形圆角图标、修复 CSP 下图标加载 |
| v1.6.0 | 更名为路南网页总结AI、自定义图标 |
| v1.5.0 | 悬浮按钮拖动与边缘吸附 |
| v1.4.0 | 总结后追问、配置导出导入 |
| v1.3.0 | Markdown 渲染、丰富提示词 |
| v1.2.0 | 设置自动保存 |
| v1.1.0 | 模型列表自动检测与映射 |
| v1.0.0 | 初始版本 |

---

<p align="center">仅供学习与交流 · API 费用由使用者自行承担</p>

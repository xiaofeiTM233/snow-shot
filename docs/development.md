## 开发文档

GUI 框架使用 [Tauri](https://tauri.app/) 
Web 开发框架使用 [Next.js](https://nextjs.org/) 
UI 组件库使用 [Ant Design](https://ant.design/)

### Git 工作流规范

在开始开发之前，请务必阅读 [Git 工作流规范](./git-workflow.md)，了解项目的分支管理和提交规范。

项目已配置自动化工具来确保代码质量和提交规范：
- **Husky**: Git hooks 管理
- **Commitlint**: Commit message 格式检查
- **Lint-staged**: 提交前自动格式化代码
- **EditorConfig**: 统一编辑器配置（缩进、行尾符等）
- **Git Attributes**: 统一使用 LF 行尾符

### 开发环境

| 软件                                         | 参考版本   |
| -------------------------------------------- | ---------- |
| 操作系统                                      | Windows 11 |
| [Node.js](https://nodejs.org)                | 20.11.0    |
| [pnpm](https://pnpm.io/)                     | 10.0.0     |
| [yarn](https://classic.yarnpkg.com/lang/en/) | 1.22.22    |
| [rust](https://rust-lang.org)                | 1.84.1     |
| [cargo](https://rust-lang.org)               | 1.84.1     |

如需进行编译 tauri，请使用 [Visual Studio Installer](https://visualstudio.microsoft.com/zh-hans/downloads/) 安装以下**单个组件**：
| 软件  | 参考版本   |
| ----- | ---------- |
| [Windows 11 SDK](https://learn.microsoft.com/en-us/windows/apps/windows-sdk/downloads) | 10.0.22621.0 |
| MSVC C++ 生成工具 | v143 - VS 2022 (v14.40-17.10) |

### 运行项目

#### 1. 准备 Excalidraw

在安装 Snow Shot 的项目依赖前，还需要手动准备一下 [@mg-chao/excalidraw](https://github.com/mg-chao/excalidraw) 项目作为项目的依赖。

因为 Snow Shot 需要自定义 Excalidraw 非常多的功能，Excalidraw 的官方组件远远没法满足 Snow Shot 的支持。

将 `@mg-chao/excalidraw` 项目 `clone` 到 Snow Shot 的**同级目录**后，**使用 git 切换到项目的 `custom/master` 分支**，然后使用以下命令安装依赖。

```bash
yarn install
```

Excalidraw 使用 yarn 作为包管理器，这点和 Snow Shot 不同。

接着回到 Snow Shot 目录，运行命令以构建 Excalidraw。

```bash
pnpm update:excalidraw
```

#### 2. 准备 ONNX 模型的运行环境

Snow Shot 使用 ONNX 调用文本识别模型，为了更好的兼容性，使用了静态编译来包含模型所需的库。所以需要下载将 ONNX Runtime 的静态库放到 `src-tauri/lib` 目录下供静态编译使用。

ONNX Runtime 可以从 [ONNX Runtime Releases](https://github.com/supertone-inc/onnxruntime-build/releases) 下载，选择 `onnxruntime-win-x64-static_lib-1.22.1.zip`。

下载完毕后将 `onnxruntime.lib` 文件放到 `src-tauri/lib` 下即可。

#### 3. 准备视频录制环境（可选）

为了完成视频录制，Snow Shot 选择调用 FFmpeg CLI 进行屏幕录制。如果不准备进行视频录制相关功能的开发，可以选择不安装 FFmpeg。

可以从 [FFmpeg Builds](https://www.gyan.dev/ffmpeg/builds/) 下载 FFmpeg 的 CLI 程序，然后将 `ffmpeg.exe` 文件放入 `src-tauri/ffmpeg` 中。

#### 4. 安装前端依赖

使用以下命令安装前端依赖。

```bash
pnpm i
```

#### 5. 运行

安装完成后，使用以下命令调试项目

```bash
pnpm tauri dev
```

#### 6. 打包

开发完成后，使用以下命令打包项目

```bash
pnpm build 
pnpm tauri build
```

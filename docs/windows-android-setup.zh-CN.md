# Windows / Android 开发环境

本文只覆盖在 **Windows** 上编译 Readest **桌面端** 和 **Android**。贡献流程、PR 规范见 [CONTRIBUTING.md](../CONTRIBUTING.md)。其它平台的通用前置条件见 [Tauri 文档](https://v2.tauri.app/start/prerequisites/)。

国内网络访问 `services.gradle.org`、Google Maven、Maven Central 经常超时。Gradle 镜像配在 **本机用户目录**，不要改仓库里的 `gradle-wrapper.properties`（Tauri 会重新生成，也会影响不需要镜像的同事）。

## 1. 必备软件

| 软件 | 说明 |
| --- | --- |
| Node.js 24 + pnpm | 前端（Next.js） |
| Rust + rustup | Tauri / Cargo |
| Visual Studio 2022 Build Tools（或完整 VS） | 勾选 **使用 C++ 的桌面开发** |
| JDK 17 | Android Gradle 需要，例如 Liberica / Temurin 17 |
| Android SDK + NDK | Android Studio 或 command-line tools |

Windows ARM64 桌面额外需要 **VS 2022 C++ ARM64 生成工具** 和 **适用于 Windows 的 C++ Clang**，并把 Clang 加进 `Path`，例如：

`C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\Llvm\x64\bin`

在 **用户环境变量** 里设置（路径按本机实际安装位置改）：

```text
JAVA_HOME      C:\Program Files\BellSoft\LibericaJDK-17
ANDROID_HOME   D:\AppStorage\Android\Sdk
NDK_HOME       D:\AppStorage\Android\Sdk\ndk\30.0.16248370
```

`Path` 里至少要有：

- `%JAVA_HOME%\bin`
- `%ANDROID_HOME%\platform-tools`
- `%USERPROFILE%\.cargo\bin`

安装 Node / pnpm / Rust（PowerShell）：

```powershell
winget install OpenJS.NodeJS.LTS
npm install -g pnpm
# 或: irm https://get.pnpm.io/install.ps1 | iex

winget install Rustlang.Rustup
rustup update
```

确认：

```powershell
node -v
pnpm -v
rustc -V
adb version
```

## 2. 克隆与依赖

在仓库根目录执行：

```powershell
git clone https://github.com/readest/readest.git
cd readest
git submodule update --init --recursive
pnpm install
pnpm --filter @readest/readest-app setup-vendors
pnpm tauri info
```

代码更新后如果依赖或 submodule 变了，再跑一遍 `git submodule update --init --recursive` 和 `pnpm install`。`pnpm tauri info` 会打印当前 Windows / Android SDK / NDK 探测结果，有报错先看这一段。

## 3. Windows 桌面

```powershell
pnpm tauri dev
```

只改前端、不编 Rust 时可以用 `pnpm dev-web`。

桌面安装包打不出来、或双击 exe 没窗口，多半是本机没有 [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2)。详见 [README 故障排除](../README.md#troubleshooting)。

生产构建：

```powershell
pnpm tauri build
```

## 4. Android

下面这一组 **只需做一次**（之后 `pnpm tauri android dev` 会按需更新 `gen/android`）：

```powershell
Remove-Item -Recurse -Force apps\readest-app\src-tauri\gen\android -ErrorAction SilentlyContinue
pnpm tauri android init
pnpm tauri icon ../../data/icons/readest-book.png
git checkout apps/readest-app/src-tauri/gen/android
```

`rustup` 的 Android target（`aarch64-linux-android` 等）一般由 `android init` 安装。`NDK_HOME` 必须指向具体 NDK 版本目录，不能只指到 `Sdk\ndk`。

模拟器：

```powershell
pnpm tauri android dev
```

真机（让 Metro/dev server 监听局域网）：

```powershell
pnpm tauri android dev --host
```

生产 APK / AAB：

```powershell
pnpm tauri android build
```

## 5. Gradle 国内镜像（本机全局）

Android 编到 Rust `.so` 之后会跑 `gradlew`。失败通常是两类下载，处理方式不同。

| 下载 | 典型报错 | 能否用 init 脚本改源 |
| --- | --- | --- |
| Gradle 发行包 `gradle-x.y.z-bin.zip` | `Downloading from https://services.gradle.org/... failed: timeout` | **不能**。`gradlew` 在 Gradle 启动前按 `distributionUrl` 拉 zip |
| 依赖（AGP、AndroidX、Kotlin、插件） | `google()` / `mavenCentral()` / Plugin Portal 超时 | **能**。写到用户目录的 init 脚本，对本机所有 Gradle 工程生效 |

当前 wrapper 版本以这个文件为准（Tauri 生成，版本会变）：

`apps/readest-app/src-tauri/gen/android/gradle/wrapper/gradle-wrapper.properties`

下文示例用 **8.14.3**。不要把 `distributionUrl` 改成镜像后提交。

### 5.1 依赖镜像（推荐先做）

创建目录 `%USERPROFILE%\.gradle\init.d\`，新建文件 `tencent-mirror.init.gradle`，内容如下。这会把 `google()`、`mavenCentral()`、Gradle Plugin Portal 指到腾讯云。

```gradle
// 本机全局镜像。不能改写 wrapper 的 gradle-x.y.z-bin.zip 地址。
def mirrors = [
    'https://dl.google.com/dl/android/maven2': 'https://mirrors.cloud.tencent.com/nexus/repository/maven-public/',
    'https://maven.google.com': 'https://mirrors.cloud.tencent.com/nexus/repository/maven-public/',
    'https://repo.maven.apache.org/maven2': 'https://mirrors.cloud.tencent.com/nexus/repository/maven-public/',
    'https://repo1.maven.org/maven2': 'https://mirrors.cloud.tencent.com/nexus/repository/maven-public/',
    'https://plugins.gradle.org/m2': 'https://mirrors.cloud.tencent.com/nexus/repository/gradle-plugins/',
]

def rewrite = { org.gradle.api.artifacts.dsl.RepositoryHandler repos ->
    repos.all { repo ->
        if (repo instanceof org.gradle.api.artifacts.repositories.MavenArtifactRepository) {
            def original = repo.url.toString().replaceAll(/\/+$/, '')
            def mapped = mirrors[original]
            if (mapped != null) {
                repo.setUrl(mapped)
            }
        }
    }
}

gradle.beforeSettings { settings ->
    println '[gradle-mirror] Tencent Cloud (google / mavenCentral / pluginPortal)'
    rewrite(settings.pluginManagement.repositories)
    rewrite(settings.dependencyResolutionManagement.repositories)
}

gradle.allprojects { project ->
    project.buildscript { bs ->
        rewrite(bs.repositories)
    }
    rewrite(project.repositories)
}
```

可选：在 `%USERPROFILE%\.gradle\gradle.properties` 加长超时（同样只影响本机）：

```properties
systemProp.sun.net.client.defaultConnectTimeout=30000
systemProp.sun.net.client.defaultReadTimeout=120000
```

下次构建日志里出现 `[gradle-mirror] Tencent Cloud (...)` 即生效。删掉 `tencent-mirror.init.gradle` 就恢复官方源。

### 5.2 预下载 Gradle 发行包

同一版本只要已经完整缓存在 `%USERPROFILE%\.gradle\wrapper\dists\`，不会再去官方源。wrapper **升版本** 时要再灌一次。

1. 先跑一次 `pnpm tauri android dev`，让 wrapper 创建哈希目录（下载可能超时，没关系）。
2. 用腾讯云镜像拉 **同一个版本** 的 zip，放进该目录，并删掉半截文件：

```powershell
$ver = "8.14.3"   # 改成 gradle-wrapper.properties 里的版本
curl.exe -L -o "$env:TEMP\gradle-$ver-bin.zip" "https://mirrors.cloud.tencent.com/gradle/gradle-$ver-bin.zip"
$dir = Get-ChildItem "$env:USERPROFILE\.gradle\wrapper\dists\gradle-$ver-bin" -Directory |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if (-not $dir) { throw "还没有 dists\gradle-$ver-bin 目录，先跑一次 Android 构建" }
Move-Item -Force "$env:TEMP\gradle-$ver-bin.zip" (Join-Path $dir.FullName "gradle-$ver-bin.zip")
Remove-Item (Join-Path $dir.FullName "gradle-$ver-bin.zip.part") -ErrorAction SilentlyContinue
Remove-Item (Join-Path $dir.FullName "gradle-$ver-bin.zip.lck") -ErrorAction SilentlyContinue
Get-Item (Join-Path $dir.FullName "gradle-$ver-bin.zip")
```

zip 大约 130MB。再跑 `pnpm tauri android dev`，wrapper 会用本地缓存。

## 6. 常见问题

**`ld.lld: error: unable to find library -ladvapi32`（编 `turso_sdk_kit`）**  
这是在 Windows 上交叉编译 Android 时，上游 `turso_ext` 的 `build.rs` 误用了主机 `cfg!(windows)`。仓库里已通过 `[patch.crates-io]` 指向 `packages/turso-ext` 修好。如果本地还在报，确认 workspace 根目录 `Cargo.toml` 有 `turso_ext = { path = "packages/turso-ext" }`。

**`gradlew` 报 `Read timed out`，URL 是 `services.gradle.org/distributions/...`**  
走第 5.2 节，不要改仓库里的 wrapper URL。

**依赖一直从 `dl.google.com` / `repo.maven.apache.org` 拉、很慢或超时**  
走第 5.1 节。确认文件名是 `*.init.gradle`（必须带 `.init.`），并且在用户目录 `.gradle\init.d\`，不是项目目录。

**`pnpm tauri info` 找不到 NDK**  
`NDK_HOME` 要指到带 `toolchains\llvm\prebuilt\windows-x86_64` 的那一层版本目录。新开一个终端后再编。

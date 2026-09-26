# 发布流程

应用版本统一来自 `package.json`，同时与 `src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、Cargo/npm lockfile 保持一致。Git 标签采用 `v<version>`；资源归档版本与应用一致，桌宠 ID 不变。

## 桌宠资源

```bash
python3 scripts/package-pet-library.py
```

需要 Pillow，以及本机 `local-pet-packs/FocusPetPetPacks/` 原始资源库。也可以把 Release 的全集 ZIP 解压到该目录作为输入。脚本会核对分类目录、ID、映射、PNG 完整性、帧数、尺寸、音频引用与路径范围；输出全集、分类合集、17 个单包、JSON 索引和 SHA-256 文件到 `release/v<version>/`。

原作者和授权标记保留；生成的说明文件会去掉维护者本机绝对路径。资源文件只发到 Release，预览与目录可跟随 Git 提交。完整 ZIP 不放进 Git 历史；既有的小型迁移测试 ZIP 继续作为导入测试夹具。

发布前还要运行资源创建技能的严格验证，检查实际动画帧。缺少推荐动作、部分静态待机、大尺寸或不透明的特殊动作需要如实记录，不能为了通过检查伪造动画。

全集可选用生产 Rust 导入器再验收：

```bash
FOCUS_PET_RELEASE_PETS_ZIP="$PWD/release/v0.2.1/FocusPet-Pets-All-0.2.1.zip" \
  cargo test --manifest-path src-tauri/Cargo.toml imports_release_pet_library -- --ignored
```

## 应用构建与发布

1. 更新版本、README、`docs/releases/v<version>.md` 和资源索引，运行本地检查。
2. 提交到远程，创建并推送匹配版本标签。
3. `Build Release` 在 macOS arm64、macOS Intel、Windows x64、Linux x64 构建和测试。
4. 工作流生成可下载的安装包及逐文件 SHA-256，上传到 **草稿 Release**。macOS 用系统 `hdiutil` 打包，不依赖 Finder 自动布局脚本。
5. 将本机生成的桌宠资源资产上传到同一草稿，核对所有文件、哈希及下载链接，然后发布为 Latest。

没有 Apple 公证或 Windows 商业代码签名时，必须在下载页明确说明，不能将 ad-hoc 签名描述为公证。发布自动化只创建草稿，不会把缺少资源的发布自动公开。

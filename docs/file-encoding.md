# MiMoCode 文件编码配置

## 概述

MiMoCode 默认使用 UTF-8 编码读取文件。如果你的项目包含 GBK、GB2312 等编码的中文文件，可以通过配置项切换默认编码。

## 配置方式

### 项目级配置

在项目根目录创建 `mimocode.json`：

```json
{
  "files": {
    "encoding": "gbk"
  }
}
```

### 全局配置

| 操作系统 | 配置文件路径 |
|---------|-------------|
| Windows | `%APPDATA%\mimocode\mimocode.json` |
| Linux/macOS | `~/.config/mimocode/mimocode.json` |
| 自定义 (MIMOCODE_HOME) | `$MIMOCODE_HOME/config/mimocode.json` |

### Windows 示例

```
C:\Users\你的用户名\AppData\Roaming\mimocode\mimocode.json
```

## 支持的编码

| 编码 | 说明 | 适用场景 |
|------|------|---------|
| `utf-8` | UTF-8（默认） | 大多数现代项目 |
| `gbk` | GBK 编码 | 中文 Windows 系统文件 |
| `gb2312` | GB2312 编码 | 简体中文文件 |
| `big5` | Big5 编码 | 繁体中文文件 |
| `latin1` | Latin-1 编码 | 西欧语言文件 |

> 完整编码列表参考：[Node.js 支持的编码](https://nodejs.org/api/buffer.html#buffers-and-character-encodings)

## 配置优先级

项目级配置优先于全局配置。

```
项目根目录/mimocode.json  >  全局配置文件
```

## 注意事项

1. **编码检测**：MiMoCode 不会自动检测文件编码，需要手动在配置中指定
2. **混用问题**：如果项目中同时包含 UTF-8 和 GBK 文件，建议将 GBK 文件转换为 UTF-8（推荐使用工具如 `iconv` 或编辑器批量转换）
3. **写入编码**：当前版本仅影响文件读取编码，写入仍使用 UTF-8

## 快速开始

1. 在项目根目录创建 `mimocode.json`
2. 添加以下内容：

```json
{
  "files": {
    "encoding": "gbk"
  }
}
```

3. 重启 MiMoCode 使配置生效

## 常见问题

### Q: 配置后中文仍然乱码？

A: 请确认文件实际编码与配置一致。可以用以下命令检测文件编码：

```bash
# 使用 file 命令 (Linux/macOS)
file -i yourfile.txt

# 使用 chardet (Python)
pip install chardet
chardet yourfile.txt
```

### Q: 如何将 GBK 文件转为 UTF-8？

A: 使用 `iconv` 命令：

```bash
# Linux/macOS
iconv -f gbk -t utf-8 input.txt > output.txt

# Windows (PowerShell)
Get-Content input.txt -Encoding Default | Set-Content output.txt -Encoding UTF8
```

### Q: 配置后需要重启吗？

A: 是的，修改配置文件后需要重启 MiMoCode 才能生效。

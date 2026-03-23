# OpenClaw 数据目录管理系统

独立的 Web 管理系统，用于管理多个 OpenClaw 数据目录。

## 功能

- **目录管理**: 新增/删除/编辑数据目录
- **进程管理**: 启动/停止/重启 OpenClaw 实例
- **模块复制**: 选择性复制 agents/skills/config 等模块
- **备份恢复**: tar.gz 打包备份，支持恢复和下载
- **GitHub 部署**: 从预设仓库或自定义仓库部署

## 端口规则

- 管理服务: 15501
- 数据目录: 13000, 13001, 13002... (13 + 目录编号)

## 目录结构

```
~/.openclaw/                    # 默认目录 (公司)
~/.openclaw-001/                # 第二个目录 (私人)
~/.openclaw-002/                # 第三个目录 (测试)
~/.openclaw-registry.json       # 注册表
~/.openclaw-backups/            # 备份存储
~/.openclaw-pids/               # PID 文件
```

## API 接口

### 目录管理

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | /api/directories | 获取所有目录 |
| POST | /api/directories | 创建新目录 |
| DELETE | /api/directories/:id | 删除目录 |
| POST | /api/directories/:id/start | 启动目录 |
| POST | /api/directories/:id/stop | 停止目录 |
| POST | /api/directories/:id/restart | 重启目录 |
| GET | /api/directories/:id/logs | 获取日志 |

### 模块复制

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | /api/directories/:id/modules | 获取模块列表 |
| POST | /api/directories/:id/modules/copy | 复制模块 |

### 备份恢复

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | /api/directories/:id/backup | 创建备份 |
| GET | /api/directories/:id/backups | 获取备份历史 |
| POST | /api/directories/:id/restore | 恢复备份 |
| DELETE | /api/directories/:id/backups/:file | 删除备份 |

### GitHub 部署

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | /api/github/repos | 获取预设仓库列表 |
| POST | /api/github/deploy | 部署预设仓库 |
| POST | /api/github/custom | 部署自定义仓库 |

## 启动

```bash
cd E:/syncthing/mywork/ai/projects/github-repos/a009-openclaw-dir-manager
node server.js
```

访问 http://localhost:15501

## 技术栈

- 后端: Node.js (原生 http 模块)
- 前端: 单页 HTML + 原生 JavaScript
- 样式: 深色主题 (复用 a002 管理系统样式)

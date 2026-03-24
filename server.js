#!/usr/bin/env node
/**
 * OpenClaw 数据目录管理系统 - 服务端
 * 支持跨平台 (Windows + WSL)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const os = require('os');
const archiver = require('archiver');
const zlib = require('zlib');
const tar = require('tar');

// ============================================================================
// 常量定义
// ============================================================================

const PORT = 15501;
const HOME_DIR = os.homedir();
const REGISTRY_FILE = path.join(HOME_DIR, '.openclaw-registry.json');
const BACKUP_DIR = path.join(HOME_DIR, '.openclaw-backups');
const PID_DIR = path.join(HOME_DIR, '.openclaw-pids');
const OPENCLAW_BIN = 'openclaw';

// ============================================================================
// 核心工具函数
// ============================================================================

/**
 * 读取 JSON 文件
 * @param {string} file - 文件路径
 * @returns {object|null} - 解析后的 JSON 对象，失败返回 null
 */
function readJson(file) {
  try {
    if (!fs.existsSync(file)) {
      return null;
    }
    const content = fs.readFileSync(file, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    return null;
  }
}

/**
 * 写入 JSON 文件
 * @param {string} file - 文件路径
 * @param {object} data - 要写入的数据
 */
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * 读取注册表
 * 不存在则创建默认结构
 * @returns {object} - 注册表对象
 */
function readRegistry() {
  let registry = readJson(REGISTRY_FILE);
  if (!registry) {
    registry = {
      version: '1.0',
      directories: [],
      nextSuffix: 1
    };
    writeRegistry(registry);
  }
  return registry;
}

/**
 * 写入注册表
 * @param {object} registry - 注册表对象
 */
function writeRegistry(registry) {
  writeJson(REGISTRY_FILE, registry);
}

/**
 * 获取目录路径
 * @param {string|number} suffix - 目录后缀
 * @returns {string} - 目录完整路径
 */
function getDirectoryPath(suffix) {
  if (!suffix || suffix === 'default') {
    return path.join(HOME_DIR, '.openclaw');
  }
  return path.join(HOME_DIR, `.openclaw-${suffix}`);
}

/**
 * 获取端口
 * @param {string|number} suffix - 目录后缀
 * @returns {number} - 端口号
 */
function getPort(suffix) {
  if (!suffix) {
    return 13000;
  }
  return 13000 + parseInt(suffix, 10);
}

/**
 * 获取目录运行状态
 * @param {string|number} suffix - 目录后缀
 * @returns {string} - 'running' 或 'stopped'
 */
function getDirectoryStatus(suffix) {
  const pidFile = path.join(PID_DIR, `${suffix || 'default'}.pid`);

  // 检查 PID 文件是否存在
  if (!fs.existsSync(pidFile)) {
    return 'stopped';
  }

  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);

    // 检查进程是否存活
    if (isNaN(pid)) {
      return 'stopped';
    }

    // 跨平台进程检查
    try {
      if (process.platform === 'win32') {
        // Windows: 使用 tasklist 检查进程
        const result = execSync(`tasklist /FI "PID eq ${pid}" /NH`, {
          encoding: 'utf8',
          timeout: 5000
        });
        return result.includes(pid.toString()) ? 'running' : 'stopped';
      } else {
        // Unix/Linux/WSL: 使用 kill -0 检查进程
        process.kill(pid, 0);
        return 'running';
      }
    } catch (e) {
      return 'stopped';
    }
  } catch (error) {
    return 'stopped';
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 确保必要目录存在
 */
function ensureDirs() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
  if (!fs.existsSync(PID_DIR)) {
    fs.mkdirSync(PID_DIR, { recursive: true });
  }
}

// ============================================================================
// 目录管理 API
// ============================================================================

/**
 * 获取所有目录列表
 * @returns {Array} - 目录列表，包含状态信息
 */
function getDirectories() {
  const registry = readRegistry();
  return registry.directories.map(dir => ({
    ...dir,
    status: getDirectoryStatus(dir.suffix)
  }));
}

/**
 * 创建新目录
 * @param {string} name - 目录名称
 * @param {string|null} templateSuffix - 模板目录后缀（可选）
 * @param {Array} modules - 要复制的模块列表（可选）
 * @returns {object} - 创建的目录信息
 */
function createDirectory(name, templateSuffix = null, modules = []) {
  const registry = readRegistry();

  // 生成新的 suffix - 转换为字符串
  const suffix = String(registry.nextSuffix);
  const dirPath = getDirectoryPath(suffix);

  // 创建目录
  fs.mkdirSync(dirPath, { recursive: true });

  // 如果有模板，复制模块
  if (templateSuffix) {
    const templatePath = getDirectoryPath(templateSuffix);

    if (modules && modules.length > 0) {
      // 只复制指定的模块
      modules.forEach(moduleName => {
        const srcModule = path.join(templatePath, moduleName);
        const destModule = path.join(dirPath, moduleName);

        if (fs.existsSync(srcModule)) {
          fs.cpSync(srcModule, destModule, { recursive: true });
        }
      });
    }
  }

  // 创建基础 openclaw.json 配置
  const configPath = path.join(dirPath, 'openclaw.json');
  const baseConfig = {
    meta: {
      lastTouchedVersion: '2026.3.1',
      lastTouchedAt: new Date().toISOString()
    },
    auth: { profiles: {} },
    models: { mode: 'merge', providers: {} },
    agents: { list: [], defaults: {} },
    bindings: []
  };
  writeJson(configPath, baseConfig);

  // 创建目录信息对象
  const dirInfo = {
    suffix: suffix,
    name: name,
    path: dirPath,
    port: getPort(suffix),
    createdAt: new Date().toISOString(),
    templateFrom: templateSuffix || null
  };

  // 更新注册表
  registry.directories.push(dirInfo);
  registry.nextSuffix = suffix + 1;
  writeRegistry(registry);

  return {
    ...dirInfo,
    status: 'stopped'
  };
}

/**
 * 删除目录
 * @param {string|number} suffix - 目录后缀
 * @returns {object} - 操作结果
 */
function deleteDirectory(suffix) {
  const registry = readRegistry();

  // 查找目录 - 修复类型比较
  const dirIndex = registry.directories.findIndex(d => String(d.suffix) === String(suffix));
  if (dirIndex === -1) {
    throw new Error(`Directory with suffix ${suffix} not found`);
  }

  // 检查是否正在运行
  const status = getDirectoryStatus(suffix);
  if (status === 'running') {
    throw new Error(`Cannot delete running directory. Please stop it first.`);
  }

  // 删除目录内容
  const dirPath = getDirectoryPath(suffix);
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }

  // 删除 PID 文件
  const pidFile = path.join(PID_DIR, `${suffix}.pid`);
  if (fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  // 从注册表移除
  registry.directories.splice(dirIndex, 1);
  writeRegistry(registry);

  return { success: true, message: `Directory ${suffix} deleted` };
}

/**
 * 获取目录的模块列表
 * @param {string|number} suffix - 目录后缀
 * @returns {Array} - 模块列表
 */
function getModules(suffix) {
  const dirPath = getDirectoryPath(suffix);
  const modules = [];

  // 检查常见模块
  const moduleNames = ['agents', 'skills', 'agency-agents', 'canvas', 'cron', 'devices', 'logs', 'vault'];

  moduleNames.forEach(name => {
    const modulePath = path.join(dirPath, name);
    if (fs.existsSync(modulePath)) {
      const stat = fs.statSync(modulePath);
      modules.push({
        name: name,
        type: fs.statSync(modulePath).isDirectory() ? 'directory' : 'file',
        size: stat.size,
        modified: stat.mtime
      });
    }
  });

  return modules;
}

/**
 * 复制模块到目标目录
 * @param {string|number} sourceSuffix - 源目录后缀
 * @param {string|number} targetSuffix - 目标目录后缀
 * @param {Array} modules - 要复制的模块名称列表
 * @returns {object} - 复制结果
 */
function copyModules(sourceSuffix, targetSuffix, modules) {
  const sourcePath = getDirectoryPath(sourceSuffix);
  const targetPath = getDirectoryPath(targetSuffix);

  if (!fs.existsSync(targetPath)) {
    return { success: false, error: 'Target directory does not exist' };
  }

  const copied = [];
  const failed = [];

  modules.forEach(moduleName => {
    const src = path.join(sourcePath, moduleName);
    const dest = path.join(targetPath, moduleName);

    if (!fs.existsSync(src)) {
      failed.push({ module: moduleName, error: 'Source module not found' });
      return;
    }

    try {
      if (fs.statSync(src).isDirectory()) {
        if (fs.existsSync(dest)) {
          fs.rmSync(dest, { recursive: true });
        }
        fs.cpSync(src, dest, { recursive: true });
      } else {
        fs.copyFileSync(src, dest);
      }
      copied.push(moduleName);
    } catch (e) {
      failed.push({ module: moduleName, error: e.message });
    }
  });

  return {
    success: failed.length === 0,
    copied,
    failed
  };
}

/**
 * 扫描并导入已有目录
 * @returns {object} - 可导入的目录列表
 */
function scanExistingDirectories() {
  const homeDir = HOME_DIR;
  const existingDirs = [];

  // 扫描所有 .openclaw-* 格式的目录
  const entries = fs.readdirSync(homeDir, { withFileTypes: true });

  entries.forEach(entry => {
    const name = entry.name;
    if (name.startsWith('.openclaw') && entry.isDirectory()) {
      // 跳过备份目录
      if (name === '.openclaw-backups') return;

      const fullPath = path.join(homeDir, name);

      // 提取 suffix
      let suffix = '';
      if (name === '.openclaw') {
        suffix = '';
      } else if (name.startsWith('.openclaw-')) {
        suffix = name.replace('.openclaw-', '');
      }

      if (suffix !== '') {
        // 检查是否已在注册表中
        const registry = readRegistry();
        const alreadyRegistered = registry.directories.some(d => d.suffix === suffix);

        if (!alreadyRegistered) {
          // 检查是否包含 openclaw.json
          const configPath = path.join(fullPath, 'openclaw.json');
          if (fs.existsSync(configPath)) {
            existingDirs.push({
              suffix: suffix,
              name: name.replace('.openclaw', '').replace('-', ''),
              path: fullPath,
              status: 'stopped'
            });
          }
        }
      }
    }
  });

  return existingDirs;
}

/**
 * 导入已有目录
 * @param {string} suffix - 目录后缀 (空字符串表示默认目录)
 * @param {string} name - 目录名称
 * @returns {object} - 导入结果
 */
function importDirectory(suffix, name) {
  const registry = readRegistry();

  // 检查是否已存在
  const exists = registry.directories.some(d => d.suffix === suffix);
  if (exists) {
    return { success: false, error: 'Directory already registered' };
  }

  const dirPath = getDirectoryPath(suffix);

  if (!fs.existsSync(dirPath)) {
    return { success: false, error: 'Directory does not exist' };
  }

  // 添加到注册表
  const dirInfo = {
    suffix: suffix,
    name: name,
    path: dirPath,
    port: getPort(suffix),
    createdAt: new Date().toISOString(),
    templateFrom: null,
    status: 'stopped'
  };

  registry.directories.push(dirInfo);
  writeRegistry(registry);

  return {
    success: true,
    directory: dirInfo
  };
}

/**
 * 获取单个目录详情
 * @param {string|number} suffix - 目录后缀
 * @returns {object} - 目录详细信息
 */
function getDirectoryInfo(suffix) {
  const registry = readRegistry();

  // 查找目录
  const dirInfo = registry.directories.find(d => d.suffix === suffix);
  if (!dirInfo) {
    throw new Error(`Directory with suffix ${suffix} not found`);
  }

  const dirPath = getDirectoryPath(suffix);

  // 获取目录中的模块列表
  let modules = [];
  if (fs.existsSync(dirPath)) {
    modules = fs.readdirSync(dirPath, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  }

  // 读取配置文件
  const configPath = path.join(dirPath, 'openclaw.json');
  let config = null;
  if (fs.existsSync(configPath)) {
    config = readJson(configPath);
  }

  return {
    ...dirInfo,
    status: getDirectoryStatus(suffix),
    modules: modules,
    config: config
  };
}

// ============================================================================
// 进程管理 API
// ============================================================================

/**
 * 启动目录
 * @param {string|number} suffix - 目录后缀
 * @returns {object} - 操作结果
 */
function startDirectory(suffix) {
  const dirPath = getDirectoryPath(suffix);
  const port = getPort(suffix);
  const pidFile = path.join(PID_DIR, `openclaw-${suffix || 'default'}.pid`);

  // 检查目录是否存在
  if (!fs.existsSync(dirPath)) {
    return { success: false, error: 'Directory does not exist' };
  }

  // 检查是否已在运行
  const status = getDirectoryStatus(suffix);
  if (status === 'running') {
    return { success: false, error: 'Directory is already running' };
  }

  // 启动进程
  const child = spawn(OPENCLAW_BIN, ['start', '--port', port.toString()], {
    cwd: dirPath,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32' // Windows 需要 shell
  });

  // 确保子进程独立运行
  child.unref();

  // 记录 PID
  fs.mkdirSync(PID_DIR, { recursive: true });
  fs.writeFileSync(pidFile, child.pid.toString());

  // 更新注册表状态
  const registry = readRegistry();
  const dir = registry.directories.find(d => d.suffix === suffix);
  if (dir) {
    dir.status = 'running';
    writeRegistry(registry);
  }

  return { success: true, pid: child.pid, port: port };
}

/**
 * 停止目录
 * @param {string|number} suffix - 目录后缀
 * @returns {object} - 操作结果
 */
function stopDirectory(suffix) {
  const pidFile = path.join(PID_DIR, `openclaw-${suffix || 'default'}.pid`);

  // 检查 PID 文件是否存在
  if (!fs.existsSync(pidFile)) {
    return { success: false, error: 'PID file not found, process may not be running' };
  }

  // 读取 PID
  let pid;
  try {
    pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (isNaN(pid)) {
      fs.unlinkSync(pidFile);
      return { success: false, error: 'Invalid PID in file' };
    }
  } catch (error) {
    return { success: false, error: 'Failed to read PID file' };
  }

  // 检查进程是否运行
  const status = getDirectoryStatus(suffix);
  if (status === 'stopped') {
    // 进程已停止，清理 PID 文件
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
    return { success: false, error: 'Process is not running' };
  }

  // 跨平台停止进程
  try {
    if (process.platform === 'win32') {
      // Windows: 使用 taskkill
      execSync(`taskkill /PID ${pid} /F`, {
        encoding: 'utf8',
        timeout: 10000
      });
    } else {
      // Linux/WSL: 使用 SIGTERM
      process.kill(pid, 'SIGTERM');

      // 等待进程结束（最多等待 5 秒）
      let attempts = 0;
      const maxAttempts = 50;
      while (attempts < maxAttempts) {
        try {
          process.kill(pid, 0);
          // 进程还在运行，等待
          const waitMs = 100;
          const start = Date.now();
          while (Date.now() - start < waitMs) {
            // 忙等待
          }
          attempts++;
        } catch (e) {
          // 进程已结束
          break;
        }
      }

      // 如果进程还在运行，强制杀死
      if (attempts >= maxAttempts) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (e) {
          // 忽略错误
        }
      }
    }
  } catch (error) {
    // 进程可能已经停止
    if (!error.message.includes('not found') && !error.message.includes('No such process')) {
      return { success: false, error: `Failed to stop process: ${error.message}` };
    }
  }

  // 删除 PID 文件
  if (fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  // 更新注册表状态
  const registry = readRegistry();
  const dir = registry.directories.find(d => d.suffix === suffix);
  if (dir) {
    dir.status = 'stopped';
    writeRegistry(registry);
  }

  return { success: true, message: `Process ${pid} stopped` };
}

/**
 * 重启目录
 * @param {string|number} suffix - 目录后缀
 * @returns {object} - 操作结果
 */
function restartDirectory(suffix) {
  // 先停止
  const stopResult = stopDirectory(suffix);

  // 即使停止失败（进程可能已经停止），也尝试启动
  if (!stopResult.success && !stopResult.error.includes('not running') && !stopResult.error.includes('not found')) {
    return { success: false, error: `Failed to stop: ${stopResult.error}` };
  }

  // 等待一秒确保进程完全停止
  const waitMs = 1000;
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    // 忙等待
  }

  // 再启动
  const startResult = startDirectory(suffix);
  if (!startResult.success) {
    return { success: false, error: `Failed to start: ${startResult.error}` };
  }

  return {
    success: true,
    message: 'Directory restarted successfully',
    pid: startResult.pid,
    port: startResult.port
  };
}

/**
 * 获取目录日志
 * @param {string|number} suffix - 目录后缀
 * @param {number} lines - 要获取的行数，默认 100
 * @returns {object} - 操作结果，包含日志内容
 */
function getDirectoryLogs(suffix, lines = 100) {
  const dirPath = getDirectoryPath(suffix);
  const logFile = path.join(dirPath, 'openclaw.log');

  // 检查日志文件是否存在
  if (!fs.existsSync(logFile)) {
    return { success: false, error: 'Log file not found' };
  }

  try {
    // 读取日志文件
    const content = fs.readFileSync(logFile, 'utf8');
    const allLines = content.split('\n');

    // 获取最后 N 行
    const startIndex = Math.max(0, allLines.length - lines);
    const lastLines = allLines.slice(startIndex);

    return {
      success: true,
      lines: lastLines.length,
      logs: lastLines.join('\n')
    };
  } catch (error) {
    return { success: false, error: `Failed to read log file: ${error.message}` };
  }
}

// ============================================================================
// 备份恢复 API
// ============================================================================

/**
 * 创建目录备份 (使用 archiver 库，跨平台兼容)
 * @param {string|number} suffix - 目录后缀
 * @param {string} description - 备份描述（可选）
 * @returns {Promise<object>} - 备份信息
 */
async function backupDirectory(suffix, description = '') {
  const dirPath = getDirectoryPath(suffix);

  // 检查目录是否存在
  if (!fs.existsSync(dirPath)) {
    throw new Error(`Directory with suffix ${suffix} does not exist`);
  }

  // 生成时间戳: YYYY-MM-DD_HHMMSS
  const now = new Date();
  const timestamp = now.toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 19)
    .replace('T', '_');

  // 备份文件名
  const backupName = `${suffix || 'default'}_${timestamp}.tar.gz`;
  const backupFile = path.join(BACKUP_DIR, backupName);

  // 确保备份目录存在
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  // 排除的目录和文件
  const excludePatterns = ['logs', 'node_modules', 'backups', '*.log'];

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(backupFile);
    const archive = archiver('tar', {
      gzip: true,
      gzipOptions: { level: 9 }
    });

    output.on('close', () => {
      const stats = fs.statSync(backupFile);
      resolve({
        success: true,
        backup: {
          file: backupName,
          path: backupFile,
          size: (stats.size / 1024 / 1024).toFixed(2) + ' MB',
          description: description,
          createdAt: new Date().toISOString(),
          suffix: suffix || 'default'
        }
      });
    });

    archive.on('error', (err) => {
      // 清理部分文件
      if (fs.existsSync(backupFile)) {
        try { fs.unlinkSync(backupFile); } catch (e) { /* ignore */ }
      }
      reject(new Error(`Backup failed: ${err.message}`));
    });

    archive.pipe(output);

    // 添加目录内容到归档，排除指定项
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryName = entry.name;
      const entryPath = path.join(dirPath, entryName);

      // 检查是否应该排除
      if (excludePatterns.includes(entryName) ||
          (entryName.endsWith('.log') && excludePatterns.includes('*.log'))) {
        continue;
      }

      if (entry.isDirectory()) {
        archive.directory(entryPath, entryName);
      } else {
        archive.file(entryPath, { name: entryName });
      }
    }

    archive.finalize();
  });
}

/**
 * 获取备份历史
 * @param {string|number} suffix - 目录后缀（可选，不提供则返回所有备份）
 * @returns {object} - 备份列表
 */
function getBackupHistory(suffix) {
  // 确保备份目录存在
  if (!fs.existsSync(BACKUP_DIR)) {
    return { success: true, backups: [] };
  }

  try {
    // 读取备份目录中的所有文件
    const files = fs.readdirSync(BACKUP_DIR);

    // 过滤出 .tar.gz 文件
    let backups = files
      .filter(file => file.endsWith('.tar.gz'))
      .map(file => {
        const filePath = path.join(BACKUP_DIR, file);
        const stats = fs.statSync(filePath);

        // 从文件名解析 suffix
        // 格式: {suffix}_{timestamp}.tar.gz
        const match = file.match(/^(.+?)_(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.tar\.gz$/);
        let fileSuffix = 'unknown';
        let timestamp = '';

        if (match) {
          fileSuffix = match[1];
          timestamp = match[2];
        }

        return {
          file: file,
          suffix: fileSuffix,
          timestamp: timestamp,
          size: (stats.size / 1024 / 1024).toFixed(2) + ' MB',
          createdAt: stats.birthtime.toISOString(),
          modifiedAt: stats.mtime.toISOString()
        };
      });

    // 如果指定了 suffix，过滤出对应的备份
    if (suffix !== undefined && suffix !== null) {
      const targetSuffix = suffix || 'default';
      backups = backups.filter(b => b.suffix === targetSuffix);
    }

    // 按创建时间倒序排列
    backups.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return {
      success: true,
      suffix: suffix !== undefined ? (suffix || 'default') : 'all',
      count: backups.length,
      backups: backups
    };
  } catch (error) {
    throw new Error(`Failed to get backup history: ${error.message}`);
  }
}

/**
 * 恢复备份 (使用 tar npm 库，跨平台兼容)
 * @param {string|number} suffix - 目标目录后缀
 * @param {string} backupFile - 备份文件名
 * @returns {Promise<object>} - 恢复结果
 */
async function restoreBackup(suffix, backupFile) {
  const dirPath = getDirectoryPath(suffix);
  const backupPath = path.join(BACKUP_DIR, backupFile);

  // 检查备份文件是否存在
  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupFile}`);
  }

  // 检查目标目录是否存在
  if (!fs.existsSync(dirPath)) {
    // 如果目录不存在，创建它
    fs.mkdirSync(dirPath, { recursive: true });
  }

  // 检查目录是否正在运行
  const status = getDirectoryStatus(suffix);
  if (status === 'running') {
    throw new Error('Cannot restore backup to a running directory. Please stop it first.');
  }

  try {
    // 备份当前目录（如果非空）
    const currentFiles = fs.existsSync(dirPath) ? fs.readdirSync(dirPath) : [];
    let preRestoreBackup = null;

    if (currentFiles.length > 0) {
      // 创建恢复前的备份
      preRestoreBackup = await backupDirectory(suffix, 'pre-restore');
      preRestoreBackup = preRestoreBackup.backup.file;
    }

    // 清空目标目录
    if (fs.existsSync(dirPath)) {
      const entries = fs.readdirSync(dirPath);
      for (const entry of entries) {
        const entryPath = path.join(dirPath, entry);
        fs.rmSync(entryPath, { recursive: true, force: true });
      }
    }

    // 使用 tar npm 包解压
    await tar.x({
      file: backupPath,
      cwd: dirPath,
      gzip: true
    });

    return {
      success: true,
      message: `Backup restored successfully to ${dirPath}`,
      restoredFrom: backupFile,
      targetSuffix: suffix || 'default',
      preRestoreBackup: preRestoreBackup
    };
  } catch (error) {
    throw new Error(`Restore failed: ${error.message}`);
  }
}

/**
 * 删除备份
 * @param {string|number} suffix - 目录后缀（用于验证）
 * @param {string} backupFile - 备份文件名
 * @returns {object} - 删除结果
 */
function deleteBackup(suffix, backupFile) {
  const backupPath = path.join(BACKUP_DIR, backupFile);

  // 检查备份文件是否存在
  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupFile}`);
  }

  // 验证备份文件名中的 suffix 是否匹配
  const match = backupFile.match(/^(.+?)_(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.tar\.gz$/);
  if (match) {
    const fileSuffix = match[1];
    const targetSuffix = suffix || 'default';

    if (fileSuffix !== targetSuffix) {
      throw new Error(`Backup file suffix mismatch. Expected ${targetSuffix}, got ${fileSuffix}`);
    }
  }

  try {
    // 获取文件大小用于报告
    const stats = fs.statSync(backupPath);
    const fileSize = (stats.size / 1024 / 1024).toFixed(2) + ' MB';

    // 删除文件
    fs.unlinkSync(backupPath);

    return {
      success: true,
      message: `Backup deleted successfully`,
      deletedFile: backupFile,
      freedSpace: fileSize
    };
  } catch (error) {
    throw new Error(`Failed to delete backup: ${error.message}`);
  }
}

// ============================================================================
// GitHub 部署 API
// ============================================================================

/**
 * 预设仓库列表
 */
const PRESET_REPOS = [
  { id: 'a005-openclaw-personas', name: 'Bot 人设模板', description: '23个预设人设模板', target: 'agents' },
  { id: 'a006-skills-library', name: 'Skills 库', description: 'OpenClaw Skills 库', target: 'skills' },
  { id: 'a007-openclaw-config', name: '配置模板', description: '配置文件模板', target: '' }
];

/**
 * 获取可部署的仓库列表
 * @returns {Array} - 可部署的仓库列表
 */
function getDeployableRepos() {
  return PRESET_REPOS.map(repo => ({
    id: repo.id,
    name: repo.name,
    description: repo.description,
    target: repo.target
  }));
}

/**
 * 部署预设仓库
 * @param {string} repoId - 仓库 ID
 * @param {string|number} targetSuffix - 目标目录后缀
 * @param {string} branch - 分支名称，默认 'main'
 * @returns {object} - 部署结果
 */
function deployFromGitHub(repoId, targetSuffix, branch = 'main') {
  const repo = PRESET_REPOS.find(r => r.id === repoId);
  if (!repo) {
    return { success: false, error: 'Repository not found' };
  }

  const targetPath = getDirectoryPath(targetSuffix);
  if (!fs.existsSync(targetPath)) {
    return { success: false, error: 'Target directory does not exist' };
  }

  const cloneUrl = `https://github.com/waysh/${repoId}.git`;
  const tempDir = path.join(HOME_DIR, '.openclaw-temp', `${repoId}-${Date.now()}`);

  try {
    // 清理可能存在的临时目录
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });

    // 克隆仓库
    execSync(`git clone --branch ${branch} --depth 1 ${cloneUrl} "${tempDir}"`, {
      stdio: 'pipe',
      timeout: 120000
    });

    // 复制到目标目录
    if (repo.target) {
      const destPath = path.join(targetPath, repo.target);
      if (fs.existsSync(destPath)) {
        fs.rmSync(destPath, { recursive: true });
      }
      fs.cpSync(tempDir, destPath, { recursive: true });
    } else {
      // 配置模板，复制根目录文件
      const files = fs.readdirSync(tempDir).filter(f => !f.startsWith('.'));
      files.forEach(f => {
        const src = path.join(tempDir, f);
        const dest = path.join(targetPath, f);
        if (fs.statSync(src).isDirectory()) {
          fs.cpSync(src, dest, { recursive: true });
        } else {
          fs.copyFileSync(src, dest);
        }
      });
    }

    // 清理临时目录
    fs.rmSync(tempDir, { recursive: true });

    return { success: true, repo: repoId, deployed: true };
  } catch (e) {
    // 清理临时目录
    if (fs.existsSync(tempDir)) {
      try { fs.rmSync(tempDir, { recursive: true }); } catch (err) { /* ignore */ }
    }
    return { success: false, error: e.message };
  }
}

/**
 * 自定义仓库部署
 * @param {string} repoUrl - 仓库 URL
 * @param {string|number} targetSuffix - 目标目录后缀
 * @param {string} targetPath - 目标子路径（可选）
 * @param {string} branch - 分支名称，默认 'main'
 * @returns {object} - 部署结果
 */
function customDeploy(repoUrl, targetSuffix, targetPath, branch = 'main') {
  const basePath = getDirectoryPath(targetSuffix);
  const destPath = targetPath ? path.join(basePath, targetPath) : basePath;

  if (!fs.existsSync(basePath)) {
    return { success: false, error: 'Base directory does not exist' };
  }

  const tempDir = path.join(HOME_DIR, '.openclaw-temp', `custom-${Date.now()}`);

  try {
    // 清理可能存在的临时目录
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });

    // 克隆仓库
    execSync(`git clone --branch ${branch} --depth 1 "${repoUrl}" "${tempDir}"`, {
      stdio: 'pipe',
      timeout: 120000
    });

    // 确保目标目录存在
    fs.mkdirSync(destPath, { recursive: true });

    // 复制内容
    fs.cpSync(tempDir, destPath, { recursive: true });

    // 清理临时目录
    fs.rmSync(tempDir, { recursive: true });

    return { success: true, repo: repoUrl, deployed: true };
  } catch (e) {
    // 清理临时目录
    if (fs.existsSync(tempDir)) {
      try { fs.rmSync(tempDir, { recursive: true }); } catch (err) { /* ignore */ }
    }
    return { success: false, error: e.message };
  }
}

// ============================================================================
// 初始化
// ============================================================================

// 确保必要目录存在
ensureDirs();

// ============================================================================
// HTTP 服务器和路由
// ============================================================================

/**
 * CORS 头配置
 */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

/**
 * API 路由处理器
 */
const API_HANDLERS = {
  'GET /api/directories': () => ({ directories: getDirectories() }),

  'POST /api/directories': (params, body) => {
    const { name, copyFrom, modules } = body;
    if (!name) return { success: false, error: 'Name is required' };
    return createDirectory(name, copyFrom, modules);
  },

  'DELETE /api/directories/:id': (params) => deleteDirectory(params.id),

  'GET /api/directories/:id': (params) => getDirectoryInfo(params.id),

  'POST /api/directories/:id/start': (params) => startDirectory(params.id),

  'POST /api/directories/:id/stop': (params) => stopDirectory(params.id),

  'POST /api/directories/:id/restart': (params) => restartDirectory(params.id),

  'GET /api/directories/:id/logs': (params, body) => {
    const lines = parseInt(body?.lines, 10) || 100;
    return getDirectoryLogs(params.id, lines);
  },

  'GET /api/directories/:id/modules': (params) => ({ modules: getModules(params.id) }),

  'POST /api/directories/:id/modules/copy': (params, body) => {
    const { targetDir, modules } = body;
    return copyModules(params.id, targetDir, modules);
  },

  'POST /api/directories/:id/backup': (params, body) => {
    const { description } = body || {};
    return backupDirectory(params.id, description);
  },

  'GET /api/directories/:id/backups': (params) => ({ backups: getBackupHistory(params.id) }),

  'POST /api/directories/:id/restore': (params, body) => {
    const { backupFile } = body;
    return restoreBackup(params.id, backupFile);
  },

  'DELETE /api/directories/:id/backups/:file': (params) => deleteBackup(params.id, params.file),

  'GET /api/github/repos': () => ({ repos: getDeployableRepos() }),

  // 导入目录相关 API
  'GET /api/directories/scan': () => ({ directories: scanExistingDirectories() }),

  'POST /api/directories/import': (params, body) => {
    const { suffix, name } = body;
    return importDirectory(suffix, name);
  },

  'POST /api/github/deploy': (params, body) => {
    const { repoId, targetDir, branch } = body;
    return deployFromGitHub(repoId, targetDir, branch);
  },

  'POST /api/github/custom': (params, body) => {
    const { repoUrl, targetDir, targetPath, branch } = body;
    return customDeploy(repoUrl, targetDir, targetPath, branch);
  }
};

/**
 * 路由匹配函数
 * @param {string} method - HTTP 方法
 * @param {string} pathname - URL 路径
 * @returns {object|null} - 匹配结果 { handler, params } 或 null
 */
function matchRoute(method, pathname) {
  // 先尝试精确匹配
  const exactKey = `${method} ${pathname}`;
  if (API_HANDLERS[exactKey]) {
    return { handler: API_HANDLERS[exactKey], params: {} };
  }

  // 尝试参数化路由匹配
  for (const [route, handler] of Object.entries(API_HANDLERS)) {
    const [routeMethod, ...routePathParts] = route.split(' ');
    const routePath = routePathParts.join(' ');

    // 检查方法是否匹配
    if (routeMethod !== method) {
      continue;
    }

    // 分割路径进行匹配
    const routeSegments = routePath.split('/');
    const pathSegments = pathname.split('/');

    // 段数必须相同
    if (routeSegments.length !== pathSegments.length) {
      continue;
    }

    // 逐段匹配
    const params = {};
    let matched = true;

    for (let i = 0; i < routeSegments.length; i++) {
      const routeSeg = routeSegments[i];
      const pathSeg = pathSegments[i];

      if (routeSeg.startsWith(':')) {
        // 参数段，提取参数值
        const paramName = routeSeg.slice(1);
        params[paramName] = pathSeg;
      } else if (routeSeg !== pathSeg) {
        // 静态段不匹配
        matched = false;
        break;
      }
    }

    if (matched) {
      return { handler, params };
    }
  }

  return null;
}

/**
 * 创建 HTTP 服务器
 */
const server = http.createServer((req, res) => {
  // CORS 预检请求处理
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://' + req.headers.host);
  const pathname = url.pathname;

  // 静态文件服务 - 提供 Web UI
  if (pathname === '/' || pathname === '/index.html') {
    const indexPath = path.join(__dirname, 'web', 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS });
      res.end(fs.readFileSync(indexPath));
      return;
    }
  }

  // API 路由处理
  const matched = matchRoute(req.method, pathname);
  if (matched) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const parsedBody = body ? JSON.parse(body) : {};
        const result = await Promise.resolve(matched.handler(matched.params, parsedBody));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // 404 处理
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS });
  res.end(JSON.stringify({ success: false, error: 'Not found' }));
});

// 启动服务器
server.listen(PORT, () => {
  console.log(`OpenClaw Directory Manager running on port ${PORT}`);
  console.log(`Management UI: http://localhost:${PORT}`);
});

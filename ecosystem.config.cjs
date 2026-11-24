const path = require('path');

module.exports = {
  apps: [
    {
      name: 'dlufl-library-backend',
      cwd: path.resolve(__dirname, 'backend'),
      script: 'dist/main.js',
      // 必须单实例运行，防止 18:01 定时抢座调度器与 SQLite 写入产生多实例重复触发
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      kill_timeout: 5000,
      time: true,
      out_file: path.resolve(__dirname, 'logs/backend-out.log'),
      error_file: path.resolve(__dirname, 'logs/backend-error.log'),
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        PORT: 18301,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 18301,
      },
    },
    {
      name: 'dlufl-library-frontend',
      cwd: path.resolve(__dirname, 'frontend'),
      script: path.resolve(__dirname, 'frontend/node_modules/vite/bin/vite.js'),
      args: 'preview --host 127.0.0.1 --port 18517 --strictPort',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      time: true,
      out_file: path.resolve(__dirname, 'logs/frontend-out.log'),
      error_file: path.resolve(__dirname, 'logs/frontend-error.log'),
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        BACKEND_PORT: 18301,
        FRONTEND_PORT: 18517,
      },
      env_production: {
        NODE_ENV: 'production',
        BACKEND_PORT: 18301,
        FRONTEND_PORT: 18517,
      },
    },
  ],
};

# 大连外国语大学图书馆座位预约与定时抢座系统 (DLUFL Library)

基于 **NestJS + React (Vite + Tailwind CSS) + SQLite** 构建的网页端图书馆座位预约系统。登录验证参考 [hydrooj-oauth-dlufl](https://github.com/hprogq/hydrooj-oauth-dlufl.git)，底层图书馆预约接口基于本仓库的 `src/cas` 与 `src/icspace`（杭州联创 ICSpace）。

## 核心功能

1. **数字大外 CAS 统一身份认证（正常跳转 + 稳定回调 + 二次登录无异常）**
   - 点击登录直接 302 跳转至 `https://cas.dlufl.edu.cn/cas/login?service=...`。
   - 回调路由 `/api/auth/cas/callback` 由服务端**单次**调用 `https://cas.dlufl.edu.cn/cas/proxyValidate` 解析 `sso:serviceResponse` XML 属性（`user_id`, `unit_name`, `id_number`, `user_name`, `id_type`）。
   - 采用规范化的固定 `service` URL（`returnTo` 存入短期 HttpOnly Cookie），服务端签发 `HttpOnly` JWT Cookie 后立刻 302 重定向并剥离 `?ticket=...`，彻底避免 React StrictMode 重复消费 ST 票据、刷新回调页报错、以及二次登录用户唯一键冲突。
   - 支持 CAS 统一登出（`/api/auth/cas/logout`）、强制重新认证切换账号（`?renew=true`），以及校园内网环境下的 DES 加密直连兜底登录。
2. **多区域网页可视化选座**
   - 覆盖 `二楼东区 (100475785)`、`二楼中区 (100475787)`、`二楼西区 (100475789)`、`六楼电子阅览室 (109342010)`。
   - 支持按日期（今天 / 明天 / 自定义）与时间段查询每个座位的实时占用时间轴与空闲率，点击座位一键预约。
3. **每日 18:01 定期预约 + 无座持续轮询找座**
   - 图书馆每天 18:00 放次日座位，系统默认在 **18:01** 自动按区域优先级与心仪座位号开抢次日座位。
   - 若第一时间没有可用空座（或座位被抢占），任务自动转入 **`polling` 轮询找座模式**，按设定间隔（默认 5 秒）持续扫描并尝试预约，**直到成功约上座位**（或手动停止 / 到达轮询上限）。
4. **卡片系统成功预约次数查询**
   - 支持按学号 / 校园一卡通号或姓名查询个人图书馆预约凭证卡，展示累计成功约座次数、本月/本周次数、手动选座 / 18:01 准点抢座 / 轮询捡漏拆分统计、常去区域分布、近期凭证记录以及全馆预约成就卡片墙。
5. **首页实时数据看板**
   - 持久化展示**累计成功约座次数**、**系统累计访问次数**、今日新增统计、当前轮询任务数以及距离下次 18:01 开抢的实时倒计时。

## 目录结构

- `backend/` — NestJS 后端（CAS 认证、ICSpace 代理、18:01 定时与轮询调度引擎、SQLite 持久化、统计与卡片查询 API）
- `frontend/` — React + Vite + Tailwind CSS 前端应用
- `src/` — 原有命令行脚本（保持不动）

## 快速启动

### 1. 安装依赖

```bash
cd backend && npm install
cd ../frontend && npm install
```

### 2. 配置环境变量

编辑 [backend/.env](backend/.env)（参考 [backend/.env.example](backend/.env.example)）：

```env
PORT=18301
PUBLIC_BASE_URL=http://localhost:18517
FRONTEND_URL=http://localhost:18517
CAS_SERVER_URL=https://cas.dlufl.edu.cn
ICSPACE_HOST=https://icspace.dlufl.edu.cn
# 生产/校园网环境请保持 false；无校园网本地体验界面与抢座流程可设为 true
ICSPACE_MOCK_MODE=false
```

> 生产部署在反向代理（Nginx / Caddy）后时，请将 `PUBLIC_BASE_URL` 和 `FRONTEND_URL` 设为你的外部域名（例如 `https://lib.example.com`），并参考 [deploy/nginx.conf](deploy/nginx.conf) 配置，确保 `/cas/login` 与 `/cas/proxyValidate` 使用完全一致的 `service` 回调地址。

### 3. 启动开发环境

分别启动后端与前端：

```bash
# 终端 1：启动 NestJS 后端（端口 18301）
cd backend
npm run start:dev

# 终端 2：启动 React 前端（端口 18517，已自动将 /api 代理至 18301 并保留 Host/X-Forwarded-*）
cd frontend
npm run dev
```

打开浏览器访问 `http://localhost:18517`。

### 4. 使用 PM2 生产托管（推荐）

仓库根目录已内置 [ecosystem.config.cjs](ecosystem.config.cjs)，同时托管后端（单实例保证 18:01 定时调度与轮询不重复触发）与前端静态预览（已自动代理 `/api` 并透传 `Host` / `X-Forwarded-*` 确保 CAS 回调无误）：

```bash
# 1) 如未安装 PM2，全局安装一次
npm install -g pm2

# 2) 构建前后端产物
npm run build:all

# 3) 使用 PM2 启动服务
pm2 start ecosystem.config.cjs --env production

# 4) 常用管理命令
pm2 status                         # 查看运行状态
pm2 logs                           # 查看前后端实时日志（输出至 ./logs/）
pm2 restart ecosystem.config.cjs --update-env   # 修改 .env 后热重启
pm2 save && pm2 startup            # 设置开机自启（Linux 服务器）
```

### 5. 构建与测试

```bash
cd backend && npm run build && npm test
cd ../frontend && npm run build
```

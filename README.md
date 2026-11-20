# 查分网站（Render + Neon 部署版）

学生输入姓名 + 学号查自己的成绩，老师录入成绩。数据存 PostgreSQL（Neon），
网站跑在 Render 免费 Web Service 上，部署后得到一个 `xxx.onrender.com` 的动态网址，
老师录入和学生查分共用同一份数据库。

## 功能

- 首页两个独立入口卡：「学生查分」和「成绩录入」，各自是单独页面，可返回首页 / 顶部导航切换。
- 学生查分：输入姓名 + 学号，按考试列出各科分数、总分、全体排名和班级排名；查不到会提示。
- 成绩录入（老师）：逐条添加 / 修改 / 删除，科目可自由增减；可把 Excel 整表粘贴批量导入
  （第一行表头，前四列依次为 姓名、学号、班级、考试，后面各列为科目名）。
- 页面设置（在录入页底部）：学校名称、副标题、公告、首页介绍、查分入口名称、查分页说明、
  录入入口名称、页脚文字，保存后全站生效。
- 启动时自动建表（`score_records` 成绩表、`settings` 设置表），无需手动建库表。

## 本地运行（可选）

```bash
npm install
DATABASE_URL='postgres://USER:PASSWORD@HOST/DB?sslmode=require' npm start
# 打开 http://localhost:3000
```

不设 `DATABASE_URL` 也能启动看页面，但数据接口会提示未配置。

## 部署步骤

### 1. 在 Neon 建项目，拿连接串

1. 打开 https://neon.tech ，注册并登录（免费版即可，不用绑卡）。
2. 新建 Project（名字随意，如 `cha-fen`），得到一个 PostgreSQL 数据库。
3. 在项目 Dashboard 点 **Connection string**，复制连接串，形如：

   ```
   postgres://USER:PASSWORD@HOST.neon.tech/DBNAME?sslmode=require
   ```

   这是密码级别的机密，不要发到公开地方、不要写进代码仓库。部署时只填到 Render 的环境变量里。

### 2. 把本项目推到 Git 仓库

把本目录（含 `server.js`、`public/`、`package.json`、`render.yaml`）推到一个
GitHub / GitLab 仓库。注意 `.gitignore` 已忽略 `node_modules` 和 `.env`，不要把连接串提交上去。

### 3. 在 Render 从 Git 仓库新建 Web Service

1. 打开 https://render.com ，注册并登录。
2. **New → Web Service**，连接上一步的 Git 仓库。
   - 如果仓库里有本项目的 `render.yaml`，Render 会自动读到配置：
     免费套餐（free）、Build Command `npm install`、Start Command `npm start`。
   - 没有自动读取时手动填：Environment 选 **Node**，Plan 选 **Free**，
     Build Command 填 `npm install`，Start Command 填 `npm start`。
3. 在 **Environment Variables** 里添加：
   - Key：`DATABASE_URL`
   - Value：第 1 步复制的 Neon 连接串（占位示例：`postgres://USER:PASSWORD@HOST.neon.tech/DBNAME?sslmode=require`）
4. 点 **Create Web Service** 开始部署。首次部署完成后，启动日志出现建表成功即表示已连上 Neon。

### 4. 拿到网址

部署成功后，Render 服务页顶部就是网址，形如：

```
https://cha-fen-wang-zhan.onrender.com
```

把这个网址发给老师和学生即可：老师从首页进「成绩录入」，学生进「学生查分」。

## 注意（免费版限制）

- Render 免费服务闲置约 15 分钟会休眠，下一次打开要等 30–60 秒冷启动，属正常现象。
- Neon 免费数据库额度对查分这种小数据量足够；不要使用 Render 自带的免费 Postgres（会过期）。
- 修改页面文字不用重新部署：在录入页底部「页面设置」里改完保存即可。

## 部署到 Vercel（备选，与 Render 二选一）

本项目同时支持部署到 Vercel：`api/index.js` 是 Serverless Function 入口
（重新导出 `server.js` 的请求处理逻辑），`vercel.json` 把 `/api/*` 和其余请求
都转给它处理，页面和接口行为与 Render 版一致。数据库仍用 Neon，不用改代码。
Vercel Hobby 免费版不用绑卡，部署步骤如下：

1. 打开 https://vercel.com ，用 GitHub 登录（选 **Continue with GitHub**，
   就是存放本项目代码的那个 GitHub 账号）。
2. 在 Dashboard 点 **Add New → Project**，在 **Import Git Repository** 里选
   仓库 `hbnbn/cha-fen-wang-zhan`，点 **Import**。
   - Framework Preset 保持 **Other** 即可，不用改 Build / Output 设置，
     本项目靠仓库里的 `vercel.json` 工作。
3. 在 **Environment Variables** 里添加：
   - Name：`DATABASE_URL`
   - Value：在 Neon 项目 Dashboard 的 **Connection string** 里复制的连接串
     （占位示例：`postgres://USER:PASSWORD@HOST.neon.tech/DBNAME?sslmode=require`）
   - 这是密码级别的机密，只填到 Vercel 的环境变量里，不要写进代码仓库。
4. 点 **Deploy**，等部署完成。
5. 拿到网址：部署完成后项目页给出的网址形如

   ```
   https://cha-fen-wang-zhan.vercel.app
   ```

   把这个网址发给老师和学生即可（具体以你部署后 Vercel 显示的为准）。

注意：

- Vercel **Hobby 免费版仅限个人非商用**用途，学校/个人自用查分属于这个范围；
  如果以后要商用，需要升级到 Pro。
- Vercel 是无状态 Serverless：本项目已改成首次请求时才懒加载建表、连接池
  全局缓存短用，不依赖长驻进程，所以冷启动后第一次查分稍慢一点属正常现象。
- 已经部署在 Render 上的服务不受影响，两种部署方式可以共存、共用同一个
  Neon 数据库；不再需要其中一个时，在对应平台删掉那个项目/服务即可。

## 部署到腾讯云 CloudBase（国内访问）

为什么加这一套：`*.vercel.app` 默认域名在中国大陆网络基本打不开，Render 的
`onrender.com` 也在境外。腾讯云 CloudBase 云托管（Cloud Run，容器部署）跑在
国内节点，部署后给的默认域名（形如 `xxx.tcloudbaseapp.com` / 云托管服务默认
域名）在国内可直接访问、免备案（用平台默认域名时；以后要绑自己的域名再按
腾讯云要求走备案）。本仓库已备好容器部署需要的三个文件，代码逻辑不用改：

- `Dockerfile`：`node:18-alpine`，装生产依赖后 `node server.js` 启动。
- `.dockerignore`：构建镜像时排除 `node_modules`、`.git`、`.env` 等。
- `container.config.json`：云托管服务参考配置（服务名 `cha-fen-wang-zhan`、
  CPU 0.25 核 / 内存 0.5 GB 最小规格、最小实例数 0、端口 80），里面的
  `DATABASE_URL` 只是占位符，真实连接串只填在控制台环境变量里。

端口不用操心：云托管运行时会注入环境变量 `PORT=80`，`server.js` 读的是
`process.env.PORT`（未注入时才用默认 3000），所以容器里会自动监听 80。

### 数据库怎么选（重要，先看这里）

现在数据库里还没有正式成绩（之前上线的测试记录已删，库是空的），所以换
方案不涉及数据迁移，选哪套都是从空库开始。

**方案 A（先试，零改代码）：云托管容器继续连现有 Neon**

- 容器在国内、Neon 在境外（US East），这是**服务端出境连接**：学生的浏览器
  只和 CloudBase 的国内域名通信，不直连 Neon，所以页面在国内能正常打开。
- 代价是每次查分/录入都要跨境查一次 Postgres，延迟会比同区数据库高
  （一次查询多花几百毫秒量级，冷启动建连更明显），偶尔也可能受跨境网络
  波动影响出现连接超时。本项目的接口已设了 10 秒连接超时、失败可重试，
  小流量查分一般能接受。先按方案 A 部署，实测录一条、查一次，能用就不用折腾。
- 配置上唯一要做的就是把原来填在 Vercel 里的那条 Neon 连接串，填到云托管
  服务的环境变量 `DATABASE_URL` 里，代码一行不用动。

**方案 B（若方案 A 连不通或太慢）：把数据层换成 CloudBase 云数据库**

- CloudBase 云数据库是文档型（NoSQL 集合），不是 PostgreSQL，不能直接套用
  现在的 SQL。需要改的点都在 `server.js` 的数据层，页面和接口形状可以不变：
  1. 连接方式：去掉 `pg` 的 `Pool` / `DATABASE_URL`，改用 CloudBase 的
     Node SDK（`@cloudbase/node-sdk`）按环境 ID 初始化，或用其 MongoDB
     兼容连接；凭据走云托管内置身份/环境变量，不再有单独的连接串。
  2. 表改集合：`score_records`、`settings` 两张表改成两个集合，启动建表
     的 `initDb` 改成「集合不存在则创建 + settings 集合没有默认文档时写入」。
  3. 字段映射：成绩的 `subjects` 本来就是 JSONB 对象，文档里直接存嵌套
     对象即可；自增整数 `id` 改用文档 `_id`，前端/接口返回时把 `_id` 映射回
     `id`；时间戳改用云数据库的 serverDate 或普通字段。
  4. 查询改写：增删改查的 SQL 改成集合的 add / doc().update / remove /
     where().get()；排名本来就是在代码里拉同场考试的记录数出来的（不是靠
     SQL 窗口函数），换成拉同 `exam_name` 的文档在内存里数，逻辑不用变。
  5. 部署配置：`package.json` 的依赖从 `pg` 换成 CloudBase SDK；
     `container.config.json` 的环境变量占位符从 `DATABASE_URL` 换成
     CloudBase 环境 ID 等。改完后整站（页面 + 接口 + 数据）都在国内，
     不再有跨境连接。
- 另一个改动更小的备选：如果只是 Neon 跨境不行，又不想改代码，可以把
  Postgres 换成国内的 PostgreSQL（例如腾讯云自己的云数据库 PostgreSQL），
  那时仍是标准连接串，只改 `DATABASE_URL` 一个环境变量即可。

### 部署步骤

1. **注册腾讯云并实名认证**：打开 https://cloud.tencent.com ，用微信/QQ
   注册登录，按提示完成个人实名认证（国内云服务开通前必须做，只能本人做）。
2. **开通云开发 CloudBase 环境**：进入云开发 CloudBase 控制台
   （https://console.cloud.tencent.com/tcb），新建一个环境，套餐选
   免费/基础额度即可（查分这种小流量够用；超出免费额度的部分按量计费，
   开通时看清控制台提示）。记下环境 ID，部署时要用。
3. **在云托管里新建服务**：在该环境下进入 **云托管（Cloud Run）**，
   新建服务，服务名填 `cha-fen-wang-zhan`，选容器/代码部署：
   - 方式一（推荐）：关联 GitHub 仓库 `hbnbn/cha-fen-wang-zhan`，让平台按
     仓库根目录的 `Dockerfile` 构建镜像；
   - 方式二：把本目录打包成代码包上传，同样按 `Dockerfile` 构建。
   - 规格按 `container.config.json` 的参考值填：CPU 0.25 核、内存 0.5 GB、
     最小实例数 0（无访问时缩容省钱，代价是冷启动几秒到几十秒；想常开可
     改成 1，但会产生费用）、端口 80。
4. **填环境变量**：在服务的环境变量里加 `DATABASE_URL`，值按上面方案 A
   填现有 Neon 的连接串（占位示例：
   `postgres://USER:PASSWORD@HOST.neon.tech/DBNAME?sslmode=require`）。
   这是密码级别的机密，只填控制台，不要写进仓库。
5. **部署并拿网址**：点部署，等构建 + 启动完成，日志出现
   `cha-fen server listening` 和建表成功即表示已连上数据库。服务详情页会
   给出默认域名，形如：

   ```
   https://cha-fen-wang-zhan-xxxx.tcloudbaseapp.com
   ```

   （具体以控制台实际显示为准。）把这个网址发给老师和学生，国内网络可
   直接打开：老师进「成绩录入」，学生进「学生查分」。

注意：

- 已经部署在 Vercel 上的版本不受影响，可以和云托管版并存、共用同一个
  Neon 数据库（方案 A 时）；国内用户用 CloudBase 网址即可。
- 最小实例数 0 时，长时间没人访问后再打开第一次会慢一点（容器冷启动 +
  跨境连 Neon 建连），属正常现象。

## 部署到 EdgeOne Pages（国内访问）

这是目前面向国内用户的推荐部署方式：腾讯 EdgeOne 的节点在国内，部署后给的
默认域名 `xxx.edgeone.app` 在中国大陆网络可直接打开，不用再连 Neon、也不用
服务器。这一套的代码在本仓库的 `edgeone/` 子目录里，是一个自包含的
EdgeOne Pages / EdgeOne Makers 全栈项目，和根目录的 Render/Vercel 版互不
影响（前端页面是同一套，接口路径 `/api/*` 完全一致）：

```
edgeone/
├── public/                 静态前端（index / lookup / admin 三个页面 + common.js / styles.css）
├── edge-functions/
│   └── api/[[default]].js 边缘函数：一个函数处理全部 /api/* 请求
└── edgeone.json            导入时控制台填写值的备查记录（见下方说明）
```

与数据库版的区别先说清：

- 存储改用 **EdgeOne KV**，不再连 PostgreSQL。成绩全部存一个键
  `score_records`（JSON 数组），页面设置存一个键 `score_settings`（JSON）。
- KV 是最终一致的（官方文档说约 60 秒内全球同步），且整表读写不带锁：
  老师单人录入、学生查分这种小场景够用；多人同时录入可能互相覆盖，
  刚录完在个别地区节点上可能要等几十秒才能查到。数据量大了（成千上万条）
  就不适合这个存法，再考虑迁回数据库版。
- 好处是整站都在 EdgeOne 上：没有跨境数据库连接、没有冷启动的数据库建连，
  也不用再维护 Neon。

### 部署步骤

1. **登录 EdgeOne Pages / Makers**：打开 EdgeOne Pages 控制台
   （国际版 https://edgeone.ai 的 Pages，或腾讯云国内版 EdgeOne Makers
   https://pages.edgeone.ai ），选 **用 GitHub 登录**，用存放本仓库的
   GitHub 账号 `hbnbn` 授权登录。国内版如果提示要腾讯云账号/实名，按页面
   提示用本人账号完成即可。
2. **导入仓库**：新建项目 → **导入 Git 仓库**，选
   `hbnbn/cha-fen-wang-zhan`，填写值如下（备查记录也在
   `edgeone/edgeone.json` 里）：
   - 根目录（Root Directory）：`edgeone`
   - 框架预设（Framework Preset）：**Other**（其它/无框架）
   - 构建命令（Build Command）：**留空**（纯静态页面 + 边缘函数，不用构建）
   - 输出目录（Output Directory）：`public`
3. **创建并绑定 KV**（关键一步，漏了接口会报「SCORE_KV 未绑定」）：
   在控制台的 **KV 存储** 里先开通 KV、新建一个命名空间（如 `cha-fen-kv`），
   再回到本项目里把这个命名空间**绑定**到项目，绑定时填的**变量名必须是
   `SCORE_KV`**（大写，和函数代码里的名字一致，改了名函数就找不到存储）。
4. **部署**：保存后点部署，等构建完成。`edge-functions/api/[[default]].js`
   会自动按目录结构生成 `/api/*` 路由，静态页面从 `public/` 发布。
5. **拿到网址**：部署完成后项目页给出默认域名，形如：

   ```
   https://cha-fen-wang-zhan.edgeone.app
   ```

   （具体以控制台实际显示为准。）把这个网址发给老师和学生，国内网络可
   直接打开：老师进「成绩录入」，学生进「学生查分」。部署完先自己实测
   一遍：录一条测试成绩 → 查分能查到 → 再把测试记录删掉。

平台细节说明（写代码时核对过的与还没法确认的）：

- 边缘函数的目录和入口按 EdgeOne Makers 官方文档《Edge Functions》：
  `edge-functions/` 目录按结构生成路由，`[[default]].js` 捕获多级路径，
  入口是 `export default function onRequest(context)`。
- KV 的用法按官方《KV 存储》文档：绑定变量名会被注入为**全局变量**，
  示例就是 `my_kv.get('count')` / `await my_kv.put(key, value)` 这样直接用，
  不是从 `context.env` 里取；本项目据此用全局变量 `SCORE_KV`。
- 国际版 EdgeOne Pages（edgeone.ai）的函数目录叫 `functions/`、入口是
  命名导出 `export function onRequest(...)`，与 Makers 写法不同；如果改用
  国际版部署，需要把 `edge-functions/` 改名为 `functions/` 并改导出方式，
  其余逻辑可原样复用。
- `edgeone/edgeone.json` 只是导入填写值的备查记录，不保证平台会读取它；
  一切以控制台里实际填写的根目录、输出目录和 KV 绑定为准。

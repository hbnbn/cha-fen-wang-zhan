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

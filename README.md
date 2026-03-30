# 够级 - 六人联网对战

山东扑克够级的在线多人版本，6人实时对战。

## 快速开始

### 方法一：电脑运行（局域网玩）

确保电脑装了 Node.js（v16+），然后：

```bash
cd gouji-online
npm install
npm start
```

终端会显示：
```
🀄 够级服务器已启动！
   本机访问: http://localhost:3000
   局域网访问: http://192.168.x.x:3000
```

所有人连同一个WiFi，手机浏览器打开那个 **局域网地址** 即可。

### 方法二：部署到云端（不在同一WiFi也能玩）

#### Render（免费）
1. 代码上传到 GitHub
2. 去 render.com → New Web Service → 选你的仓库
3. Build Command: `npm install`
4. Start Command: `npm start`
5. 部署完成后拿到公网URL，分享给朋友

#### Railway（免费额度）
1. 去 railway.app → 连接 GitHub 仓库
2. 自动检测 Node.js 项目并部署
3. 拿到公网URL

## 玩法

1. 一人创建房间，得到4位房间号
2. 把房间号发给朋友
3. 朋友打开同一个网址，输入房间号加入
4. 6人到齐，房主点"开始游戏"

## 作弊功能（仅房主）

快速三击左上角 **"够级"** 标题 → 标题变红 = 已激活。
下一局发牌时房主会拿到 70-80% 的大牌（Q以上）。
发完牌自动复原，一次性的。

# 独立云部署

本机验收只需要 README 中的启动步骤。以下操作用于之后接通真实独立服务，建议先在隔离的测试数据上验证。

## 1. 准备项目资源

在专用 Cloudflare 项目创建 D1 和私有 R2 桶，并记录 D1 的 UUID。域名仓库已指定 `learn.hachile.org`，只为这一条主机名配置自定义域名。仓库里的零 UUID 仅供本机模拟器使用。

```powershell
npx wrangler d1 create learn-video-classroom
npx wrangler r2 bucket create learn-classroom-media
```

创建专用的百炼业务空间和密钥，确认该地域提供 `qwen-plus` 和 `cosyvoice-v3-flash`。默认 API 接入点使用北京 DashScope；使用业务空间专属接入点时，为 Worker 设置 `QWEN_BASE` 为含 `/compatible-mode/v1` 的完整基址，为渲染函数设置对应地域的 `COSYVOICE_WS`。

## 2. 渲染服务

在部署机将 `renderer/Dockerfile` 构建为 Linux AMD64 镜像，推送到函数计算可拉取的容器仓库。镜像内包含 FFmpeg、Pillow 和中文字体。示例配置见 [函数配置](../renderer/fc.example.yaml)。

```powershell
docker build --platform linux/amd64 -t $env:FC_IMAGE renderer
docker push $env:FC_IMAGE
s deploy -t renderer/fc.example.yaml
```

设置 `FC_REGION`、`FC_IMAGE` 和独立的 `DASHSCOPE_API_KEY`。函数名默认为 `learn-classroom-render`，超时 900 秒，单实例同时处理一个任务，异步任务模式开启，云端自动重试次数设为 0。通过 RAM 授权的 InvokeFunction API 派发，Worker 对超时的派发使用相同任务编号重试。函数只凭该任务专属的回调令牌领取分镜、上传 MP4 和确认完成。函数内只接受预先配置的 `CLASSROOM_ORIGIN` 为回调源。[函数计算异步任务](https://help.aliyun.com/zh/functioncompute/asynchronous-task) [CosyVoice 协议](https://help.aliyun.com/en/model-studio/cosyvoice-websocket-api)

## 3. Worker 配置

| 配置 | 用途 |
| --- | --- |
| `LEARN_D1_ID` | 部署机环境变量，用来生成临时 Wrangler 配置 |
| `AUTH_SECRET`、`INVITE_CODE`、`RENDER_SECRET` | 三个独立随机值，分别保护验证码、内测邀请和渲染任务 |
| `MAIL_API_KEY`、`MAIL_FROM` | 为专用发信域验证后的 Resend 密钥和发件地址 |
| `DASHSCOPE_API_KEY` | 千问服务端密钥 |
| `FC_ENDPOINT`、`FC_FUNCTION` | 函数计算 API 基址及函数名；基址形如 `https://<account>.<region>.fc.aliyuncs.com` |
| `FC_ACCESS_KEY_ID`、`FC_ACCESS_KEY_SECRET` | 仅授权调用本项目渲染函数的 RAM 凭据 |
| `ADMIN_EMAILS` | 管理员邮箱，多个以逗号分隔，仍需要验证邮箱 |
| `ALIPAY_APP_ID`、`ALIPAY_SELLER_ID` | 当前环境的应用及收款方标识 |
| `ALIPAY_PRIVATE_KEY`、`ALIPAY_PUBLIC_KEY` | PKCS#8 的应用 RSA 私钥、SPKI 格式的支付宝平台公钥 |
| `PAYMENT_MODE`、`ACCESS_MODE` | 默认沙箱、邀请制。配置生产收款后可显式设为 `live` 和 `public` |

在 Cloudflare 的专用 Worker 下配置秘密值，或用 `npx wrangler secret put <名称> --name learn-video-classroom` 交互输入。将 `MAIL_FROM`、`FC_ENDPOINT`、`FC_FUNCTION`、`ADMIN_EMAILS` 等非秘密参数放在部署终端环境中，部署脚本会将它们带入配置。GitHub 仓库只保存占位示例。

用测试资源验证 D1 迁移、邮箱到达、两种真实课程的配音及渲染回调。正式切入域名时，在 Cloudflare 处理 `learn` 原有 CNAME，再运行下列命令。脚本会应用远程 D1 迁移，并将 Worker 绑定到 `learn.hachile.org`。私有桶不开启公开访问，文件通过 Worker 的作者或公开状态检查后播放。

```powershell
$env:LEARN_D1_ID = '<本项目专用 D1 UUID>'
npm run deploy
```

## 4. 支付宝联调

先用专属沙箱应用的 RSA2 密钥配置网站支付。在桌面端验证电脑网站支付，在符合条件的手机浏览器验证手机网站支付。通知路径为 `https://learn.hachile.org/api/payments/notify`，返回页为 `/wallet`。服务端验证通知签名、应用、收款方、订单金额与交易状态，重复通知仅产生一笔积分流水。通知迟到时，登录用户可以从钱包发起查单，服务端验证支付宝签名后的查询结果。[支付宝官方 SDK](https://github.com/alipay/alipay-easysdk)

分别测试支付成功、取消、重复通知、查单以及测试余额隔离。商户签约成功并配置正式应用的密钥、收款方和对应权限后，再切换生产环境。保留 50 元内测成本上限，后续运营预算由项目负责人单独调整。

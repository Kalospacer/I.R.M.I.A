#!/bin/bash
# IRMIA systemd 服务重装脚本（VM 更换后用）
# 用法：先 export IRMIA_API_KEY / QQ_BOT_APP_ID / QQ_BOT_CLIENT_SECRET，再 sudo 运行本脚本
set -euo pipefail
export PATH="/opt/hatch-image/bin:$PATH"

if [[ $EUID -ne 0 ]]; then echo "请用 root 运行（sudo）"; exit 1; fi
for v in IRMIA_API_KEY QQ_BOT_APP_ID QQ_BOT_CLIENT_SECRET; do
  if [[ -z "${!v:-}" ]]; then echo "缺少环境变量 $v"; exit 1; fi
done

cd /home/hatch/workspace/irmia

# 1. 确保补丁代码已编译
npm run build

# 2. 从干净备份生成带密钥的 service 文件（密钥必须插进 [Service] 段，不能追加到文件尾）
cp irmia.service /etc/systemd/system/irmia.service
python3 - "$IRMIA_API_KEY" "$QQ_BOT_APP_ID" "$QQ_BOT_CLIENT_SECRET" << 'PYEOF'
import sys
key, appid, secret = sys.argv[1], sys.argv[2], sys.argv[3]
p = '/etc/systemd/system/irmia.service'
s = open(p).read()
inject = (
    f"Environment=IRMIA_API_KEY={key}\n"
    f"Environment=QQ_BOT_APP_ID={appid}\n"
    f"Environment=QQ_BOT_CLIENT_SECRET={secret}\n"
)
assert '\n[Install]' in s, "service 模板里找不到 [Install] 段"
s = s.replace('\n[Install]', '\n' + inject + '[Install]', 1)
open(p, 'w').write(s)
print("密钥已注入 [Service] 段")
PYEOF

# 3. 生效并启动（restart 确保已在跑的老进程也被换掉）
systemctl daemon-reload
systemctl enable irmia
systemctl restart irmia
sleep 8
systemctl is-active irmia
echo "重装完成"

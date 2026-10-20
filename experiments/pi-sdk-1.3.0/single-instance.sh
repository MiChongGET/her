#!/bin/bash
set -u
APP=/Users/michong/work/her
BIN="$APP/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
D=$(mktemp -d)
snap() { (cd "$D/Her-Pi-v1" 2>/dev/null && find . -type f -exec stat -f '%N %z %m' {} + | sort); }

HER_DATA_DIR="$D" "$BIN" "$APP" >"$D/first.log" 2>&1 &
FIRST=$!
for i in $(seq 1 40); do [ -f "$D/Her-Pi-v1/her.sqlite" ] && break; sleep 0.5; done
echo "第一个实例 pid=$FIRST 在运行: $(kill -0 $FIRST 2>/dev/null && echo 是 || echo 否)"
echo "her.sqlite 已创建: $([ -f "$D/Her-Pi-v1/her.sqlite" ] && echo 是 || echo 否)"
sleep 2
snap >"$D/before.txt"
echo "第一个实例下 Her-Pi-v1 文件数: $(wc -l <"$D/before.txt" | tr -d ' ')"

START=$(date +%s)
HER_DATA_DIR="$D" timeout 40 "$BIN" "$APP" >"$D/second.log" 2>&1
CODE=$?
echo "第二个实例退出码=$CODE 用时=$(( $(date +%s) - START ))s (124 表示被 40 秒超时杀掉)"
sleep 1
snap >"$D/after.txt"
echo "--- 第二个实例前后 Her-Pi-v1 的差异(排除第一个实例自己的正常写入需要看下面的对照)"
diff "$D/before.txt" "$D/after.txt" && echo "(无差异)"
echo "第一个实例仍在运行: $(kill -0 $FIRST 2>/dev/null && echo 是 || echo 否)"

kill $FIRST 2>/dev/null; sleep 3; kill -9 $FIRST 2>/dev/null
echo "清理后真实 Electron 进程数: $(pgrep -f 'Electron.app/Contents/MacOS/Electron' | wc -l | tr -d ' ')"
echo "日志目录: $D"

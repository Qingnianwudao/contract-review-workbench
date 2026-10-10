@echo off
setlocal
cd /d "%~dp0"
set "NODE_EXE=node"
set "PORT=3000"
echo 正在启动合同审查工作台，请保持本窗口开启。
echo 服务地址：http://127.0.0.1:3000
echo 将会打开系统默认浏览器；服务窗口关闭后网站会停止。
start "合同审查工作台服务" "%NODE_EXE%" "%~dp0server.mjs"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:3000"

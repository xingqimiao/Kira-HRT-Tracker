@echo off
cd /d E:\HRT\server
node --experimental-transform-types --import ./resolve-hook.mjs --test test/*.test.ts > E:\HRT\server\t.out 2> E:\HRT\server\t.err
echo code=%ERRORLEVEL% > E:\HRT\server\t.exit

<#
一次跑完发布流程。

为什么必须重新登录：npm 的 token 在这台机器上有效期很短（几小时），过期后
publish 不会报 401，而是报 E404「package could not be found or you do not
have permission」——npm 用 404 掩盖权限失败，非常容易误判成包名或版本问题。
所以登录放在流程里，而不是靠记性。

用法（在仓库根目录）：
    .\scripts\publish.ps1
#>

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

# 从 package.json 直接读版本：ConvertFrom-Json 在 PowerShell 5.1 里会把中文
# description 读坏，正则反而稳。
$version = (Select-String -Path package.json -Pattern '"version":\s*"([^"]+)"').Matches[0].Groups[1].Value
Write-Host "准备发布 @zmairc/persona-forge@$version" -ForegroundColor Cyan

$dirty = git status --porcelain
if ($dirty) {
    Write-Host "工作树不干净，先提交或 stash：" -ForegroundColor Red
    $dirty | ForEach-Object { Write-Host "  $_" }
    exit 1
}

Write-Host "`n[1/4] git push" -ForegroundColor Cyan
git push

Write-Host "`n[2/4] npm login（token 每次都会失效，必须重新登录）" -ForegroundColor Yellow
Write-Host "      浏览器会打开，登录完按提示回来" -ForegroundColor DarkGray
npm login --registry=https://registry.npmjs.org/

Write-Host "`n[3/4] npm publish" -ForegroundColor Cyan
npm publish

Write-Host "`n[4/4] 确认 registry 上的版本" -ForegroundColor Cyan
Start-Sleep -Seconds 5
npm view @zmairc/persona-forge version

Write-Host "`n如果上面显示的不是 $version，等两分钟再查（CDN 有延迟）：" -ForegroundColor Yellow
Write-Host "  npm view @zmairc/persona-forge version"
Write-Host "`n确认之后装进 DSH：" -ForegroundColor Cyan
Write-Host "  dsh plugin --profile web add @zmairc/persona-forge@$version"
Write-Host "  （不能用 update，它升不上去——add 写的是精确版本）"

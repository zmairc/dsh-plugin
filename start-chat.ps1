# persona-forge 启动器：从用户环境变量载入 key、进入项目目录、打印命令
# 不在此文件里写 key，避免随仓库泄露
if (-not $env:PERSONAFORGE_API_KEY) {
    $env:PERSONAFORGE_API_KEY = [Environment]::GetEnvironmentVariable('PERSONAFORGE_API_KEY', 'User')
}
Set-Location -Path $PSScriptRoot
Clear-Host
Write-Host ''
if ($env:PERSONAFORGE_API_KEY) {
    Write-Host '  persona-forge 已就位，API key 已载入当前会话。' -ForegroundColor Green
} else {
    Write-Host '  没有找到 API key。先在当前窗口设置：' -ForegroundColor Red
    Write-Host '    $env:PERSONAFORGE_API_KEY = "sk-..."' -ForegroundColor Yellow
}
Write-Host ''
Write-Host '  第 1 步  自检 key' -ForegroundColor Cyan
Write-Host '    node scripts/check-api.ts' -ForegroundColor Yellow
Write-Host ''
Write-Host '  第 2 步  开始对话' -ForegroundColor Cyan
Write-Host '    node src/cli/index.ts chat --persona dennis' -ForegroundColor Yellow
Write-Host '    node src/cli/index.ts chat --persona zhaoming' -ForegroundColor Yellow
Write-Host ''
Write-Host '  对话中 /actions 动作表情  /reset 清空  /exit 退出' -ForegroundColor DarkGray
Write-Host ''

$body = @{
    model = "qwen3.7-plus"
    messages = @(
        @{ role = "user"; content = "Say OK" }
    )
} | ConvertTo-Json

Invoke-RestMethod -Uri "https://ai.chinatowercom.cn:30080/v1/chat/completions" `
    -Method Post `
    -Headers @{
        "Authorization" = "Bearer YOUR_API_KEY"
        "Content-Type" = "application/json"
    } `
    -Body $body `
    -SkipCertificateCheck

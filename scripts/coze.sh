
#!/bin/bash

curl -X POST 'https://api.coze.cn/v1/workflow/stream_run' \
-H "Authorization: Bearer sat_BlpLEcVFobjUyzcMosXzOxhvSSzPc0tdRqYttJIAOJVMaaOmmkHhwmKFyjdyp7Vq" \
-H "Content-Type: application/json" \
-d '{
  "workflow_id": "7591776708463509542",
  "app_id": "7475677244766044187",
  "parameters": {
    "input": "Boss直聘 杭州 前端开发 应届生 React JavaScript"
  }
}'


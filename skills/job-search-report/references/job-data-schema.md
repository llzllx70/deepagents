# 岗位数据字段规范

用于 `analysis/jobs_data.json` 或 `analysis/jobs_data.csv`。

## JSON 格式

`analysis/jobs_data.json` 为数组，每个元素为岗位对象：

```json
[
  {
    "company": "阿里云",
    "title": "Web前端实习",
    "platform": "Boss直聘",
    "salary_min": 6000,
    "salary_max": 12000,
    "experience": "实习",
    "education": "本科",
    "location": "杭州·西湖区",
    "url": "https://...",
    "skills": ["JavaScript", "React", "HTML/CSS"],
    "match_score": 88,
    "notes": "26届/4天/周"
  }
]
```

## CSV 格式

`analysis/jobs_data.csv` 首行为表头，字段：

```
company,title,platform,salary_min,salary_max,experience,education,location,url,skills,match_score,notes
```

- `skills` 使用 `;` 分隔
- `salary_min` / `salary_max` 使用月薪数字（元）
- `match_score` 为 0-100 的整数

## 必填字段

- `company`
- `title`
- `platform`
- `salary_min`
- `salary_max`
- `experience`
- `education`
- `match_score`

其他字段可选，但尽量补齐 `location` 与 `url`。

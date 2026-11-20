# LLM 모델 대시보드

주요 LLM 제공사(OpenAI, Anthropic, Google, Meta, xAI, DeepSeek, Mistral, Qwen)의 **최신 모델 · 토큰 가격 · 컨텍스트 길이 · 벤치마크**를 보여주는 정적 웹사이트입니다.

- **운영 비용 0원**: GitHub Pages(무료 호스팅) + GitHub Actions(무료 자동 갱신) + 키가 필요 없는 공개 API
- **빌드 과정 없음**: `index.html` + CSS + 순수 JavaScript, 차트만 CDN의 Chart.js 사용
- **자동 갱신**: 매주 월요일 09:00(KST)에 OpenRouter 공개 모델 API에서 데이터를 받아 `data/models.json` 갱신

## 폴더 구조

```
index.html                     # 페이지 (main 브랜치 루트에서 배포)
assets/css/style.css           # 스타일 (다크/라이트, 반응형)
assets/js/app.js               # 화면 로직 (정렬·필터·검색·차트)
data/models.json               # 자동 수집 데이터 (직접 수정하지 마세요)
data/meta.json                 # 마지막 갱신 시각(KST)·출처 (자동 생성)
data/benchmarks.json           # 직접 관리하는 벤치마크·설명
scripts/fetch-models.mjs       # 수집 스크립트 (Node.js, 외부 패키지 없음)
scripts/fixtures/              # 오프라인 테스트용 샘플 API 응답
.github/workflows/update-data.yml  # 주간 자동 갱신 워크플로
```

> ℹ️ 처음 저장소에 들어 있는 `data/models.json`은 **화면 확인용 샘플**입니다(화면 상단에 안내 배너가 보입니다).
> 아래 (3)의 방법으로 워크플로를 한 번 실행하면 실제 데이터로 바뀌고 배너도 사라집니다.

---

## (1) GitHub Pages 켜는 방법

1. 이 저장소의 **Settings → Pages** 로 이동합니다.
2. **Build and deployment → Source** 를 **Deploy from a branch** 로 선택합니다.
3. **Branch** 를 `main`, 폴더를 `/ (root)` 로 선택하고 **Save** 를 누릅니다.
4. 1~2분 뒤 같은 화면 상단에 사이트 주소(`https://<사용자명>.github.io/<저장소명>/`)가 표시됩니다.

> 저장소 루트의 `.nojekyll` 파일은 GitHub Pages가 Jekyll 변환 없이 파일을 그대로 배포하도록 하는 설정이니 지우지 마세요.
> 비공개(private) 저장소에서 Pages를 쓰려면 유료 플랜이 필요하므로, 무료로 쓰려면 저장소를 **공개(public)** 로 두세요.

## (2) Actions 쓰기 권한 설정 방법

워크플로가 갱신된 데이터를 `main`에 커밋/푸시하려면 쓰기 권한이 필요합니다.

1. **Settings → Actions → General** 로 이동합니다.
2. **Actions permissions** 가 **Allow all actions and reusable workflows** (또는 GitHub 공식 액션 허용)인지 확인합니다.
3. 아래쪽 **Workflow permissions** 에서 **Read and write permissions** 를 선택하고 **Save** 를 누릅니다.

> 워크플로 파일에도 `permissions: contents: write` 가 선언되어 있지만, 저장소/조직 설정이 "Read" 로 제한되어 있으면 푸시가 거부됩니다.
> `main` 브랜치에 보호 규칙(Branch protection)을 걸어 직접 푸시를 막았다면 `github-actions[bot]` 을 예외로 허용해야 합니다.

## (3) 수동으로 갱신 실행하는 방법

1. 저장소의 **Actions** 탭 → 왼쪽 목록에서 **모델 데이터 자동 갱신** 을 선택합니다.
2. 오른쪽의 **Run workflow** → 브랜치 `main` → **Run workflow** 를 누릅니다.
3. 1분 정도 뒤 실행 결과를 확인합니다.
   - ✅ 성공 + 데이터 변경 있음 → `chore(data): 모델 데이터 자동 갱신 …` 커밋이 생기고, 워크플로가 Pages 재빌드를 요청해 1~2분 뒤 사이트에 반영됩니다.
     (Actions의 기본 토큰으로 푸시한 커밋은 Pages 빌드를 자동으로 트리거하지 않기 때문에, 워크플로 마지막 단계에서 Pages 빌드 API를 직접 호출합니다.)
   - ✅ 성공 + 변경 없음 → 커밋하지 않습니다(로그에 "데이터 변경 없음").
   - ❌ 실패 → 기존 데이터는 그대로 유지됩니다. 로그의 `::error::` 메시지를 확인하세요.

자동 실행 일정은 **매주 월요일 00:00 UTC = 월요일 09:00 KST** 입니다 (`cron: '0 0 * * 1'`). GitHub 사정에 따라 수십 분 늦게 시작될 수 있습니다.
또한 GitHub는 **60일 동안 저장소 활동이 없으면 예약 실행을 자동으로 중지**하므로, 그런 경우 Actions 탭에서 워크플로를 다시 활성화하세요.

### 안전장치

수집 스크립트(`scripts/fetch-models.mjs`)는 아래 상황에서 **파일을 쓰지 않고 실패(exit 1)** 합니다.

| 조건 | 기준 (환경 변수로 조정 가능) |
|---|---|
| API 요청 실패 (3회 재시도 후) | – |
| 응답에 `data` 배열이 없음 / 전체 모델 50개 미만 | – |
| 대상 제공사 모델 수가 너무 적음 | `MIN_MODELS` (기본 30) |
| 이전 대비 모델 수 급감 | `MAX_DROP_RATIO` (기본 0.3 = 30% 초과 감소) |
| 제공사 수가 너무 적음 | `MIN_PROVIDERS` (기본 5) |
| 가격 정보가 이상한 모델 비율 20% 초과 | – |

파일은 임시 파일에 쓴 뒤 교체(atomic write)하므로 중간에 깨진 JSON이 남지 않습니다.

### 데이터 출처와 수집 방식

- 출처: [OpenRouter Models API](https://openrouter.ai/docs/api-reference/models/get-models) — `GET https://openrouter.ai/api/v1/models` (API 키 불필요)
- OpenRouter의 가격은 토큰당 USD 문자열이므로 **× 1,000,000** 하여 `USD / 1M tokens` 로 변환합니다.
- 모델 id 접두사로 제공사를 구분합니다: `openai/`, `anthropic/`, `google/`, `meta-llama/`, `x-ai/`, `deepseek/`, `mistralai/`, `qwen/`·`alibaba/`
- `:free` 무료 변형은 별도 행으로 넣지 않고 원래 모델에 "무료 버전" 표시만 합니다.
- 가격이 음수(변동 가격 라우터 등)인 항목은 제외합니다.
- OpenRouter 경유 가격은 제공사 공식 가격과 다를 수 있습니다. 화면 하단에도 안내가 있습니다.

## (4) benchmarks.json 수정 방법

`data/benchmarks.json` 은 자동 수집이 어려운 정보를 **직접 관리**하는 파일입니다. GitHub 웹에서 파일을 열고 연필(✏️) 아이콘으로 수정한 뒤 커밋하면 바로 반영됩니다.

```jsonc
{
  "updatedAt": "2026-11-20",            // 이 파일을 마지막으로 고친 날짜
  "benchmarks": [                        // 표의 점수 열 정의
    { "key": "gpqa", "name": "GPQA Diamond", "description": "대학원 수준 과학 문제 (정답률 %)", "unit": "%", "url": "https://arxiv.org/abs/2311.12022" }
  ],
  "entries": [                           // 모델별 행
    {
      "modelId": "openai/gpt-5",         // models.json의 id와 같으면 가격도 함께 표시됨
      "modelName": "GPT-5",
      "provider": "OpenAI",
      "summary": "한 줄 설명",
      "scores": { "gpqa": null },        // 확인된 숫자만 입력, 모르면 null
      "sourceUrl": "https://…",          // 점수를 확인한 출처 (필수)
      "asOf": "2026-11-20",              // 출처 기준 날짜 (YYYY-MM-DD)
      "note": ""                         // 비고 (선택)
    }
  ]
}
```

- **점수 입력**: `"gpqa": null` → 확인한 숫자로 바꿉니다(따옴표 없이 숫자, `%` 기호 없이). 화면에는 `unit` 이 붙어 표시됩니다.
- **확실하지 않은 수치는 넣지 말고 `null`** 로 두세요. 화면에는 `–` 로 표시됩니다. 초기 파일의 점수는 모두 비워 두었습니다.
- **새 벤치마크 열 추가**: `benchmarks` 배열에 항목을 추가하고, 각 entry의 `scores` 에 같은 `key` 로 값을 넣습니다.
- **새 모델 추가**: `entries` 배열에 객체를 하나 더 추가합니다. 앞 항목 뒤에 쉼표(`,`)를 빠뜨리지 않도록 주의하세요.
- 한 모델의 점수들이 서로 다른 출처에서 왔다면, 행을 나누거나 `note` 에 출처를 적어 주세요.
- 실제 파일은 표준 JSON이므로 위 예시의 `// 주석` 은 넣으면 안 됩니다. 수정 후 JSON 문법이 깨지면 벤치마크 표가 비어 보이니, 커밋 전 [JSON 검사기](https://jsonlint.com/) 등으로 확인하면 안전합니다. 자동 갱신 워크플로도 실행 시 이 파일의 JSON 형식을 검사해 오류가 있으면 경고를 표시합니다.

---

## 로컬에서 실행해 보기

브라우저 보안 정책상 `index.html` 을 더블클릭(file://)으로 열면 JSON을 읽지 못합니다. 간단한 웹 서버로 여세요.

```bash
python3 -m http.server 8000
```

그다음 브라우저에서 `http://localhost:8000` 을 엽니다.

수집 스크립트 테스트 (Node.js 20 이상):

```bash
node scripts/fetch-models.mjs --dry-run
```

```bash
node scripts/fetch-models.mjs --input scripts/fixtures/openrouter-sample.json --dry-run
```

- 첫 번째는 실제 API를 호출하되 파일은 쓰지 않고, 두 번째는 네트워크 없이 샘플 응답으로 테스트합니다.
- `--dry-run` 을 빼면 `data/models.json`, `data/meta.json` 을 실제로 갱신합니다.

## 화면 구성

1. **상단**: 제목, 마지막 갱신 시각(KST), 데이터 출처, 다크/라이트 토글(기본은 시스템 설정)
2. **최신 모델**: 최근 등록된 모델 카드 8개 (30일 이내는 NEW 표시)
3. **가격 비교표**: 제공사·모델명·입력가·출력가·컨텍스트·등록일, 열 정렬 / 제공사 필터 / 모델명 검색. 모바일에서는 카드형으로 전환
4. **차트**: 제공사별 최신 모델의 입력/출력 가격 가로 막대그래프 (모델 수·정렬·로그 스케일 선택)
5. **벤치마크**: `benchmarks.json` 내용 표 + 출처 링크
6. **하단**: 데이터 출처와 "정보는 참고용이며 공식 문서를 확인하세요" 안내

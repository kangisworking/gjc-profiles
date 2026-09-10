# GJC 여덟 프로필 스냅샷

- 스냅샷 날짜: **2026-09-10 (Asia/Seoul)**
- 원본 위치: `%USERPROFILE%\.gjc\agent\models.yml`
- GJC 버전/카탈로그 근거: **GJC 0.16.6 catalog**
- 이 문서와 스냅샷에 대해 **실제 라이브 API 호출은 테스트하지 않았다**.

`models.yml`은 원본의 프로필 여덟 개를 그대로 보관한 복사본이다. 같은 폴더의
`default-profile.yml`은 `modelProfile.default daily`를 기록한 참고 파일이다. 기본값
파일을 전체 `config.yml`로 덮어쓰는 방식은 사용하지 않는다.

## 모델 약어

역할 표는 셀을 짧게 표시하기 위해 다음 약어를 사용한다. 셀의 `:medium`,
`:high`, `:xhigh`는 해당 모델의 thinking level이며, 약어와 level을 합치면
원본 `model_mapping` 값이 된다.

| 약어 | 정확한 모델 ID |
| --- | --- |
| O5 | `anthropic/claude-opus-5` |
| F5.1 | `anthropic/claude-fable-5-1` |
| S5 | `anthropic/claude-sonnet-5` |
| LUNA | `openai-codex/gpt-5.6-luna` |
| TERRA | `openai-codex/gpt-5.6-terra` |
| SOL | `openai-codex/gpt-5.6-sol` |
| ASTRA | `openai-codex/gpt-6-astra` |

## 역할 매핑 (원본과 동일한 여덟 행)

모든 프로필은 `anthropic` 및 `openai-codex` provider를 요구한다.

| 프로필 | default | executor | planner | architect | critic | 토큰 사용 안내(질적) |
| --- | --- | --- | --- | --- | --- | --- |
| `daily` | O5:medium | LUNA:high | SOL:high | O5:high | SOL:high | 일상 작업의 균형형 조합이다. high가 사용량의 고정 배수가 되지는 않으며, 실제 호출된 역할과 반복 횟수에 좌우된다. |
| `coding-sprint` | O5:medium | F5.1:high | SOL:high | O5:high | ASTRA:high | 구현과 검토를 나눠 쓴다. 필요한 역할만 호출되고, 큰 컨텍스트·도구 출력·재시도가 있을 때 총량이 늘어난다. |
| `cyber-cop` | ASTRA:medium | TERRA:high | O5:high | F5.1:xhigh | ASTRA:xhigh | 보안 검토용 조합이다. xhigh는 reasoning budget을 더 쓰려는 경향일 뿐 고정 배수나 사용량 보장이 아니다. |
| `ultimate-opus` | O5:high | O5:high | ASTRA:xhigh | F5.1:xhigh | ASTRA:xhigh | Opus 중심의 고강도 검토 조합이다. 선택된 다섯 역할의 컨텍스트가 매 요청에 모두 추가되는 것은 아니다. |
| `llm-council` | ASTRA:medium | TERRA:high | SOL:xhigh | O5:high | F5.1:xhigh | 역할 배정만 정의하며 자동 voting이나 제3 provider 독립성은 만들지 않는다. 호출된 역할·반복·도구 출력만 실제 총량에 반영된다. |
| `escalation` | F5.1:high | ASTRA:xhigh | ASTRA:xhigh | O5:xhigh | F5.1:xhigh | 수동 escalation용이다(ASTRA 구현, Fable 검토). 자동 retry 정책은 없으며 xhigh도 고정 토큰 배수가 아니다. |
| `monorepo` | O5:medium | O5:high | O5:high | F5.1:high | ASTRA:high | Claude가 넓은 맥락을 맡고 Astra critic에는 검토 범위를 제한해 전달한다. Astra critic의 카탈로그 컨텍스트 표시는 272K이다. |
| `budget` | LUNA:medium | LUNA:high | LUNA:high | S5:high | S5:high | 비용·쿼터를 의식한 조합이지만 실제 비용이나 한도를 보장하지 않는다. 계정 요금제와 실제 입력·출력·재시도가 총량을 결정한다. |

### 프로필별 사용처

- **daily**: 일반적인 일상 작업의 기본 프로필.
- **coding-sprint**: Fable이 구현하고 Opus가 설계, Astra가 비평하는 작업.
- **cyber-cop**: 보안 점검처럼 ASTRA와 고강도 검토가 필요한 작업.
- **ultimate-opus**: 본체와 구현은 Opus, 설계는 Fable, 계획·비평은 Astra에 맡기는 작업.
- **llm-council**: 여러 역할에 모델을 배정하되 별도 투표 워크플로는 사용하지 않는 작업.
- **escalation**: 필요할 때 수동으로 고강도 구현·검토로 올리는 작업.
- **monorepo**: 큰 저장소의 넓은 맥락은 Claude로 처리하고 Astra 검토 입력은 제한하는 작업.
- **budget**: 프리미엄 모델을 기본 경로에서 줄이고 Luna/Sonnet을 사용하는 작업.

## 모델 토큰 용량

다음은 스냅샷 시점 GJC 0.16.6 catalog에 **표시된** 모델별 한도다.

| 약어 | 정확한 모델 ID | 표시 컨텍스트 상한 | 표시 최대 출력 |
| --- | --- | ---: | ---: |
| O5 | `anthropic/claude-opus-5` | 1M | 128K |
| F5.1 | `anthropic/claude-fable-5-1` | 1M | 128K |
| S5 | `anthropic/claude-sonnet-5` | 1M | 128K |
| LUNA | `openai-codex/gpt-5.6-luna` | 372K | 128K |
| TERRA | `openai-codex/gpt-5.6-terra` | 372K | 128K |
| SOL | `openai-codex/gpt-5.6-sol` | 372K | 128K |
| ASTRA | `openai-codex/gpt-6-astra` | 272K | 128K |

이 값은 카탈로그가 보여 주는 상한이지 실제 사용량·과금·성능 측정값이 아니다.
입력 상한과 출력 상한을 동시에 끝까지 사용할 수 있다는 보장도 아니며, 실제
provider 계정 제한과 요청 조건이 우선한다. 모델이 크거나 상한이 높다고 해서
더 많은 토큰을 쓴다고 단정할 수 없다.

### 토큰 사용을 해석하는 법

- `medium`/`high`/`xhigh`는 reasoning budget을 배정하려는 **경향**을 조절할 뿐,
  고정 배수·고정 토큰 수가 아니다.
- 역할은 필요할 때만 호출된다. 다섯 역할을 설정했다고 모든 역할의 컨텍스트가
  매 요청에 추가되는 것은 아니다.
- 반복해서 포함되는 대화 컨텍스트, 도구 출력, 재시도는 누적 사용량을 늘릴 수
  있다. 프로필 이름이나 모델 상한만으로 작업별 토큰 수를 계산하지 않는다.
- 실제 수치를 모으려면 provider의 사용량/청구 화면 또는 이미 보유한 요청 로그·
  telemetry에서 요청별 입력·출력·reasoning(및 제공되는 cache) 토큰, 재시도 횟수,
  프로필·역할·모델·시각을 함께 기록한다. 그런 계측이 없으면 정확한 작업별
  소비량은 알 수 없다.

## 복원 PowerShell

아래 순서로 **라이브 `models.yml`을 먼저 백업**한 뒤 저장된 복사본을 넣고,
기본 프로필을 `daily`로 지정한다.

```powershell
$live = Join-Path $HOME '.gjc\agent\models.yml'
$saved = 'D:\work\gjc-profiles\models.yml'
$backup = "$live.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"

Copy-Item -LiteralPath $live -Destination $backup -ErrorAction Stop
Copy-Item -LiteralPath $saved -Destination $live -Force -ErrorAction Stop
gjc config set modelProfile.default daily
```

`default-profile.yml`을 `config.yml`로 복사하거나 전체 `config.yml`을 덮어쓰지
않는다. 기존 COMBOS 프리셋은 이 스냅샷에 포함하지 않았고 변경하지 않았다.
현재 세션이 실제로 사용하는 프로필은 이미 시작된 세션의 상태에 따라
`daily`와 다를 수 있다. upstream installer를 다시 실행하면 로컬 프로필이
덮어써질 수 있으므로, 필요하면 이 스냅샷을 다시 복원한다.

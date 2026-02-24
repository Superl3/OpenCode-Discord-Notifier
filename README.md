# OpenCode 알림 전송기

OpenCode 출력 로그를 감시해서,

1. 빌드/작업 완료 신호가 나오고
2. 이어서 사용자 입력 대기 신호가 나오면

디스코드 봇으로 알림을 보내는 래퍼입니다.

브라우저 UI도 함께 제공해서, 설정 파일을 손으로 편집하지 않고
로드/수정/저장/드라이런 테스트를 한 번에 처리할 수 있습니다.

## 지원 기능

- 특정 유저 DM 전송 (`targets[].type = "user"`)
- 특정 채널 전송 (`targets[].type = "channel"`)
- 마지막 메시지 전달 모드
  - `raw`: 원문 최대한 유지
  - `cleaned`: ANSI/잡음 정리
  - `summary`: 휴리스틱 요약
- 메타데이터 포함 여부 (`includeMetadata`)
- 원문 추가 첨부 (`includeRawInCodeBlock`)
- 감지 패턴/쿨다운/윈도우 모두 설정 가능
- 알림 제목을 `message.title | 작업공간 - 대화 제목` 형태로 자동 구성
- 취소/중단 이벤트가 발생하면 마지막 메시지 대신 상태 알림 전송

## 설치

### 자동 설치 (권장)

아래 스크립트 한 번이면 다음을 자동으로 진행합니다.

- node/npm 존재 확인 (없으면 설치 시도)
- `npm install`
- `npm run plugin:install` (OpenCode `plugin` 배열에 repo 플러그인 등록)

Windows (PowerShell):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap-opencode.ps1
```

macOS/Linux:

```bash
bash ./scripts/bootstrap-opencode.sh
```

Discord 토큰/채널까지 바로 설정하려면 setup까지 같이 실행하세요.

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap-opencode.ps1 -RunSetup
```

macOS/Linux:

```bash
bash ./scripts/bootstrap-opencode.sh --run-setup
```

```bash
git clone https://github.com/Superl3/OpenCode-Discord-Notifier.git
cd OpenCode-Discord-Notifier
npm install
npm run setup
```

이미 저장소에 들어와 있다면 아래처럼 바로 설정만 실행해도 됩니다.

```bash
npm install
npm run setup
```

`npm install`을 처음 실행할 때도 postinstall 훅이 초기 설정 여부를 물어보도록 되어 있습니다.
건너뛰었거나 나중에 다시 설정하려면 `npm run setup`을 실행하면 됩니다.

`npm run setup`은 인터랙티브 모드로 아래를 순서대로 물어봅니다.

- 디스코드 봇 토큰
- (기존 설정에 토큰이 있으면) 기존 토큰 재사용 여부
- 채널 ID 또는 DM 유저 ID
- (선택) 멘션 유저 ID
- 현재 실행 환경 레이블 (예: `집-PC`, `회사-노트북`, `WSL-main`)
- 플러그인 모드/CLI 모드 선택

직접 파일을 편집하고 싶으면 기존 방식도 가능합니다.

```bash
cp opencode-notifier.config.example.json opencode-notifier.config.json
```

`opencode-notifier.config.json`에서 디스코드 토큰/ID와 패턴을 수정하세요.

기본 파일(`opencode-notifier.config.json`)은 채널 전송 프리셋으로 준비되어 있습니다.
실제로는 아래 2개만 바꾸면 바로 동작합니다.

- `discord.botToken`
- `discord.targets[0].id` (내 Discord 채널 ID)

## 핵심 개념 정리

### 1) `discord.botToken`은 무엇인가요?

- `discord.botToken`은 Discord 개발자 포털의 **Bot** 페이지에서 발급받는 봇 토큰입니다.
- OAuth `Client Secret`과는 다릅니다. `Client Secret`은 사용하면 안 됩니다.

### 2) `openCode.args`는 무엇인가요?

- `openCode.args`는 `openCode.command` 뒤에 붙는 추가 인자 목록입니다.
- UI의 `OpenCode 인수` 칸은 한 줄에 하나씩 입력하며, JSON에서는 배열로 저장됩니다.

### 2-1) `openCode.commandCandidates`는 무엇인가요?

- `openCode.command`가 현재 데스크탑에서 실행되지 않으면, 후보 명령을 순서대로 자동 시도합니다.
- Windows 환경에서 `opencode`가 없고 `oh-my-opencode`만 설치된 경우를 자동으로 흡수합니다.
- 기본 후보: `opencode`, `oh-my-opencode`, `opencode-cli`

예시

```json
"openCode": {
  "command": "opencode",
  "args": ["--model", "opus", "--max-turns", "20"]
}
```

UI 입력 형태

```text
--model
opus
--max-turns
20
```

### 3) 사용자 ID/채널 ID 사용

- `type: "channel"`는 지정 채널로만 알림을 보냅니다.
- `type: "user"`는 DM 대상 유저로 보냅니다.
- 채널 전용이면 유저 타겟은 비워 두어도 됩니다.

## UI로 설정하기 (권장)

```bash
npm run ui
```

브라우저에서 `http://127.0.0.1:4780`을 열면 설정 화면이 나옵니다.

### UI 사용 순서

1. `설정 불러오기`로 기존 설정 또는 예시 템플릿 로드
2. `빠른 설정`에서 토큰/대상ID/실행 명령(필요 시 명령 후보)/모드/패턴 입력
3. `폼 반영`으로 반영 후 필요하면 `원본 JSON 편집기`에서 세부 조정
4. `저장`으로 파일 저장
5. `포맷 테스트`로 감지 및 알림 포맷 확인
6. `실행 명령 복사`로 실제 실행 명령 복사

UI 하단에는 `알림 실행` 명령과 `포맷 테스트 결과`가 바로 표시됩니다.

## 실행

### 1) 설정 파일에 있는 명령으로 실행

```bash
npm run start -- --config ./opencode-notifier.config.json
```

### 2) 명령 오버라이드로 실행

```bash
npm run start -- --config ./opencode-notifier.config.json -- opencode
```

### 2-1) 프로필 지정 실행 (다른 데스크탑 재사용)

```bash
npm run start -- --config ./opencode-notifier.config.json --profile desktop-main
```

`profiles.desktop-main` 같은 블록을 두고 PC별로 `openCode.command`, `cwd`, `discord.targets`를 분리하면
동일 저장소를 여러 데스크탑에 그대로 복제해도 빠르게 적용할 수 있습니다.

추가로 알림기는 실행 환경 키(플랫폼/호스트/사용자 기반)를 자동 계산하고,
설정된 `environment.labelsByKey`에서 레이블을 찾아 제목에 `[환경 레이블]` 형태로 표시합니다.
현재 환경 키가 미등록이면 `npm run setup`으로 레이블 등록을 안내합니다.

### 3) Discord API 없이 payload 확인

```bash
npm run start -- --dry-run --config ./opencode-notifier.config.json -- opencode
```

## OpenCode IDE 플러그인 모드 (권장)

CLI 래퍼 대신 OpenCode 플러그인으로 붙이면, 사용자가 원하는 4가지가 더 정확하게 동작합니다.

- assistant 응답이 끝난 뒤 내용을 기준으로 알림 생성
- 실제 입력 가능 상태(`session.status: idle`, `session.idle`) 시점에 알림 전송
- OpenCode 플러그인 목록(`opencode.json`의 `plugin` 배열)에서 항목으로 로드
- 선택지/토큰 입력/권한 승인 같은 사용자 interrupt 대기 상태를 `INTERRUPT NOTICE` 형식으로 즉시 알림

### 설치

```bash
npm run plugin:install
```

설치 스크립트는 아래를 자동으로 처리합니다.

- OpenCode 설정 파일(`opencode.json`)의 `plugin` 배열에 `file://.../opencode-plugin/opencode-notifier-plugin.js` 등록
- 기존 `opencode-notifier-plugin` 문자열 엔트리가 있으면 제거 후 최신 file URI 엔트리로 교체

적용 후 OpenCode IDE를 재시작하세요.

### 플러그인 설정 파일

플러그인은 아래 순서로 설정을 찾습니다.

1. `<worktree>/.opencode/opencode-notifier-plugin.json`
2. `~/.config/opencode/opencode-notifier-plugin.json`
3. (없으면) `<worktree>/opencode-notifier.config.json`의 `message/discord`를 자동 브리지

예시 파일: `opencode-notifier-plugin.config.example.json`

### 제거

```bash
npm run plugin:uninstall
```

## 핵심 설정

`opencode-notifier.config.json`:

- `detection.buildCompletePatterns`
  - 빌드/작업 완료를 의미하는 문자열 또는 정규식 리터럴 문자열 (`"/pattern/i"`)
- `detection.waitingInputPatterns`
  - 입력 대기 상태를 의미하는 문자열/정규식
- `detection.readyWindowMs`
  - 완료 신호 이후 대기 신호가 이 시간 안에 나오면 알림 발송
- `detection.cooldownMs`
  - 같은 세션에서 중복 알림 방지 간격
- `message.mode`
  - `raw | cleaned | summary`
- `message.includeMetadata`
  - 메타데이터(시간/트리거/세션)를 본문에 포함할지 여부 (기본값 `false`)
- `message.summaryMaxBullets`
  - `summary` 모드에서 표시할 요약 bullet 개수 (기본값 `8`)
- `openCode.commandCandidates`
  - `openCode.command` 실패 시 순차적으로 시도할 실행 명령 목록
- `openCode.useShell`
  - Windows에서 `.cmd/.bat` 래퍼를 확실히 실행하고 싶을 때 `true` 권장
- `parser.assistantBlockStartPatterns / assistantBlockEndPatterns`
  - OpenCode 로그 형식이 명확할 때 마지막 assistant 블록 추출 정확도를 높임
- `discord.targets`
  - 여러 타겟 동시 전송 가능
- `environment.labelsByKey`
  - 실행 환경 키별 레이블 매핑. setup에서 입력한 레이블이 여기에 저장되고, 디스코드 제목에 반영됨
- `profiles`
  - 데스크탑/환경별 오버라이드 묶음. `--profile <name>`으로 선택

### 플러그인 전용 핵심 설정

- `trigger.notifyOnStatusIdle`
  - `session.status: idle` 이벤트에서 알림 (기본값 `false`, 필요 시만 켜기)
- `trigger.notifyOnSessionIdle`
  - `session.idle` 이벤트에서 알림 (기본값 `true`)
- `trigger.dedupeWindowMs`
  - 같은 메시지가 연속 idle 이벤트에서 중복 발송되는 것을 막는 보호 시간(ms)
- `trigger.requireAssistantMessage`
  - assistant 메시지가 없는 idle 이벤트는 무시
- `INTERRUPT NOTICE` (고정 동작)
  - `permission.asked`/입력 요구 이벤트가 오면 서브에이전트 포함 모든 agent에 대해 별도 notice 포맷으로 즉시 알림

## 디스코드 봇 권한/초대 설정

### 최소 권한

- `View Channels`
- `Send Messages`

### 권한 URL (예시)

`YOUR_CLIENT_ID`를 바꿔 사용하세요.

```text
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot&permissions=3072
```

`3072`는 `View Channels(1024)` + `Send Messages(2048)` 조합입니다.

### 전송 조건

- 채널 전송: 봇이 해당 서버/채널에 초대되어 있고 메시지 권한이 있어야 합니다.
- DM 전송: 봇이 대상 유저와 DM을 열 수 있어야 합니다.
- 채널 ID만 넣고 DM을 비워 둬도 정상 동작합니다.

## 알림 포맷 예시

```text
[desktop-main] OpenCode Build Finished ~ | OpenCodeNotifier - 결제 오류 원인 분석

- 핵심 포인트 1 ...
- 핵심 포인트 2 ...
- 핵심 포인트 3 ...
- 핵심 포인트 4 ...
```

여러 환경에서 같은 채널로 보내도 헤더의 `[환경 레이블]`로 어느 머신 알림인지 바로 구분할 수 있습니다.

## 트러블슈팅

- 알림이 안 오면 먼저 `--dry-run`으로 감지 자체가 되는지 확인하세요.
- 감지는 되는데 디스코드 전송만 실패하면 토큰/권한/ID를 확인하세요.
- 감지 정확도가 낮으면 `detection.*Patterns`와 `parser.*Patterns`를 현재 로그 형식에 맞게 조정하세요.
- `[notifier:error] openCode command를 실행할 수 없습니다...`(ENOENT) 오류가 나오면:
  - 원인: `openCode.command`가 현재 데스크탑 PATH에 없거나 오타입니다.
  - 먼저 `where opencode`, `where oh-my-opencode`로 실제 실행 가능 명령을 확인하세요.
  - `openCode.commandCandidates`에 실제 명령을 추가하면 데스크탑마다 자동으로 맞춰집니다.
  - 그래도 실패하면 `openCode.command`를 절대 경로(`C:\Path\To\opencode.exe`)로 지정하세요.
- "테스트 메시지는 되는데 실제 실행은 실패"라면:
  - 테스트는 `node -e ...` 같은 오버라이드 명령으로 성공했을 가능성이 큽니다.
  - 실제 운용은 config의 `openCode.command`를 쓰므로, 두 명령이 다르면 결과가 달라질 수 있습니다.
- "응답 후, 진짜 입력 가능 시점에만 보내고 싶다"면:
  - CLI 래퍼 모드보다 OpenCode IDE 플러그인 모드(`npm run plugin:install`)를 사용하세요.
  - 플러그인 모드는 `session.status: idle` / `session.idle` 이벤트를 직접 받아 트리거합니다.
- 응답 생성 중 취소/중단했다면:
  - 마지막 assistant 본문 대신 `이번 응답은 사용자가 취소했습니다.` 또는 `이번 응답은 중단되었습니다.` 형태의 상태 알림이 전송됩니다.
- `[search-mode]`, `[analyze-mode]`, `<analysis>`, `(@oracle subagent)` 같은 중간 분석/서브에이전트 응답이 알림으로 오면:
  - 최신 플러그인은 완료/요약 알림에서는 해당 패턴, `@... subagent` 세션, 그리고 `task/delegate_task` 도중 생성된 중간 메시지를 자동으로 제외합니다.
  - 대신 사용자 응답이 필요한 interrupt 대기 상태(선택/토큰/권한)는 `INTERRUPT NOTICE`로 서브에이전트 포함 즉시 알립니다.
  - 반영이 안 되면 `git pull` 후 `npm run plugin:install`을 다시 실행하고 IDE를 재시작하세요.
- 실행할 때 `현재 실행 환경 레이블이 등록되지 않았습니다`가 보이면:
  - 해당 환경 키가 아직 `environment.labelsByKey`에 없습니다.
  - `npm run setup`을 실행해 현재 환경 레이블을 등록해 주세요.
- 세션 제목이 계속 `새 작업`으로 보이면:
  - 최신 플러그인은 `session.updated`의 `info.id`/`info.title`을 반영하고, generic 제목이 기존 실제 제목을 덮어쓰지 않도록 처리합니다.
  - `git pull` 후 `npm run plugin:install` 실행, IDE 재시작으로 갱신하세요.
- "알림이 두 번씩 온다"면:
  - 최신 코드 기준 기본값은 `session.idle`만 사용하므로, 먼저 `npm run setup`으로 설정을 다시 저장하세요.
  - 플러그인 설정에서 `trigger.notifyOnStatusIdle`가 `true`이면 `false`로 바꾸고 IDE를 재시작하세요.
  - 그래도 중복이면 `trigger.dedupeWindowMs`를 `15000` 이상으로 올려서 동일 메시지 중복을 차단하세요.
- 메타데이터 줄(시간/트리거/세션)이 불필요하면:
  - `message.includeMetadata`를 `false`로 설정하세요. (`npm run setup` 기본값도 `false`)
- `Discord API ... failed (403): Missing Access`가 나오면:
  - 봇이 해당 서버에 초대되지 않았거나
  - 채널 ID가 해당 서버/채널이 아닐 수 있고
  - 채널 권한(`Send Messages`, `View Channel`)이 부족합니다.
  - 봇 초대 링크를 다시 만들고, 채널을 다시 한 번 확인하세요.

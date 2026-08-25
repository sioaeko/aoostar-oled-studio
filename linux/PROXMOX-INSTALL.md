# AOOSTAR OLED Studio Proxmox 설치 안내

이 패키지는 `x86_64` Proxmox 호스트용입니다. 웹 UI, 로컬 이미지/GIF, 브라우저
디코딩 영상, YouTube 링크, 실제 호스트 통계, 텍스트, 화면 끄기와 선택형 GIPHY
검색이 포함되어 있습니다. YouTube 지원용 공식 `yt-dlp` 실행 파일도 함께 묶입니다.

웹 서비스에는 로그인 기능이 없습니다. TCP 8787은 신뢰하는 LAN 또는 VPN에서만
허용하고 인터넷에 직접 포트포워딩하지 마십시오.

## 1. 압축 해제와 무변경 검증

```bash
unzip aoostar-oled-studio-proxmox-x86_64.zip
cd aoostar-oled-studio-proxmox-x86_64
chmod 0755 asterctl-web yt-dlp install-asterctl-web.sh verify-package.sh brightness-probe.py
sha256sum -c SHA256SUMS
./verify-package.sh
```

`verify-package.sh`는 Linux ELF 형식과 체크섬을 확인하고 `--simulate` 서버를
`127.0.0.1:18792`에 잠시 실행해 API, 실제 통계 endpoint, 내장 UI, GIPHY/YouTube
번들과 `yt-dlp` 버전을 검사합니다. 물리 OLED에는
접근하지 않습니다. 포트가 사용 중이면 예를 들어
`ASTERCTL_VERIFY_PORT=28792 ./verify-package.sh`로 바꿀 수 있습니다.

`curl` 또는 `wget`이 없거나 설치기의 필수 관리 명령이 빠졌다면 먼저 다음 패키지를
준비하십시오.

```bash
sudo apt-get update
sudo apt-get install -y curl iproute2 procps psmisc util-linux passwd
```

`aoostar-rs`는 USB HID를 직접 제어하지 않고 `/dev/ttyACM0` 같은 Linux 직렬 문자
장치에 화면 프로토콜을 씁니다. `0416:90a1`은 기본 장치를 자동 검색할 때 쓰는 USB
UART 식별자일 뿐이며, udev의 VID/PID 속성이 설치 필수조건은 아닙니다. 설치기는
sysfs 또는 확인된 기존 systemd unit의 `--device`/`DeviceAllow`에서 실제 경로를
승계하고 새 서비스에 그 경로를 명시적으로 고정합니다.

기존 설치가 다른 직렬 경로를 쓰거나 제한된 LXC에서 udev 정보가 보이지 않는다면
그 게스트 안에서 실제 문자 장치가 보이는지 확인한 뒤 `--device`로 지정하십시오.

## 2. 기존 aoostar-rs 교체 계획만 확인

다음 명령은 서비스나 파일을 변경하지 않습니다.

```bash
sudo bash ./install-asterctl-web.sh --dry-run --purge-legacy
```

자동 승계가 불가능하지만 기존 설치가 `/dev/ttyACM0`로 정상 동작했다면 다음처럼
경로를 명시합니다. 다른 경로를 사용 중이라면 그 값으로 바꾸십시오.

```bash
sudo bash ./install-asterctl-web.sh \
  --dry-run --purge-legacy --device /dev/ttyACM0
```

설치기는 할당된 RFC1918 사설 IPv4가 하나면 자동 선택합니다. `10.x`,
`172.16.x`~`172.31.x`, `192.168.x` 주소가 여러 개라면 의도하지 않은 인터페이스
노출을 막기 위해 중단하므로, 출력된 주소 중 실제 관리 LAN 주소를 지정하십시오.

```bash
sudo bash ./install-asterctl-web.sh --dry-run --purge-legacy \
  --device /dev/ttyACM0 --bind-address 192.168.1.10
```

출력에서 다음 사항을 확인하십시오.

- 실제 OLED 직렬 경로와 선택 근거가 표시됨
- 정확히 하나의 사설 LAN 바인딩 주소가 표시되고 WAN/공인 주소가 표시되지 않음
- 설치 예정 runtime이 같은 경로를 `--device`로 고정함
- 교체할 기존 `aoostar-rs`/`asterctl`/`oled-bridge` 서비스만 표시됨
- 알 수 없는 포트 8787 또는 직렬 장치 점유 프로세스가 없음
- transient/generated 서비스나 비-systemd 자동 시작 항목이 없음

설치기가 모호한 서비스나 복원할 수 없는 상태를 발견하면 백업이나 변경 전에
중단합니다.

## 3. 설치 및 자동 시작

dry-run 결과가 정확할 때만 실행하십시오.

```bash
sudo bash ./install-asterctl-web.sh --yes --purge-legacy
```

dry-run에 `--device`를 사용했다면 실제 설치에도 같은 값을 반드시 사용합니다.

```bash
sudo bash ./install-asterctl-web.sh \
  --yes --purge-legacy --device /dev/ttyACM0
```

dry-run에서 주소가 여러 개라 `--bind-address`를 사용했다면 실제 설치에도 확인한
동일한 사설 IP를 추가합니다(위의 `192.168.1.10`은 예시일 뿐입니다).

설치기는 기존 상태를 `/var/backups/asterctl-web-migration/` 아래에 백업하고, 기존 표시
서비스를 중지한 뒤 선택한 직렬 경로가 포함된 `asterctl-web.service`를 설치·자동
시작합니다. 새 서비스/API/UI/직렬 장치 점유 검증에 실패하면 이전 상태로 자동
롤백을 시도합니다.

## 4. 설치 후 확인

```bash
systemctl is-enabled asterctl-web.service
systemctl is-active asterctl-web.service
systemctl status asterctl-web.service --no-pager
curl -fsS http://<설치기에-표시된-사설-IP>:8787/api/status
curl -fsS http://<설치기에-표시된-사설-IP>:8787/api/telemetry
ss -lntp | grep ':8787'
systemctl show asterctl-web.service -p ExecStart --no-pager
```

`/api/status`에는 `"ok":true`, `"simulated":false`와 선택한 `"device"` 경로가
나와야 하며 8787 리스너는 설치기에 표시된 사설 IPv4 하나여야 합니다.
`0.0.0.0:8787`이나 공인/WAN 주소가 나오면 안 됩니다. Proxmox 방화벽을 사용한다면
신뢰 LAN에서 들어오는 TCP 8787만 허용하십시오.

다른 PC 브라우저에서 다음 주소를 엽니다.

```text
http://<PROXMOX-IP>:8787
```

GIPHY 검색은 `GIF -> Search GIPHY`에서 각 브라우저마다 Web API 키를 한 번 입력해야
하며, 그 PC가 인터넷에 접속할 수 있어야 합니다. 로컬 GIF와 나머지 모드는 인터넷 없이
동작합니다.

YouTube는 `Video` 탭에 영상 URL을 붙여 넣습니다. 서비스는 재생목록을 무시하고
최대 128 MiB의 단일 영상을 `/run/asterctl-web/youtube`에 임시 저장해 기존 영상
프레임 경로로 보냅니다. 한 번에 한 영상만 유지하며 교체·재시작 때 정리됩니다.
영상은 10/30/60초 또는 전체 길이를 선택하고 Stop까지 반복할 수 있습니다. GIF도
Stop이나 다른 모드 선택 전까지 원본 프레임 순서대로 계속 반복합니다.

`Brightness boost`는 100-200% 범위에서 색조와 채도를 가능한 한 유지하면서 어두운
중간톤을 밝게 만들며 기본값은 100%(원본)입니다. 알려진 UART 프로토콜과 공식 AOOSTAR-X
V1.3.6에는 물리 백라이트 밝기 명령이 없어 완전한 흰색의 광량이나 백라이트 전력
자체는 바뀌지 않습니다. Stats 대시보드의 `Light` 테마는 평균 픽셀 휘도가 가장
높은 구성일 뿐, 물리 백라이트 출력을 변경하지는 않습니다.

## 4b. 화면이 순정 부팅 애니메이션보다 어두울 때 — 백라이트 프로브

패키지의 `brightness-probe.py`는 기본 실행에서 문서화된 화면 ON/OFF 및 프레임
전송 명령만 사용합니다. 기준 애니메이션 확인 → 포트 열기/설정 → 최초 ON 명령
및 응답 확인 → 순백 프레임 및 응답 확인 → 원색 컬러바 및 응답 확인 →
OFF 응답 확인 → ON 응답 확인 후 컬러바와 비교 순서로 진행합니다. 장치 응답이
없거나 예상 형식과 다르면 해당 단계에서 중단하므로, 이후 밝기 비교를 성공한
전송으로 오인하지 않습니다.

```bash
sudo systemctl disable --now asterctl-web
sudo reboot
# 재부팅 후 부팅 애니메이션이 재생 중일 때:
cd ~/aoostar-oled-studio-proxmox-x86_64
sudo python3 brightness-probe.py /dev/ttyACM0
```

끝나면 출력된 `SUMMARY` 블록을 보관합니다. 추가 제어선 프로브를 실행하지 않을
경우 자동 시작을 바로 복구합니다.

```bash
sudo systemctl enable --now asterctl-web
```

기본 프로브는 DTR/RTS를 직접 바꾸지 않습니다. 직렬 제어선의 영향을 별도로
확인하려는 경우에만 `--control-lines`를 추가할 수 있습니다. 이 옵션은 화면 프로토콜
명령이 아니라 USB 직렬 제어선을 조작하며 장치에 따라 예상하지 못한 동작이나 연결
초기화가 발생할 수 있으므로, 기본 단계의 `SUMMARY`를 먼저 보관하고 필요성이 확인된
경우에만 사용하십시오. 기본 프로브가 부팅 애니메이션을 프레임으로 덮어썼으므로,
제어선 비교 전에는 서비스를 disabled 상태로 둔 채 다시 재부팅해 기준 애니메이션을
복구해야 합니다. 앞에서 이미 서비스를 복구했다면 먼저 다시 disable하십시오.

```bash
sudo systemctl disable --now asterctl-web
sudo reboot
# 재부팅 후 부팅 애니메이션이 재생 중일 때:
cd ~/aoostar-oled-studio-proxmox-x86_64
sudo python3 brightness-probe.py --control-lines /dev/ttyACM0
sudo systemctl enable --now asterctl-web
```

프로브 결과는 관찰된 단계 사이의 상관관계를 좁히는 자료입니다. 특히 OFF/ON은 하나의
왕복 단계이므로 ON 명령 단독의 원인이라고 단정할 수 없습니다. 순백 프레임과
애니메이션의 육안 비교만으로 패널의 실제 최대 휘도나 백라이트 전력을 측정할 수도
없습니다.

## 5. 롤백

설치 성공 메시지에 표시된 정확한 백업 경로를 사용하십시오.

```bash
sudo /usr/local/sbin/asterctl-web-installer \
  --rollback /var/backups/asterctl-web-migration/<BACKUP-DIRECTORY> --yes
```

실제 Proxmox/systemd와 OLED 하드웨어에서의 최종 동작은 위 dry-run, 설치 후 상태/API,
다른 PC의 화면 전송 검증으로 확정해야 합니다.

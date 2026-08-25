#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0

set -Eeuo pipefail

PROGRAM_NAME="$(basename "$0")"
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" >/dev/null 2>&1 && pwd -P)"
SCRIPT_PATH="$(readlink -f "$0")"
BACKUP_ROOT="${ASTERCTL_WEB_BACKUP_ROOT:-/var/backups/asterctl-web-migration}"
TARGET_BINARY="/usr/local/bin/asterctl-web"
TARGET_UNIT="/etc/systemd/system/asterctl-web.service"
TARGET_INSTALLER="/usr/local/sbin/asterctl-web-installer"
TARGET_YTDLP="/usr/local/libexec/asterctl-web/yt-dlp"
YTDLP_EXPECTED_SHA256="6bbb3d314cde4febe36e5fa1d55462e29c974f63444e707871834f6d8cc210ae"
DRY_RUN=0
ASSUME_YES=0
PURGE_LEGACY=0
BINARY_SOURCE=""
UNIT_SOURCE=""
YTDLP_SOURCE=""
DEVICE_REQUEST=""
SELECTED_DEVICE=""
SELECTED_DEVICE_REAL=""
DEVICE_SELECTION_SOURCE=""
BIND_REQUEST=""
SELECTED_BIND=""
ROLLBACK_REQUEST=""
BACKUP_DIR=""
MUTATION_STARTED=0

declare -a LEGACY_UNITS=()
declare -a AOOSTAR_DEVICES=()
declare -a UNKNOWN_UNITS=()
declare -a LEGACY_REMOVED_UNITS=()
declare -a LEGACY_MASKED_UNITS=()
declare -a NONPERSISTENT_LEGACY_UNITS=()

log() {
    printf '%s\n' "$*"
}

warn() {
    printf 'WARNING: %s\n' "$*" >&2
}

die() {
    printf 'ERROR: %s\n' "$*" >&2
    return 1
}

usage() {
    cat <<EOF
Usage:
  sudo bash $PROGRAM_NAME [options]
  sudo bash $PROGRAM_NAME --rollback BACKUP_DIR [--yes]

Options:
  --binary PATH       asterctl-web binary to install
  --unit PATH         asterctl-web.service file to install
  --device PATH       pin the serial device used by the working legacy install
  --bind-address IPv4 bind only to this assigned RFC1918 LAN address
  --dry-run           inspect and print the migration plan without changes
  --yes               do not ask for interactive confirmation
  --purge-legacy      also archive old CLI/bridge binaries and aster-sysinfo
  --rollback DIR      remove the new service and restore a migration backup
  -h, --help          show this help

By default the installer replaces only confirmed display-conflicting services:
lcd-off/lcd-on, oled-bridge, and custom system services whose effective
ExecStart uses the old asterctl binary. --purge-legacy additionally archives
the inert old binaries and aster-sysinfo. Existing config, fonts, source trees,
and package-managed files are never deleted.
EOF
}

while (($#)); do
    case "$1" in
        --binary)
            (($# >= 2)) || die "--binary requires a path"
            BINARY_SOURCE="$2"
            shift 2
            ;;
        --unit)
            (($# >= 2)) || die "--unit requires a path"
            UNIT_SOURCE="$2"
            shift 2
            ;;
        --device)
            (($# >= 2)) || die "--device requires a path"
            DEVICE_REQUEST="$2"
            shift 2
            ;;
        --bind-address)
            (($# >= 2)) || die "--bind-address requires an IPv4 address"
            BIND_REQUEST="$2"
            shift 2
            ;;
        --dry-run)
            DRY_RUN=1
            shift
            ;;
        --yes)
            ASSUME_YES=1
            shift
            ;;
        --purge-legacy)
            PURGE_LEGACY=1
            shift
            ;;
        --rollback)
            (($# >= 2)) || die "--rollback requires a backup directory"
            ROLLBACK_REQUEST="$2"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            die "unknown option: $1"
            ;;
    esac
done

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

require_root() {
    [[ ${EUID:-$(id -u)} -eq 0 ]] || die "run this installer as root (sudo bash $PROGRAM_NAME ...)"
}

verify_file_sha256() {
    local path="$1" expected="$2" label="$3" actual
    actual="$(sha256sum -- "$path" | awk '{print tolower($1)}')" || return 1
    [[ "$actual" == "$expected" ]] ||
        die "$label SHA256 mismatch: expected $expected, got $actual"
}

verify_ytdlp_hash() {
    verify_file_sha256 "$1" "$YTDLP_EXPECTED_SHA256" "yt-dlp"
}

acquire_lock() {
    exec 9>/run/lock/asterctl-web-install.lock
    flock -n 9 || die "another asterctl-web installation or rollback is running"
}

metadata_value() {
    local backup="$1"
    local key="$2"
    awk -F= -v wanted="$key" '$1 == wanted { sub(/^[^=]*=/, ""); print; exit }' "$backup/metadata"
}

unit_load_state() {
    systemctl show "$1" --property=LoadState --value 2>/dev/null || true
}

unit_fragment() {
    local fragment
    fragment="$(systemctl show "$1" --property=FragmentPath --value 2>/dev/null || true)"
    if [[ -z "$fragment" && ( -e "/etc/systemd/system/$1" || -L "/etc/systemd/system/$1" ) ]]; then
        fragment="/etc/systemd/system/$1"
    fi
    printf '%s' "$fragment"
}

unit_exists() {
    local state
    state="$(unit_load_state "$1")"
    [[ -n "$state" && "$state" != "not-found" ]] ||
        [[ -e "/etc/systemd/system/$1" || -L "/etc/systemd/system/$1" ]]
}

add_legacy_unit() {
    local unit="$1"
    [[ "$unit" =~ ^[A-Za-z0-9_.@-]+\.service$ ]] || return 0
    [[ "$unit" != "asterctl-web.service" ]] || return 0
    local existing
    for existing in "${LEGACY_UNITS[@]:-}"; do
        [[ "$existing" == "$unit" ]] && return 0
    done
    LEGACY_UNITS+=("$unit")
}

add_unknown_unit() {
    local unit="$1" existing
    [[ "$unit" =~ ^[A-Za-z0-9_.@-]+\.service$ ]] || return 0
    for existing in "${UNKNOWN_UNITS[@]:-}"; do
        [[ "$existing" == "$unit" ]] && return 0
    done
    UNKNOWN_UNITS+=("$unit")
}

add_nonpersistent_legacy_unit() {
    local unit="$1" fragment="$2" state="$3" transient="$4"
    local detail existing
    detail="$unit|${fragment:--}|${state:-unknown}|${transient:-unknown}"
    for existing in "${NONPERSISTENT_LEGACY_UNITS[@]:-}"; do
        [[ "$existing" == "$detail" ]] && return 0
    done
    NONPERSISTENT_LEGACY_UNITS+=("$detail")
}

legacy_fragment_is_persistent() {
    local unit="$1" fragment="$2" fragment_real state transient
    state="$(systemctl show "$unit" --property=UnitFileState --value 2>/dev/null || true)"
    transient="$(systemctl show "$unit" --property=Transient --value 2>/dev/null || true)"

    [[ "$transient" != "yes" && "$state" != "transient" && "$state" != "generated" ]] ||
        return 1
    [[ -n "$fragment" && "$fragment" == /* && ( -e "$fragment" || -L "$fragment" ) ]] ||
        return 1
    fragment_real="$(readlink -f "$fragment" 2>/dev/null || true)"
    [[ -n "$fragment_real" && -e "$fragment_real" ]] || return 1
    case "$fragment" in
        /run/*|/tmp/*|/var/tmp/*|/proc/*|/sys/*|/dev/*)
            return 1
            ;;
    esac
    case "$fragment_real" in
        /run/*|/tmp/*|/var/tmp/*|/proc/*|/sys/*|/dev/*)
            return 1
            ;;
    esac
    return 0
}

inspect_existing_web_fragment() {
    local unit="asterctl-web.service" fragment state transient
    unit_exists "$unit" || return 0
    fragment="$(unit_fragment "$unit")"
    legacy_fragment_is_persistent "$unit" "$fragment" && return 0
    state="$(systemctl show "$unit" --property=UnitFileState --value 2>/dev/null || true)"
    transient="$(systemctl show "$unit" --property=Transient --value 2>/dev/null || true)"
    add_nonpersistent_legacy_unit "$unit" "$fragment" "$state" "$transient"
}

discover_legacy_units() {
    local unit exec_start fragment canonical state transient
    # Names alone are not sufficient evidence. Only effective ExecStart values
    # that invoke the legacy display controller are eligible for replacement.
    while IFS= read -r unit; do
        [[ -n "$unit" ]] || continue
        [[ "$unit" == "asterctl-web.service" ]] && continue
        exec_start="$(unit_exec_start "$unit")"
        if exec_is_display_legacy "$exec_start"; then
            fragment="$(unit_fragment "$unit")"
            if ! legacy_fragment_is_persistent "$unit" "$fragment"; then
                state="$(systemctl show "$unit" --property=UnitFileState --value 2>/dev/null || true)"
                transient="$(systemctl show "$unit" --property=Transient --value 2>/dev/null || true)"
                add_nonpersistent_legacy_unit "$unit" "$fragment" "$state" "$transient"
                continue
            fi
            canonical="$(basename "${fragment:-$unit}")"
            if [[ "$canonical" =~ ^[A-Za-z0-9_.@-]+\.service$ ]]; then
                add_legacy_unit "$canonical"
            else
                add_legacy_unit "$unit"
            fi
        elif ((PURGE_LEGACY == 1)) && [[ "$unit" == "aster-sysinfo.service" ]] &&
            exec_is_legacy_sysinfo "$exec_start"; then
            fragment="$(unit_fragment "$unit")"
            if ! legacy_fragment_is_persistent "$unit" "$fragment"; then
                state="$(systemctl show "$unit" --property=UnitFileState --value 2>/dev/null || true)"
                transient="$(systemctl show "$unit" --property=Transient --value 2>/dev/null || true)"
                add_nonpersistent_legacy_unit "$unit" "$fragment" "$state" "$transient"
                continue
            fi
            add_legacy_unit "$unit"
        elif [[ "$exec_start" == *"ttyACM"* || "$exec_start" == *"0416:90a1"* || "$exec_start" == *":8787"* ]]; then
            add_unknown_unit "$unit"
        elif [[ "$unit" == "lcd-off.service" || "$unit" == "lcd-on.service" ||
                "$unit" == "oled-bridge.service" || "$unit" == "asterctl.service" ||
                "$unit" == "aoostar.service" || "$unit" == "aoostar-rs.service" ]] &&
             [[ "$(systemctl is-enabled "$unit" 2>/dev/null || true)" != "masked" ]]; then
            add_unknown_unit "$unit"
        fi
    done < <({
        systemctl list-unit-files --type=service --no-legend --no-pager 2>/dev/null | awk '{print $1}'
        systemctl list-units --type=service --all --no-legend --no-pager --plain 2>/dev/null | awk '{print $1}'
    } | sort -u)
}

reject_nonpersistent_legacy_units() {
    local detail unit fragment state transient
    ((${#NONPERSISTENT_LEGACY_UNITS[@]} == 0)) && return 0
    warn "legacy display services with transient, generated, missing, or nonpersistent fragments cannot be migrated safely:"
    for detail in "${NONPERSISTENT_LEGACY_UNITS[@]}"; do
        IFS='|' read -r unit fragment state transient <<<"$detail"
        warn "  $unit fragment=$fragment state=$state transient=$transient"
    done
    return 1
}

reject_unknown_units() {
    local unit
    ((${#UNKNOWN_UNITS[@]} == 0)) && return 0
    warn "ambiguous services may conflict but were not selected for automatic removal:"
    for unit in "${UNKNOWN_UNITS[@]}"; do
        warn "  $unit ExecStart=$(unit_exec_start "$unit")"
    done
    return 1
}

unit_exec_start() {
    local unit="$1" exec_start fragment
    exec_start="$(systemctl show "$unit" --property=ExecStart --value 2>/dev/null || true)"
    if [[ -z "$exec_start" ]]; then
        fragment="$(unit_fragment "$unit")"
        if [[ -f "$fragment" ]]; then
            exec_start="$(grep -E '^[[:space:]]*ExecStart[[:space:]]*=' "$fragment" 2>/dev/null || true)"
        fi
    fi
    printf '%s' "$exec_start"
}

is_allowed_python_basename() {
    [[ "$1" =~ ^python([0-9]+(\.[0-9]+)*)?$ ]]
}

exec_is_display_legacy() {
    local exec_start="$1" remaining entry_re matched_entry path argv_text
    local -a argv=()

    # systemctl show serializes each command as path=... plus argv[]=.... Match
    # the executable and argv[0] basenames exactly; text in labels, arguments,
    # or similarly named executables is not evidence that a unit owns the LCD.
    entry_re='path=([^[:space:];]+)[[:space:]]*;[[:space:]]*argv\[\]=([^;]*)[[:space:]]*;'
    remaining="$exec_start"
    while [[ "$remaining" =~ $entry_re ]]; do
        matched_entry="${BASH_REMATCH[0]}"
        path="${BASH_REMATCH[1]}"
        argv_text="${BASH_REMATCH[2]}"
        read -r -a argv <<<"$argv_text"
        if ((${#argv[@]} > 0)) &&
            [[ "${path##*/}" == "asterctl" && "${argv[0]##*/}" == "asterctl" ]]; then
            return 0
        fi
        if ((${#argv[@]} > 0)) &&
            [[ "${path##*/}" == "oled-bridge.py" && "${argv[0]##*/}" == "oled-bridge.py" ]]; then
            return 0
        fi
        if ((${#argv[@]} > 1)) && is_allowed_python_basename "${path##*/}" &&
            [[ "${argv[0]##*/}" == "${path##*/}" && "${argv[1]##*/}" == "oled-bridge.py" ]]; then
            return 0
        fi
        remaining="${remaining#*"$matched_entry"}"
    done

    # If systemd could not serialize ExecStart, accept only the same simple,
    # direct command forms from an actual ExecStart= directive.
    local line command executable script
    while IFS= read -r line; do
        [[ "$line" =~ ^[[:space:]]*ExecStart[[:space:]]*=(.*)$ ]] || continue
        command="${BASH_REMATCH[1]}"
        read -r executable script _ <<<"$command"
        while [[ "$executable" == [-@:+!]* ]]; do
            executable="${executable:1}"
        done
        if [[ "${executable##*/}" == "asterctl" || "${executable##*/}" == "oled-bridge.py" ]]; then
            return 0
        fi
        if is_allowed_python_basename "${executable##*/}" &&
            [[ "${script##*/}" == "oled-bridge.py" ]]; then
            return 0
        fi
    done <<<"$exec_start"
    return 1
}

exec_is_legacy_sysinfo() {
    local exec_start="$1" remaining entry_re matched_entry path argv_text
    local -a argv=()
    entry_re='path=([^[:space:];]+)[[:space:]]*;[[:space:]]*argv\[\]=([^;]*)[[:space:]]*;'
    remaining="$exec_start"
    while [[ "$remaining" =~ $entry_re ]]; do
        matched_entry="${BASH_REMATCH[0]}"
        path="${BASH_REMATCH[1]}"
        argv_text="${BASH_REMATCH[2]}"
        read -r -a argv <<<"$argv_text"
        if ((${#argv[@]} > 0)) &&
            [[ "${path##*/}" == "aster-sysinfo" && "${argv[0]##*/}" == "aster-sysinfo" ]]; then
            return 0
        fi
        remaining="${remaining#*"$matched_entry"}"
    done

    local line command executable
    while IFS= read -r line; do
        [[ "$line" =~ ^[[:space:]]*ExecStart[[:space:]]*=(.*)$ ]] || continue
        command="${BASH_REMATCH[1]}"
        read -r executable _ <<<"$command"
        while [[ "$executable" == [-@:+!]* ]]; do
            executable="${executable:1}"
        done
        [[ "${executable##*/}" == "aster-sysinfo" ]] && return 0
    done <<<"$exec_start"
    return 1
}

serial_device_path_allowed() {
    [[ "$1" =~ ^/dev/tty(ACM|USB)[0-9]+$ ]] ||
        [[ "$1" =~ ^/dev/serial/by-id/[A-Za-z0-9_.:+-]+$ ]]
}

resolve_serial_device_path() {
    local resolved
    resolved="$(readlink -f "$1" 2>/dev/null || true)"
    [[ "$resolved" =~ ^/dev/tty(ACM|USB)[0-9]+$ ]] || return 1
    [[ -c "$resolved" ]] || return 1
    printf '%s' "$resolved"
}

add_aoostar_device() {
    local device="$1" resolved existing existing_resolved
    serial_device_path_allowed "$device" || return 1
    [[ -c "$device" ]] || return 1
    resolved="$(resolve_serial_device_path "$device")" || return 1
    for existing in "${AOOSTAR_DEVICES[@]:-}"; do
        existing_resolved="$(resolve_serial_device_path "$existing" 2>/dev/null || true)"
        [[ "$existing_resolved" == "$resolved" ]] && return 0
    done
    AOOSTAR_DEVICES+=("$device")
}

device_matches_aoostar_usb() {
    local device="$1" properties vendor="" model="" resolved tty sys_path parent
    if command -v udevadm >/dev/null 2>&1; then
        properties="$(udevadm info --query=property --name="$device" 2>/dev/null || true)"
        vendor="$(printf '%s\n' "$properties" | awk -F= '$1 == "ID_VENDOR_ID" {print tolower($2); exit}')"
        model="$(printf '%s\n' "$properties" | awk -F= '$1 == "ID_MODEL_ID" {print tolower($2); exit}')"
        [[ "$vendor" == "0416" && "$model" == "90a1" ]] && return 0
    fi

    # Match the runtime's Linux/musl serial-port discovery more closely. It
    # walks sysfs rather than requiring udev database properties to be present.
    resolved="$(readlink -f "$device" 2>/dev/null || true)"
    [[ "$resolved" =~ ^/dev/tty(ACM|USB)[0-9]+$ ]] || return 1
    tty="${resolved##*/}"
    sys_path="$(readlink -f "/sys/class/tty/$tty/device" 2>/dev/null || true)"
    while [[ -n "$sys_path" && "$sys_path" == /sys/* ]]; do
        if [[ -r "$sys_path/idVendor" && -r "$sys_path/idProduct" ]]; then
            vendor="$(tr '[:upper:]' '[:lower:]' <"$sys_path/idVendor")"
            model="$(tr '[:upper:]' '[:lower:]' <"$sys_path/idProduct")"
            [[ "$vendor" == "0416" && "$model" == "90a1" ]] && return 0
        fi
        parent="${sys_path%/*}"
        [[ "$parent" != "$sys_path" ]] || break
        sys_path="$parent"
    done
    return 1
}

discover_usb_identified_devices() {
    local sys_tty device
    shopt -s nullglob
    for sys_tty in /sys/class/tty/*; do
        device="/dev/${sys_tty##*/}"
        serial_device_path_allowed "$device" || continue
        [[ -c "$device" ]] || continue
        device_matches_aoostar_usb "$device" && add_aoostar_device "$device"
    done
    # A restricted container can have a udev-visible character node without a
    # corresponding /sys/class/tty entry in its namespace.
    for device in /dev/ttyACM* /dev/ttyUSB*; do
        [[ -c "$device" ]] || continue
        device_matches_aoostar_usb "$device" && add_aoostar_device "$device"
    done
    shopt -u nullglob
}

discover_legacy_device_paths() {
    local unit exec_start fragment candidate line trimmed
    for unit in "${LEGACY_UNITS[@]:-}"; do
        exec_start="$(unit_exec_start "$unit")"
        while IFS= read -r candidate; do
            [[ -n "$candidate" ]] || continue
            add_aoostar_device "$candidate" || true
        done < <(printf '%s\n' "$exec_start" |
            grep -oE '/dev/(tty(ACM|USB)[0-9]+|serial/by-id/[A-Za-z0-9_.:+-]+)' || true)

        fragment="$(unit_fragment "$unit")"
        [[ -f "$fragment" ]] || continue
        while IFS= read -r line || [[ -n "$line" ]]; do
            line="${line%$'\r'}"
            trimmed="$(trim_unit_text "$line")"
            [[ "$trimmed" =~ ^DeviceAllow[[:space:]]*=[[:space:]]*(/dev/(tty(ACM|USB)[0-9]+|serial/by-id/[A-Za-z0-9_.:+-]+))([[:space:]]|$) ]] || continue
            add_aoostar_device "${BASH_REMATCH[1]}" || true
        done <"$fragment"
    done
}

select_aoostar_device() {
    AOOSTAR_DEVICES=()
    if [[ -n "$DEVICE_REQUEST" ]]; then
        serial_device_path_allowed "$DEVICE_REQUEST" ||
            die "--device must be /dev/ttyACM<N>, /dev/ttyUSB<N>, or /dev/serial/by-id/<name>"
        add_aoostar_device "$DEVICE_REQUEST" ||
            die "serial path must resolve to a present /dev/ttyACM<N> or /dev/ttyUSB<N> character device: $DEVICE_REQUEST"
        SELECTED_DEVICE="$DEVICE_REQUEST"
        SELECTED_DEVICE_REAL="$(resolve_serial_device_path "$SELECTED_DEVICE")"
        DEVICE_SELECTION_SOURCE="explicit --device"
        return 0
    fi

    discover_usb_identified_devices
    if ((${#AOOSTAR_DEVICES[@]})); then
        DEVICE_SELECTION_SOURCE="USB UART identity 0416:90a1"
    else
        # The upstream service can operate through /dev/ttyACM0 even when a
        # container has no udev database. Reuse only a path explicitly present
        # in a confirmed legacy unit; never guess an unrelated serial port.
        discover_legacy_device_paths
        ((${#AOOSTAR_DEVICES[@]})) && DEVICE_SELECTION_SOURCE="confirmed legacy service device path"
    fi

    if ((${#AOOSTAR_DEVICES[@]} == 0)); then
        die "no verified AOOSTAR serial path was found; rerun with --device /dev/ttyACM0 (or the path used by the working legacy service)"
    fi
    if ((${#AOOSTAR_DEVICES[@]} > 1)); then
        warn "multiple candidate serial devices were found: ${AOOSTAR_DEVICES[*]}"
        die "choose the working display path explicitly with --device PATH"
    fi
    SELECTED_DEVICE="${AOOSTAR_DEVICES[0]}"
    SELECTED_DEVICE_REAL="$(resolve_serial_device_path "$SELECTED_DEVICE")"
}

find_source_file() {
    local kind="$1"
    shift
    local candidate
    for candidate in "$@"; do
        if [[ "$kind" == "binary" && -f "$candidate" && -x "$candidate" ]]; then
            printf '%s' "$candidate"
            return 0
        fi
        if [[ "$kind" == "file" && -f "$candidate" ]]; then
            printf '%s' "$candidate"
            return 0
        fi
    done
    return 1
}

trim_unit_text() {
    local value="$1"
    value="${value#"${value%%[!$' \t']*}"}"
    value="${value%"${value##*[!$' \t']}"}"
    printf '%s' "$value"
}

validate_unit_source_policy() {
    local source="$1" line trimmed section="" key value
    local requirement expected count actual exec_start
    local -A counts=()
    local -A values=()
    local -a required_service_directives=(
        'Type=simple'
        'User=aoostar'
        'Group=aoostar'
        'SupplementaryGroups=dialout'
        'Restart=on-failure'
        'RestartSec=3'
        'RuntimeDirectory=asterctl-web'
        'RuntimeDirectoryMode=0700'
        'NoNewPrivileges=true'
        'PrivateTmp=true'
        'ProtectHome=true'
        'ProtectSystem=strict'
        'ProtectKernelTunables=true'
        'ProtectKernelModules=true'
        'ProtectControlGroups=true'
        'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK'
        'LockPersonality=true'
        'MemoryDenyWriteExecute=true'
        'UMask=0077'
    )

    while IFS= read -r line || [[ -n "$line" ]]; do
        line="${line%$'\r'}"
        trimmed="$(trim_unit_text "$line")"
        [[ -n "$trimmed" && "$trimmed" != \#* && "$trimmed" != \;* ]] || continue
        [[ "$trimmed" != *\\ ]] || {
            die "unit uses a continued directive that cannot be policy-validated safely: $source"
            return 1
        }
        if [[ "$trimmed" =~ ^\[([A-Za-z]+)\]$ ]]; then
            section="${BASH_REMATCH[1]}"
            continue
        fi
        [[ "$trimmed" =~ ^([A-Za-z][A-Za-z0-9]*)[[:space:]]*=(.*)$ ]] || {
            die "unit contains an unrecognized active directive: $trimmed"
            return 1
        }
        key="${BASH_REMATCH[1]}"
        value="$(trim_unit_text "${BASH_REMATCH[2]}")"
        [[ "$section" == "Service" ]] || continue
        case "$key" in
            Type|User|Group|SupplementaryGroups|ExecStart|Restart|RestartSec|RuntimeDirectory|RuntimeDirectoryMode|\
                NoNewPrivileges|PrivateTmp|ProtectHome|ProtectSystem|\
                ProtectKernelTunables|ProtectKernelModules|ProtectControlGroups|\
                RestrictAddressFamilies|LockPersonality|MemoryDenyWriteExecute|UMask)
                ;;
            *)
                die "unit contains unsupported [Service] directive $key"
                return 1
                ;;
        esac
        counts["$key"]=$(( ${counts["$key"]:-0} + 1 ))
        values["$key"]="$value"
        if [[ "$key" == Exec* && "$key" != "ExecStart" ]]; then
            die "unit contains unsupported executable directive $key; only one ExecStart is allowed"
            return 1
        fi
    done <"$source"

    for requirement in "${required_service_directives[@]}"; do
        key="${requirement%%=*}"
        expected="${requirement#*=}"
        count="${counts["$key"]:-0}"
        actual="${values["$key"]:-}"
        [[ "$count" == "1" && "$actual" == "$expected" ]] || {
            die "unit must contain exactly one $key=$expected in [Service] (found count=$count value=${actual:--})"
            return 1
        }
    done

    count="${counts[ExecStart]:-0}"
    exec_start="${values[ExecStart]:-}"
    [[ "$count" == "1" ]] || {
        die "unit must contain exactly one active ExecStart in [Service] (found $count)"
        return 1
    }
    if [[ "$exec_start" != "/usr/local/bin/asterctl-web --bind 127.0.0.1:8787" ]]; then
        if [[ "$exec_start" =~ ^/usr/local/bin/asterctl-web[[:space:]]+--bind[[:space:]]+([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}):8787[[:space:]]+--device[[:space:]]+/dev/(tty(ACM|USB)[0-9]+|serial/by-id/[A-Za-z0-9_.:+-]+)$ ]]; then
            private_ipv4 "${BASH_REMATCH[1]}" || {
                die "unit bind address must be a valid RFC1918 IPv4 address"
                return 1
            }
        else
            die "unit ExecStart must use the loopback template or one RFC1918 LAN address with an optional explicit --device"
            return 1
        fi
    fi
}

private_ipv4() {
    local value="$1" a b c d
    [[ "$value" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
    a=$((10#${BASH_REMATCH[1]}))
    b=$((10#${BASH_REMATCH[2]}))
    c=$((10#${BASH_REMATCH[3]}))
    d=$((10#${BASH_REMATCH[4]}))
    ((a <= 255 && b <= 255 && c <= 255 && d <= 255)) || return 1
    ((a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168)))
}

select_bind_address() {
    local -a assigned=() candidates=()
    local address existing
    mapfile -t assigned < <(ip -o -4 addr show scope global | awk '{split($4, part, "/"); print part[1]}' | sort -u)
    for address in "${assigned[@]:-}"; do
        [[ -n "$address" ]] || continue
        private_ipv4 "$address" && candidates+=("$address")
    done
    if [[ -n "$BIND_REQUEST" ]]; then
        private_ipv4 "$BIND_REQUEST" || die "--bind-address must be an RFC1918 address (10/8, 172.16/12, or 192.168/16)"
        for existing in "${assigned[@]:-}"; do
            if [[ "$existing" == "$BIND_REQUEST" ]]; then
                SELECTED_BIND="$BIND_REQUEST"
                return 0
            fi
        done
        die "--bind-address is not assigned to this Proxmox host: $BIND_REQUEST"
    fi
    if ((${#candidates[@]} == 1)); then
        SELECTED_BIND="${candidates[0]}"
        return 0
    fi
    if ((${#candidates[@]} == 0)); then
        die "no assigned RFC1918 address was found; pass --bind-address after configuring the LAN interface"
    fi
    printf 'Multiple private IPv4 addresses are assigned:\n' >&2
    printf '  %s\n' "${candidates[@]}" >&2
    die "rerun with --bind-address ADDRESS so the service is not exposed on unintended interfaces"
}

resolve_sources() {
    if [[ -z "$BINARY_SOURCE" ]]; then
        BINARY_SOURCE="$(find_source_file binary \
            "$SCRIPT_DIR/asterctl-web" \
            "$SCRIPT_DIR/../target/release/asterctl-web" \
            "$PWD/asterctl-web" \
            "$PWD/target/release/asterctl-web")" ||
            die "asterctl-web binary not found; pass --binary PATH"
    fi
    if [[ -z "$UNIT_SOURCE" ]]; then
        UNIT_SOURCE="$(find_source_file file \
            "$SCRIPT_DIR/asterctl-web.service" \
            "$PWD/asterctl-web.service" \
            "$PWD/linux/asterctl-web.service")" ||
            die "asterctl-web.service not found; pass --unit PATH"
    fi
    YTDLP_SOURCE="$(find_source_file binary "$SCRIPT_DIR/yt-dlp" "$PWD/yt-dlp")" ||
        die "bundled yt-dlp helper not found next to the installer"

    BINARY_SOURCE="$(readlink -f "$BINARY_SOURCE")"
    UNIT_SOURCE="$(readlink -f "$UNIT_SOURCE")"
    YTDLP_SOURCE="$(readlink -f "$YTDLP_SOURCE")"
    [[ -x "$BINARY_SOURCE" ]] || die "binary is not executable: $BINARY_SOURCE"
    [[ -x "$YTDLP_SOURCE" ]] || die "yt-dlp helper is not executable: $YTDLP_SOURCE"
    # SHA256SUMS inside a package is not an independent trust root. Pin the
    # official yt-dlp_linux release digest before this script ever executes or
    # installs the helper.
    verify_ytdlp_hash "$YTDLP_SOURCE"
    validate_unit_source_policy "$UNIT_SOURCE"
}

scan_non_systemd_autostart() {
    local -a scan_paths=()
    local path
    for path in /etc/crontab /etc/cron.d /etc/rc.local /var/spool/cron/crontabs \
        /root/.config/systemd/user /home/*/.config/systemd/user; do
        [[ -e "$path" ]] && scan_paths+=("$path")
    done
    ((${#scan_paths[@]})) || return 0

    local matches
    matches="$(grep -RnsE '^[[:space:]]*[^#].*(asterctl|oled-bridge)' "${scan_paths[@]}" 2>/dev/null || true)"
    if [[ -n "$matches" ]]; then
        printf '%s\n' "$matches" >&2
        die "legacy AOOSTAR autostart was found outside systemd; remove or migrate it explicitly, then rerun"
    fi
}

print_unit_plan() {
    local unit active enabled fragment
    if ((${#LEGACY_UNITS[@]} == 0)); then
        log "  legacy units: none detected"
        return
    fi
    printf '  %-30s %-12s %-18s %s\n' "UNIT" "ACTIVE" "ENABLED" "FRAGMENT"
    for unit in "${LEGACY_UNITS[@]}"; do
        active="$(systemctl is-active "$unit" 2>/dev/null || true)"
        enabled="$(systemctl is-enabled "$unit" 2>/dev/null || true)"
        fragment="$(unit_fragment "$unit")"
        printf '  %-30s %-12s %-18s %s\n' "$unit" "${active:-unknown}" "${enabled:-unknown}" "${fragment:--}"
    done
}

legacy_binary_candidates() {
    ((PURGE_LEGACY == 1)) || return 0
    printf '%s\n' \
        /usr/local/bin/asterctl \
        /usr/bin/asterctl \
        /usr/local/bin/oled-bridge.py \
        /usr/bin/oled-bridge.py \
        /usr/local/bin/aster-sysinfo \
        /usr/bin/aster-sysinfo
}

is_package_owned() {
    command -v dpkg-query >/dev/null 2>&1 && dpkg-query -S "$1" >/dev/null 2>&1
}

create_backup() {
    local timestamp
    timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
    BACKUP_DIR="$BACKUP_ROOT/${timestamp}-$$"
    install -d -m 0700 "$BACKUP_DIR" "$BACKUP_DIR/units" "$BACKUP_DIR/dropins" \
        "$BACKUP_DIR/binaries" "$BACKUP_DIR/existing-web"
    printf '%s\n' \
        'format=asterctl-web-migration-v1' \
        "created_utc=$timestamp" \
        'created_user=0' \
        'created_group=0' \
        'dialout_added=0' \
        'preexisting_user=0' \
        'preexisting_group=0' \
        'preexisting_dialout_member=0' \
        'existing_web_binary=0' \
        'existing_web_unit=0' \
        'existing_web_dropin=0' \
        'existing_installer=0' \
        'existing_ytdlp=0' \
        'existing_web_present=0' \
        'existing_web_fragment=' \
        'existing_web_active=inactive' \
        'existing_web_enabled=disabled' \
        "selected_device=$SELECTED_DEVICE" \
        "selected_bind=$SELECTED_BIND" >"$BACKUP_DIR/metadata"
    : >"$BACKUP_DIR/units.tsv"
    : >"$BACKUP_DIR/binaries.tsv"
}

set_metadata() {
    local key="$1" value="$2"
    local temporary="$BACKUP_DIR/.metadata.new"
    awk -F= -v wanted="$key" -v replacement="$value" '
        BEGIN { found = 0 }
        $1 == wanted { print wanted "=" replacement; found = 1; next }
        { print }
        END { if (!found) print wanted "=" replacement }
    ' "$BACKUP_DIR/metadata" >"$temporary"
    mv -f "$temporary" "$BACKUP_DIR/metadata"
}

backup_current_state() {
    local unit active enabled fragment dropin backup_unit

    id aoostar >/dev/null 2>&1 && set_metadata preexisting_user 1
    getent group aoostar >/dev/null 2>&1 && set_metadata preexisting_group 1
    if id aoostar >/dev/null 2>&1 && id -nG aoostar | tr ' ' '\n' | grep -qx dialout; then
        set_metadata preexisting_dialout_member 1
    fi

    if [[ -e "$TARGET_BINARY" || -L "$TARGET_BINARY" ]]; then
        cp -a -- "$TARGET_BINARY" "$BACKUP_DIR/existing-web/asterctl-web"
        set_metadata existing_web_binary 1
    fi
    if [[ -e "$TARGET_UNIT" || -L "$TARGET_UNIT" ]]; then
        cp -a -- "$TARGET_UNIT" "$BACKUP_DIR/existing-web/asterctl-web.service"
        set_metadata existing_web_unit 1
    fi
    if [[ -d /etc/systemd/system/asterctl-web.service.d ]]; then
        cp -a -- /etc/systemd/system/asterctl-web.service.d "$BACKUP_DIR/existing-web/asterctl-web.service.d"
        set_metadata existing_web_dropin 1
    fi
    if [[ -e "$TARGET_INSTALLER" || -L "$TARGET_INSTALLER" ]]; then
        cp -a -- "$TARGET_INSTALLER" "$BACKUP_DIR/existing-web/asterctl-web-installer"
        set_metadata existing_installer 1
    fi
    if [[ -e "$TARGET_YTDLP" || -L "$TARGET_YTDLP" ]]; then
        cp -a -- "$TARGET_YTDLP" "$BACKUP_DIR/existing-web/yt-dlp"
        set_metadata existing_ytdlp 1
    fi
    if unit_exists asterctl-web.service; then
        set_metadata existing_web_present 1
        set_metadata existing_web_fragment "$(unit_fragment asterctl-web.service)"
    fi
    set_metadata existing_web_active "$(systemctl is-active asterctl-web.service 2>/dev/null || true)"
    set_metadata existing_web_enabled "$(systemctl is-enabled asterctl-web.service 2>/dev/null || true)"

    for unit in "${LEGACY_UNITS[@]}"; do
        active="$(systemctl is-active "$unit" 2>/dev/null || true)"
        enabled="$(systemctl is-enabled "$unit" 2>/dev/null || true)"
        fragment="$(unit_fragment "$unit")"
        backup_unit=""
        if [[ "$fragment" == "/etc/systemd/system/$unit" && ( -e "$fragment" || -L "$fragment" ) ]]; then
            backup_unit="$BACKUP_DIR/units/$unit"
            cp -a -- "$fragment" "$backup_unit"
        fi
        dropin="/etc/systemd/system/$unit.d"
        if [[ -d "$dropin" ]]; then
            cp -a -- "$dropin" "$BACKUP_DIR/dropins/$unit.d"
        fi
        printf '%s\t%s\t%s\t%s\n' "$unit" "${active:-unknown}" "${enabled:-unknown}" "$fragment" >>"$BACKUP_DIR/units.tsv"
    done

    local binary backup_path
    while IFS= read -r binary; do
        [[ -e "$binary" || -L "$binary" ]] || continue
        if is_package_owned "$binary"; then
            warn "leaving package-managed legacy file in place: $binary"
            continue
        fi
        backup_path="$BACKUP_DIR/binaries$binary"
        install -d -m 0700 "$(dirname "$backup_path")"
        cp -a -- "$binary" "$backup_path"
        printf '%s\n' "$binary" >>"$BACKUP_DIR/binaries.tsv"
    done < <(legacy_binary_candidates)
}

restore_unit_state() {
    local unit="$1" active="$2" enabled="$3" fragment="${4:-}"
    local restore_status=0
    case "$enabled" in
        enabled)
            systemctl enable "$unit" >/dev/null 2>&1 || restore_status=1
            ;;
        enabled-runtime)
            systemctl enable --runtime "$unit" >/dev/null 2>&1 || restore_status=1
            ;;
        linked)
            [[ -n "$fragment" ]] && systemctl link "$fragment" >/dev/null 2>&1 || restore_status=1
            ;;
        linked-runtime)
            [[ -n "$fragment" ]] && systemctl link --runtime "$fragment" >/dev/null 2>&1 || restore_status=1
            ;;
        masked)
            systemctl mask "$unit" >/dev/null 2>&1 || restore_status=1
            ;;
        masked-runtime)
            systemctl mask --runtime "$unit" >/dev/null 2>&1 || restore_status=1
            ;;
        disabled)
            systemctl disable "$unit" >/dev/null 2>&1 || true
            ;;
    esac
    # Do not restart formerly inactive oneshot units such as lcd-off.
    if [[ "$active" == "active" || "$active" == "activating" ]]; then
        systemctl start "$unit" >/dev/null 2>&1 || restore_status=1
    fi
    ((restore_status == 0))
}

verify_restored_unit_state() {
    local unit="$1" active="$2" enabled="$3"
    local actual_active actual_enabled
    actual_active="$(systemctl is-active "$unit" 2>/dev/null || true)"
    actual_enabled="$(systemctl is-enabled "$unit" 2>/dev/null || true)"

    case "$enabled" in
        enabled|enabled-runtime|linked|linked-runtime|masked|masked-runtime|disabled|static|indirect|generated|transient)
            [[ "$actual_enabled" == "$enabled" ]] || return 1
            ;;
    esac
    if [[ "$active" == "active" || "$active" == "activating" ]]; then
        [[ "$actual_active" == "active" ]] || return 1
    elif [[ "$active" == "inactive" || "$active" == "failed" || "$active" == "deactivating" ]]; then
        [[ "$actual_active" != "active" && "$actual_active" != "activating" ]] || return 1
    fi
}

verify_installed_hashes() {
    local expected actual
    if [[ -f "$1/installed-binary.sha256" && -e "$TARGET_BINARY" ]]; then
        expected="$(<"$1/installed-binary.sha256")"
        actual="$(sha256sum "$TARGET_BINARY" | awk '{print $1}')"
        [[ "$expected" == "$actual" ]] || return 1
    fi
    if [[ -f "$1/installed-unit.sha256" && -e "$TARGET_UNIT" ]]; then
        expected="$(<"$1/installed-unit.sha256")"
        actual="$(sha256sum "$TARGET_UNIT" | awk '{print $1}')"
        [[ "$expected" == "$actual" ]] || return 1
    fi
    if [[ -f "$1/installed-installer.sha256" && -e "$TARGET_INSTALLER" ]]; then
        expected="$(<"$1/installed-installer.sha256")"
        actual="$(sha256sum "$TARGET_INSTALLER" | awk '{print $1}')"
        [[ "$expected" == "$actual" ]] || return 1
    fi
    if [[ -f "$1/installed-ytdlp.sha256" && -e "$TARGET_YTDLP" ]]; then
        expected="$(<"$1/installed-ytdlp.sha256")"
        actual="$(sha256sum "$TARGET_YTDLP" | awk '{print $1}')"
        [[ "$expected" == "$actual" ]] || return 1
    fi
}

validate_backup_path() {
    local backup="$1" backup_real root_real owner mode
    backup_real="$(readlink -f "$backup" 2>/dev/null || true)"
    root_real="$(readlink -f "$BACKUP_ROOT" 2>/dev/null || true)"
    [[ -n "$backup_real" && -n "$root_real" && "$backup_real" == "$root_real"/* ]] || return 1
    owner="$(stat -c '%u' "$backup_real" 2>/dev/null || true)"
    mode="$(stat -c '%a' "$backup_real" 2>/dev/null || true)"
    [[ "$owner" == "0" && "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
    (( (8#$mode & 0022) == 0 ))
}

allowed_legacy_binary() {
    case "$1" in
        /usr/local/bin/asterctl|/usr/bin/asterctl|/usr/local/bin/oled-bridge.py|/usr/bin/oled-bridge.py|/usr/local/bin/aster-sysinfo|/usr/bin/aster-sysinfo)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

rollback_backup() {
    local backup="$1"
    local rollback_status=0
    validate_backup_path "$backup" || {
        warn "backup must be a root-owned, non-writable child of $BACKUP_ROOT"
        return 1
    }
    if [[ ! -f "$backup/metadata" ]]; then
        warn "invalid backup: missing metadata"
        return 1
    fi
    if [[ "$(metadata_value "$backup" format)" != "asterctl-web-migration-v1" ]]; then
        warn "unsupported backup format: $backup"
        return 1
    fi
    if ! verify_installed_hashes "$backup"; then
        warn "installed files changed after migration; refusing to overwrite them during rollback"
        return 1
    fi

    log "Rolling back from $backup"
    set +e
    systemctl disable --now asterctl-web.service >/dev/null 2>&1
    systemctl is-active --quiet asterctl-web.service && rollback_status=1

    local unit active enabled fragment saved_unit saved_dropin dropin mask_path mask_target
    while IFS=$'\t' read -r unit active enabled fragment; do
        [[ "$unit" =~ ^[A-Za-z0-9_.@-]+\.service$ ]] || { rollback_status=1; continue; }
        systemctl unmask "$unit" >/dev/null 2>&1 || true
        mask_path="/etc/systemd/system/$unit"
        if [[ -L "$mask_path" ]]; then
            mask_target="$(readlink "$mask_path" 2>/dev/null || true)"
            [[ "$mask_target" == "/dev/null" ]] && rm -f -- "$mask_path"
        fi
    done <"$backup/units.tsv"

    rm -f -- "$TARGET_BINARY" "$TARGET_UNIT" "$TARGET_INSTALLER" "$TARGET_YTDLP" \
        "$(dirname "$TARGET_BINARY")/.asterctl-web.new.$$" \
        "$(dirname "$TARGET_UNIT")/.asterctl-web.service.new.$$" \
        "$(dirname "$TARGET_INSTALLER")/.asterctl-web-installer.new.$$" \
        "$(dirname "$TARGET_YTDLP")/.yt-dlp.new.$$" || rollback_status=1
    rm -rf -- /etc/systemd/system/asterctl-web.service.d || rollback_status=1

    if [[ "$(metadata_value "$backup" existing_web_binary)" == "1" ]]; then
        cp -a -- "$backup/existing-web/asterctl-web" "$TARGET_BINARY" || rollback_status=1
    fi
    if [[ "$(metadata_value "$backup" existing_web_unit)" == "1" ]]; then
        cp -a -- "$backup/existing-web/asterctl-web.service" "$TARGET_UNIT" || rollback_status=1
    fi
    if [[ "$(metadata_value "$backup" existing_web_dropin)" == "1" ]]; then
        cp -a -- "$backup/existing-web/asterctl-web.service.d" /etc/systemd/system/asterctl-web.service.d || rollback_status=1
    fi
    if [[ "$(metadata_value "$backup" existing_installer)" == "1" ]]; then
        cp -a -- "$backup/existing-web/asterctl-web-installer" "$TARGET_INSTALLER" || rollback_status=1
    fi
    if [[ "$(metadata_value "$backup" existing_ytdlp)" == "1" ]]; then
        install -d -m 0755 "$(dirname "$TARGET_YTDLP")" || rollback_status=1
        cp -a -- "$backup/existing-web/yt-dlp" "$TARGET_YTDLP" || rollback_status=1
    fi

    local binary saved_binary
    while IFS= read -r binary; do
        [[ -n "$binary" ]] || continue
        allowed_legacy_binary "$binary" || { rollback_status=1; continue; }
        saved_binary="$backup/binaries$binary"
        if [[ -e "$saved_binary" || -L "$saved_binary" ]]; then
            install -d -m 0755 "$(dirname "$binary")" || rollback_status=1
            cp -a -- "$saved_binary" "$binary" || rollback_status=1
        fi
    done <"$backup/binaries.tsv"

    while IFS=$'\t' read -r unit active enabled fragment; do
        [[ "$unit" =~ ^[A-Za-z0-9_.@-]+\.service$ ]] || { rollback_status=1; continue; }
        saved_unit="$backup/units/$unit"
        if [[ -e "$saved_unit" || -L "$saved_unit" ]]; then
            [[ "$fragment" == "/etc/systemd/system/$unit" ]] || { rollback_status=1; continue; }
            install -d -m 0755 "$(dirname "$fragment")" || rollback_status=1
            cp -a -- "$saved_unit" "$fragment" || rollback_status=1
        fi
        saved_dropin="$backup/dropins/$unit.d"
        dropin="/etc/systemd/system/$unit.d"
        if [[ -d "$saved_dropin" ]]; then
            rm -rf -- "$dropin" || rollback_status=1
            cp -a -- "$saved_dropin" "$dropin" || rollback_status=1
        fi
    done <"$backup/units.tsv"

    systemctl daemon-reload || rollback_status=1

    while IFS=$'\t' read -r unit active enabled fragment; do
        [[ "$unit" =~ ^[A-Za-z0-9_.@-]+\.service$ ]] || { rollback_status=1; continue; }
        restore_unit_state "$unit" "$active" "$enabled" "$fragment" || rollback_status=1
        verify_restored_unit_state "$unit" "$active" "$enabled" || rollback_status=1
    done <"$backup/units.tsv"
    if [[ "$(metadata_value "$backup" existing_web_present)" == "1" ]]; then
        restore_unit_state asterctl-web.service \
            "$(metadata_value "$backup" existing_web_active)" \
            "$(metadata_value "$backup" existing_web_enabled)" \
            "$(metadata_value "$backup" existing_web_fragment)" || rollback_status=1
        verify_restored_unit_state asterctl-web.service \
            "$(metadata_value "$backup" existing_web_active)" \
            "$(metadata_value "$backup" existing_web_enabled)" || rollback_status=1
    fi

    if [[ "$(metadata_value "$backup" preexisting_user)" == "1" ]]; then
        if [[ "$(metadata_value "$backup" preexisting_dialout_member)" == "0" ]] &&
            id -nG aoostar 2>/dev/null | tr ' ' '\n' | grep -qx dialout; then
            gpasswd --delete aoostar dialout >/dev/null 2>&1 || rollback_status=1
        fi
        if [[ "$(metadata_value "$backup" preexisting_dialout_member)" == "0" ]]; then
            id -nG aoostar 2>/dev/null | tr ' ' '\n' | grep -qx dialout && rollback_status=1
        fi
    elif id aoostar >/dev/null 2>&1; then
        userdel aoostar >/dev/null 2>&1 || rollback_status=1
        id aoostar >/dev/null 2>&1 && rollback_status=1
    fi
    if [[ "$(metadata_value "$backup" preexisting_group)" == "0" ]] && getent group aoostar >/dev/null 2>&1; then
        groupdel aoostar >/dev/null 2>&1 || rollback_status=1
        getent group aoostar >/dev/null 2>&1 && rollback_status=1
    fi
    set -e
    if ((rollback_status != 0)); then
        warn "rollback encountered file or systemd errors; preserve this backup for manual recovery: $backup"
        return 1
    fi
    log "Rollback complete. Physical OLED power state could not be read back; restored services retain their previous enable/active policy."
}

handle_failure() {
    local exit_code="$1" line="$2"
    trap - ERR INT TERM
    printf 'ERROR: installation failed at line %s (exit %s)\n' "$line" "$exit_code" >&2
    if ((MUTATION_STARTED == 1)) && [[ -n "$BACKUP_DIR" ]]; then
        journalctl --unit=asterctl-web.service --lines=30 --no-pager 2>/dev/null >&2 || true
        rollback_backup "$BACKUP_DIR" || warn "automatic rollback was incomplete; backup: $BACKUP_DIR"
    fi
    exit "$exit_code"
}

handle_signal() {
    local signal_name="$1"
    trap - ERR INT TERM
    warn "received $signal_name"
    if ((MUTATION_STARTED == 1)) && [[ -n "$BACKUP_DIR" ]]; then
        rollback_backup "$BACKUP_DIR" || warn "automatic rollback was incomplete; backup: $BACKUP_DIR"
    fi
    exit 130
}

ensure_service_user() {
    getent group dialout >/dev/null 2>&1 || die "dialout group does not exist"
    if id aoostar >/dev/null 2>&1; then
        local uid
        uid="$(id -u aoostar)"
        ((uid < 1000)) || die "existing aoostar account has UID $uid and appears to be a login user; refusing to modify it"
        getent group aoostar >/dev/null 2>&1 ||
            die "existing aoostar account has no matching aoostar group; refusing to repurpose it"
        [[ "$(id -gn aoostar)" == "aoostar" ]] ||
            die "existing aoostar account uses a different primary group; refusing to repurpose it"
    else
        if getent group aoostar >/dev/null 2>&1; then
            useradd --system --gid aoostar --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin aoostar
        else
            useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin aoostar
            set_metadata created_group 1
        fi
        set_metadata created_user 1
    fi
    if ! id -nG aoostar | tr ' ' '\n' | grep -qx dialout; then
        usermod --append --groups dialout aoostar
        set_metadata dialout_added 1
    fi
}

validate_service_user() {
    getent group dialout >/dev/null 2>&1 || die "dialout group does not exist"
    if id aoostar >/dev/null 2>&1; then
        local uid
        uid="$(id -u aoostar)"
        ((uid < 1000)) || die "existing aoostar account has UID $uid and appears to be a login user; refusing to modify it"
        getent group aoostar >/dev/null 2>&1 ||
            die "existing aoostar account has no matching aoostar group; refusing to repurpose it"
        [[ "$(id -gn aoostar)" == "aoostar" ]] ||
            die "existing aoostar account uses a different primary group; refusing to repurpose it"
    fi
}

remove_legacy_installation() {
    local unit fragment dropin binary enabled_after
    systemctl stop asterctl-web.service >/dev/null 2>&1 || true
    if systemctl is-active --quiet asterctl-web.service; then
        die "could not stop the existing asterctl-web.service"
    fi
    rm -rf -- /etc/systemd/system/asterctl-web.service.d

    for unit in "${LEGACY_UNITS[@]}"; do
        systemctl stop "$unit" >/dev/null 2>&1 || true
        if systemctl is-active --quiet "$unit"; then
            die "could not stop legacy unit: $unit"
        fi
        systemctl disable "$unit" >/dev/null 2>&1 || true
        enabled_after="$(systemctl is-enabled "$unit" 2>/dev/null || true)"
        case "$enabled_after" in
            enabled|enabled-runtime|linked|linked-runtime)
                die "could not disable legacy unit: $unit ($enabled_after)"
                ;;
        esac
        fragment="$(unit_fragment "$unit")"
        if [[ "$fragment" == "/etc/systemd/system/$unit" && ( -e "$fragment" || -L "$fragment" ) ]]; then
            rm -f -- "$fragment"
            LEGACY_REMOVED_UNITS+=("$unit")
        elif [[ -n "$fragment" ]]; then
            warn "preserving package/vendor or aliased unit file and masking its unit name: $fragment"
            LEGACY_MASKED_UNITS+=("$unit")
        else
            LEGACY_MASKED_UNITS+=("$unit")
        fi
        dropin="/etc/systemd/system/$unit.d"
        if [[ -d "$dropin" && "$dropin" == /etc/systemd/system/*.service.d ]]; then
            rm -rf -- "$dropin"
        fi
    done

    while IFS= read -r binary; do
        [[ -e "$binary" || -L "$binary" ]] || continue
        is_package_owned "$binary" && continue
        rm -f -- "$binary"
    done < <(legacy_binary_candidates)
    systemctl daemon-reload

    # Package/vendor units are not deleted. Mask only those units; manually
    # installed /etc units above are removed completely after being archived.
    for unit in "${LEGACY_MASKED_UNITS[@]:-}"; do
        [[ -n "$unit" ]] || continue
        systemctl mask "$unit" >/dev/null
        [[ "$(systemctl is-enabled "$unit" 2>/dev/null || true)" == "masked" ]] ||
            die "could not mask legacy unit against future activation: $unit"
    done
    for unit in "${LEGACY_REMOVED_UNITS[@]:-}"; do
        [[ -n "$unit" ]] || continue
        enabled_after="$(systemctl is-enabled "$unit" 2>/dev/null || true)"
        case "$enabled_after" in
            enabled|enabled-runtime|linked|linked-runtime|masked|masked-runtime)
                die "removed legacy unit still has an activation state: $unit ($enabled_after)"
                ;;
        esac
    done
}

unit_is_planned_owner() {
    local candidate="$1" unit
    [[ "$candidate" == "asterctl-web.service" ]] && return 0
    for unit in "${LEGACY_UNITS[@]:-}"; do
        [[ "$candidate" == "$unit" ]] && return 0
    done
    return 1
}

pid_systemd_unit() {
    local pid="$1"
    [[ -r "/proc/$pid/cgroup" ]] || return 1
    awk -F/ '{ for (i = NF; i >= 1; i--) if ($i ~ /\.service$/) { print $i; exit } }' "/proc/$pid/cgroup"
}

verify_known_holder_pid() {
    local pid="$1" context="$2" unit command_line
    [[ "$pid" =~ ^[0-9]+$ ]] || return 1
    unit="$(pid_systemd_unit "$pid" 2>/dev/null || true)"
    command_line="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)"
    if unit_is_planned_owner "$unit"; then
        log "  expected holder: $context pid=$pid unit=$unit"
        return 0
    fi
    warn "unknown holder blocks migration: $context pid=$pid unit=${unit:-none} command=${command_line:-unknown}"
    return 1
}

preflight_conflict_owners() {
    local blockers=0 pid device listeners listener_pids holders
    declare -A checked_pids=()

    while IFS= read -r pid; do
        [[ -n "$pid" ]] || continue
        checked_pids["$pid"]=1
        verify_known_holder_pid "$pid" "legacy process" || blockers=1
    done < <(pgrep -f '(^|/)[a]sterctl([[:space:]]|$)|[o]led-bridge\.py' 2>/dev/null || true)

    listeners="$(ss -H -ltnp 2>/dev/null | awk '$4 ~ /:8787$/ {print}' || true)"
    if [[ -n "$listeners" ]]; then
        log "  current TCP 8787 listener:"
        printf '%s\n' "$listeners"
        listener_pids="$(printf '%s\n' "$listeners" | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true)"
        if [[ -z "$listener_pids" ]]; then
            warn "could not identify the TCP 8787 listener PID"
            blockers=1
        fi
        while IFS= read -r pid; do
            [[ -n "$pid" ]] || continue
            [[ -n "${checked_pids[$pid]:-}" ]] && continue
            checked_pids["$pid"]=1
            verify_known_holder_pid "$pid" "TCP 8787" || blockers=1
        done <<<"$listener_pids"
    fi

    holders="$(fuser "$SELECTED_DEVICE_REAL" 2>/dev/null || true)"
    for pid in $holders; do
        [[ -n "${checked_pids[$pid]:-}" ]] && continue
        checked_pids["$pid"]=1
        verify_known_holder_pid "$pid" "$SELECTED_DEVICE_REAL" || blockers=1
    done
    ((blockers == 0))
}

reject_legacy_timers() {
    local timer target active enabled legacy
    while IFS= read -r timer; do
        [[ -n "$timer" ]] || continue
        target="$(systemctl show "$timer" --property=Unit --value 2>/dev/null || true)"
        [[ -n "$target" ]] || target="${timer%.timer}.service"
        legacy=0
        unit_is_planned_owner "$target" && [[ "$target" != "asterctl-web.service" ]] && legacy=1
        ((legacy == 1)) || continue
        active="$(systemctl is-active "$timer" 2>/dev/null || true)"
        enabled="$(systemctl is-enabled "$timer" 2>/dev/null || true)"
        if [[ "$active" == "active" || "$enabled" == "enabled" || "$enabled" == "enabled-runtime" ]]; then
            warn "timer $timer can reactivate legacy unit $target (active=$active enabled=$enabled)"
            return 1
        fi
    done < <(systemctl list-unit-files --type=timer --no-legend --no-pager 2>/dev/null | awk '{print $1}')
}

assert_conflicts_gone() {
    local processes listeners device holders
    processes="$(pgrep -af '(^|/)[a]sterctl([[:space:]]|$)|[o]led-bridge\.py' 2>/dev/null || true)"
    if [[ -n "$processes" ]]; then
        printf '%s\n' "$processes" >&2
        return 1
    fi

    listeners="$(ss -H -ltnp 2>/dev/null | awk '$4 ~ /:8787$/ {print}' || true)"
    if [[ -n "$listeners" ]]; then
        printf '%s\n' "$listeners" >&2
        return 1
    fi

    if command -v fuser >/dev/null 2>&1; then
        holders="$(fuser "$SELECTED_DEVICE_REAL" 2>/dev/null || true)"
        if [[ -n "$holders" ]]; then
            fuser -v "$SELECTED_DEVICE_REAL" >&2 || true
            return 1
        fi
    fi
}

render_service_unit() {
    local source="$1" destination="$2" device="$3" bind="$4"
    awk -v device="$device" -v bind="$bind" '
        BEGIN { replacements = 0 }
        /^[[:space:]]*ExecStart[[:space:]]*=/ {
            print "ExecStart=/usr/local/bin/asterctl-web --bind " bind ":8787 --device " device
            replacements++
            next
        }
        { print }
        END { if (replacements != 1) exit 41 }
    ' "$source" >"$destination" || {
        rm -f -- "$destination"
        die "could not render a single pinned ExecStart for $device on $bind"
    }
}

install_new_service() {
    local staged_binary staged_unit staged_installer staged_ytdlp
    # Recheck immediately before copying to close the gap between preflight
    # and mutation, then verify the staged file before making it live.
    verify_ytdlp_hash "$YTDLP_SOURCE"
    staged_binary="$(dirname "$TARGET_BINARY")/.asterctl-web.new.$$"
    staged_unit="$(dirname "$TARGET_UNIT")/.asterctl-web.service.new.$$"
    install -m 0755 -o root -g root "$BINARY_SOURCE" "$staged_binary"
    mv -f -- "$staged_binary" "$TARGET_BINARY"
    render_service_unit "$UNIT_SOURCE" "$staged_unit" "$SELECTED_DEVICE" "$SELECTED_BIND"
    chown root:root "$staged_unit"
    chmod 0644 "$staged_unit"
    validate_unit_source_policy "$staged_unit"
    mv -f -- "$staged_unit" "$TARGET_UNIT"
    install -d -m 0755 "$(dirname "$TARGET_INSTALLER")"
    staged_installer="$(dirname "$TARGET_INSTALLER")/.asterctl-web-installer.new.$$"
    install -m 0755 -o root -g root "$SCRIPT_PATH" "$staged_installer"
    mv -f -- "$staged_installer" "$TARGET_INSTALLER"
    install -d -m 0755 -o root -g root "$(dirname "$TARGET_YTDLP")"
    staged_ytdlp="$(dirname "$TARGET_YTDLP")/.yt-dlp.new.$$"
    install -m 0755 -o root -g root "$YTDLP_SOURCE" "$staged_ytdlp"
    verify_ytdlp_hash "$staged_ytdlp"
    mv -f -- "$staged_ytdlp" "$TARGET_YTDLP"
    verify_ytdlp_hash "$TARGET_YTDLP"

    sha256sum "$TARGET_BINARY" | awk '{print $1}' >"$BACKUP_DIR/installed-binary.sha256"
    sha256sum "$TARGET_UNIT" | awk '{print $1}' >"$BACKUP_DIR/installed-unit.sha256"
    sha256sum "$TARGET_INSTALLER" | awk '{print $1}' >"$BACKUP_DIR/installed-installer.sha256"
    sha256sum "$TARGET_YTDLP" | awk '{print $1}' >"$BACKUP_DIR/installed-ytdlp.sha256"

    systemctl daemon-reload
    if command -v systemd-analyze >/dev/null 2>&1; then
        systemd-analyze verify "$TARGET_UNIT"
    fi
    systemctl reset-failed asterctl-web.service >/dev/null 2>&1 || true
    systemctl enable --now asterctl-web.service
}

http_get() {
    local url="$1"
    if command -v curl >/dev/null 2>&1; then
        curl --fail --silent --show-error --max-time 4 "$url"
    else
        wget --quiet --timeout=4 --output-document=- "$url"
    fi
}

verify_new_service() {
    local _attempt status_json="" first_pid second_pid first_restarts second_restarts listeners
    local html asset_path unit binary holders device_owned=0
    for _attempt in {1..15}; do
        if systemctl is-active --quiet asterctl-web.service; then
            status_json="$(http_get "http://$SELECTED_BIND:8787/api/status" 2>/dev/null || true)"
            if printf '%s' "$status_json" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
                break
            fi
        fi
        sleep 1
    done
    printf '%s' "$status_json" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'
    printf '%s' "$status_json" | grep -Eq '"simulated"[[:space:]]*:[[:space:]]*false'
    printf '%s' "$status_json" | grep -Fq "\"device\":\"$SELECTED_DEVICE\""
    html="$(http_get "http://$SELECTED_BIND:8787/")"
    printf '%s' "$html" | grep -q 'id="root"'
    asset_path="$(printf '%s' "$html" | grep -oE '/assets/[^"[:space:]]+\.js' | head -n 1)"
    [[ -n "$asset_path" ]]
    http_get "http://$SELECTED_BIND:8787$asset_path" >/dev/null
    http_get "http://$SELECTED_BIND:8787/api/telemetry" | grep -Eq '"hostname"[[:space:]]*:'

    first_pid="$(systemctl show asterctl-web.service --property=MainPID --value)"
    first_restarts="$(systemctl show asterctl-web.service --property=NRestarts --value)"
    sleep 4
    systemctl is-active --quiet asterctl-web.service
    second_pid="$(systemctl show asterctl-web.service --property=MainPID --value)"
    second_restarts="$(systemctl show asterctl-web.service --property=NRestarts --value)"
    [[ "$first_pid" != "0" && "$first_pid" == "$second_pid" ]]
    [[ "$first_restarts" == "0" && "$second_restarts" == "0" ]]
    [[ "$(systemctl is-enabled asterctl-web.service 2>/dev/null || true)" == "enabled" ]]

    status_json="$(http_get "http://$SELECTED_BIND:8787/api/status")"
    printf '%s' "$status_json" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'
    listeners="$(ss -H -ltnp 2>/dev/null | awk -v endpoint="$SELECTED_BIND:8787" '$4 == endpoint {print}')"
    [[ -n "$listeners" ]]
    printf '%s\n' "$listeners" | grep -q "pid=$second_pid,"

    for unit in "${LEGACY_MASKED_UNITS[@]:-}"; do
        [[ -n "$unit" ]] || continue
        [[ "$(systemctl is-enabled "$unit" 2>/dev/null || true)" == "masked" ]]
        if systemctl is-active --quiet "$unit"; then
            return 1
        fi
    done
    for unit in "${LEGACY_REMOVED_UNITS[@]:-}"; do
        [[ -n "$unit" ]] || continue
        case "$(systemctl is-enabled "$unit" 2>/dev/null || true)" in
            enabled|enabled-runtime|linked|linked-runtime|masked|masked-runtime)
                return 1
                ;;
        esac
        if systemctl is-active --quiet "$unit"; then
            return 1
        fi
    done
    holders="$(fuser "$SELECTED_DEVICE_REAL" 2>/dev/null || true)"
    [[ " $holders " == *" $second_pid "* ]] && device_owned=1
    ((device_owned == 1))
    while IFS= read -r binary; do
        [[ -n "$binary" ]] || continue
        [[ ! -e "$binary" && ! -L "$binary" ]]
    done <"$BACKUP_DIR/binaries.tsv"
}

for command_name in systemctl install cp rm mv chmod chown awk grep head find sort cut tr readlink sha256sum stat ss pgrep fuser getent useradd usermod groupadd groupdel userdel gpasswd flock ip; do
    require_command "$command_name"
done
require_root
if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    die "curl or wget is required for post-install HTTP verification"
fi

if [[ -n "$ROLLBACK_REQUEST" ]]; then
    BACKUP_DIR="$(readlink -f "$ROLLBACK_REQUEST" 2>/dev/null || true)"
    [[ -n "$BACKUP_DIR" ]] || die "rollback backup does not exist: $ROLLBACK_REQUEST"
    [[ "$ASSUME_YES" -eq 1 ]] || {
        read -r -p "Restore legacy services from $BACKUP_DIR and remove the current web service? [y/N] " answer
        [[ "$answer" == "y" || "$answer" == "Y" ]] || exit 0
    }
    acquire_lock
    rollback_backup "$BACKUP_DIR"
    exit 0
fi

((DRY_RUN == 0)) && acquire_lock
resolve_sources
validate_service_user
scan_non_systemd_autostart
discover_legacy_units
inspect_existing_web_fragment
select_aoostar_device
select_bind_address

log "[1/4] Preflight (no changes)"
log "  binary: $BINARY_SOURCE"
log "  sha256: $(sha256sum "$BINARY_SOURCE" | awk '{print $1}')"
log "  unit:   $UNIT_SOURCE"
log "  bind:   $SELECTED_BIND:8787 (single private LAN address; no authentication)"
log "  yt-dlp: $YTDLP_SOURCE ($("$YTDLP_SOURCE" --version))"
log "  OLED:   $SELECTED_DEVICE ($DEVICE_SELECTION_SOURCE)"
log "  runtime: pinned serial path; udev VID/PID metadata is not required"
print_unit_plan
reject_nonpersistent_legacy_units || die "transient, generated, missing, or nonpersistent legacy units require manual migration; no changes were made"
reject_unknown_units || die "inspect or disable the ambiguous service units above; no changes were made"
reject_legacy_timers || die "disable the reported legacy activation timer before migration"
preflight_conflict_owners || die "an unknown process owns TCP 8787 or the AOOSTAR serial device; no changes were made"

log "[2/4] Planned replacement"
log "  - back up legacy unit state under $BACKUP_ROOT"
log "  - stop/disable detected legacy display services"
log "  - install and enable asterctl-web.service with --device $SELECTED_DEVICE"
log "  - install the bundled yt-dlp helper for YouTube URLs"
log "  - verify hardware mode, live telemetry, UI/API, stable PID, and $SELECTED_BIND:8787 listener"
log "  - automatically restore the previous state if verification fails"
if ((PURGE_LEGACY == 1)); then
    log "  - archive legacy CLI/bridge binaries and aster-sysinfo (--purge-legacy)"
else
    log "  - keep inert legacy binaries and the non-conflicting aster-sysinfo helper"
fi
log "  Existing cfg/fonts/source directories and package-managed files will be preserved."
log "  Starting the new service initializes and powers on the OLED."

if ((DRY_RUN == 1)); then
    log "Dry run complete; no changes were made."
    exit 0
fi

if ((ASSUME_YES == 0)); then
    read -r -p "Replace the detected legacy AOOSTAR installation now? [y/N] " answer
    [[ "$answer" == "y" || "$answer" == "Y" ]] || exit 0
fi

create_backup
backup_current_state
MUTATION_STARTED=1
trap 'handle_failure $? $LINENO' ERR
trap 'handle_signal INT' INT
trap 'handle_signal TERM' TERM

log "[3/4] Replacing legacy services"
remove_legacy_installation
assert_conflicts_gone || die "port 8787, the AOOSTAR serial device, or a legacy display process is still in use"
ensure_service_user
install_new_service

log "[4/4] Verifying the replacement"
verify_new_service
MUTATION_STARTED=0
trap - ERR INT TERM

log "Migration complete."
log "  LAN URL:  http://$SELECTED_BIND:8787"
log "  Backup:   $BACKUP_DIR"
log "  Rollback: sudo $TARGET_INSTALLER --rollback '$BACKUP_DIR' --yes"
log "Allow inbound TCP 8787 from the trusted LAN if the Proxmox firewall is enabled."
log "The process listens only on $SELECTED_BIND, but keep TCP 8787 blocked from WAN/VPN-untrusted zones."

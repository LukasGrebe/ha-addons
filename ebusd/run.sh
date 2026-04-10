#!/usr/bin/with-contenv bashio

bashio::log.info "eBUSd addon version $(bashio::addon.version)"

declare -a ebusd_args

ebusd_args+=(
    "--foreground"
    "--updatecheck=off"
)

# ---------------------------------------------------------------------------
# Read options.json once — all subsequent jq calls pipe from this variable
# ---------------------------------------------------------------------------
_options_json=$(cat /data/options.json 2>/dev/null)
_user_opts=$(printf '%s' "$_options_json" | jq -r '.commandline_options[]?' 2>/dev/null)

# ---------------------------------------------------------------------------
# commandline_options validation
# Warn about entries that bundle multiple flags (e.g. "--mqttjson --scanconfig")
# and about duplicate flags, both of which are common mistakes.
# ---------------------------------------------------------------------------
_opts_type=$(printf '%s' "$_options_json" | jq -r '.commandline_options | type' 2>/dev/null)

if [ "$_opts_type" = "array" ]; then
    declare -A _seen_flags=()
    while IFS= read -r _opt; do
        [ -z "$_opt" ] && continue
        # Multi-flag entry: contains a space followed by a dash
        if [[ "$_opt" == *" -"* ]]; then
            bashio::log.warning "commandline_options entry '$_opt' looks like multiple flags in one entry — put each flag on its own line."
        fi
        # Duplicate flag: strip =value to get the flag name, then check
        _flag_name="${_opt%%=*}"
        _flag_name="${_flag_name%% *}"
        if [ -n "${_seen_flags[$_flag_name]+x}" ]; then
            bashio::log.warning "Duplicate flag in commandline_options: '$_flag_name' appears more than once."
        fi
        _seen_flags["$_flag_name"]=1
    done <<< "$_user_opts"
    unset _seen_flags
fi

# ---------------------------------------------------------------------------
# MQTT credentials — sourced from HA Supervisor MQTT service unless the user
# has already supplied --mqtthost manually (external broker case).
# ---------------------------------------------------------------------------
if printf '%s' "$_user_opts" | grep -q -- '--mqtthost'; then
    bashio::log.info "Custom --mqtthost found in commandline_options — skipping Supervisor MQTT credentials."
elif bashio::services.available 'mqtt'; then
    ebusd_args+=(
        "--mqtthost=$(bashio::services mqtt 'host')"
        "--mqttport=$(bashio::services mqtt 'port')"
        "--mqttuser=$(bashio::services mqtt 'username')"
        "--mqttpass=$(bashio::services mqtt 'password')"
    )
else
    bashio::log.warning "MQTT service not available via Supervisor and no --mqtthost in commandline_options. MQTT disabled unless --mqtthost is supplied manually."
fi

# ---------------------------------------------------------------------------
# --mqttint + mqtt-hassio.cfg seeding
# When seed_mqtt_cfg is true (default), the bundled mqtt-hassio.cfg is copied
# to /config/mqtt-hassio.cfg on first start (if it does not already exist),
# and --mqttint=/config/mqtt-hassio.cfg is added to the ebusd arguments.
# Set seed_mqtt_cfg to false if you manage your own MQTT entities via CSV/YAML
# and do not want the bundled HA integration config or the --mqttint flag.
# If seed_mqtt_cfg is true but you supply your own --mqttint= in
# commandline_options, seeding is skipped and your path is used as-is.
# ---------------------------------------------------------------------------
if bashio::config.true 'seed_mqtt_cfg'; then
    if printf '%s' "$_user_opts" | grep -q -- '--mqttint'; then
        # Case 3: user supplied their own --mqttint path — skip seeding but warn that
        # --mqttjson is not auto-set for custom paths and suggest disabling seed_mqtt_cfg.
        bashio::log.info "Custom --mqttint found in commandline_options — skipping auto mqtt-hassio.cfg seeding. --mqttjson is not auto-set when using a custom --mqttint; add it to commandline_options if your config requires it. Consider setting seed_mqtt_cfg: false."
    else
        if [ ! -f /config/mqtt-hassio.cfg ]; then
            # Case 1: initial seed — quietly add --mqttint and --mqttjson like any built-in flag.
            bashio::log.info "Seeding default mqtt-hassio.cfg into addon config folder."
            cp /etc/ebusd/mqtt-hassio.cfg /config/mqtt-hassio.cfg
        else
            # Case 2: file already exists — nudge the user to take explicit ownership.
            bashio::log.info "mqtt-hassio.cfg exists in config folder and seed_mqtt_cfg is true — set seed_mqtt_cfg: false and add --mqttint=/config/mqtt-hassio.cfg and --mqttjson to commandline_options if you no longer need auto-seeding."
        fi
        ebusd_args+=("--mqttint=/config/mqtt-hassio.cfg")
        if ! printf '%s' "$_user_opts" | grep -q -- '--mqttjson'; then
            ebusd_args+=("--mqttjson")
        fi
    fi
else
    if [ -f /config/mqtt-hassio.cfg ] && ! printf '%s' "$_user_opts" | grep -q -- '--mqttint'; then
        bashio::log.warning "mqtt-hassio.cfg exists in config folder but seed_mqtt_cfg is false and no --mqttint in commandline_options — the file will not be used by ebusd."
    elif ! printf '%s' "$_user_opts" | grep -q -- '--mqttint'; then
        bashio::log.info "seed_mqtt_cfg is false — skipping mqtt-hassio.cfg seeding and --mqttint. Supply --mqttint= via commandline_options if needed."
    fi
fi

if bashio::config.has_value "network_device"; then
    if bashio::config.has_value "device"; then
        bashio::log.warning "Both 'device' and 'network_device' are set — using network_device."
    fi
    ebusd_args+=("--device=$(bashio::config 'network_device')")
elif bashio::config.has_value "device"; then
    ebusd_args+=("--device=$(bashio::config 'device')")
else
    bashio::log.info "No device configured — ebusd will attempt mDNS auto-discovery."
fi

ttyd --port 7681 --writable bash >/dev/null 2>&1 &

# ---------------------------------------------------------------------------
# --configpath validation (local paths only; HTTP/HTTPS URLs are skipped)
# ebusd expects:
#   root/          — *.csv files here are always loaded at startup
#   root/_templates.csv  — shared field type definitions, loaded first
#   root/<manufacturer>/ — *.csv files here loaded per-device via --scanconfig
# A CDN clone (ebus.github.io) adds a language layer: root/en/, root/de/ etc.
# ---------------------------------------------------------------------------
_configpath=$(printf '%s' "$_user_opts" | grep -o -- '--configpath=[^ ]*' | head -1 | cut -d= -f2-)
# --configlang selects inline column translations within CSV files; when using a local
# CDN clone it should also match the language subfolder chosen via --configpath.
_configlang=$(printf '%s' "$_user_opts" | grep -o -- '--configlang=[^ ]*' | head -1 | cut -d= -f2- | tr '[:upper:]' '[:lower:]')

if [ -n "$_configpath" ]; then
    case "$_configpath" in
        http://*|https://*)
            bashio::log.info "--configpath is a URL ($_configpath) — skipping local CSV validation."
            ;;
        *)
            if [ ! -d "$_configpath" ]; then
                bashio::log.warning "--configpath=$_configpath does not exist. Note: /config/ in the addon maps to /addon_configs/<slug>/ on the HA host."
            else
                _root_csv=$(find "$_configpath" -maxdepth 1 -name "*.csv" 2>/dev/null | wc -l | tr -d ' ')
                _sub_csv=$(find  "$_configpath" -mindepth 2 -maxdepth 2 -name "*.csv" 2>/dev/null | wc -l | tr -d ' ')

                if [ "$_root_csv" -eq 0 ] && [ "$_sub_csv" -eq 0 ]; then
                    bashio::log.warning "--configpath=$_configpath contains no CSV files at the root or in subdirectories."
                    bashio::log.warning "ebusd expects *.csv files directly in the configpath root (always loaded) and/or <manufacturer>/*.csv subdirectories (loaded per-device with --scanconfig)."
                    bashio::log.warning "Note: /config/ in the addon maps to /addon_configs/<slug>/ on the HA host."

                    # Build a list of candidate paths that do contain CSV entry points.
                    # If --configlang is set, check that language subdir first and exclusively
                    # suggest it — using a different language folder than --configlang is
                    # contradictory (configpath picks the file set; configlang picks inline
                    # column translations within those files).
                    _candidates=()
                    _parent=$(dirname "$_configpath")

                    _p_root=$(find "$_parent" -maxdepth 1 -name "*.csv" 2>/dev/null | wc -l | tr -d ' ')
                    _p_sub=$(find  "$_parent" -mindepth 2 -maxdepth 2 -name "*.csv" 2>/dev/null | wc -l | tr -d ' ')
                    [ "$(( _p_root + _p_sub ))" -gt 0 ] && _candidates+=("$_parent")

                    # CDN clone layout: configpath/<lang>/ — prefer --configlang if set.
                    _langs_to_check=(en de fr nl pl tt)
                    if [ -n "$_configlang" ]; then
                        _langs_to_check=("$_configlang")
                    fi
                    for _lang in "${_langs_to_check[@]}"; do
                        _lang_dir="$_configpath/$_lang"
                        if [ -d "$_lang_dir" ]; then
                            _l_root=$(find "$_lang_dir" -maxdepth 1 -name "*.csv" 2>/dev/null | wc -l | tr -d ' ')
                            _l_sub=$(find  "$_lang_dir" -mindepth 2 -maxdepth 2 -name "*.csv" 2>/dev/null | wc -l | tr -d ' ')
                            [ "$(( _l_root + _l_sub ))" -gt 0 ] && _candidates+=("$_lang_dir")
                        fi
                    done

                    if [ "${#_candidates[@]}" -gt 0 ]; then
                        bashio::log.warning "Did you mean one of these? ${_candidates[*]}"
                    fi
                elif [ -n "$_configlang" ]; then
                    # CSVs found — but warn if the configpath language folder doesn't match
                    # --configlang. e.g. --configpath=.../en --configlang=de loads English
                    # files while asking for German inline column translations.
                    _path_lang=$(basename "$_configpath" | tr '[:upper:]' '[:lower:]')
                    if [ "$_path_lang" != "$_configlang" ] && [ -d "$_configpath/$_configlang" ]; then
                        bashio::log.warning "--configpath ends in '$_path_lang' but --configlang=$_configlang — these should match when using a local CDN clone. Did you mean --configpath=$(dirname "$_configpath")/$_configlang?"
                    fi
                fi
            fi
            ;;
    esac
fi

# ---------------------------------------------------------------------------
# Deprecated config field detection — old (<=25.1) top-level keys in options.json
# ---------------------------------------------------------------------------
_deprecated_keys=(mode scanconfig readonly http pollinterval latency configpath
    accesslevel mqtttopic mqttint mqttvar mqttlog mqttretain mqtthost mqttport
    mqttuser mqttpass lograwdata lograwdatafile lograwdatasize
    loglevel_all loglevel_main loglevel_bus loglevel_update loglevel_network loglevel_other)
_found=()
for _k in "${_deprecated_keys[@]}"; do
    if printf '%s' "$_options_json" | jq -e --arg k "$_k" 'has($k)' >/dev/null 2>&1; then
        _found+=("$_k")
    fi
done
if [ ${#_found[@]} -gt 0 ]; then
    bashio::log.warning "================================================"
    bashio::log.warning " DEPRECATED CONFIG FIELDS DETECTED: ${_found[*]}"
    bashio::log.warning " These fields are from the old (<=25.1) schema"
    bashio::log.warning " and are NO LONGER APPLIED by this addon version."
    bashio::log.warning " Move them into the commandline_options list."
    bashio::log.warning " See: https://github.com/LukasGrebe/ha-addons/blob/main/ebusd/DOCS.md"
    bashio::log.warning "================================================"
fi

# ---------------------------------------------------------------------------
# Apply commandline_options and exec ebusd
# ---------------------------------------------------------------------------
if [ "$_opts_type" = "string" ]; then
    bashio::log.warning "commandline_options is a plain string — please convert it to a list (one flag per entry). Using it as-is for now."
    _str_opts=$(printf '%s' "$_options_json" | jq -r '.commandline_options')
    bashio::log.info "ebusd $(printf '%s ' "${ebusd_args[@]}" ${_str_opts} | sed 's/--mqttuser=[^ ]*/--mqttuser=<redacted>/g; s/--mqttpass=[^ ]*/--mqttpass=<redacted>/g')"
    exec ebusd "${ebusd_args[@]}" ${_str_opts}
elif [ "$_opts_type" = "array" ]; then
    while IFS= read -r _opt; do
        [ -n "$_opt" ] && ebusd_args+=("$_opt")
    done <<< "$_user_opts"
    bashio::log.info "ebusd $(printf '%s ' "${ebusd_args[@]}" | sed 's/--mqttuser=[^ ]*/--mqttuser=<redacted>/g; s/--mqttpass=[^ ]*/--mqttpass=<redacted>/g')"
    exec ebusd "${ebusd_args[@]}"
else
    bashio::log.info "No commandline_options set — running with defaults only."
    bashio::log.info "ebusd $(printf '%s ' "${ebusd_args[@]}" | sed 's/--mqttuser=[^ ]*/--mqttuser=<redacted>/g; s/--mqttpass=[^ ]*/--mqttpass=<redacted>/g')"
    exec ebusd "${ebusd_args[@]}"
fi

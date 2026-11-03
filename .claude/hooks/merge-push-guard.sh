#!/usr/bin/env bash
# The owner merges every PR (U123), and a push that lands on develop or main
# deploys an environment. git push and gh api run without a prompt (U126,
# TYRE-413), so this refuses a merge outright and asks before a push to
# either branch. A feature-branch push and every other gh api call pass.
set -uo pipefail
input=$(cat)
cmd=$(jq -r '.tool_input.command // empty' <<<"$input" 2>/dev/null) || exit 0
[[ "$cmd" == *push* || "$cmd" == *gh* ]] || exit 0
cwd=$(jq -r '.cwd // empty' <<<"$input" 2>/dev/null)
# jq on Windows ends each line with a CR, so no heredoc delimiter would match.
cmd=${cmd//$'\r'/}
cwd=${cwd//$'\r'/}
[[ -z "$cwd" ]] && cwd=$PWD

guarded='^(develop|main)$'

deny() {
  cat >&2 <<EOF
Blocked: this merges a pull request or a branch, and only the owner merges,
in the GitHub web UI (U123, TYRE-413).

  $1

Leave the PR open and tell the owner it is ready.
EOF
  exit 2
}

asks=()
ask() { asks+=("$1"); }

unquote() { local s=$1; s=${s#[\"\']}; s=${s%[\"\']}; printf '%s' "$s"; }

resolve() {
  local d
  d=$(unquote "$1")
  case "$d" in
    /* | [A-Za-z]:* | ~*) printf '%s' "$d" ;;
    *) printf '%s/%s' "$cwd" "$d" ;;
  esac
}

# The branch a bare push or a HEAD refspec lands on, and with push.default
# upstream, the branch it tracks.
landing() {
  local dir=$1 b mode up
  b=$(git -C "$dir" symbolic-ref --quiet --short HEAD 2>/dev/null) || return 0
  printf '%s\n' "$b"
  mode=$(git -C "$dir" config --get push.default 2>/dev/null)
  if [[ "$mode" == upstream || "$mode" == tracking ]]; then
    up=$(git -C "$dir" config --get "branch.$b.merge" 2>/dev/null)
    [[ -n "$up" ]] && printf '%s\n' "${up#refs/heads/}"
  fi
}

check_push() {
  local seg=$1 dir=$cwd rest remote="" refspecs=() tok skip=0 dst src b
  if [[ "$seg" =~ [[:space:]]-C[[:space:]]+(\'[^\']*\'|\"[^\"]*\"|[^[:space:]]+) ]]; then
    dir=$(resolve "${BASH_REMATCH[1]}")
  fi
  rest=${seg#*push}
  read -ra toks <<<"$rest"
  for tok in "${toks[@]}"; do
    tok=$(unquote "$tok")
    if ((skip)); then skip=0; continue; fi
    case "$tok" in
      --all | --mirror | --branches) ask "$seg"; return ;;
      --repo | -o | --push-option | --receive-pack | --exec) skip=1 ;;
      -*) ;;
      *) if [[ -z "$remote" ]]; then remote=$tok; else refspecs+=("$tok"); fi ;;
    esac
  done
  if ((${#refspecs[@]} == 0)); then
    while IFS= read -r b; do
      [[ "$b" =~ $guarded ]] && { ask "$seg"; return; }
    done < <(landing "$dir")
    return
  fi
  for tok in "${refspecs[@]}"; do
    tok=${tok#+}
    if [[ "$tok" == *:* ]]; then src=${tok%%:*}; dst=${tok#*:}; else src=$tok; dst=$tok; fi
    dst=${dst#refs/heads/}
    if [[ "$dst" == HEAD || "$dst" == @ ]]; then
      while IFS= read -r b; do
        [[ "$b" =~ $guarded ]] && { ask "$seg"; return; }
      done < <(landing "$dir")
    elif [[ "$dst" =~ $guarded ]]; then
      ask "$seg"; return
    fi
  done
}

check_gh_api() {
  local seg=$1
  [[ "$seg" =~ (pulls/[0-9]+/merge|/merges)([?\"\'[:space:]]|$) ]] && deny "$seg"
  [[ "$cmd" =~ (mergePullRequest|enablePullRequestAutoMerge) ]] && deny "$seg"
  if [[ "$seg" =~ refs/heads/(develop|main)([?\"\'[:space:]]|$) ]]; then
    if [[ "$seg" =~ (-X|--method)[[:space:]=]+([A-Za-z]+) ]] && [[ "${BASH_REMATCH[2]^^}" != GET ]]; then
      ask "$seg"
    elif [[ "$seg" =~ [[:space:]](-f|-F|--field|--raw-field|--input)([[:space:]=]|$) ]]; then
      ask "$seg"
    fi
  fi
}

# A heredoc's body is data (a PR body, a doc), so it is dropped, unless the
# line that opens it runs a shell, which reads the body as commands.
strip_heredocs() {
  local line t delim="" keep=0 tab=$'\t'
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ -n "$delim" ]]; then
      t=${line#"${line%%[!${tab}]*}"}
      ((keep)) && printf '%s\n' "$line"
      [[ "$t" == "$delim" ]] && delim=""
      continue
    fi
    printf '%s\n' "$line"
    if [[ "$line" =~ (^|[^\<])\<\<-?[[:space:]]*[\'\"]?([A-Za-z_][A-Za-z0-9_]*) ]]; then
      delim=${BASH_REMATCH[2]}
      keep=0
      [[ "$line" =~ (^|[[:space:]\;\&\|])(ba|z)?sh([[:space:]]|$) ]] && keep=1
    fi
  done <<<"$1"
}

# One command per line: split on the shell's separators and at each place a
# nested command starts, so "cd x && git push" and bash -c "..." are judged.
segments=$(strip_heredocs "$cmd" | sed -E 's/\$\(/\n/g; s/`/\n/g; s/\|\|/\n/g; s/&&/\n/g; s/[;|()]/\n/g; s/(^|[[:space:]])(ba|z)?sh[[:space:]]+-l?c[[:space:]]+/\n/g')
while IFS= read -r seg; do
  seg=$(printf '%s' "$seg" | sed -E "s/^[[:space:]\"']+//; s/^([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)+//; s/^(command|exec|time|nohup|env)[[:space:]]+//")
  if [[ "$seg" =~ ^cd[[:space:]]+(.+)$ ]]; then
    cwd=$(resolve "$(printf '%s' "${BASH_REMATCH[1]}" | sed -E 's/[[:space:]]+$//')")
  elif [[ "$seg" =~ ^gh[[:space:]]+pr[[:space:]]+merge([[:space:]]|$) ]]; then
    deny "$seg"
  elif [[ "$seg" =~ ^gh[[:space:]]+api([[:space:]]|$) ]]; then
    check_gh_api "$seg"
  elif [[ "$seg" =~ ^git([[:space:]]+-[Cc][[:space:]]+(\'[^\']*\'|\"[^\"]*\"|[^[:space:]]+)|[[:space:]]+--[a-z-]+(=[^[:space:]]+)?)*[[:space:]]+push([[:space:]]|$) ]]; then
    check_push "$seg"
  fi
done <<<"$segments"

((${#asks[@]} == 0)) && exit 0
reason="This push lands on develop or main, which deploys an environment, so the owner approves it (TYRE-413): ${asks[*]}"
jq -n --arg r "$reason" \
  '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: $r}}'
exit 0

#!/usr/bin/env bash
# The owner merges every PR (U123), and a write that lands on develop or main
# deploys an environment. git push and gh api run without a prompt (U126,
# TYRE-413), so this refuses a merge and asks before a push, a ref write or a
# contents write to either branch (U167). It reads the text as bash would:
# quotes, comments, continuations, heredocs, $( ) and a shell's -c. A command
# built to evade it passes: a branch or refspec in a variable, a glob refspec,
# `git push origin :`, a query read from a file (TYRE-413 c14118).
set -uo pipefail
input=$(cat)
cmd=$(jq -r '.tool_input.command // empty' <<<"$input" 2>/dev/null) || exit 0
[[ "$cmd" == *push* || "$cmd" == *gh* ]] || exit 0
cwd=$(jq -r '.cwd // empty' <<<"$input" 2>/dev/null)
# jq on Windows ends each line with a CR (docs/lessons.md, 2026-11-03).
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
  [[ "$d" == "~" || "$d" == "~/"* ]] && d=$HOME${d#\~}
  case "$d" in
    /* | [A-Za-z]:*) printf '%s' "$d" ;;
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

lands_guarded() {
  local b
  while IFS= read -r b; do [[ "$b" =~ $guarded ]] && return 0; done < <(landing "$1")
  return 1
}

# $1 is "git ... push" as written, $2 the words after it, $3 the segment.
check_push() {
  local head=$1 rest=$2 seg=$3 dir=$cwd remote="" refspecs=() tok skip=0 dst
  if [[ "$head" =~ [[:space:]]-C[[:space:]]+(\'[^\']*\'|\"[^\"]*\"|[^[:space:]]+) ]]; then
    dir=$(resolve "${BASH_REMATCH[1]}")
  fi
  read -ra toks <<<"$rest"
  for tok in "${toks[@]}"; do
    if ((skip)); then skip=0; continue; fi
    # A redirection is not a refspec; a bare operator's filename follows it.
    case "$tok" in
      [0-9]*'>'* | [0-9]*'<'* | '>'* | '<'* | '&>'*)
        [[ "$tok" =~ ^[0-9]*(\>\>?|\<|\&\>)$ ]] && skip=1
        continue
        ;;
    esac
    tok=${tok%%[<>]*}
    tok=$(unquote "${tok%)}")
    [[ -z "$tok" ]] && continue
    case "$tok" in
      --all | --mirror | --branches) ask "$seg"; return ;;
      --repo | -o | --push-option | --receive-pack | --exec) skip=1 ;;
      -*) ;;
      *) if [[ -z "$remote" ]]; then remote=$tok; else refspecs+=("$tok"); fi ;;
    esac
  done
  if ((${#refspecs[@]} == 0)); then
    lands_guarded "$dir" && ask "$seg"
    return
  fi
  for tok in "${refspecs[@]}"; do
    tok=${tok#+}
    if [[ "$tok" == *:* ]]; then dst=${tok#*:}; else dst=$tok; fi
    dst=${dst#refs/heads/}
    if [[ "$dst" == HEAD || "$dst" == @ ]]; then
      lands_guarded "$dir" && { ask "$seg"; return; }
    elif [[ "$dst" =~ $guarded ]]; then
      ask "$seg"; return
    fi
  done
}

check_gh_api() {
  local s=$1 method="" fields=0 write=0 end='([?"'\''[:space:]]|$)'
  [[ "$s" =~ pulls/[^/[:space:]]+/merge/?$end ]] && deny "$s"
  [[ "$s" =~ /merges/?$end ]] && deny "$s"
  [[ "$s" =~ (mergePullRequest|enablePullRequestAutoMerge) ]] && deny "$s"
  if [[ "$s" =~ (^|[[:space:]])(-X|--method)[[:space:]=]*[\"\']?([A-Za-z]+) ]]; then
    method=${BASH_REMATCH[3]^^}
  fi
  [[ "$s" =~ [[:space:]](-f|-F|--field|--raw-field|--input)([[:space:]=]|$) ]] && fields=1
  if [[ -n "$method" ]]; then [[ "$method" != GET ]] && write=1; else write=$fields; fi
  ((write)) || return 0
  [[ "$s" =~ refs/heads/(develop|main)$end ]] && ask "$s"
  if [[ "$s" =~ /contents/ ]] &&
    [[ "$s" =~ (-f|-F|--field|--raw-field)[[:space:]=]+[\"\']?branch=(develop|main)$end ]]; then
    ask "$s"
  fi
}

# One pass over the text as bash reads it. Each command is printed as two
# aligned views, separated by \037 and ended by \036: as written, and with
# quoted text blanked to "_", so a mention in quotes is never matched. A
# break falls at ; | ( ) and an & that is not a redirection, and at a newline
# outside quotes. A newline in quotes is a space, a backslash-newline joins
# lines, a # comment ends the line, and a heredoc's body is skipped unless a
# shell reads it. $( ), backticks and a shell's -c or eval body are scanned
# as commands of their own.
read -r -d '' split_awk <<'AWK'
function brk() {
  if (segf ~ /[^[:space:]]/) printf "%s\037%s\036", segf, segb
  segf = ""; segb = ""
}
function put(f, b) { segf = segf f; segb = segb b }
function wordstart(  p) { p = substr(segf, length(segf), 1); return (segf == "" || p ~ /[[:space:];&|(]/) }
function opener() {
  return (segb ~ /(^|[[:space:]])([^[:space:]]*\/)?(ba|z|da|k)?sh([[:space:]]+-[A-Za-z]+)*[[:space:]]+-[A-Za-z]*c[A-Za-z]*[[:space:]]*$/ ||
    segb ~ /(^|[[:space:]])eval[[:space:]]*$/)
}
function shellcmd() { return (segb ~ /(^|[[:space:]])([^[:space:]]*\/)?(ba|z|da|k)?sh([[:space:]]+-[^[:space:]]+)*[[:space:]]*$/) }
function push(c, r) { top++; cl[top] = c; rq[top] = r; dp[top] = 0; q = ""; inner = 0; brk() }
function pop() { q = rq[top]; top--; inner = 0; brk() }
{ s = s $0 "\n" }
END {
  n = length(s); q = ""; top = 0; hd = ""; keep = 0; inner = 0
  for (i = 1; i <= n; i++) {
    c = substr(s, i, 1); nx = substr(s, i + 1, 1)
    if (q == sq) {
      if (c == sq) { q = ""; put(c, "_"); continue }
      put(c == "\n" ? " " : c, "_"); continue
    }
    if (c == bs) {
      if (nx == "\n") { i++; continue }
      if (top > 0 && cl[top] == dq && nx == dq) {
        if (q == dq) { q = ""; inner = 0 } else if (q == "") { q = dq; inner = 1 }
        put(c nx, "__"); i++; continue
      }
      put(c nx, q == dq ? "__" : c nx); i++; continue
    }
    if (q == dq) {
      if (c == dq) { if (inner) { pop(); continue } q = ""; put(c, "_"); continue }
      if (c == bq) { push(bq, dq); continue }
      if (c == "$" && nx == "(") { push(")", dq); i++; continue }
      put(c == "\n" ? " " : c, "_"); continue
    }
    if (top > 0 && c == cl[top] && (c != ")" || dp[top] == 0)) { pop(); continue }
    if (c == "#" && wordstart()) { while (i < n && substr(s, i + 1, 1) != "\n") i++; continue }
    if (c == "<" && nx == "<" && substr(s, i + 2, 1) != "<" && substr(segf, length(segf), 1) != "<") {
      keep = shellcmd(); j = i + 2
      while (substr(s, j, 1) ~ /[- \t]/) j++
      w = ""
      while (j <= n) { d = substr(s, j, 1); if (d ~ /[[:space:];&|<>()]/) break; if (d != sq && d != dq && d != bs) w = w d; j++ }
      put(substr(s, i, j - i), substr(s, i, j - i)); i = j - 1; hd = w; continue
    }
    if (c == "\n") {
      brk()
      if (hd != "" && !keep) {
        j = i + 1
        while (j <= n) {
          e = index(substr(s, j), "\n"); line = (e ? substr(s, j, e - 1) : substr(s, j))
          sub(/^\t+/, "", line); j = (e ? j + e : n + 1)
          if (line == hd) break
        }
        i = j - 1
      }
      hd = ""; continue
    }
    if (c == "(") { if (top > 0 && cl[top] == ")") dp[top]++; brk(); continue }
    if (c == ")") { if (top > 0 && cl[top] == ")") dp[top]--; brk(); continue }
    if (c == ";" || c == "|") { brk(); continue }
    if (c == "&") {
      p = substr(segf, length(segf), 1)
      if (p == ">" || p == "<" || nx == ">") { put(c, c); continue }
      brk(); continue
    }
    if (c == "$" && nx == "(") { push(")", ""); i++; continue }
    if (c == bq) { push(bq, ""); continue }
    if (c == sq || c == dq) {
      if (opener()) { push(c, ""); continue }
      q = c; put(c, "_"); continue
    }
    put(c, c)
  }
  brk()
}
AWK

boundary='(^|[^[:alnum:]_.-])'
merge_re="${boundary}gh[[:space:]]+pr[[:space:]]+merge([[:space:]]|$)"
api_re="${boundary}gh[[:space:]]+api([[:space:]]|$)"
push_re="${boundary}git(([[:space:]]+-[Cc][[:space:]]+[^[:space:]]+)|([[:space:]]+--[a-z-]+(=[^[:space:]]+)?))*[[:space:]]+push([[:space:]]|$)"

while IFS=$'\037' read -r -d $'\036' full blank; do
  if [[ "$blank" =~ ^[[:space:]]*cd[[:space:]]+[^[:space:]] ]]; then
    arg=${full#*cd}
    arg=$(printf '%s' "$arg" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
    cwd=$(resolve "$arg")
  fi
  [[ "$blank" =~ $merge_re ]] && deny "$full"
  [[ "$blank" =~ $api_re ]] && check_gh_api "$full"
  if [[ "$blank" =~ $push_re ]]; then
    m=${BASH_REMATCH[0]}
    pre=${blank%%"$m"*}
    check_push "${full:${#pre}:${#m}}" "${full:${#pre}+${#m}}" "$full"
  fi
done < <(printf '%s' "$cmd" | awk -v sq="'" -v dq='"' -v bq='`' -v bs='\\' "$split_awk")

((${#asks[@]} == 0)) && exit 0
reason="This lands on develop or main, which deploys an environment, so the owner approves it (TYRE-413): ${asks[*]}"
jq -n --arg r "$reason" \
  '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: $r}}'
exit 0

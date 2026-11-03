#!/usr/bin/env bash
# The owner merges every PR (U123), and a write that lands on develop or main
# deploys an environment. git push and gh api run without a prompt (U126,
# TYRE-413), so this refuses a merge and asks before a push, a ref write or a
# contents write to either branch (U167, c14119). It reads the text as bash
# would: quotes, comments, continuations, heredocs, $( ) and a shell's -c. It
# asks when it cannot tell where a push lands. A command built to evade it
# passes: a refspec in a variable, a glob refspec, `git push origin :`, a
# query read from a file (TYRE-413 c14118).
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

# A directory the hook can follow, or "?" for one it cannot (a variable, a
# substitution, cd -).
resolve() {
  local d
  d=$(unquote "$1")
  if [[ "$d" == *'$'* || "$d" == *'`'* || "$d" == - || -z "$d" ]]; then printf '?'; return; fi
  [[ "$d" == "~" || "$d" == "~/"* ]] && d=$HOME${d#\~}
  case "$d" in
    /* | [A-Za-z]:*) printf '%s' "$d" ;;
    *) [[ "$cwd" == "?" ]] && printf '?' || printf '%s/%s' "$cwd" "$d" ;;
  esac
}

# Where a bare push or a HEAD refspec lands: guarded, safe, or unknown. With
# push.default upstream it also lands on the branch it tracks.
landing() {
  local dir=$1 b mode up
  [[ "$dir" == "?" ]] && { echo unknown; return; }
  b=$(git -C "$dir" symbolic-ref --quiet --short HEAD 2>/dev/null) || { echo unknown; return; }
  [[ "$b" =~ $guarded ]] && { echo guarded; return; }
  mode=$(git -C "$dir" config --get push.default 2>/dev/null)
  if [[ "$mode" == upstream || "$mode" == tracking ]]; then
    up=$(git -C "$dir" config --get "branch.$b.merge" 2>/dev/null)
    [[ "${up#refs/heads/}" =~ $guarded ]] && { echo guarded; return; }
  fi
  echo safe
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
    [[ "$(landing "$dir")" != safe ]] && ask "$seg"
    return
  fi
  for tok in "${refspecs[@]}"; do
    tok=${tok#+}
    if [[ "$tok" == *:* ]]; then dst=${tok#*:}; else dst=$tok; fi
    dst=${dst#refs/heads/}
    if [[ "$dst" == HEAD || "$dst" == @ ]]; then
      [[ "$(landing "$dir")" != safe ]] && { ask "$seg"; return; }
    elif [[ "$dst" =~ $guarded ]]; then
      ask "$seg"; return
    fi
  done
}

# Reads the call as written, quoted values included, since a path or query
# may be quoted; so a field that only names an endpoint or mutation counts too.
check_gh_api() {
  local s=$1 method="" fields=0 write=0 branch end='([?"'\''[:space:]]|$)'
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
  # With no branch field, a contents write lands on the default branch, main.
  if [[ "$s" =~ /contents/ ]]; then
    branch=""
    if [[ "$s" =~ (-f|-F|--field|--raw-field)[[:space:]=]+[\"\']?branch=[\"\']?([^[:space:]\"\']*) ]]; then
      branch=${BASH_REMATCH[2]}
    fi
    [[ -z "$branch" || "$branch" =~ $guarded ]] && ask "$s"
  fi
}

# One pass over the text as bash reads it. Each command is printed as three
# fields, separated by \037 and ended by \036: the command as written; the
# same with quoted text blanked to "_", which the merge, push and cd patterns
# search, so a quoted mention is not a command; and its subshell depth, so a
# cd stays in its subshell. A break falls at ; | ( ) and an & that is not a
# redirection, and at a newline outside quotes. A newline in quotes is a
# space, a backslash-newline joins lines, and a # comment ends the line. A
# $( ), a backtick or a shell's -c or eval body is printed as its own
# command, and the command around it keeps a placeholder in its place. A
# heredoc's body is code when a shell on its line reads it, part of the call
# for a gh api graphql query read from it, and skipped otherwise.
read -r -d '' split_awk <<'AWK'
function brk() {
  if (segf ~ /[^[:space:]]/) printf "%s\037%s\037%d\036", segf, segb, top
  segf = ""; segb = ""
}
function put(f, b) { segf = segf f; segb = segb b; lineb = lineb b }
function wordstart(  p) { p = substr(segf, length(segf), 1); return (segf == "" || p ~ /[[:space:];&|(]/) }
function opener() {
  return (segb ~ /(^|[[:space:]])([^[:space:]]*\/)?(ba|z|da|k)?sh([[:space:]]+(-o[[:space:]]+[A-Za-z]+|--[a-z-]+|-[A-Za-z]+))*[[:space:]]+-[A-Za-z]*c[A-Za-z]*[[:space:]]*$/ ||
    segb ~ /(^|[[:space:]])eval[[:space:]]*$/)
}
function push(k, c, r) {
  if (k == "group") brk()
  top++; kind[top] = k; cl[top] = c; rq[top] = r; sf[top] = segf; sb[top] = segb
  segf = ""; segb = ""; q = ""; inner = 0
}
function pop(  k) {
  k = kind[top]; brk(); segf = sf[top]; segb = sb[top]; q = rq[top]; top--; inner = 0
  if (k == "group") { segf = ""; segb = ""; return }
  if (k == "sub") put("$(_)", "$(_)"); else put("'_'", "___")
}
function skipbody(  j, e, line) {
  j = i + 1
  while (j <= n) {
    e = index(substr(s, j), "\n"); line = (e ? substr(s, j, e - 1) : substr(s, j))
    sub(/^\t+/, "", line); j = (e ? j + e : n + 1)
    if (line == hd) break
    if (attach) { segf = segf " " line; segb = segb sprintf("%" (length(line) + 1) "s", "") }
  }
  i = j - 1
}
{ s = s $0 "\n" }
END {
  n = length(s); q = ""; top = 0; hd = ""; inner = 0; lineb = ""
  for (i = 1; i <= n; i++) {
    c = substr(s, i, 1); nx = substr(s, i + 1, 1)
    # Inside a single-quoted -c body, '\'' is one apostrophe of the script.
    if (top > 0 && kind[top] == "code" && cl[top] == sq && substr(s, i, 4) == sq bs sq sq) {
      q = (q == sq ? "" : sq); put(substr(s, i, 4), "____"); i += 3; continue
    }
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
      if (c == bq) { push("sub", bq, dq); continue }
      if (c == "$" && nx == "(") { push("sub", ")", dq); i++; continue }
      put(c == "\n" ? " " : c, "_"); continue
    }
    if (top > 0 && c == cl[top]) {
      # Bash joins quoted pieces into one word, so the -c body goes on.
      if (kind[top] == "code" && (nx == sq || nx == dq)) { cl[top] = nx; put(c nx, "__"); i++; continue }
      pop(); continue
    }
    if (c == "#" && wordstart()) { while (i < n && substr(s, i + 1, 1) != "\n") i++; continue }
    if (c == "<" && nx == "<" && substr(s, i + 2, 1) != "<" && substr(segf, length(segf), 1) != "<") {
      j = i + 2
      while (substr(s, j, 1) ~ /[- \t]/) j++
      w = ""
      while (j <= n) { d = substr(s, j, 1); if (d ~ /[[:space:];&|<>()]/) break; if (d != sq && d != dq && d != bs) w = w d; j++ }
      put(substr(s, i, j - i), substr(s, i, j - i)); i = j - 1; hd = w; continue
    }
    if (c == "\n") {
      if (hd != "") {
        attach = (segf ~ /(^|[^[:alnum:]_.-])gh[[:space:]].*api[[:space:]]+graphql/ && segf ~ /query=@-|--input[[:space:]]+-/)
        if (!attach && lineb ~ /(^|[[:space:];&|(])([^[:space:]]*\/)?(ba|z|da|k)?sh([[:space:]]|$)/) { brk(); hd = ""; lineb = ""; continue }
        skipbody(); brk(); attach = 0; hd = ""; lineb = ""; continue
      }
      brk(); lineb = ""; continue
    }
    if (c == "(") { lineb = lineb c; push("group", ")", ""); continue }
    if (c == ")") { lineb = lineb c; brk(); continue }
    if (c == ";" || c == "|") { lineb = lineb c; brk(); continue }
    if (c == "&") {
      p = substr(segf, length(segf), 1)
      if (p == ">" || p == "<" || nx == ">") { put(c, c); continue }
      lineb = lineb c; brk(); continue
    }
    if (c == "$" && nx == "(") { push("sub", ")", ""); i++; continue }
    if (c == bq) { push("sub", bq, ""); continue }
    if (c == sq || c == dq) {
      if (opener()) { push("code", c, ""); continue }
      q = c; put(c, "_"); continue
    }
    put(c, c)
  }
  brk()
}
AWK

boundary='(^|[^[:alnum:]_.-])'
gh_re="${boundary}gh([[:space:]]+(-R|--repo)([[:space:]]+|=)[^[:space:]]+)*[[:space:]]+"
merge_re="${gh_re}pr[[:space:]]+merge([[:space:]]|$)"
api_re="${gh_re}api([[:space:]]|$)"
push_re="${boundary}git(([[:space:]]+-[Cc][[:space:]]+[^[:space:]]+)|([[:space:]]+--[a-z-]+(=[^[:space:]]+)?))*[[:space:]]+push([[:space:]]|$)"
cd_re='^[[:space:]]*((if|then|do|else|elif|while|until|time|\{|!)[[:space:]]+)*cd[[:space:]]+'

# An awk that cannot read the program would let every command through.
segs=$(printf '%s' "$cmd" | awk -v sq="'" -v dq='"' -v bq='`' -v bs='\\' "$split_awk") && [[ -n "$segs" ]] ||
  ask "the guard could not read this command"

dirs=("$cwd")
cur=0
while IFS=$'\037' read -r -d $'\036' full blank depth; do
  depth=${depth:-0}
  for ((k = cur + 1; k <= depth; k++)); do dirs[k]=${dirs[k - 1]}; done
  cur=$depth
  if [[ "$blank" =~ $cd_re ]]; then
    m=${BASH_REMATCH[0]}
    word=${full:${#m}}
    cwd=${dirs[cur]}
    if [[ "$word" =~ ^(\'[^\']*\'|\"[^\"]*\"|[^[:space:]]+) ]]; then dirs[cur]=$(resolve "${BASH_REMATCH[1]}"); fi
  fi
  cwd=${dirs[cur]}
  [[ "$blank" =~ $merge_re ]] && deny "$full"
  [[ "$blank" =~ $api_re ]] && check_gh_api "$full"
  if [[ "$blank" =~ $push_re ]]; then
    m=${BASH_REMATCH[0]}
    pre=${blank%%"$m"*}
    check_push "${full:${#pre}:${#m}}" "${full:${#pre}+${#m}}" "$full"
  fi
done <<<"$segs"

((${#asks[@]} == 0)) && exit 0
reason="This may land on develop or main, which deploys an environment, or the guard cannot tell where it lands, so the owner approves it (TYRE-413): ${asks[*]}"
jq -n --arg r "$reason" \
  '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: $r}}'
exit 0

#!/usr/bin/env bash
# The owner merges every PR (U123), and a write that lands on develop or main
# deploys an environment. git push and gh api run without a prompt (U126,
# TYRE-413), so this refuses a merge and asks before a push, a ref write or a
# contents write to either branch (U167, c14119). Where it cannot read a
# command precisely, it asks: a shell's -c, eval or a heredoc a shell reads
# that names a push or merge, and a bare push after a cd it cannot follow.
# A command built to evade it passes: a refspec in a variable, a glob
# refspec, `git push origin :`, a query read from a file (TYRE-413 c14118).
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
end='([?"'\''[:space:]]|$)'
boundary='(^|[^[:alnum:]_.-])'
repo_flag='([[:space:]]+(-R[[:space:]]*|--repo([[:space:]]+|=))[^[:space:]]+)*'
merge_re="${boundary}gh${repo_flag}[[:space:]]+pr${repo_flag}[[:space:]]+merge([[:space:]]|$)"
api_re="${boundary}gh${repo_flag}[[:space:]]+api([[:space:]]|$)"
push_re="${boundary}git(([[:space:]]+-[Cc][[:space:]]+[^[:space:]]+)|([[:space:]]+--[a-z-]+(=[^[:space:]]+)?))*[[:space:]]+push([[:space:]]|$)"
cd_re='^[[:space:]]*((if|then|do|else|elif|while|until|time|\{|!)[[:space:]]+)*cd[[:space:]]+'
dirs_re="${boundary}(pushd|popd)([[:space:]]|$)|(builtin|command)[[:space:]]+cd([[:space:]]|$)"
mutation_re='(mergePullRequest|enablePullRequestAutoMerge)'

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

# A directory the hook can follow, or "?" for one it cannot.
resolve() {
  local d
  d=$(unquote "$1")
  if [[ "$d" == *'$'* || "$d" == *'`'* || "$d" == - || -z "$d" || "$cwd" == "?" ]]; then printf '?'; return; fi
  [[ "$d" == "~" || "$d" == "~/"* ]] && d=$HOME${d#\~}
  case "$d" in
    /* | [A-Za-z]:*) printf '%s' "$d" ;;
    *) printf '%s/%s' "$cwd" "$d" ;;
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
  local s=$1 method="" fields=0 write=0 branch
  [[ "$s" =~ pulls/[^/[:space:]]+/merge/?$end ]] && deny "$s"
  [[ "$s" =~ /merges/?$end ]] && deny "$s"
  [[ "$s" =~ $mutation_re ]] && deny "$s"
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

# Text a shell runs that the hook does not decode: refused when it holds a
# merge, asked when it names a push or merge, and any cd in it is unknown.
check_opaque() {
  local b=$1
  [[ "$b" =~ $merge_re ]] && deny "$b"
  if [[ "$b" =~ $api_re ]]; then
    [[ "$b" =~ pulls/[^/[:space:]]+/merge/?$end || "$b" =~ /merges/?$end || "$b" =~ $mutation_re ]] && deny "$b"
  fi
  [[ "$b" =~ (^|[^[:alnum:]_-])(push|merge)([^[:alnum:]_-]|$) ]] && ask "$b"
  [[ "$b" =~ ${boundary}(cd|pushd|popd)([[:space:]]|$) ]] && cwd="?"
}

# One pass over the text as bash reads it. Each record is three fields,
# separated by \037 and ended by \036: the text as written, the same with
# quoted text blanked to "_" (which the merge, push and cd patterns search,
# so a quoted mention is not a command), and a kind. "cmd" is a command and
# "nested" one inside ( ), $( ) or backticks. "opaque" is text a shell runs
# that is not decoded: a shell's -c or eval word, or a heredoc a shell in the
# heredoc's own pipeline reads. "gql" is a heredoc a gh api graphql call in
# that pipeline reads as its query. A break falls at ; | ( ), an & that is
# not a redirection, and a newline outside quotes. A newline in quotes is a
# space, a backslash-newline joins lines, and a # comment ends the line. The
# command around a $( ) or backtick stays whole, with a placeholder.
read -r -d '' split_awk <<'AWK'
function emit(f, b, k) { printf "%s\037%s\037%s\036", f, b, k }
function brk() {
  if (segf ~ /[^[:space:]]/) emit(segf, segb, top > 0 ? "nested" : "cmd")
  segf = ""; segb = ""
}
function put(f, b) { segf = segf f; segb = segb b; lineb = lineb b }
function blank(t,  r) { r = t; gsub(/./, "_", r); return r }
function wordstart(  p) { p = substr(segf, length(segf), 1); return (segf == "" || p ~ /[[:space:];&|(]/) }
function opener() {
  return (segb ~ /(^|[[:space:]])([^[:space:]]*\/)?(ba|z|da|k)?sh([[:space:]]+[^[:space:]]+)*[[:space:]]+-[A-Za-z]*c[A-Za-z]*[[:space:]]*$/ ||
    segb ~ /(^|[[:space:]])eval[[:space:]]*$/)
}
function wordend(k,  d, qq) {
  qq = ""
  while (k <= n) {
    d = substr(s, k, 1)
    if (qq == sq) { if (d == sq) qq = ""; k++; continue }
    if (d == bs) { k += 2; continue }
    if (qq == dq) { if (d == dq) qq = ""; k++; continue }
    if (d == sq || d == dq) { qq = d; k++; continue }
    if (d ~ /[[:space:];&|()<>]/) break
    k++
  }
  return k
}
function push(k, c, r) {
  if (k == "group") brk()
  top++; kind[top] = k; cl[top] = c; rq[top] = r; sf[top] = segf; sb[top] = segb
  segf = ""; segb = ""; q = ""
}
function pop(  k) {
  k = kind[top]; brk(); segf = sf[top]; segb = sb[top]; q = rq[top]; top--
  if (k == "group") { segf = ""; segb = ""; return }
  put("$(_)", "$(_)")
}
# The pipeline holding the heredoc: its piece of the line between ; && ||.
function hdpipe(  t, parts, m, x, r) {
  t = lineb; gsub(/&&|\|\||;/, "\n", t); m = split(t, parts, "\n"); r = ""
  for (x = 1; x <= m; x++) if (index(parts[x], "<<")) r = parts[x]
  return r
}
function body(  j, e, line, out) {
  j = i + 1; out = ""
  while (j <= n) {
    e = index(substr(s, j), "\n"); line = (e ? substr(s, j, e - 1) : substr(s, j))
    j = (e ? j + e : n + 1)
    sub(/^\t+/, "", line)
    if (line == hd) break
    out = out line "\n"
  }
  i = j - 1
  return out
}
{ s = s $0 "\n" }
END {
  n = length(s); q = ""; top = 0; hd = ""; lineb = ""
  for (i = 1; i <= n; i++) {
    c = substr(s, i, 1); nx = substr(s, i + 1, 1)
    if (q == sq) {
      if (c == sq) { q = ""; put(c, "_"); continue }
      put(c == "\n" ? " " : c, "_"); continue
    }
    if (c == bs) {
      if (nx == "\n") { i++; continue }
      put(c nx, q == dq ? "__" : c nx); i++; continue
    }
    if (q == dq) {
      if (c == dq) { q = ""; put(c, "_"); continue }
      if (c == bq) { push("sub", bq, dq); continue }
      if (c == "$" && nx == "(") { push("sub", ")", dq); i++; continue }
      put(c == "\n" ? " " : c, "_"); continue
    }
    if (top > 0 && c == cl[top]) { pop(); continue }
    if (c == "#" && wordstart()) { while (i < n && substr(s, i + 1, 1) != "\n") i++; continue }
    if (c == "<" && nx == "<" && substr(s, i + 2, 1) != "<" && substr(segf, length(segf), 1) != "<") {
      j = i + 2
      while (substr(s, j, 1) ~ /[- \t]/) j++
      w = ""
      while (j <= n) { d = substr(s, j, 1); if (d ~ /[[:space:];&|<>()]/) break; if (d != sq && d != dq && d != bs) w = w d; j++ }
      put(substr(s, i, j - i), substr(s, i, j - i)); i = j - 1; hd = w; continue
    }
    if (c == "\n") {
      brk()
      if (hd != "") {
        p = hdpipe(); t = body()
        if (p ~ /(^|[^[:alnum:]_.-])gh[[:space:]].*api[[:space:]]+graphql/ && p ~ /query=@-|--input[[:space:]]+-/) emit(t, "", "gql")
        else if (p ~ /(^|[[:space:]|(])([^[:space:]]*\/)?(ba|z|da|k)?sh([[:space:]]|$)/) emit(t, "", "opaque")
        hd = ""
      }
      lineb = ""; continue
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
      if (opener()) {
        j = wordend(i); t = substr(s, i, j - i); emit(t, "", "opaque")
        gsub(/\n/, " ", t); put(t, blank(t)); i = j - 1; continue
      }
      q = c; put(c, "_"); continue
    }
    put(c, c)
  }
  brk()
}
AWK

# An awk that cannot read the program would let every command through.
segs=$(printf '%s' "$cmd" | awk -v sq="'" -v dq='"' -v bq='`' -v bs='\\' "$split_awk") && [[ -n "$segs" ]] ||
  ask "the guard could not read this command"

while IFS=$'\037' read -r -d $'\036' full blank kind; do
  case "$kind" in
    opaque) check_opaque "$full"; continue ;;
    gql) [[ "$full" =~ $mutation_re ]] && deny "a graphql query: $full"; continue ;;
  esac
  [[ "$blank" =~ $dirs_re ]] && cwd="?"
  if [[ "$blank" =~ $cd_re ]]; then
    if [[ "$kind" == nested ]]; then
      cwd="?"
    elif [[ "${full:${#BASH_REMATCH[0]}}" =~ ^(\'[^\']*\'|\"[^\"]*\"|[^[:space:]]+) ]]; then
      cwd=$(resolve "${BASH_REMATCH[1]}")
    fi
  fi
  [[ "$blank" =~ $merge_re ]] && deny "$full"
  [[ "$blank" =~ $api_re ]] && check_gh_api "$full"
  if [[ "$blank" =~ $push_re ]]; then
    m=${BASH_REMATCH[0]}
    pre=${blank%%"$m"*}
    check_push "${full:${#pre}:${#m}}" "${full:${#pre}+${#m}}" "$full"
  fi
done <<<"$segs"

((${#asks[@]} == 0)) && exit 0
reason="This may land on develop or main, which deploys an environment, or the guard cannot tell, so the owner approves it (TYRE-413): ${asks[*]}"
jq -n --arg r "$reason" \
  '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: $r}}'
exit 0
